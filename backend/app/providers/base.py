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
import asyncio
from dataclasses import dataclass, field
from typing import Callable
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Literal

from app.providers._attachments import Attachment

# Normalized event vocabulary emitted to the web/mobile clients.
EVENT_TYPES = (
    "session.start",   # turn began; data: {provider, model, workspace}
    "text.delta",      # streaming assistant text; data: {text}
    "thinking.delta",  # streaming reasoning; data: {text}
    "tool.use",        # agent invoked a tool; data: {id, name, input}
    "tool.result",     # tool returned; data: {id, name, output, is_error}
    "turn.complete",   # terminal success; data: {text, model, usage, cost_usd, stop_reason, cli_session_id}
    "error",           # terminal failure; data: {code, message}  (code "turn.interrupted" = user pressed Stop)
    "notice",          # NON-terminal warning/info shown inline; data: {level, message, code}
    "session.info",    # CLI capabilities (tools, slash commands, skills, MCP servers…); not persisted as an event
    "user.steer",      # the user added instructions mid-turn; data: {text, attachments, client_msg_id}
)

EventType = Literal[
    "session.start",
    "text.delta",
    "thinking.delta",
    "tool.use",
    "tool.result",
    "turn.complete",
    "error",
    "notice",
    "session.info",
    "user.steer",
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class ProviderEvent:
    type: EventType
    data: dict[str, Any] = field(default_factory=dict)
    seq: int = 0
    timestamp: str = field(default_factory=_now_iso)
    eid: int | None = None  # events-table row id once persisted (client resume cursor)

    def to_dict(self) -> dict[str, Any]:
        d = {
            "type": self.type,
            "seq": self.seq,
            "timestamp": self.timestamp,
            "data": self.data,
        }
        if self.eid is not None:
            d["eid"] = self.eid
        return d


@dataclass
class AuthStatus:
    """Whether a provider is usable right now."""

    provider: str
    connected: bool
    auth_mode: str  # oauth | api_key | none
    detail: str = ""


@dataclass
class SteerMessage:
    """Extra instructions the user sent while the turn is running."""

    text: str
    attachments: list[Attachment] = field(default_factory=list)
    delivered: "asyncio.Future[bool] | None" = None  # resolved by the provider
    # Runs synchronously at the moment of delivery, so the session records the
    # instruction in its true place — before the provider emits anything else.
    on_delivered: Callable[[], None] | None = None

    def resolve(self, ok: bool) -> None:
        if self.delivered is not None and self.delivered.done():
            return
        if ok and self.on_delivered is not None:
            self.on_delivered()
        if self.delivered is not None:
            self.delivered.set_result(ok)


class TurnInbox:
    """Mid-turn input channel from the session to the running provider.

    The provider closes it once the turn can no longer take input (final
    result produced / process ended); ``offer`` then returns False and the UI
    falls back to sending the message as the next turn.
    """

    def __init__(self) -> None:
        self.queue: asyncio.Queue[SteerMessage] = asyncio.Queue()
        self.open = True

    def offer(self, msg: SteerMessage) -> bool:
        if not self.open:
            return False
        self.queue.put_nowait(msg)
        return True

    def close(self) -> None:
        self.open = False
        while not self.queue.empty():  # nobody will deliver these now
            self.queue.get_nowait().resolve(False)


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
    attachments: list[Attachment] = field(default_factory=list)  # files sent with the latest user message
    mode: str = "agent"                   # agent (full autonomy) | plan (read-only, propose a plan)
    extra_dirs: list[str] = field(default_factory=list)  # additional folders the agent may use
    inbox: TurnInbox | None = None        # mid-turn steering (None => provider can't be steered)
    # Conversation context this engine hasn't seen (full handoff after a
    # provider switch, or a catch-up on turns another engine ran). Prepended
    # to the user's message.
    preamble: str = ""


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
