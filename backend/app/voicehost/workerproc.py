"""The server's handle on one engine worker process (app/voicehost/worker/__main__.py).

The worker runs in its engine's own Python environment with only the backend's source on its path. It connects back
to a one-off listener on 127.0.0.1 and proves itself with a one-off token; then requests go one JSON object per line
and answers come back the same way. A socket instead of inherited pipe descriptors: the same on Linux, Windows and
macOS. stdout / stderr stay free for the libraries' own output, which is copied to the server's log.

Each worker may be held to a memory ceiling (``capped``, a systemd scope, where the host has one). An address-space
limit is never used: a CUDA process maps far more virtual memory than it uses, and would fail to start under one.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import shutil
import sys
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("app.voicehost.worker")

# the directory holding the `app` package: the worker imports app.voicehost.worker from here, and nothing else of ours
SRC_ROOT = Path(__file__).resolve().parents[2]
CONNECT_TIMEOUT = 60.0  # a cold Python + torch import on a slow disk


class WorkerError(Exception):
    def __init__(self, message: str, kind: str = "internal") -> None:
        super().__init__(message)
        self.kind = kind


def _capped(argv: list[str], mem_gb: float) -> list[str]:
    """``capped -m <n>G -- argv`` where a systemd user scope can be made (this machine's memory guard), else argv."""
    if os.name == "nt" or not mem_gb:
        return argv
    exe = shutil.which("capped") or os.path.expanduser("~/.local/bin/capped")
    run_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    if os.path.isfile(exe) and os.access(exe, os.X_OK) and shutil.which("systemd-run") \
            and os.path.exists(os.path.join(run_dir, "bus")):
        return [exe, "-m", f"{max(1, int(round(mem_gb)))}G", "--", *argv]
    return argv


class WorkerProcess:
    def __init__(self, engine: str, python: str | None = None, env: dict[str, str] | None = None,
                 label: str = "", mem_gb: float = 0.0) -> None:
        self.engine = engine
        self.python = python or sys.executable
        self.extra_env = env or {}
        self.label = label or engine
        self.mem_gb = mem_gb
        self.proc: asyncio.subprocess.Process | None = None
        self._r: asyncio.StreamReader | None = None
        self._w: asyncio.StreamWriter | None = None
        self._lock = asyncio.Lock()
        self._seq = 0
        self._log_tasks: list[asyncio.Task] = []
        self.started_at = 0.0
        self.pid: int | None = None  # the worker's own pid (capped puts a wrapper in between)

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None and self._w is not None

    async def start(self) -> float:
        t0 = time.perf_counter()
        token = secrets.token_urlsafe(24)
        arrived: asyncio.Future = asyncio.get_running_loop().create_future()

        async def on_connect(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
            if arrived.done():
                w.close()
                return
            try:
                hello = json.loads((await asyncio.wait_for(r.readline(), 10)).decode() or "{}")
            except (asyncio.TimeoutError, ValueError):
                w.close()
                return
            if not secrets.compare_digest(str(hello.get("token", "")), token):
                w.close()  # (not ours)
                return
            arrived.set_result((r, w, hello.get("pid")))

        server = await asyncio.start_server(on_connect, "127.0.0.1", 0, limit=16 * 1024 * 1024)
        port = server.sockets[0].getsockname()[1]
        env = dict(os.environ)
        env.update(self.extra_env)
        env["GENY_VOICE_PORT"] = str(port)
        env["GENY_VOICE_TOKEN"] = token
        env["PYTHONPATH"] = str(SRC_ROOT)  # (only our source: the engine's environment has its own packages)
        env.pop("PYTHONHOME", None)
        env.setdefault("PYTHONUNBUFFERED", "1")
        # One growing arena instead of fixed-size blocks: less fragmentation, so reserved memory tracks real use.
        env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        env.setdefault("TOKENIZERS_PARALLELISM", "false")
        env.setdefault("TQDM_DISABLE", "1")
        env.setdefault("HF_HUB_OFFLINE", "1")  # weights are local; never let a library phone home mid-request
        # (-s: no user site-packages — the engine's environment only, plus our source on PYTHONPATH)
        argv = _capped([self.python, "-s", "-m", "app.voicehost.worker", "--engine", self.engine], self.mem_gb)
        if argv[0] != self.python:
            env.pop("CAPPED_MEM", None)  # (its own memory scope, not a share of the server's)
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env=env, cwd=str(SRC_ROOT))
            self._log_tasks = [asyncio.create_task(self._pump(self.proc.stdout)),
                               asyncio.create_task(self._pump(self.proc.stderr))]
            waiter = asyncio.ensure_future(self.proc.wait())
            done, _ = await asyncio.wait({arrived, waiter}, timeout=CONNECT_TIMEOUT,
                                         return_when=asyncio.FIRST_COMPLETED)
            if arrived not in done:
                waiter.cancel()
                code = self.proc.returncode
                await self.kill()
                raise WorkerError(f"{self.label} worker did not start"
                                  + (f" (exit {code})" if code is not None else " (no answer)"), "dead")
            waiter.cancel()
            self._r, self._w, pid = arrived.result()
            self.pid = int(pid) if pid else self.proc.pid
        finally:
            server.close()
        self.started_at = time.time()
        return time.perf_counter() - t0

    async def _pump(self, stream: asyncio.StreamReader | None) -> None:
        """Copy the worker's stdout/stderr to our log. Raw chunks, not readline(): progress bars write "\\r" without
        a newline, and a readline() that overruns its buffer would end this task, leave the pipe unread, and the
        worker would block forever on its next write."""
        if stream is None:
            return
        buf = b""
        while True:
            try:
                chunk = await stream.read(65536)
            except Exception:  # noqa: BLE001 - never stop draining
                chunk = b""
            if not chunk:
                if buf.strip():
                    log.info("[%s] %s", self.label, buf.decode("utf-8", "replace")[:2000])
                return
            buf += chunk
            *lines, buf = buf.replace(b"\r", b"\n").split(b"\n")
            if len(buf) > 65536:
                lines.append(buf)
                buf = b""
            for raw in lines:
                text = raw.decode("utf-8", "replace").rstrip()
                if text and "it/s]" not in text and "s/it]" not in text:
                    log.info("[%s] %s", self.label, text[:2000])

    async def call(self, op: str, timeout: float | None = None, **kwargs: Any) -> dict[str, Any]:
        if not self.alive:
            raise WorkerError(f"{self.label} worker is not running", "dead")
        async with self._lock:
            self._seq += 1
            msg = {"id": self._seq, "op": op, **kwargs}
            assert self._w is not None and self._r is not None
            try:
                self._w.write((json.dumps(msg, ensure_ascii=False) + "\n").encode())
                await self._w.drain()
                line = await asyncio.wait_for(self._r.readline(), timeout)
            except asyncio.TimeoutError:
                await self.kill()
                raise WorkerError(f"{self.label}: {op} timed out after {timeout:.0f}s", "timeout") from None
            except (ConnectionError, OSError):
                line = b""
            if not line:
                code = await self._exit_code()
                raise WorkerError(f"{self.label} worker exited (code {code}) during {op}", "dead")
            resp = json.loads(line)
            if not resp.get("ok"):
                raise WorkerError(resp.get("error", "worker error"), resp.get("kind", "internal"))
            return resp.get("result") or {}

    async def _exit_code(self) -> int | None:
        if self.proc is None:
            return None
        try:
            return await asyncio.wait_for(self.proc.wait(), 5)
        except asyncio.TimeoutError:
            return None

    async def stop(self, timeout: float = 10.0) -> None:
        if self.proc is None or self.proc.returncode is not None:
            self._close()
            return
        try:
            await self.call("shutdown", timeout=timeout)
        except WorkerError:
            pass
        try:
            await asyncio.wait_for(self.proc.wait(), timeout)
        except asyncio.TimeoutError:
            await self.kill()
        self._close()

    async def kill(self) -> None:
        if self.proc is not None and self.proc.returncode is None:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass
            await self.proc.wait()
        self._close()

    def _close(self) -> None:
        if self._w is not None:
            try:
                self._w.close()
            except (OSError, RuntimeError):
                pass
            self._w = None
        for t in self._log_tasks:
            t.cancel()
        self._log_tasks = []
