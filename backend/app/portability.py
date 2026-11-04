"""Small OS primitives shared by the native runtime and server; no shell interpolation."""
from __future__ import annotations
import os
import subprocess
import time


def lock_file(fd: int) -> None:
    if os.name != 'nt':
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX)
        return
    import msvcrt
    if os.fstat(fd).st_size == 0:
        os.write(fd, b'0')
    while True:
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return
        except OSError:
            time.sleep(.1)


def kill_tree(pid: int) -> None:
    """Children may own their own process group (provider MCP engines)."""
    import psutil
    try:
        root = psutil.Process(pid)
        children = root.children(recursive=True)
    except psutil.NoSuchProcess:
        return
    for p in [*reversed(children), root]:
        try:
            p.kill()
        except psutil.NoSuchProcess:
            pass


def child_command(binary: str, args: list[str]) -> list[str]:
    # npm shims are cmd scripts. Never interpolate arbitrary user/provider arguments into cmd.exe.
    # Prefer the adjacent JS entry and node so shell metacharacters remain plain argv.
    if binary.lower().endswith(".py"):
        import sys
        return [sys.executable, binary, *args]
    if os.name == 'nt' and binary.lower().endswith(('.cmd', '.bat')):
        from pathlib import Path
        import shutil
        base = Path(binary).parent
        entries = {
            'claude': 'node_modules/@anthropic-ai/claude-code/cli.js',
            'codex': 'node_modules/@openai/codex/bin/codex.js',
            'npm': 'node_modules/npm/bin/npm-cli.js',
        }
        entry = entries.get(Path(binary).stem.lower())
        if entry is None:
            return [binary, *args]
        node = shutil.which('node')
        target = base / entry
        if node and target.is_file():
            return [node, str(target), *args]
        raise RuntimeError('Install the native CLI using the setup assistant; this legacy Windows shim has no usable Node runtime')
    return [binary, *args]


def subprocess_flags() -> dict:
    return {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
