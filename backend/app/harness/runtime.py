"""What lives on between the turns of one chat: background shells and subagents, the files read so far, the to-do
list, the MCP connections, and where the shell stands.

Claude Code keeps these in its long-lived process; here one :class:`SessionRuntime` per chat holds them. It ends with
the chat's engine: on rewind, /clear, delete and shutdown (``shutdown``), or after it has sat idle with nothing running
(``reap``).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import signal
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

IDLE_S = 30 * 60
BUSY_IDLE_S = 12 * 3600


@dataclass
class Shell:
    id: str
    command: str
    description: str
    proc: asyncio.subprocess.Process
    output_path: str
    started_at: float
    tool_use_id: str = ""
    read_offset: int = 0
    exit_code: int | None = None
    ended_at: float | None = None
    killed: bool = False
    waiter: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        return self.exit_code is None and not self.killed

    def status(self) -> str:
        if self.killed:
            return "killed"
        if self.exit_code is None:
            return "running"
        return "completed" if self.exit_code == 0 else "failed"

    def read_new(self) -> str:
        try:
            with open(self.output_path, "rb") as fh:
                fh.seek(self.read_offset)
                data = fh.read()
        except OSError:
            return ""
        self.read_offset += len(data)
        return data.decode("utf-8", errors="replace")


@dataclass
class BackgroundAgent:
    id: str
    description: str
    tool_use_id: str
    task: asyncio.Task
    started_at: float
    result: str | None = None
    status: str = "running"


class SessionRuntime:
    def __init__(self, sid: str) -> None:
        self.sid = sid
        self.cwd: str | None = None                # where the shell stands (cd carries over)
        self.base_cwd: str | None = None           # the chat's working directory it started from
        self.read_files: dict[str, int] = {}       # path -> mtime_ns when the model last saw it
        self.todos: list[dict[str, Any]] = []
        self.shells: dict[str, Shell] = {}
        self.agents: dict[str, BackgroundAgent] = {}
        self.notices: list[str] = []               # finished background work the model hasn't heard about yet
        self.mcp: Any = None                       # tools.mcp.McpHub
        self.dir = tempfile.mkdtemp(prefix="hrh-harness-")
        self.last_used = time.monotonic()
        self._n = 0
        # Called with a ProviderEvent (task.update) when background work changes state outside a turn.
        self.on_event: Callable[[Any], None] | None = None
        # Called when background work finishes while no turn runs (the session layer may start one).
        self.on_idle_notice: Callable[[], None] | None = None
        self.turn_running = False

    def next_id(self, prefix: str) -> str:
        self._n += 1
        return f"{prefix}_{self._n}"

    def touch(self) -> None:
        self.last_used = time.monotonic()

    @property
    def busy(self) -> bool:
        return any(s.running for s in self.shells.values()) or any(a.status == "running" for a in self.agents.values())

    def notify(self, text: str) -> None:
        self.notices.append(text)
        if not self.turn_running and self.on_idle_notice is not None:
            with contextlib.suppress(Exception):
                self.on_idle_notice()

    def take_notices(self) -> list[str]:
        out, self.notices = self.notices, []
        return out

    def emit(self, ev: Any) -> None:
        if self.on_event is not None:
            with contextlib.suppress(Exception):
                self.on_event(ev)

    async def shutdown(self) -> None:
        for shell in list(self.shells.values()):
            await kill_shell(shell)
        for agent in list(self.agents.values()):
            if not agent.task.done():
                agent.task.cancel()
        if self.mcp is not None:
            with contextlib.suppress(Exception):
                await self.mcp.close()
            self.mcp = None
        shutil.rmtree(self.dir, ignore_errors=True)


async def kill_shell(shell: Shell) -> None:
    if shell.exit_code is not None:
        return
    shell.killed = True
    kill_process(shell.proc)
    with contextlib.suppress(Exception):
        await asyncio.wait_for(shell.proc.wait(), 5)
    if shell.ended_at is None:
        shell.ended_at = time.time()


def kill_process(proc: asyncio.subprocess.Process) -> None:
    """The process and everything it started (its own process group / tree)."""
    if proc.returncode is not None:
        return
    try:
        if os.name == "nt":
            from app.portability import kill_tree

            kill_tree(proc.pid)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        with contextlib.suppress(Exception):
            proc.kill()


_runtimes: dict[str, SessionRuntime] = {}


def get(sid: str) -> SessionRuntime:
    rt = _runtimes.get(sid)
    if rt is None:
        rt = _runtimes[sid] = SessionRuntime(sid)
    rt.touch()
    return rt


def peek(sid: str) -> SessionRuntime | None:
    return _runtimes.get(sid)


async def shutdown(sid: str) -> None:
    rt = _runtimes.pop(sid, None)
    if rt is not None:
        await rt.shutdown()


async def shutdown_all() -> None:
    for sid in list(_runtimes):
        await shutdown(sid)


async def reap() -> None:
    """Close runtimes that sat idle (a chat with background work running gets much longer)."""
    now = time.monotonic()
    for sid, rt in list(_runtimes.items()):
        limit = BUSY_IDLE_S if rt.busy else IDLE_S
        if not rt.turn_running and now - rt.last_used > limit:
            await shutdown(sid)
