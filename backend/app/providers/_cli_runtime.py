"""Async subprocess runner for CLI-based providers.

Spawns a provider CLI, streams its stdout line-by-line, feeds stdin, enforces
a wall-clock timeout, and scrubs the child environment so only whitelisted
parent vars (plus explicit extras) leak through — the geny-executor
``CLIProcessRunner`` pattern.
"""

from __future__ import annotations

import asyncio
import os
import signal
from dataclasses import dataclass, field
from typing import AsyncIterator

# Parent env vars the child is allowed to inherit. Notably ANTHROPIC_API_KEY is
# NOT here — it is injected explicitly only on the api_key auth path.
_ENV_WHITELIST = ("HOME", "PATH", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ", "SHELL")


@dataclass
class CLIResult:
    returncode: int
    stderr: str


@dataclass
class CLIProcessRunner:
    binary: str
    cwd: str | None = None
    env_extras: dict[str, str] = field(default_factory=dict)
    timeout_s: float = 600.0

    def _build_env(self) -> dict[str, str]:
        env = {k: os.environ[k] for k in _ENV_WHITELIST if k in os.environ}
        env.update(self.env_extras)
        return env

    async def stream(
        self, argv: list[str], *, stdin: bytes | None = None, keep_stdin_open: bool = False
    ) -> AsyncIterator[bytes]:
        """Spawn ``[binary, *argv]`` and yield stdout lines (with newline).

        With ``keep_stdin_open`` the caller can push more input mid-run
        (:meth:`write`) and must :meth:`close_stdin` when done — used to steer
        a running Claude turn. Collects stderr for diagnostics; on non-zero
        exit the caller inspects :attr:`last_result`. Raises
        :class:`asyncio.TimeoutError` on timeout.
        """
        proc = await asyncio.create_subprocess_exec(
            self.binary,
            *argv,
            cwd=self.cwd,
            env=self._build_env(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            # Own process group, so Stop/timeout also kills the shells and MCP
            # servers the agent spawned — not just the CLI itself.
            start_new_session=True,
            limit=16 * 1024 * 1024,  # stream-json lines (e.g. big tool output) can be large
        )
        assert proc.stdout is not None and proc.stdin is not None
        self._proc = proc

        if stdin is not None:
            proc.stdin.write(stdin)
            await proc.stdin.drain()
        if not keep_stdin_open:
            proc.stdin.close()

        stderr_chunks: list[bytes] = []

        async def _drain_stderr() -> None:
            assert proc.stderr is not None
            async for line in proc.stderr:
                stderr_chunks.append(line)

        stderr_task = asyncio.create_task(_drain_stderr())

        try:
            async def _lines() -> AsyncIterator[bytes]:
                assert proc.stdout is not None
                async for line in proc.stdout:
                    yield line

            agen = _lines()
            try:
                while True:
                    try:
                        line = await asyncio.wait_for(agen.__anext__(), timeout=self.timeout_s)
                    except StopAsyncIteration:
                        break
                    yield line
            finally:
                await agen.aclose()

            await asyncio.wait_for(proc.wait(), timeout=self.timeout_s)
        except BaseException:
            # Timeout, Stop (CancelledError) or the consumer abandoning us at a
            # yield (GeneratorExit): never leave the CLI running behind.
            if proc.returncode is None:
                _kill_group(proc)
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass
            raise
        finally:
            if not stderr_task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(stderr_task), timeout=5)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    stderr_task.cancel()

        self.last_result = CLIResult(
            returncode=proc.returncode if proc.returncode is not None else -1,
            stderr=b"".join(stderr_chunks).decode(errors="replace"),
        )

    last_result: CLIResult | None = None
    _proc: asyncio.subprocess.Process | None = None

    async def write(self, data: bytes) -> bool:
        """Send more input to a running process (``keep_stdin_open`` mode)."""
        proc = self._proc
        if proc is None or proc.stdin is None or proc.stdin.is_closing() or proc.returncode is not None:
            return False
        try:
            proc.stdin.write(data)
            await proc.stdin.drain()
            return True
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            return False

    def close_stdin(self) -> None:
        proc = self._proc
        if proc is not None and proc.stdin is not None and not proc.stdin.is_closing():
            proc.stdin.close()

    def terminate(self) -> None:
        """Kill the running process group (the stream then ends normally)."""
        if self._proc is not None and self._proc.returncode is None:
            _kill_group(self._proc)


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    """SIGTERM the CLI's whole process group, then SIGKILL anything left."""
    try:
        pgid = os.getpgid(proc.pid)
    except ProcessLookupError:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return
        if sig is signal.SIGTERM:
            # Give the CLI a moment to flush its session transcript.
            import time

            for _ in range(20):
                if proc.returncode is not None:
                    break
                time.sleep(0.05)
