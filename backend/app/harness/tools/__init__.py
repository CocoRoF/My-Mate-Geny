"""The tools an API-key agent gets, chosen per turn like the CLIs' (``--tools``, ``--allowedTools``, plan mode)."""

from __future__ import annotations

from typing import Any

from app.harness.tools.base import Tool, ToolContext, ToolOutput
from app.harness.tools.files import Edit, MultiEdit, NotebookEdit, Read, Write
from app.harness.tools.search import Glob, Grep
from app.harness.tools.shell import Bash, BashOutput, KillShell
from app.harness.tools.tasks import Skill, Task, TodoWrite
from app.harness.tools.web import WebFetch, WebSearch

__all__ = ["Tool", "ToolContext", "ToolOutput", "builtin", "select"]


def builtin(skills: dict[str, dict[str, str]] | None = None) -> list[Tool]:
    tools: list[Tool] = [Bash(), BashOutput(), KillShell(), Read(), Write(), Edit(), MultiEdit(), NotebookEdit(),
                         Glob(), Grep(), WebFetch(), WebSearch(), TodoWrite(), Task()]
    if skills:
        tools.append(Skill(skills))
    return tools


def select(builtins: list[Tool], mcp: list[Tool], req: Any, *, subagent: bool = False) -> list[Tool]:
    """``req.tools``: None = every built-in tool, [] = none, else those names. A sealed chat (a Mate) gets only the
    MCP tools its ``allowed_tools`` name (``mcp__mate`` = all of that server). Plan mode keeps what changes nothing; a
    subagent can't start subagents."""
    names = req.tools
    chosen = [t for t in builtins if names is None or t.name in names]
    allowed = list(req.allowed_tools or [])
    if req.sealed or names == []:
        mcp = [t for t in mcp if not allowed or any(t.name == a or t.name.startswith(a + "__") for a in allowed)]
    chosen += mcp
    if req.mode == "plan":
        chosen = [t for t in chosen if t.read_only]
    if subagent:
        chosen = [t for t in chosen if t.name != "Task"]
    seen: set[str] = set()
    out = []
    for t in chosen:
        if t.name not in seen:
            seen.add(t.name)
            out.append(t)
    return out
