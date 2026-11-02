"""The processing tools (numpy, scipy, OpenCV, Pillow, ffmpeg) — in a venv of their own, made on first use.

The backend's own Python stays lean (the Docker image has none of these), so the avatar pipeline
(app/avatar/pipeline.py) runs in ``~/.hr-harnessor/avatar-venv/<python>`` (``AVATAR_VENV`` overrides it), created
from the backend's interpreter with pip — one per interpreter, so a host install and a container sharing the home
folder never break each other's copy. ffmpeg: the system's when there is one, else the static build that comes with
``imageio-ffmpeg`` (the container has no ffmpeg).

Every pipeline run is memory-capped (``capped`` — a systemd scope — where it works, else an address-space limit) and
serialized: one avatar's processing at a time on this machine (an fcntl lock under the avatar root, so separate
backends sharing it queue too).
"""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import os
import resource
import shutil
import sys
import time
from pathlib import Path
from typing import Any, AsyncIterator

from app.config import settings

PIPELINE = Path(__file__).with_name("pipeline.py")
# (OpenCV 5 dropped the cascade face detectors the stills need: stay on 4.x)
PACKAGES = ["numpy<3", "scipy", "opencv-python-headless<5", "pillow", "imageio-ffmpeg"]


GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"


def find_uv() -> str | None:
    for c in (shutil.which("uv"), os.path.expanduser("~/.local/bin/uv"), os.path.expanduser("~/.cargo/bin/uv"),
              "/usr/local/bin/uv"):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def venv_dir() -> Path:
    if settings.avatar_venv:
        return Path(os.path.expanduser(settings.avatar_venv)).resolve()
    tag = hashlib.sha256(os.path.realpath(sys.executable).encode()).hexdigest()[:8]
    return settings.home_dir / "avatar-venv" / f"py{sys.version_info[0]}{sys.version_info[1]}-{tag}"


def venv_python() -> Path:
    return venv_dir() / "bin" / "python"


def _mem_bytes(text: str) -> int:
    t = text.strip().upper()
    mult = {"K": 1 << 10, "M": 1 << 20, "G": 1 << 30}.get(t[-1:], 1)
    return int(float(t[:-1] if t[-1:] in "KMG" else t) * mult)


def capped_argv(argv: list[str], mem: str) -> tuple[list[str], Any]:
    """``capped -m <mem> -- argv`` where a systemd user scope can be made; else argv with an address-space limit
    set in the child (preexec)."""
    exe = shutil.which("capped") or os.path.expanduser("~/.local/bin/capped")
    run_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    if os.path.isfile(exe) and os.access(exe, os.X_OK) and shutil.which("systemd-run") \
            and os.path.exists(os.path.join(run_dir, "bus")):
        return [exe, "-m", mem, "--", *argv], None
    limit = _mem_bytes(mem) * 2  # (virtual size: libraries and thread arenas count too)

    def lower() -> None:
        try:
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        except (ValueError, OSError):
            pass
    return argv, lower


class Deps:
    def __init__(self) -> None:
        self._install: asyncio.Task | None = None
        self._lines: list[str] = []
        self._phase = ""
        self._error: str | None = None
        self._subs: list[asyncio.Queue] = []
        self._status: tuple[float, dict[str, Any]] | None = None
        self._lock = asyncio.Lock()

    # ---- status ----

    def _ready_file(self) -> Path:
        return venv_dir() / "ready.json"

    def ready(self) -> bool:
        return venv_python().is_file() and self._ready_file().is_file()

    def status(self) -> dict[str, Any]:
        info: dict[str, Any] = {}
        try:
            info = json.loads(self._ready_file().read_text())
        except (OSError, ValueError):
            pass
        return {"ready": self.ready(), "installing": self._install is not None and not self._install.done(),
                "phase": self._phase or None, "error": self._error, "venv": str(venv_dir()),
                "versions": info.get("versions"), "log": self._lines[-12:]}

    # ---- install ----

    def _emit(self, line: str) -> None:
        line = line.rstrip()[:300]
        if not line:
            return
        self._lines.append(line)
        del self._lines[:-200]
        for q in list(self._subs):
            q.put_nowait({"phase": self._phase, "line": line})

    async def _run(self, argv: list[str], timeout: float) -> int:
        cmd, pre = capped_argv(argv, "2G")
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT, preexec_fn=pre,
                                                    env={**os.environ, "PIP_DISABLE_PIP_VERSION_CHECK": "1",
                                                         "PYTHONNOUSERSITE": "1"})
        assert proc.stdout
        deadline = time.monotonic() + timeout
        try:
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=left)
                if not line:
                    break
                self._emit(line.decode("utf-8", "replace"))
            return await proc.wait()
        except (TimeoutError, asyncio.TimeoutError):
            proc.kill()
            await proc.wait()
            raise RuntimeError("timed out") from None

    async def _do_install(self) -> None:
        """uv when the machine has it (fast, no ensurepip needed), else venv + pip, else a venv without pip and
        pip bootstrapped from get-pip.py (Debian/Ubuntu without python3-venv)."""
        self._error = None
        d = venv_dir()
        uv = find_uv()
        try:
            d.parent.mkdir(parents=True, exist_ok=True)
            if not venv_python().is_file():
                self._phase = "venv"
                self._emit(f"creating {d}")
                if uv:
                    ok = await self._run([uv, "venv", "--python", sys.executable, str(d)], 300) == 0
                else:
                    ok = await self._run([sys.executable, "-m", "venv", str(d)], 300) == 0
                    if not ok:
                        shutil.rmtree(d, ignore_errors=True)
                        ok = await self._run([sys.executable, "-m", "venv", "--without-pip", str(d)], 300) == 0
                if not ok or not venv_python().is_file():
                    raise RuntimeError("could not create the venv")
            self._phase = "packages"
            self._emit("installing " + ", ".join(PACKAGES))
            if uv:
                rc = await self._run([uv, "pip", "install", "--python", str(venv_python()), *PACKAGES], 1800)
            else:
                if await self._run([str(venv_python()), "-m", "pip", "--version"], 60) != 0:
                    await self._get_pip()
                rc = await self._run([str(venv_python()), "-m", "pip", "install", "--no-input", "--progress-bar",
                                      "off", *PACKAGES], 1800)
            if rc != 0:
                raise RuntimeError("installing the packages failed (see the log)")
            self._phase = "verify"
            res = await self.run("versions", [], timeout=120, check_ready=False)
            if not res.get("x264"):
                raise RuntimeError("the ffmpeg found has no H.264 encoder (libx264)")
            self._ready_file().write_text(json.dumps({"versions": res, "at": time.time()}))
            self._phase = "done"
            self._emit("ready")
        except Exception as exc:  # noqa: BLE001 - shown in the UI
            self._error = str(exc)[:300]
            self._phase = "error"
            self._emit(f"error: {self._error}")
        finally:
            for q in list(self._subs):
                q.put_nowait(None)

    async def _get_pip(self) -> None:
        import urllib.request

        self._emit("bootstrapping pip (get-pip.py)")
        dest = venv_dir() / "get-pip.py"

        def fetch() -> None:
            with urllib.request.urlopen(GET_PIP_URL, timeout=120) as r:  # noqa: S310 - the official bootstrap
                dest.write_bytes(r.read(20 * 1024 * 1024))
        await asyncio.to_thread(fetch)
        if await self._run([str(venv_python()), str(dest), "--no-warn-script-location"], 600) != 0:
            raise RuntimeError("could not bootstrap pip")

    def start_install(self) -> None:
        if self._install is None or self._install.done():
            self._lines = []
            self._install = asyncio.get_running_loop().create_task(self._do_install())

    async def install_stream(self) -> AsyncIterator[dict[str, Any]]:
        """Start (or join) the install and follow it: {phase, line} … then the final status."""
        q: asyncio.Queue = asyncio.Queue()
        self._subs.append(q)
        try:
            self.start_install()
            for line in self._lines[-20:]:
                yield {"phase": self._phase, "line": line}
            while True:
                if self._install is not None and self._install.done() and q.empty():
                    break
                item = await q.get()
                if item is None:
                    break
                yield item
        finally:
            self._subs.remove(q)
        yield {"phase": "done" if self.ready() else "error", **self.status()}

    # ---- running a step ----

    async def run(self, step: str, args: list[str], *, timeout: float = 1800, check_ready: bool = True,
                  on_progress: Any = None) -> dict[str, Any]:
        """One pipeline step in the venv, memory-capped, one at a time. → its JSON answer (RuntimeError on
        failure)."""
        if check_ready and not self.ready():
            raise RuntimeError("the processing tools are not installed yet")
        root = settings.avatar_root_path
        root.mkdir(parents=True, exist_ok=True)
        async with self._lock:
            fd = os.open(root / ".processing.lock", os.O_RDWR | os.O_CREAT, 0o600)
            try:
                await asyncio.to_thread(fcntl.flock, fd, fcntl.LOCK_EX)
                return await self._run_step(step, args, timeout, on_progress)
            finally:
                os.close(fd)  # (closing drops the lock)

    async def _run_step(self, step: str, args: list[str], timeout: float, on_progress: Any) -> dict[str, Any]:
        argv, pre = capped_argv([str(venv_python()), "-I", str(PIPELINE), step, *args], settings.avatar_mem)
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", ""),
               "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2",
               **({"XDG_RUNTIME_DIR": os.environ["XDG_RUNTIME_DIR"]} if os.environ.get("XDG_RUNTIME_DIR") else {})}
        proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE, preexec_fn=pre, env=env)
        assert proc.stdout and proc.stderr
        last: dict[str, Any] | None = None
        errs: list[str] = []

        async def read_err() -> None:
            async for line in proc.stderr:  # type: ignore[union-attr]
                errs.append(line.decode("utf-8", "replace").rstrip())
                del errs[:-30]

        err_task = asyncio.create_task(read_err())
        try:
            async def read_out() -> None:
                nonlocal last
                async for raw in proc.stdout:  # type: ignore[union-attr]
                    try:
                        obj = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(obj, dict) and "progress" in obj:
                        if on_progress is not None:
                            try:
                                on_progress(obj["progress"])
                            except Exception:  # noqa: BLE001
                                pass
                    elif isinstance(obj, dict):
                        last = obj
            await asyncio.wait_for(read_out(), timeout=timeout)
            rc = await asyncio.wait_for(proc.wait(), timeout=30)
        except (TimeoutError, asyncio.TimeoutError):
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"{step}: timed out after {int(timeout)} s") from None
        finally:
            await asyncio.gather(err_task, return_exceptions=True)
        if rc == 137 or rc == -9:
            raise RuntimeError(f"{step}: stopped at its memory cap ({settings.avatar_mem})")
        if last is None:
            raise RuntimeError(f"{step}: exit {rc}: " + (" | ".join(errs[-3:]) or "no answer"))
        if not last.get("ok"):
            raise RuntimeError(f"{step}: {last.get('error') or 'failed'}")
        last.pop("ok", None)
        return last
