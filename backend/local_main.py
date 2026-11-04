"""The packaged desktop's owned loopback runtime (also runnable from a source checkout)."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
from pathlib import Path


def configure(data: Path, static: Path) -> None:
    if os.name != "nt":
        os.umask(0o077)
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    password_file = data / "local-owner.key"
    if not password_file.exists():
        fd = os.open(password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as out:
            out.write(secrets.token_urlsafe(48))
    defaults = {
        "EXECUTION_MODE": "local", "DATA_HOME": str(data), "DB_PATH": str(data / "geny.db"),
        "STATIC_DIR": str(static), "AUTH_USERNAME": "local", "AUTH_PASSWORD": password_file.read_text(),
        "HOST": "127.0.0.1", "COOKIE_SECURE": "false", "CORS_ORIGINS": "", "MATE_SEARCH_ROOTS": str(Path.home()),
        "MOUNT_ROOT": str(data / "mounts"), "REPOS_ROOT": str(data / "repos"),
        "UPLOADS_ROOT": str(data / "uploads"), "MATES_ROOT": str(data / "mates"),
        "HIGGSFIELD_ROOT": str(data / "higgsfield"), "AVATAR_ROOT": str(data / "avatars"),
        "CLI_MANAGED_PREFIX": str(data / "cli"),
    }
    # Never borrow a development .env or a server DB when launching the local product.
    os.environ.update(defaults)
    os.environ.setdefault("PYTHONNOUSERSITE", "1")
    os.chdir(data)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data-dir", required=True)
    p.add_argument("--static-dir", required=True)
    p.add_argument("--port", type=int, default=0)
    args = p.parse_args()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name != "nt":
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    elif hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        sock.bind(("127.0.0.1", args.port if 1024 <= args.port <= 65535 else 0))
    except OSError:
        sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = sock.getsockname()[1]
    configure(Path(args.data_dir).resolve(), Path(args.static_dir).resolve())
    os.environ["PORT"] = str(port)
    # A native crash/forced Quit must not strand local engines, even on Windows.
    import threading, time
    import psutil
    parent_pid = int(os.environ.pop("GENY_NATIVE_PARENT_PID", "0"))
    if parent_pid:
        parent = psutil.Process(parent_pid)
        def watch_parent():
            while parent.is_running():
                time.sleep(.5)
            from app.portability import kill_tree
            kill_tree(os.getpid())
        threading.Thread(target=watch_parent, daemon=True).start()
    import uvicorn
    from app.main import app
    os.environ.pop("LOCAL_BOOTSTRAP_SECRET", None)

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", loop="asyncio"))
    app.state.local_shutdown = lambda: setattr(server, "should_exit", True)
    # Emitted only after lifespan startup, not merely after a port was reserved.
    original_startup = server.startup
    async def startup(sockets=None):
        await original_startup(sockets=sockets)
        if not server.should_exit:
            print("GENY_LOCAL_READY " + json.dumps({"port": port}), flush=True)
    server.startup = startup
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
