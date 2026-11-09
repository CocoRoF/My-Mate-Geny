"""What a tool is, and what it gets to work with.

Tools carry Claude Code's names and input shapes (Bash, Read, Edit, Grep, Task, TodoWrite, ``mcp__server__tool``…):
models are trained on that shape, and the chat already draws a card for each (frontend ``turn/toolMeta.ts``), so a turn
on an API key reads exactly like one on Claude Code.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.harness.runtime import SessionRuntime


@dataclass
class ToolOutput:
    text: str
    is_error: bool = False
    images: list[dict[str, str]] = field(default_factory=list)  # {media_type, data(base64)}: shown to the model and the user
    agent: dict[str, Any] | None = None   # a subagent's report (Task): tool.result's ``agent``

    @classmethod
    def error(cls, text: str) -> ToolOutput:
        return cls(text, is_error=True)


@dataclass
class ToolContext:
    sid: str
    runtime: SessionRuntime
    cwd: str                                   # where the chat works (the workspace, or a remote chat's scratch dir)
    roots: list[str]                           # every folder of the chat on this machine
    mode: str = "agent"                        # agent | plan
    env: dict[str, str] = field(default_factory=dict)  # for the commands the agent runs
    tool_use_id: str = ""
    parent: str | None = None                  # the Task call this runs in (a subagent's tools)
    # Events a tool produces while it runs (a background job's state, a subagent's steps): the turn streams them.
    emit: Callable[[Any], None] = lambda ev: None
    # A short side question to the chat's model, with nothing of the conversation: WebFetch, WebSearch.
    ask: Callable[..., Awaitable[Any]] | None = None
    # Runs a subagent (Task): the engine provides it.
    run_agent: Callable[..., Awaitable[ToolOutput]] | None = None
    timeout_s: float | None = None

    def path(self, raw: str) -> str:
        """An absolute path for what the model wrote (``~``, relative to the working directory)."""
        p = os.path.expanduser(str(raw or "").strip())
        if not os.path.isabs(p):
            p = os.path.join(self.runtime.cwd or self.cwd, p)
        return os.path.normpath(p)


class Tool:
    name: str = ""
    description: str = ""
    schema: dict[str, Any] = {}
    read_only: bool = False    # usable in plan mode (changes nothing)
    parallel: bool = False     # may run at the same time as other parallel calls of one answer

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:  # pragma: no cover - interface
        raise NotImplementedError


def obj(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


def truncate_middle(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    tail = limit - head
    cut = len(text) - head - tail
    return f"{text[:head]}\n\n... [{cut} characters truncated] ...\n\n{text[-tail:]}"


async def to_thread(fn: Callable[..., Any], *a: Any, **k: Any) -> Any:
    return await asyncio.to_thread(fn, *a, **k)
