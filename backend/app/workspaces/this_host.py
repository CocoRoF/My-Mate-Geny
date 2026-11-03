"""Is an SSH connection really *this* machine?

A connection may point back at the server the app (and the agent CLIs) run on — e.g. the user's
"this host" connection to reach folders through SSH. Its folders are then better used directly:
the CLI's own tools work on them, no SSH hop, no key needed — and the same folder must not show
up twice (once "local", once over SSH).

Two checks, both needed:

1. **Same machine** — a random nonce is written to a file under this server's home and read back
   over SSH at the same path. Only a host that sees this server's files gets it right.
2. **Same folder** — a container sees only part of the host (here ``/home`` is mounted, ``/etc``
   is the container's own): a path is local-equivalent only if ``stat`` gives the same
   device + inode on both sides (a bind mount keeps both).

Results are cached per connection for a few minutes (a failed probe briefly) — the probe costs
one SSH round trip.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import shlex
import time
from typing import Any

from app.config import settings

_TTL_OK = 600.0
_TTL_FAIL = 60.0
_cache: dict[str, tuple[bool, float]] = {}
_locks: dict[str, asyncio.Lock] = {}


def _spec_key(connector: Any) -> str:
    s = connector._spec  # noqa: SLF001 - same package
    return f"{s.connection_id}|{s.host}|{s.port}|{s.username}"


async def ssh_run(connector: Any, script: str, *, stdin: bytes | None = None, timeout: float = 20) -> tuple[int, str, str]:
    """Run ``script`` on the connector's host (``sh -c`` there via ssh)."""
    argv = [*connector.ssh_prefix(), script]
    proc = await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "", "timed out"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


def forget(connection_id: str | None = None) -> None:
    if connection_id is None:
        _cache.clear()
    else:
        for k in [k for k in _cache if k.startswith(connection_id + "|")]:
            _cache.pop(k, None)


async def is_this_host(connector: Any) -> bool:
    key = _spec_key(connector)
    hit = _cache.get(key)
    if hit and time.monotonic() < hit[1]:
        return hit[0]
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _cache.get(key)
        if hit and time.monotonic() < hit[1]:
            return hit[0]
        same = await _probe(connector)
        _cache[key] = (same, time.monotonic() + (_TTL_OK if same else _TTL_FAIL))
        return same


async def _probe(connector: Any) -> bool:
    d = settings.home_dir / "tmp"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    nonce = secrets.token_hex(16)
    path = d / f"hostprobe-{secrets.token_hex(6)}"
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(nonce)
        rc, out, _ = await ssh_run(connector, f"cat -- {shlex.quote(str(path))} 2>/dev/null", timeout=12)
        return rc == 0 and out.strip() == nonce
    except Exception:  # noqa: BLE001 - unreachable / no key: not this host (as far as we can tell)
        return False
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _local_id(path: str) -> tuple[int, int] | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st.st_dev, st.st_ino


async def local_equivalents(connector: Any, paths: list[str]) -> dict[str, str]:
    """{remote path: local path} for those of ``paths`` (on the connector's host) that are the very
    same folders on this server. Empty when the connection is another machine."""
    if not paths or not await is_this_host(connector):
        return {}
    script = "".join(
        f"p={_q(p)}; r=$(cd -- \"$p\" 2>/dev/null && pwd -P) && printf '%s\\t%s\\n' \"$r\" "
        f"\"$(stat -L -c '%d %i' -- \"$r\" 2>/dev/null)\" || echo\n"
        for p in paths
    )
    rc, out, _ = await ssh_run(connector, script, timeout=15)
    if rc != 0:
        return {}
    lines = out.splitlines()
    found: dict[str, str] = {}
    for i, p in enumerate(paths):
        ln = lines[i] if i < len(lines) else ""
        real, _, ids = ln.partition("\t")
        if not real or not ids.strip():
            continue
        try:
            dev, ino = (int(x) for x in ids.split())
        except ValueError:
            continue
        if _local_id(real) == (dev, ino):
            found[p] = real
    return found


def _q(p: str) -> str:
    if p == "~":
        return '"$HOME"'
    if p.startswith("~/"):
        return '"$HOME"/' + shlex.quote(p[2:])
    return shlex.quote(p)
