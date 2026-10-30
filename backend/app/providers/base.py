"""Provider contract + normalized event schema.

A *provider* is an agent engine (Claude Code, Codex) that runs a full
agentic loop inside a spawned CLI subprocess. The host (this backend) feeds it
a user turn and streams back **normalized events** — the UI never sees
provider-specific wire formats.

Normalized event schema (mirrors geny-executor's ``PipelineEvent`` shape):

    { "type": <str>, "seq": <int>, "timestamp": <iso>, "data": {...} }

``type`` is one of :data:`EVENT_TYPES`.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Literal

# Normalized event vocabulary emitted to the web/mobile clients.
EVENT_TYPES = (
    "session.start",   # turn began; data: {provider, model, workspace}
    "text.delta",      # streaming assistant text; data: {text}
    "thinking.delta",  # streaming reasoning; data: {text}
    "tool.use",        # agent invoked a tool; data: {id, name, input}
    "tool.result",     # tool returned; data: {id, name, output, is_error}
    "turn.complete",   # terminal success; data: {text, model, usage, cost_usd, stop_reason, cli_session_id}
    "error",           # terminal failure; data: {code, message}
)

EventType = Literal[
    "session.start",
    "text.delta",
    "thinking.delta",
    "tool.use",
    "tool.result",
    "turn.complete",
    "error",
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class ProviderEvent:
    type: EventType
    data: dict[str, Any] = field(default_factory=dict)
    seq: int = 0
    timestamp: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "seq": self.seq,
            "timestamp": self.timestamp,
            "data": self.data,
        }


@dataclass
class AuthStatus:
    """Whether a provider is usable right now."""

    provider: str
    connected: bool
    auth_mode: str  # oauth | api_key | none
    detail: str = ""


@dataclass
class TurnRequest:
    """Everything a provider needs to run one chat turn."""

    messages: list[dict[str, str]]        # [{role, content}, ...] full history
    model: str                            # alias ("sonnet") or full id; "" => provider default
    cwd: str                              # working directory (local path or sshfs mount)
    effort: str = ""                      # reasoning/think level; "" or "default" => provider default
    cli_session_id: str | None = None     # resume a provider-side session when set
    mcp_config: dict[str, Any] | None = None   # e.g. remote-bash bridge
    allow_tools: list[str] = field(default_factory=list)
    api_key: str | None = None            # when auth_mode == api_key
    extra_env: dict[str, str] = field(default_factory=dict)
    timeout_s: float | None = None


class ProviderTurnError(RuntimeError):
    """Raised when a turn fails. ``code`` groups failures (exec.cli.*)."""

    def __init__(self, message: str, *, code: str = "exec.cli.unknown") -> None:
        super().__init__(message)
        self.code = code


class Provider(abc.ABC):
    """Base class every agent provider implements."""

    name: str

    @abc.abstractmethod
    async def auth_status(self, *, api_key: str | None = None) -> AuthStatus:
        """Report whether this provider can run right now."""

    @abc.abstractmethod
    def run_turn_stream(self, request: TurnRequest) -> AsyncIterator[ProviderEvent]:
        """Run one turn, yielding normalized events. Terminal event is
        ``turn.complete`` on success or ``error`` on failure."""
        raise NotImplementedError
