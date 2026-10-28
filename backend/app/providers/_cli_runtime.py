"""Async subprocess runner for CLI-based providers.

Spawns a provider CLI, streams its stdout line-by-line, feeds stdin, enforces
a wall-clock timeout, and scrubs the child environment so only whitelisted
parent vars (plus explicit extras) leak through — the geny-executor
``CLIProcessRunner`` pattern.
"""

from __future__ import annotations

import asyncio
import os
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
        self, argv: list[str], *, stdin: bytes | None = None
    ) -> AsyncIterator[bytes]:
        """Spawn ``[binary, *argv]`` and yield stdout lines (with newline).

        Collects stderr for diagnostics; on non-zero exit the caller inspects
        :attr:`last_result`. Raises :class:`asyncio.TimeoutError` on timeout.
        """
        proc = await asyncio.create_subprocess_exec(
            self.binary,
            *argv,
            cwd=self.cwd,
            env=self._build_env(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdout is not None and proc.stdin is not None

        if stdin is not None:
            proc.stdin.write(stdin)
            await proc.stdin.drain()
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
        except (asyncio.TimeoutError, asyncio.CancelledError):
            proc.kill()
            await stderr_task
            raise
        finally:
            await stderr_task

        self.last_result = CLIResult(
            returncode=proc.returncode if proc.returncode is not None else -1,
            stderr=b"".join(stderr_chunks).decode(errors="replace"),
        )

    last_result: CLIResult | None = None
