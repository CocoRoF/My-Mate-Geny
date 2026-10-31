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
    "tool.use",        # agent invoked a tool; data: {id, name, input, parent?}  (parent = the Agent/Task call it ran in)
    "tool.result",     # tool returned; data: {id, name, output, is_error, parent?, agent?}  (agent = subagent report + stats)
    "subagent.text",   # a subagent's prose (one complete block); data: {parent, text} — never part of the answer
    "subagent.thinking",  # a subagent's reasoning block; data: {parent, text}
    "turn.complete",   # terminal success; data: {text, model, usage, cost_usd, cost_kind, stop_reason, cli_session_id}
                       #   cost_usd = this turn's API-equivalent cost when cost_kind == "turn"
                       #   ("none": the engine reports no cost; unmarked = legacy, see services.turn_cost)
    "error",           # terminal failure; data: {code, message}  (code "turn.interrupted" = user pressed Stop)
    "notice",          # NON-terminal warning/info shown inline; data: {level, message, code}
    "session.info",    # CLI capabilities (tools, slash commands, skills, MCP servers…); not persisted as an event
    "user.steer",      # the user added instructions mid-turn; data: {text, attachments, client_msg_id}
    "task.update",     # background/long task state (Claude); data: {task_id, status, description, …}
    "usage.update",    # live plan utilization (Claude rate_limit_event); not persisted
    "engine.exit",     # internal: the persistent engine process ended
    "turn.changes",    # files the turn changed (git snapshots); data: {repos[], files, added, removed}
    "context.update",  # main-conversation context size (Claude); data: {tokens, window, threshold, auto_compact, source}
                       #   source "call" = after an API call (usage of that call), "cli" = the engine's own count
)

EventType = Literal[
    "session.start",
    "text.delta",
    "thinking.delta",
    "tool.use",
    "tool.result",
    "subagent.text",
    "subagent.thinking",
    "turn.complete",
    "error",
    "notice",
    "session.info",
    "user.steer",
    "task.update",
    "usage.update",
    "engine.exit",
    "turn.changes",
    "context.update",
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
    # The engine can't open files (Mate): contents go inline (see _attachments).
    inline_files: bool = False

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
    # Per-session uploads dir, always an additional working dir for Claude so
    # attachments never change the persistent engine's launch settings.
    uploads_dir: str | None = None
    # Claude: CLAUDE_CODE_AUTO_COMPACT_WINDOW (tokens); 0 = the CLI's default.
    auto_compact_window: int = 0
    # Claude: replace the default system prompt (Mate engines). None = the
    # CLI's own prompt + the harness's wait guide.
    system_prompt: str | None = None
    # ... or that prompt in a file (``--system-prompt-file``: no argv size
    # limit; Codex: ``model_instructions_file``). Likewise the MCP config as a
    # file: it may carry a token that must not show up in the process list.
    system_prompt_file: str | None = None
    mcp_config_file: str | None = None
    # Identity of the launch prompt for the engine fingerprint ("" = hash of
    # system_prompt). Lets parts of the prompt (e.g. memories the model wrote
    # itself) change without restarting the engine.
    prompt_key: str = ""
    # Claude: built-in tool set (``--tools``); None = default, [] = none.
    tools: list[str] | None = None
    # Claude: tools allowed without a prompt (``--allowedTools``).
    allowed_tools: list[str] = field(default_factory=list)
    # Claude: no skills / slash commands, no user/project settings files
    # (hooks, plugins) — a sealed engine (Mate). Codex: runs in its own
    # ``engine_home`` (below) with only the instructions + MCP servers given
    # here, and none of Codex's own tools (shell, apply_patch, web, images…).
    sealed: bool = False
    # Codex, sealed: a private CODEX_HOME the provider owns (its config, the
    # threads to resume; the account's auth.json linked in). Required when
    # sealed — the user's own ~/.codex config is never loaded.
    engine_home: str | None = None
    # Attachments as ids + inline contents instead of paths for the agent's
    # tools (an engine without file tools: Mate). The contents are filled in
    # beforehand (``_inline_files.prepare_inline``).
    inline_files: bool = False


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
