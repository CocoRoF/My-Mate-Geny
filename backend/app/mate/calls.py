"""Phone calls with a mate (docs/mate-calls.md).

* A call runs on the lightest model, never her usual one: Claude Haiku 5.5 (:data:`CALL_MODEL`), with no tools at all and a
  prompt of its own (``prompt.call_prompt``: who she is, how she talks, how she feels, her day, what she always knows, the
  chat lately, the call's rules). The lowest-latency path there is: an Anthropic API key (the Anthropic provider's pool, or
  the Claude provider's own key) streamed straight from the Messages API — thinking off, effort low, the prompt cached; else
  the Claude Code CLI kept warm as ONE long-lived stream-json process for the whole call (no tools, no MCP, nothing on disk).
* The voice is the page's: its speech recognition turns what the user says into text (sent over the call socket,
  ``/ws/mate-calls/{id}``), her reply streams back as text and the page speaks it sentence by sentence with her own voice
  (``/speech``). The server never holds audio. A barge-in (the user talks over her) stops the reply; the next message tells
  her what they actually heard.
* During a call she only talks: no tools exist, and anything else she would do on her own (delegation results, her own
  messages, screen comments) waits. When it ends the call is one entry in her conversation (a card: who called, how long,
  the transcript); her own engine then gets it as a turn of her own — the whole transcript and the call's rules: she takes
  it in, does what was asked with her usual tools, and writes only when there is something they need to hear (a result, a
  question); otherwise [SILENT] and the card is all that shows. She never recaps the call to them.
* She can call them too (:meth:`CallService.consider`): rarely, by day, not while they chat, only to the Android app when it
  is connected and lets her speak first there. A call they turn down or miss moves how she feels and keeps her from calling
  for a good while (a cooldown that doubles with every one in a row; picking up resets it).
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import secrets
import statistics
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from app.mate import files
from app.mate import memory as M
from app.mate import state as S
from app.mate.prompt import call_prompt, context_block
from app.mate.store import MateError
from app.providers.accounts import AccountUnavailable
from app.providers.base import TurnRequest
from app.services._ids import now_iso

CALL_MODEL = "claude-haiku-5-5"   # a call is always on the lightest model, never her usual one
CALL_CLIENT = 1                   # the call screen a page announces in its hello (``calls``)
RING_S = 30                       # she calls: unanswered this long → a missed call
DIAL_S = 45                       # they call: no call screen connected this long → given up
RESUME_S = 10                     # a dropped call socket may come back this long
MAX_CALL_S = 60 * 60              # an hour at most
MAX_REPLY_TOKENS = 400
MAX_TEXT = 2000                   # one utterance
MAX_TRANSCRIPT = 400              # lines kept
RECENT_MESSAGES = 16              # of the chat, for the call's prompt
# when she may call (the user's clock): by day only
CALL_HOURS = (10, 21)
CHATTING = timedelta(minutes=15)          # they wrote to her this recently: they are talking already
COOLDOWN = timedelta(hours=6)             # after a call of hers; doubles with each one in a row they didn't take
COOLDOWN_MAX = timedelta(days=7)
AFTER_ANY_CALL = timedelta(hours=3)       # after any call at all
ASKED_AFTER, NEWS_AFTER, STALE = timedelta(minutes=40), timedelta(minutes=20), timedelta(hours=8)
LONELY_FROM, LONELY_CHANCE = 0.55, 0.08   # missing them this much, she calls now and then (per scan, once a minute)
SCAN_S = 60
LINK_PING_S = 45                  # the phone app's background link hears something at least this often (under proxies' 60 s idle)
PHONES_KEY = "call_phones"        # what each phone app last said it lets her do (its device → {enabled, mate_id, at})

_TAG = re.compile(r"\[\s*[A-Za-z_]+(?:\s*:\s*[0-9.]+)?\s*\]")
_SPACE = re.compile(r"[ \t]+")


class CallError(MateError):
    def __init__(self, message: str, *, status: int = 400, code: str = "error") -> None:
        super().__init__(message, status=status)
        self.code = code


class EngineError(RuntimeError):
    pass


def spoken(text: str) -> str:
    """What of a reply is words (emotion tags and [SILENT] out)."""
    return _SPACE.sub(" ", _TAG.sub("", text or "").replace("[SILENT]", "")).strip()


def clip(text: str, n: int) -> str:
    t = " ".join(str(text or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def cooldown(in_a_row: int) -> timedelta:
    """How long she waits after a call of hers, by how many of hers in a row they didn't take."""
    return min(COOLDOWN * (2 ** max(0, in_a_row)), COOLDOWN_MAX)


def by_day(hour: int) -> bool:
    return CALL_HOURS[0] <= hour < CALL_HOURS[1]


def _t(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


#: why she called (``Call.reason``), as she remembers it
WHY = {"question": "you had asked them something and were still waiting for the answer",
       "work": "you had news for them from work you'd handed off",
       "lonely": "you missed them and wanted to hear their voice"}


def describe(card: dict[str, Any], tz: Any = timezone.utc, *, name: str = "You", lines: int = 40) -> str:
    """A call as she remembers it — who called whom and when, why (hers), how it went, what was said — from its card
    (``CallService.card``): for her chat's handoffs and catch-ups and a later call's prompt, so no call of hers, taken or
    not, is ever something she knows nothing about. ``name``: how her own lines are labelled."""
    mine = card.get("direction") == "incoming"
    at = _t(card.get("started_at"))
    when = f" at {at.astimezone(tz).strftime('%Y-%m-%d %H:%M')}" if at else ""
    head = f"You phoned them{when}" if mine else f"They phoned you{when}"
    if mine and card.get("reason") in WHY:
        about = clip(card.get("about") or "", 200)
        head += f" ({WHY[card['reason']]}" + (f": “{about}”" if about else "") + ")"
    status = card.get("status") or ""
    dur = int(card.get("duration_s") or 0)
    took = f"{dur // 60}:{dur % 60:02d}"
    outcome = {
        "talked": f"{'they' if mine else 'you'} picked up and you talked for {took}",
        "declined": "they turned the call down",
        "missed": "they didn't pick up (a missed call)",
        "cancelled": "the call was cut off before they picked up" if mine else "they hung up before you picked up",
        "failed": "the call didn't connect",
    }.get(status, status or "it ended")
    said = [x for x in card.get("transcript") or [] if x.get("text")]
    body = [f"{'User' if x.get('who') == 'user' else name}: {clip(x.get('text'), 600)}" + (" (cut off)" if x.get("cut") else "")
            for x in said[-lines:]]
    if status == "talked":
        if not any(x.get("who") == "user" for x in said):
            body.append({"network": "(The line dropped before they said anything.)",
                         "limit": "(It ran out of time.)"}.get(card.get("end_reason") or "",
                                                              "(They didn't say a word, and the call ended.)"))
        elif card.get("end_reason") == "network":
            body.append("(The line dropped at the end.)")
    return f"[Phone call — {head}; {outcome}.]" + ("\n" + "\n".join(body) if body else "")


# ---- the engines ----

Delta = Callable[[str], Awaitable[None]]


class ApiEngine:
    """Claude Haiku straight from the Messages API, streamed: thinking off, effort low, the system prompt cached. The
    conversation is kept here (append-only)."""

    kind = "anthropic"

    def __init__(self, key: str, system: str, *, model: str = CALL_MODEL, release: Callable[[], None] | None = None) -> None:
        self.key, self.system, self.model = key, system, model
        self.messages: list[dict[str, Any]] = []
        self.tool_attempts = 0
        self._release = release

    async def start(self) -> None:
        return None

    def request(self) -> dict[str, Any]:
        return {"model": self.model, "max_tokens": MAX_REPLY_TOKENS,
                "system": [{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral"}}],
                "messages": self.messages, "thinking": {"type": "disabled"}, "output_config": {"effort": "low"},
                "cache_control": {"type": "ephemeral"}}

    async def reply(self, prompt: str, on_delta: Delta) -> str:
        from app.harness.llm.anthropic_api import _client, _error

        self.messages.append({"role": "user", "content": prompt})
        text = ""
        try:
            async with _client(self.key).messages.stream(**self.request()) as stream:
                async for ev in stream:
                    if ev.type == "content_block_start" and getattr(ev.content_block, "type", "") == "tool_use":
                        self.tool_attempts += 1  # (it has no tools: nothing is ever run)
                        break
                    if ev.type == "content_block_delta" and getattr(ev.delta, "type", "") == "text_delta" and ev.delta.text:
                        text += ev.delta.text
                        await on_delta(ev.delta.text)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - the vendor's error, in words
            raise EngineError(str(_error(exc))) from exc
        finally:
            self.messages.append({"role": "assistant", "content": text or "…"})
        return text

    async def close(self) -> None:
        if self._release is not None:
            release, self._release = self._release, None
            release()


class CliEngine:
    """Claude Code on Claude Haiku as one long-lived stream-json process for the whole call: no built-in tools, no MCP
    servers, no session on disk, none of the user's settings. Each utterance is one message; a barge-in interrupts."""

    kind = "claude-code"

    def __init__(self, provider: Any, system_file: str, cwd: str, *, env: dict[str, str] | None = None,
                 api_key: str | None = None, model: str = CALL_MODEL, release: Callable[[], None] | None = None) -> None:
        self.provider, self.system_file, self.cwd, self.model = provider, system_file, cwd, model
        self.env, self.api_key = dict(env or {}), api_key
        self.engine: Any = None
        self.tool_attempts = 0
        self._open = False      # a turn of the process not finished (an interrupted one leaves its end behind)
        self._release = release

    def argv(self) -> list[str]:
        req = TurnRequest(messages=[], model=self.model, effort="low", cwd=self.cwd, system_prompt_file=self.system_file,
                          sealed=True, ephemeral=True, tools=[], allowed_tools=[], mcp_config={"mcpServers": {}},
                          api_key=self.api_key, mode="agent")
        return self.provider.engine_argv(req)

    async def start(self) -> None:
        from app.providers.claude_code import CLI_ENV
        from app.providers.claude_engine import ClaudeEngine

        env = {**CLI_ENV, **self.env}
        if self.api_key:
            env["ANTHROPIC_API_KEY"] = self.api_key
        self.engine = ClaudeEngine(binary=self.provider._binary, argv=self.argv(), cwd=self.cwd, env_extras=env,
                                   fingerprint="mate-call", model=self.model, mode="agent")
        await self.engine.start()

    async def _settle(self) -> None:
        """What an interrupted turn still sends goes before the next message."""
        e = self.engine
        end = time.monotonic() + 4
        while self._open and time.monotonic() < end:
            try:
                ev = await asyncio.wait_for(e.events.get(), timeout=max(0.05, end - time.monotonic()))
            except asyncio.TimeoutError:
                break
            if ev.type in ("turn.complete", "error", "engine.exit"):
                self._open = False
        self._open = False

    async def _interrupt(self) -> None:
        try:
            await asyncio.wait_for(self.engine.interrupt(), timeout=3)
        except Exception:  # noqa: BLE001 - a process that is gone has nothing to stop
            pass

    async def reply(self, prompt: str, on_delta: Delta) -> str:
        e = self.engine
        if e is None or not e.alive:
            raise EngineError("the call's engine has stopped")
        await self._settle()
        self._open = True
        await e.send_user(self.provider._envelope(prompt, []))
        text, streamed = "", False
        try:
            while True:
                ev = await asyncio.wait_for(e.events.get(), timeout=90)
                if ev.type == "text.delta":
                    t = str(ev.data.get("text") or "")
                    if t:
                        text += t
                        streamed = True
                        await on_delta(t)
                elif ev.type in ("tool.start", "tool.use"):
                    self.tool_attempts += 1  # (it has none; never run, the reply ends there)
                    await self._interrupt()
                    return text
                elif ev.type == "turn.complete":
                    self._open = False
                    final = str(ev.data.get("text") or "")
                    if not streamed and final:
                        text = final
                        await on_delta(final)
                    return text
                elif ev.type == "error":
                    self._open = False
                    raise EngineError(str(ev.data.get("message") or "the call's engine failed"))
                elif ev.type == "engine.exit":
                    self._open = False
                    raise EngineError("the call's engine stopped: " + (e.stderr_tail()[-300:] or "no output"))
        except asyncio.CancelledError:
            await self._interrupt()  # (a barge-in: the rest of it is not said)
            raise
        except asyncio.TimeoutError:
            await self._interrupt()
            raise EngineError("the call's engine didn't answer") from None

    async def close(self) -> None:
        if self.engine is not None:
            try:
                await self.engine.close(grace=0.5)
            except Exception:  # noqa: BLE001
                pass
        if self._release is not None:
            release, self._release = self._release, None
            release()


# ---- a call ----

@dataclass
class Call:
    id: str
    mate_id: str
    name: str
    session_id: str
    direction: str            # "outgoing": the user called her · "incoming": she called the user
    status: str               # ringing (she calls) · dialing (they call) · active · ended
    device: str = ""
    reason: str = ""          # why she called: question · work · lonely
    about: str = ""
    created_at: str = field(default_factory=now_iso)
    answered_at: str | None = None
    ended_at: str | None = None
    end_reason: str = ""
    error: str = ""
    engine: Any = None
    engine_kind: str = ""
    transcript: list[dict[str, Any]] = field(default_factory=list)
    replies: dict[str, dict[str, Any]] = field(default_factory=dict)
    metrics: list[dict[str, Any]] = field(default_factory=list)
    send: Callable[[dict[str, Any]], None] | None = None
    socket: str = ""
    cut_note: str | None = None
    restarted: bool = False
    tool_attempts: int = 0    # times the model reached for a tool it doesn't have (never run)
    local_models: list[str] = field(default_factory=list)  # her local voice models held on the GPU for this call
    tasks: set[asyncio.Task] = field(default_factory=set)
    timers: list[asyncio.TimerHandle] = field(default_factory=list)
    reply_task: asyncio.Task | None = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    answering: bool = False   # picked up on the phone's ringing; the app is coming up to take it

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "mate_id": self.mate_id, "name": self.name, "session_id": self.session_id,
                "direction": self.direction, "status": self.status, "device": self.device, "reason": self.reason,
                "created_at": self.created_at, "answered_at": self.answered_at, "ended_at": self.ended_at,
                "end_reason": self.end_reason, "error": self.error, "model": CALL_MODEL, "engine": self.engine_kind}

    def said(self, who: str) -> list[str]:
        return [x["text"] for x in self.transcript if x["who"] == who and x["text"]]


@dataclass
class Link:
    """The Android app's background link (``GET /api/mate-calls/link``, its foreground service): her ringing reaches the
    phone with the app closed, the way a call would."""
    id: str
    device: str
    send: Callable[[dict[str, Any]], None]
    connected_at: float


class CallService:
    def __init__(self, mates: Any, *, clock: Callable[[], float] = time.time,
                 rng: Callable[[], float] = random.random) -> None:
        self.mates = mates
        self.svc = mates._svc
        self.store = mates.store
        self.broker = mates.capture
        self.clock, self.rng = clock, rng
        self.calls: dict[str, Call] = {}
        self.links: dict[str, Link] = {}
        self.voice: Any = None  # the app's VoiceService (her local voice models are warmed for a call: app/main.py)
        self.task: asyncio.Task | None = None
        self._followups: set[asyncio.Task] = set()
        db = self.store._db
        db.execute("CREATE TABLE IF NOT EXISTS mate_calls(id TEXT PRIMARY KEY, mate_id TEXT NOT NULL, session_id TEXT, "
                   "direction TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', device TEXT NOT NULL "
                   "DEFAULT '', created_at TEXT NOT NULL, answered_at TEXT, ended_at TEXT, end_reason TEXT NOT NULL DEFAULT "
                   "'', engine TEXT NOT NULL DEFAULT '', transcript TEXT NOT NULL DEFAULT '[]', metrics TEXT NOT NULL "
                   "DEFAULT '{}', noted INTEGER NOT NULL DEFAULT 0)")
        db.execute("CREATE INDEX IF NOT EXISTS mate_calls_by_mate ON mate_calls(mate_id, created_at)")
        # (a call that was on when the server stopped: it ended then)
        db.execute("UPDATE mate_calls SET status='ended', end_reason='restart', ended_at=COALESCE(ended_at, ?) "
                   "WHERE status IN ('ringing','dialing','active')", (now_iso(),))
        self.phones = self._load_phones()
        mates.calls = self
        self.svc.call_note = lambda card: describe(card, self.store.tz())  # (her chat's handoffs and catch-ups)

    # ---- what is on ----

    def active(self) -> Call | None:
        return next((c for c in self.calls.values() if c.status != "ended"), None)

    def in_call(self, mate_id: str) -> bool:
        c = self.active()
        return c is not None and c.mate_id == mate_id

    def get(self, cid: str) -> Call:
        c = self.calls.get(cid)
        if c is None or c.status == "ended":
            raise CallError("no such call (it has ended)", status=404, code="gone")
        return c

    def plan(self, mate: dict[str, Any], voice: Any) -> dict[str, Any]:
        """How the page should listen and speak on a call with her: ``stt.mode`` realtime (ElevenLabs, her engine) · record
        (a server engine: the page cuts utterances itself and sends each) · browser (the page's own recognition; ``fallback``:
        a server engine for a recording when the page has none) — and her TTS engine."""
        stt = (mate.get("voice") or {}).get("stt") or {}
        engine = stt.get("engine") or "browser"
        providers = voice.providers
        fallback = voice.stt_fallback()
        if engine == "elevenlabs" and providers.configured("elevenlabs"):
            listen = {"mode": "realtime", "engine": "elevenlabs", "fallback": fallback}
        elif engine in ("openai", "whisper", "google", "elevenlabs", "local") and providers.configured(engine, "stt"):
            listen = {"mode": "record", "engine": engine, "fallback": fallback}
        else:
            listen = {"mode": "browser", "engine": "browser", "fallback": fallback}
        tts = ((mate.get("voice") or {}).get("tts") or {}).get("engine") or "browser"
        return {"stt": listen, "tts": {"engine": tts}, "model": CALL_MODEL}

    # ---- her local voice on a call (app/voicehost) ----

    def _hold_local(self, call: Call, mate: dict[str, Any]) -> None:
        """She speaks or hears with this server's own GPU: those models go on the GPU while it rings — her first words
        don't wait for a model to load — and stay there until the call ends (pinned: never idled out or moved out)."""
        host = getattr(self.voice, "local", None) if self.voice is not None else None
        if host is None or not host.ready():
            return
        v = mate.get("voice") or {}
        held = []
        if (v.get("tts") or {}).get("engine") == "local":
            held.append(host.model_for("tts", str(v["tts"].get("model") or "")))
        if (v.get("stt") or {}).get("engine") == "local":
            held.append(host.model_for("stt", str(v["stt"].get("model") or "")))
        held = [m for m in dict.fromkeys(held) if m]
        for m in held:
            host.pin(m)
            self._spawn(call, host.prewarm(m))
        call.local_models = held

    def _release_local(self, call: Call) -> None:
        host = getattr(self.voice, "local", None) if self.voice is not None else None
        for m in getattr(call, "local_models", []) or []:
            if host is not None:
                host.unpin(m)
        call.local_models = []

    # ---- the user calls her ----

    async def dial(self, mate_id: str, device: str = "") -> Call:
        if self.active() is not None:
            raise CallError("a call is already on", status=409, code="busy")
        mate = self.store.get(mate_id)
        if mate.get("draft"):
            raise CallError("this mate is still being made in the studio", status=409)
        sid = self.mates.conversation(mate_id)["session_id"]
        call = Call(id="call_" + secrets.token_hex(8), mate_id=mate_id, name=mate["name"], session_id=sid,
                    direction="outgoing", status="dialing", device=str(device or "")[:80], created_at=self._now_iso())
        self._open(call)
        self._hold_local(call, mate)
        self._later(call, DIAL_S, lambda: self._spawn(call, self.end(call, "failed", error="the call screen never connected"))
                    if call.send is None and call.status == "dialing" else None)
        self._spawn(call, self._prepare(call))
        return call

    # ---- she calls them ----

    async def ring(self, mate_id: str, device: str, reason: str, about: str = "") -> Call:
        if self.active() is not None:
            raise CallError("a call is already on", status=409, code="busy")
        mate = self.store.get(mate_id)
        sid = self.mates.conversation(mate_id)["session_id"]
        call = Call(id="call_" + secrets.token_hex(8), mate_id=mate_id, name=mate["name"], session_id=sid,
                    direction="incoming", status="ringing", device=device, reason=reason, about=about,
                    created_at=self._now_iso())
        self._open(call)
        self._hold_local(call, mate)
        ring = {"type": "call.ring", "data": call.public()}
        for c in self.broker.clients():
            if c.device == device:
                self._tell(c, ring)
        for lk in list(self.links.values()):
            if lk.device == device:
                self._tell(lk, ring)  # (the app's ringing with the page itself gone: the phone rings like a call)
        self._later(call, RING_S, lambda: self._spawn(call, self.end(call, "missed"))
                    if call.status == "ringing" and not call.answering else None)
        self._spawn(call, self._prepare(call))  # (warm: her hello is ready the moment they pick up)
        self.mates._log("info", f"“{mate['name']}” is calling ({reason})", code="mate.call_ring",
                        detail={"call": call.id, "reason": reason, "device": device})
        return call

    async def accept(self, cid: str, device: str = "") -> Call:
        call = self.get(cid)
        if call.status != "ringing":
            raise CallError("this call isn't ringing", status=409, code="state")
        call.status = "active"
        call.answered_at = self._now_iso()
        call.device = str(device or call.device)[:80]
        self._save(call)
        self._announce(call)
        self._later(call, DIAL_S, lambda: self._spawn(call, self.end(call, "network")) if call.send is None else None)
        return call

    async def answering(self, cid: str) -> Call:
        """They picked up on the phone's ringing (the notification) and the app is coming up to take the call: it doesn't
        go missed meanwhile — the ring holds another :data:`RING_S` for the page to accept."""
        call = self.get(cid)
        if call.status != "ringing":
            raise CallError("this call isn't ringing", status=409, code="state")
        if not call.answering:
            call.answering = True
            self._later(call, RING_S, lambda: self._spawn(call, self.end(call, "missed")) if call.status == "ringing" else None)
        return call

    async def decline(self, cid: str) -> Call:
        call = self.get(cid)
        if call.status != "ringing":
            raise CallError("this call isn't ringing", status=409, code="state")
        await self.end(call, "declined")
        return call

    async def hangup(self, cid: str) -> Call:
        call = self.get(cid)
        await self.end(call, "hangup")
        return call

    # ---- the line (/ws/mate-calls/{id}) ----

    def attach(self, call: Call, send: Callable[[dict[str, Any]], None]) -> str:
        """The call screen connected (or came back): what it missed of the reply being said comes again."""
        sock = secrets.token_hex(6)
        call.send, call.socket = send, sock
        send({"type": "state", "call": call.public()})
        for r in call.replies.values():
            if not r.get("delivered") and not r.get("cut"):
                send({"type": "reply", "rid": r["rid"], "greeting": r.get("greeting", False)})
                if r["text"]:
                    send({"type": "delta", "rid": r["rid"], "text": r["text"]})
                if r["done"]:
                    send({"type": "done", "rid": r["rid"], "text": r["text"], "ttft_ms": r.get("ttft")})
                    r["delivered"] = True
        return sock

    def detach(self, call: Call, sock: str) -> None:
        """The call screen's socket went: it may come back for a moment, else the call ends (network)."""
        if call.socket != sock or call.status == "ended":
            return
        call.send, call.socket = None, ""
        self._later(call, RESUME_S, lambda: self._spawn(call, self.end(call, "network"))
                    if call.send is None and call.status != "ended" else None)

    async def receive(self, call: Call, msg: dict[str, Any]) -> None:
        """One message from the call screen. What they say and talk over goes in order, on the side (the line keeps
        listening: a hang-up is never stuck behind a reply)."""
        kind = msg.get("type")
        if kind == "say":
            self._spawn(call, self._in_order(call, self._say(call, str(msg.get("text") or ""))))
        elif kind == "barge":
            self._spawn(call, self._in_order(call, self._barge(call, str(msg.get("rid") or ""), str(msg.get("heard") or ""))))
        elif kind == "metric":
            m = {k: msg[k] for k in ("rid", "first_audio_ms", "stt_ms", "stt") if k in msg}
            r = call.replies.get(str(m.get("rid") or ""))
            if r is not None:
                m["ttft_ms"] = r.get("ttft")
            if isinstance(m.get("first_audio_ms"), (int, float)) and 0 <= m["first_audio_ms"] < 60000:
                call.metrics = [*call.metrics, m][-200:]
        elif kind == "hangup":
            await self.end(call, "hangup")
        elif kind == "ping":
            self._send(call, {"type": "pong"})

    @staticmethod
    async def _in_order(call: Call, coro: Awaitable[Any]) -> None:
        async with call.lock:
            await coro

    async def settle(self, call: Call) -> None:
        """(tests) until what the screen sent so far is handled."""
        for _ in range(100):
            pending = [t for t in call.tasks if not t.done() and t is not call.reply_task and t is not asyncio.current_task()]
            if not pending:
                return
            await asyncio.wait(pending, timeout=2)

    # ---- talking ----

    def _system(self, call: Call) -> str:
        """Her prompt for this call, as things are the moment it starts."""
        m = self.mates
        mate = self.store.get(call.mate_id)
        prefs = mate.get("prefs") or {}
        now = datetime.now(timezone.utc)
        tz = self.store.tz()
        local = now.astimezone(tz).replace(tzinfo=None)
        memories = self.store.memories(call.mate_id)
        core = M.core(memories)
        recent = self.recent(call.session_id)
        query = " ".join(recent[-6:])
        core_ids = {x["id"] for x in core}
        level = (prefs.get("memory") or {}).get("recall") or "normal"
        recalled = M.recall([x for x in memories if x["id"] not in core_ids], query, now_utc=now, now_local=local,
                            level=level) if level != "off" else []
        rel = m._advanced(call.mate_id, now, tz)
        relation = bool(rel and rel["enabled"])
        summary = m._state_event(call.mate_id, None)
        life = ""
        try:
            now_life = self.store.life_now(call.mate_id, mate.get("builtin"), prefs)
            if now_life:
                from app.mate.life import sim

                lang = (mate.get("persona") or {}).get("language") or "ko"
                life = sim.line(now_life[0], now_life[1], now, tz, woke=False, lang=lang)
        except Exception:  # noqa: BLE001 - her day is colour, never a reason a call can't start
            life = ""
        ctx = context_block(local, m._tz_name(tz, now), recalled=recalled,
                            relation=m._relation_lines(rel, {}, now, tz, 1), outfit=self.store.worn_outfit(call.mate_id),
                            feeling=S.line(summary), life=life)
        return call_prompt(mate["name"], mate.get("persona") or {}, prefs, core, relation=relation,
                           stage=rel["stage"] if relation else None, context=ctx, recent=recent)

    def recent(self, sid: str) -> list[str]:
        """The chat lately, as she knows it: what was written after the last clear, nothing the user deleted, no internal
        prompts; a call as what was said on it."""
        sess = self.svc.get(sid)
        floor = sess.get("context_floor") or ""
        out: list[str] = []
        for msg in self.svc.messages(sid):
            meta = msg.get("meta") or {}
            if msg["created_at"] <= floor or meta.get("hidden") or meta.get("speech_pending") or meta.get("refused"):
                continue
            if meta.get("kind") == "call" and isinstance(meta.get("call"), dict):
                out.append(describe(meta["call"], self.store.tz(), lines=8))  # (taken or not: she knows it happened)
                continue
            if meta.get("internal"):
                continue
            text = spoken(msg["content"]) if msg["role"] == "assistant" else msg["content"]
            if msg["role"] in ("user", "steer") and text.strip():
                out.append(f"User: {clip(text, 400)}")
            elif msg["role"] == "assistant" and text.strip():
                out.append(f"You: {clip(text, 400)}")
        return out[-RECENT_MESSAGES:]

    async def make_engine(self, call: Call, system: str) -> Any:
        """The fastest way to Claude Haiku there is: an Anthropic API key (the Anthropic provider's pool, the Claude
        provider's key, a pooled Claude key), else the Claude Code CLI kept warm for the call."""
        from app.services import session_service as ss

        pool = self.svc._pool
        if pool is not None:
            try:
                lease = await asyncio.to_thread(pool.select, "anthropic", begin_turn=True)
            except (AccountUnavailable, KeyError, ValueError):
                lease = None
            if lease is not None and lease.api_key:
                return ApiEngine(lease.api_key, system, release=lambda: (pool.end_turn(lease), pool.release(lease)))
            if lease is not None:
                pool.end_turn(lease)
                pool.release(lease)
        key = self.svc._providers.resolved_api_key("claude")
        if key:
            return ApiEngine(key, system)
        lease, env = None, {}
        if pool is not None:
            try:
                lease = await asyncio.to_thread(pool.select, "claude", begin_turn=True)
            except AccountUnavailable as exc:
                raise CallError(str(exc), status=503, code="unavailable") from None
        release = None
        if lease is not None:
            if lease.auth_mode == "api_key" and lease.api_key:
                return ApiEngine(lease.api_key, system, release=lambda: (pool.end_turn(lease), pool.release(lease)))
            if not lease.is_primary:
                from app.providers.accounts import link_shared_state

                await asyncio.to_thread(link_shared_state, "claude", lease.account_id)
                env["CLAUDE_CONFIG_DIR"] = lease.config_dir
            release = lambda: (pool.end_turn(lease), pool.release(lease))  # noqa: E731
        root = files.mate_dir(call.mate_id) / "call"
        root.mkdir(parents=True, exist_ok=True)
        prompt_file = files.engine_file(call.mate_id, "call", "md", system)
        return CliEngine(ss.get_provider("claude"), prompt_file, str(root), env=env, release=release)

    async def _prepare(self, call: Call) -> None:
        """Her engine (warm), then her first words: she answers the phone (they called) or says why she called."""
        try:
            system = await asyncio.to_thread(self._system, call)
            engine = await self.make_engine(call, system)
            if call.status == "ended":
                await engine.close()
                return
            call.engine, call.engine_kind = engine, engine.kind
            await engine.start()
        except Exception as exc:  # noqa: BLE001 - no engine: the call can't go through
            await self.end(call, "failed", error=str(exc)[:300])
            return
        finally:
            call.ready.set()
        if call.status == "ended":
            return
        self._save(call)
        if call.direction == "outgoing":
            hello = ("[The phone rings: it's them calling you, and you pick up. Answer the way you would, in a few words — "
                     "you know who it is.]")
        else:
            why = {"question": "you asked them something and are still waiting for an answer",
                   "work": "the work you passed on to a chat has news for them",
                   "lonely": "you missed them and wanted to hear their voice — nothing urgent"}.get(call.reason, "you wanted to talk")
            hello = f"[They picked up your call. You called them because {why}"
            hello += (f": “{clip(call.about, 300)}”" if call.about else "") + ". Say hello and why you called, in a few words.]"
        await self._start_reply(call, hello, greeting=True)

    async def _start_reply(self, call: Call, prompt: str, *, greeting: bool = False) -> None:
        rid = "r" + secrets.token_hex(4)
        task = asyncio.create_task(self._reply(call, prompt, rid, greeting=greeting))
        call.reply_task = task
        call.tasks.add(task)
        task.add_done_callback(call.tasks.discard)

    async def _reply(self, call: Call, prompt: str, rid: str, *, greeting: bool = False) -> None:
        r = {"rid": rid, "text": "", "done": False, "t0": time.monotonic(), "ttft": None, "greeting": greeting,
             "delivered": False}
        call.replies[rid] = r
        while len(call.replies) > 40:
            call.replies.pop(next(iter(call.replies)))
        self._send(call, {"type": "reply", "rid": rid, "greeting": greeting})

        async def delta(t: str) -> None:
            if r["ttft"] is None:
                r["ttft"] = round((time.monotonic() - r["t0"]) * 1000)
                if call.direction == "outgoing" and call.status == "dialing":
                    call.status, call.answered_at = "active", self._now_iso()  # (she picked up)
                    self._save(call)
                    self._announce(call)
            r["text"] += t
            self._send(call, {"type": "delta", "rid": rid, "text": t})

        try:
            text = await call.engine.reply(prompt, delta)
        except asyncio.CancelledError:
            r["done"] = r["cut"] = True
            raise
        except EngineError as exc:
            r["done"] = True
            if call.status == "ended":
                return
            if not call.restarted:  # once: a fresh engine that knows the call so far
                call.restarted = True
                self.mates._log("warning", f"call engine failed, restarting: {exc}", code="mate.call_engine")
                if await self._restart(call):
                    await self._reply(call, prompt, rid + "b", greeting=greeting)
                    return
            await self.end(call, "failed", error=str(exc)[:300])
            return
        r["done"] = True
        words = spoken(text)
        if words and not any(x.get("rid") == rid for x in call.transcript):
            self._line(call, "mate", words, rid=rid)
        self._send(call, {"type": "done", "rid": rid, "text": text, "ttft_ms": r["ttft"]})
        if call.send is not None:
            r["delivered"] = True
        if call.direction == "outgoing" and call.status == "dialing":
            call.status, call.answered_at = "active", self._now_iso()
            self._save(call)
            self._announce(call)

    async def _restart(self, call: Call) -> bool:
        old = call.engine
        try:
            if old is not None:
                await old.close()
            so_far = "\n".join(f"{'User' if x['who'] == 'user' else 'You'}: {x['text']}" for x in call.transcript[-30:])
            system = await asyncio.to_thread(self._system, call)
            if so_far:
                system += "\n\n## This call so far (the line dropped for a moment; go on from here)\n" + so_far
            call.engine = await self.make_engine(call, system)
            call.engine_kind = call.engine.kind
            await call.engine.start()
            return True
        except Exception as exc:  # noqa: BLE001
            self.mates._log("warning", f"call engine restart failed: {exc}", code="mate.call_engine")
            return False

    def _line(self, call: Call, who: str, text: str, **extra: Any) -> None:
        call.transcript.append({"who": who, "text": clip(text, MAX_TEXT), "at": now_iso(), **extra})
        if len(call.transcript) > MAX_TRANSCRIPT:
            del call.transcript[: len(call.transcript) - MAX_TRANSCRIPT]

    async def _stop_reply(self, call: Call) -> dict[str, Any] | None:
        """Her reply being made, stopped (they talk): -> it, or None when none was on."""
        task = call.reply_task
        if task is None or task.done():
            return None
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        return next((r for r in reversed(list(call.replies.values())) if r.get("cut")), None)

    async def _barge(self, call: Call, rid: str, heard: str) -> None:
        """They talked over her: she stops; what they heard of it is what she said."""
        await self._stop_reply(call)
        r = call.replies.get(rid)
        heard = spoken(heard)
        if r is None:
            return
        full = spoken(r["text"])
        said = heard if heard else ""
        cut = bool(full) and said != full
        line = next((x for x in call.transcript if x.get("rid") == rid), None)
        text = (said + "…") if cut and said else said
        if line is not None:
            if text:
                line["text"], line["cut"] = text, cut
            else:
                call.transcript.remove(line)
        elif text:
            self._line(call, "mate", text, rid=rid, cut=cut)
        if cut:
            call.cut_note = said

    async def _say(self, call: Call, text: str) -> None:
        text = clip(text, MAX_TEXT)
        if not text or call.status != "active":
            return
        await call.ready.wait()
        if call.engine is None or call.status != "active":
            return
        cut = await self._stop_reply(call)
        if cut is not None and not any(x.get("rid") == cut["rid"] for x in call.transcript) and spoken(cut["text"]):
            # (talked over before the page said what it heard: what was made of it so far)
            self._line(call, "mate", spoken(cut["text"]) + "…", rid=cut["rid"], cut=True)
            call.cut_note = call.cut_note if call.cut_note is not None else spoken(cut["text"])
        self._line(call, "user", text)
        prompt = text
        if call.cut_note is not None:
            note = clip(call.cut_note, 300)
            prompt = (f"[They talked over you; of what you were saying they heard only: “{note}”]\n{text}" if note
                      else f"[They talked over you before you said anything.]\n{text}")
            call.cut_note = None
        await self._start_reply(call, prompt)

    # ---- the end ----

    async def end(self, call: Call, reason: str, *, error: str = "") -> None:
        if call.status == "ended":
            return
        was = call.status
        call.status, call.end_reason, call.ended_at = "ended", reason, self._now_iso()
        self._release_local(call)
        if error:
            call.error = error
        for t in call.timers:
            t.cancel()
        call.timers.clear()
        me = asyncio.current_task()
        for t in list(call.tasks):
            if t is not me:
                t.cancel()
        engine, call.engine = call.engine, None
        if engine is not None:
            call.tool_attempts += int(getattr(engine, "tool_attempts", 0) or 0)
            try:
                await asyncio.wait_for(engine.close(), timeout=6)
            except Exception:  # noqa: BLE001
                pass
        self._send(call, {"type": "ended", "reason": reason, "call": call.public()})
        self._announce(call)
        self.calls.pop(call.id, None)
        try:
            self._record(call, was)
        except Exception as exc:  # noqa: BLE001 - the call is over whatever the record does
            self.mates._log("warning", f"call record: {exc}", code="mate.call_record")

    def outcome(self, call: Call, was: str) -> str:
        """talked · declined · missed · cancelled · failed"""
        if call.answered_at and (call.transcript or was == "active"):
            return "talked"
        if was == "ringing":
            return "declined" if call.end_reason == "declined" else "missed" if call.end_reason == "missed" else "cancelled"
        if call.end_reason == "failed":
            return "failed"
        return "cancelled"

    def card(self, call: Call, status: str) -> dict[str, Any]:
        begun, ended = _t(call.answered_at), _t(call.ended_at)
        lat = [m["first_audio_ms"] for m in call.metrics if isinstance(m.get("first_audio_ms"), (int, float))]
        ttft = [r["ttft"] for r in call.replies.values() if isinstance(r.get("ttft"), (int, float))]
        latency = {"n": len(lat), "first_audio_ms": round(statistics.median(lat)) if lat else None,
                   "ttft_ms": round(statistics.median(ttft)) if ttft else None}
        return {"id": call.id, "direction": call.direction, "status": status, "reason": call.reason,
                "about": clip(call.about, 300), "started_at": call.created_at, "answered_at": call.answered_at, "ended_at": call.ended_at,
                "end_reason": call.end_reason, "duration_s": round((ended - begun).total_seconds()) if begun and ended else 0,
                # (a call nobody picked up has nothing said on it: her hello, made while it rang, was never heard)
                "transcript": [{k: x[k] for k in ("who", "text", "at", "cut") if k in x} for x in call.transcript]
                if status == "talked" else [],
                "latency": latency, "engine": call.engine_kind, "model": CALL_MODEL,
                **({"error": call.error} if call.error and status == "failed" else {})}

    def _record(self, call: Call, was: str) -> None:
        status = self.outcome(call, was)
        card = self.card(call, status)
        db = self.store._db
        db.execute("UPDATE mate_calls SET status=?, answered_at=?, ended_at=?, end_reason=?, engine=?, transcript=?, metrics=? "
                   "WHERE id=?", (status, call.answered_at, call.ended_at, call.end_reason, call.engine_kind,
                                  json.dumps(card["transcript"], ensure_ascii=False), json.dumps(card["latency"]), call.id))
        self.mates._log("info", f"call with “{call.name}” ({call.direction}) {status}: {card['duration_s']} s, "
                        f"{len(call.transcript)} lines, engine {call.engine_kind or '-'} ({CALL_MODEL}), first audio "
                        f"{card['latency']['first_audio_ms'] or '-'} ms, first token {card['latency']['ttft_ms'] or '-'} ms",
                        code="mate.call", detail={"call": call.id, "status": status, "latency": card["latency"],
                                                  "tools_refused": call.tool_attempts})
        if status == "talked":
            self.mates._state_event(call.mate_id, lambda doc, who, at, tz: S.call_talked(doc, who, at, tz))
        elif call.direction == "incoming" and status in ("declined", "missed"):
            n = self.unanswered_in_a_row(call.mate_id)
            self.mates._state_event(call.mate_id, lambda doc, who, at, tz: S.call_unanswered(doc, who, status == "declined",
                                                                                              n, at, tz))
        said = call.said("user")
        if status == "talked":
            # (picked up, even without a word from them: a call happened between them — hers to take in, like any)
            task = asyncio.create_task(self._follow_up(call, card, said))
            self._followups.add(task)
            task.add_done_callback(self._followups.discard)
            return
        meta = {"internal": True, "kind": "call", "call": card}
        try:
            mid = self.svc._add_message(call.session_id, "user", "", meta=meta)
            self.svc._publish(call.session_id, {"type": "user.message", "data": {"message_id": mid, "text": "", **meta}})
        except KeyError:
            return
        # (what waited for the call — a chat's result — comes now; after a talk, once her note on it is done)
        asyncio.get_running_loop().call_soon(self.mates._flush, call.session_id)

    async def _follow_up(self, call: Call, card: dict[str, Any], said: list[str]) -> None:
        """Her own engine gets the call as a turn (its card is the message): a short note on what they talked about and
        agreed, then what was asked, with her usual tools. Waits for a turn she is in the middle of."""
        from app.services.session_service import TurnBusyError

        meta = {"kind": "call", "call": card}
        deadline = time.monotonic() + 15 * 60
        while True:
            try:
                self.svc.start_turn(call.session_id, "\n".join(said), client_msg_id=f"call~{call.device}" if call.device else None,
                                    meta=meta)
                return
            except TurnBusyError:
                if time.monotonic() > deadline:
                    break
                await asyncio.sleep(1.0)
            except KeyError:
                return
        mid = self.svc._add_message(call.session_id, "user", "\n".join(said), meta=meta)
        self.svc._publish(call.session_id, {"type": "user.message", "data": {"message_id": mid, "text": "\n".join(said), **meta}})

    def follow_up_prompt(self, mate_name: str, card: dict[str, Any]) -> str:
        """What her engine reads for the call's turn (the stored message is only what the user said on it)."""
        dur = int(card.get("duration_s") or 0)
        theirs = card.get("direction") == "outgoing"
        record = describe(card, self.store.tz(), name=mate_name, lines=MAX_TRANSCRIPT)
        silent = not any(x.get("who") == "user" and x.get("text") for x in card.get("transcript") or [])
        if silent:
            rules = ("They picked up but never said a word before it ended — busy, somewhere they couldn't talk, or a tap by "
                     "mistake; you can't know which. You may send one short message the way you would after a call like that "
                     "(what you called about, if it still matters, or just that it's fine) — or nothing, if that fits better: "
                     "then reply with EXACTLY [SILENT].")
        else:
            rules = ("On the call you could only talk, so nothing they asked for has been done yet — if they asked you to do "
                     "something (hand work to a chat, remember something, change your style…) and you said you would, do it now "
                     "with your tools, exactly as you would for a message. Write to them only if there is something they need to hear: what "
                     "came of what you did, a question you must ask, or something that matters you didn't get to say on the "
                     "call — briefly, in your own voice, like a message. Never recap or summarize the call for them: they were "
                     "there. Otherwise — nothing was asked, or it's done and there's nothing to tell — reply with EXACTLY "
                     "[SILENT].")
        return (f"<phone_call caller=\"{'user' if theirs else 'you'}\" duration=\"{dur // 60}:{dur % 60:02d}\">\n{record}\n"
                "</phone_call>\n"
                f"[That was a phone call between you and the user that just ended ({'they' if theirs else 'you'} called). It is "
                "in the chat now as one call entry, and you remember it — that it happened, who called and why. This turn is "
                f"for you, not a message to them: take in what was said. {rules}]")

    # ---- what she is told later ----

    def notes(self, mate_id: str) -> tuple[list[str], Callable[[], None]]:
        """Her calls they didn't take since she was last told: lines for her <context>, and how to mark them told."""
        rows = self.store._db.query("SELECT id, status, created_at FROM mate_calls WHERE mate_id=? AND direction='incoming' "
                                    "AND status IN ('declined','missed') AND noted=0 ORDER BY created_at", (mate_id,))
        if not rows:
            return [], lambda: None
        tz = self.store.tz()
        out = []
        for r in rows[-3:]:
            at = _t(r["created_at"])
            when = at.astimezone(tz).strftime("%H:%M") if at else "earlier"
            out.append(f"At {when} you phoned them and they " + ("turned the call down." if r["status"] == "declined"
                                                                   else "didn't pick up (a missed call)."))
        out.append("You may mention it once if it fits, the way you would; don't guilt-trip them.")
        ids = [r["id"] for r in rows]

        def told() -> None:
            self.store._db.execute(f"UPDATE mate_calls SET noted=1 WHERE id IN ({','.join('?' * len(ids))})", tuple(ids))

        return out, told

    def unanswered_in_a_row(self, mate_id: str) -> int:
        n = 0
        for r in self.store._db.query("SELECT status FROM mate_calls WHERE mate_id=? AND direction='incoming' AND status "
                                      "NOT IN ('ringing','dialing','active') ORDER BY created_at DESC LIMIT 20", (mate_id,)):
            if r["status"] in ("declined", "missed"):
                n += 1
            elif r["status"] == "talked":
                break
        return n

    # ---- whether she calls them now ----

    @staticmethod
    def _hers(pol: dict[str, Any], mate: dict[str, Any]) -> bool:
        """a phone's policy lets this mate speak first (set to her, or to nobody and she is the default)"""
        if pol.get("enabled") is not True:
            return False
        chosen = pol.get("mate_id") or ""
        return chosen == mate["id"] or (not chosen and bool(mate.get("is_default")))

    def phone(self, mate: dict[str, Any]) -> str | None:
        """The Android app she may call: one whose page is open (in front or in the background) and lets her speak first
        there, the most recently used; else one whose background link is up (the app closed, its service running), as its
        page last said — the most recently seen."""
        best = None
        for c in self.broker.clients():
            if c.native != "android" or c.calls < CALL_CLIENT or not c.device or not self._hers(c.screen_policy or {}, mate):
                continue
            if best is None or c.active_at > best.active_at:
                best = c
        if best is not None:
            return best.device
        linked = {lk.device for lk in self.links.values()}
        able = [(str(self.phones[d].get("at") or ""), d) for d in linked if d in self.phones and self._hers(self.phones[d], mate)]
        return max(able)[1] if able else None

    # ---- the phone app's background link ----

    def _load_phones(self) -> dict[str, dict[str, Any]]:
        try:
            doc = json.loads(self.store._setting(PHONES_KEY) or "{}")
        except ValueError:
            doc = {}
        return {str(k): v for k, v in doc.items() if isinstance(v, dict)} if isinstance(doc, dict) else {}

    def saw(self, client: Any) -> None:
        """A phone app's page said who it is (``/ws/sessions`` hello): whether it lets her speak first, and to whom, is
        kept for its device — so once the page is gone (the app closed) its background link still knows."""
        if getattr(client, "native", "") != "android" or not client.device or client.calls < CALL_CLIENT:
            return
        pol = client.screen_policy or {}
        want = {"enabled": pol.get("enabled") is True, "mate_id": str(pol.get("mate_id") or "")}
        have = self.phones.get(client.device) or {}
        stale = (_t(have.get("at")) or datetime.min.replace(tzinfo=timezone.utc)) < datetime.now(timezone.utc) - timedelta(hours=1)
        if {k: have.get(k) for k in want} == want and not stale:
            return
        self.phones[client.device] = {**want, "at": self._now_iso()}
        if len(self.phones) > 20:  # (the newest twenty phones)
            self.phones = dict(sorted(self.phones.items(), key=lambda kv: str(kv[1].get("at") or ""))[-20:])
        self.store._put_setting(PHONES_KEY, json.dumps(self.phones))
        if {k: have.get(k) for k in want} != want:
            for lk in list(self.links.values()):
                if lk.device == client.device:
                    self._tell(lk, {"type": "policy", **self.reach(lk.device)})

    def reach(self, device: str) -> dict[str, Any]:
        """What a phone's link is for right now: whether she may call it, and who she is (the app says so in its
        notification)."""
        pol = self.phones.get(device) or {}
        if pol.get("enabled") is not True:
            return {"calls": False, "mate": ""}
        name = ""
        try:
            mid = pol.get("mate_id") or ""
            mate = self.store.get(mid) if mid else next((m for m in self.store.list() if m.get("is_default")), None)
            name = (mate or {}).get("name") or ""
        except Exception:  # noqa: BLE001 - a mate gone or a store hiccup: the line still holds
            name = ""
        return {"calls": True, "mate": name}

    def link(self, device: str, send: Callable[[dict[str, Any]], None]) -> Link:
        """The phone app's service connected: it hears her ringing for its device (a ring already on comes at once) and
        where every call stands."""
        lk = Link(id=secrets.token_hex(6), device=str(device)[:80], send=send, connected_at=time.monotonic())
        self.links[lk.id] = lk
        ringing = next((c for c in self.calls.values() if c.status == "ringing" and c.device == lk.device), None)
        self._tell(lk, {"type": "hello", **self.reach(lk.device), "ring": ringing.public() if ringing else None})
        return lk

    def unlink(self, lid: str) -> None:
        self.links.pop(lid, None)

    def _last_user(self, sid: str) -> datetime | None:
        for r in self.store._db.query("SELECT created_at, meta FROM messages WHERE session_id=? AND role IN ('user','steer') "
                                      "ORDER BY rowid DESC LIMIT 30", (sid,)):
            try:
                meta = json.loads(r["meta"] or "null") or {}
            except ValueError:
                meta = {}
            if not meta.get("internal"):
                return _t(r["created_at"])
        return None

    def why(self, mate: dict[str, Any], sid: str, now: datetime) -> tuple[str, str] | None:
        """A reason of hers to call now — (reason, what about) — or None: a question they never answered, news from work she
        passed on, or simply missing them."""
        mid = mate["id"]
        doc, who = self.store.state_doc(mid), self.store.state_who(mid)
        spoke = doc.get("spoke") if isinstance(doc.get("spoke"), dict) else None
        last_user = self._last_user(sid)
        if spoke and spoke.get("asked"):
            at = _t(spoke.get("at"))
            if at and ASKED_AFTER <= now - at <= STALE:
                row = self.store._db.query_one("SELECT content FROM messages WHERE session_id=? AND role='assistant' "
                                               "ORDER BY rowid DESC LIMIT 1", (sid,))
                return "question", clip(spoken(row["content"]) if row else "", 300)
        rows = self.store._db.query("SELECT role, content, meta, created_at FROM messages WHERE session_id=? ORDER BY rowid DESC "
                                    "LIMIT 12", (sid,))
        for i, r in enumerate(rows):
            try:
                meta = json.loads(r["meta"] or "null") or {}
            except ValueError:
                meta = {}
            if r["role"] in ("user", "steer") and not meta.get("internal"):
                break
            if r["role"] == "user" and meta.get("kind") == "delegation_result":
                at = _t(r["created_at"])
                if at and NEWS_AFTER <= now - at <= STALE and (last_user is None or at > last_user):
                    answer = next((x["content"] for x in reversed(rows[:i]) if x["role"] == "assistant"), "")
                    titles = ", ".join(d.get("title") or "" for d in meta.get("delegations") or [])
                    return "work", clip(spoken(answer) or titles, 300)
                break
        lonely = S.levels(doc, who, now, self.store.tz())["lonely"]["v"]
        rel = self.mates._advanced(mid, now, self.store.tz())
        close = bool(rel and rel["enabled"] and rel["stage"] != "new")
        if lonely >= (LONELY_FROM if close else 0.7) and (last_user is None or now - last_user >= timedelta(hours=3)):
            return "lonely", ""
        return None

    async def consider(self, mate_id: str) -> str:
        """Does she call them now? -> what decided it (``ringing`` when she does)."""
        if self.active() is not None:
            return "line_busy"
        try:
            mate = self.store.get(mate_id)
        except KeyError:
            return "gone"
        sid = mate.get("session_id")
        if mate.get("draft") or not sid:
            return "no_conversation"
        device = self.phone(mate)
        if device is None:
            return "no_phone"
        now = datetime.fromtimestamp(self.clock(), timezone.utc)
        tz = self.store.tz()
        if not by_day(now.astimezone(tz).hour):
            return "quiet_hours"
        if (mate.get("life") or {}).get("asleep"):
            return "asleep"
        if self.svc.is_running(sid) or self.svc.running_task_count(sid) > 0:
            return "busy"
        if any(c.device == device and c.user_busy and time.monotonic() - c.busy_at < 10 for c in self.broker.clients()):
            return "busy"
        last_user = self._last_user(sid)
        if last_user is not None and now - last_user < CHATTING:
            return "chatting"
        mine = self.store._db.query_one("SELECT created_at FROM mate_calls WHERE mate_id=? AND direction='incoming' ORDER BY "
                                        "created_at DESC LIMIT 1", (mate_id,))
        if mine and (at := _t(mine["created_at"])) and now - at < cooldown(self.unanswered_in_a_row(mate_id)):
            return "cooldown"
        last = self.store._db.query_one("SELECT ended_at FROM mate_calls WHERE mate_id=? AND ended_at IS NOT NULL ORDER BY "
                                        "ended_at DESC LIMIT 1", (mate_id,))
        if last and (at := _t(last["ended_at"])) and now - at < AFTER_ANY_CALL:
            return "recent_call"
        doc, who = self.store.state_doc(mate_id), self.store.state_who(mate_id)
        if S.furious(doc, who, now, tz):
            return "upset"
        reason = self.why(mate, sid, now)
        if reason is None:
            return "nothing"
        if reason[0] == "lonely" and self.rng() > LONELY_CHANCE:
            return "not_now"
        try:
            await self.ring(mate_id, device, reason[0], reason[1])
        except CallError:
            return "line_busy"
        return "ringing"

    async def scan(self) -> None:
        for row in self.store._db.query("SELECT id FROM mates WHERE draft = 0"):
            try:
                await self.consider(row["id"])
            except Exception as exc:  # noqa: BLE001 - one mate never stops the others
                self.mates._log("warning", f"call check for {row['id']}: {exc}", code="mate.call_check")

    async def run(self) -> None:
        while True:
            await asyncio.sleep(SCAN_S + random.uniform(-3, 3))
            await self.scan()

    def start(self) -> None:
        self.task = asyncio.create_task(self.run())
        self._end_links_on_exit()

    def end_links(self) -> None:
        """The server is going: every phone's link ends now (``bye``: the app comes back to the new one in seconds)."""
        for lk in list(self.links.values()):
            self._tell(lk, {"type": "bye"})

    def _end_links_on_exit(self) -> None:
        """A link is a response that never ends, and the server's graceful stop waits for every response — so a stop
        (SIGTERM, Ctrl+C) would hang with a phone linked (until docker kills it, the phone still on the old server). The
        server's own handlers are wrapped: the links end first, then it stops as it would."""
        import signal
        import threading

        if threading.current_thread() is not threading.main_thread():
            return  # (tests: no signals here)
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            prev = signal.getsignal(sig)
            if not callable(prev) or getattr(prev, "_ends_links", False):
                continue  # (no server's handler to wrap)

            def handler(s: int, frame: Any, prev: Callable[..., Any] = prev) -> None:
                loop.call_soon_threadsafe(self.end_links)
                prev(s, frame)

            handler._ends_links = True  # type: ignore[attr-defined]
            signal.signal(sig, handler)

    async def stop(self) -> None:
        if self.task is not None:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        for call in list(self.calls.values()):
            await self.end(call, "restart")
        for t in list(self._followups):
            t.cancel()

    # ---- plumbing ----

    def _now_iso(self) -> str:
        return datetime.fromtimestamp(self.clock(), timezone.utc).isoformat()

    def _open(self, call: Call) -> None:
        self.calls[call.id] = call
        self.store._db.execute("INSERT INTO mate_calls(id, mate_id, session_id, direction, status, reason, device, created_at) "
                               "VALUES(?,?,?,?,?,?,?,?)", (call.id, call.mate_id, call.session_id, call.direction,
                                                           call.status, call.reason, call.device, call.created_at))
        self._later(call, MAX_CALL_S, lambda: self._spawn(call, self.end(call, "limit")))
        self._announce(call)

    def _save(self, call: Call) -> None:
        self.store._db.execute("UPDATE mate_calls SET status=?, answered_at=?, device=?, engine=? WHERE id=?",
                               (call.status, call.answered_at, call.device, call.engine_kind, call.id))

    def _later(self, call: Call, seconds: float, fn: Callable[[], Any]) -> None:
        call.timers.append(asyncio.get_running_loop().call_later(seconds, fn))

    def _spawn(self, call: Call, coro: Awaitable[Any]) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        call.tasks.add(task)
        task.add_done_callback(call.tasks.discard)
        return task

    def _send(self, call: Call, msg: dict[str, Any]) -> None:
        if call.send is not None:
            try:
                call.send(msg)
            except Exception:  # noqa: BLE001 - a closing socket: detach follows
                pass

    @staticmethod
    def _tell(client: Any, msg: dict[str, Any]) -> None:
        try:
            client.send(msg)
        except Exception:  # noqa: BLE001
            pass

    def _announce(self, call: Call) -> None:
        """Every window hears where a call stands (a ringing screen elsewhere goes away once it is taken or over)."""
        msg = {"type": "call.update", "data": call.public()}
        for c in [*self.broker.clients(), *self.links.values()]:
            self._tell(c, msg)
