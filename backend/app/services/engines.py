"""Persistent Claude engines: spawn/reuse, turn routing, auto turns, reaping.

The session layer asks for a turn stream (:meth:`EngineManager.turn`) and gets
exactly the event stream a one-shot provider would yield, so the turn
pipeline (context handoff, steering, logging, account health) is shared.

Everything the engine says *outside* a turn is routed here:

* ``task.update``  -> ``on_task(sid, task)``      (also shown inside a running turn)
* ``usage.update`` -> ``on_usage(sid, info)``
* output while idle (Claude reacting to a finished background task) ->
  ``on_auto_turn(sid, stream, inbox)``: a turn nobody typed.
* a background subagent's work while idle (events carrying ``parent``) ->
  ``on_subagent(sid, event)``: it belongs to the turn that launched it, so it
  must not open a turn of its own.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

from app.providers.base import ProviderEvent, SteerMessage, TurnInbox
from app.providers.claude_engine import ClaudeEngine, EngineError, cli_context

# Close an engine after this long without a turn or a running task. Each engine
# is a Claude Code (node) process holding a few hundred MB, so idle ones don't
# stay forever. Closing one does NOT cost the prompt cache: the cache lives
# server-side per account (1h TTL, refreshed by each call), and the next turn
# respawns with --resume on the SAME account (sticky balancing), so a chat
# picked up within the hour still reads its context from cache. (What used to
# cost a full re-write was the respawn landing on a different account.)
IDLE_TIMEOUT_S = 30 * 60
MAX_TASK_HOLD_S = 12 * 3600       # but never keep one alive for tasks longer than this
_TURN_START = ("session.info", "text.delta", "thinking.delta", "tool.use", "notice")
_TERMINAL = ("turn.complete", "error")


@dataclass
class EngineSlot:
    engine: ClaudeEngine
    lease: Any = None
    dispatcher: asyncio.Task | None = None
    sink: asyncio.Queue | None = None       # the turn currently receiving events
    meta: dict[str, Any] = field(default_factory=dict)


class EngineManager:
    def __init__(
        self,
        *,
        on_task: Callable[[str, dict[str, Any]], None],
        on_usage: Callable[[str, dict[str, Any]], None],
        on_auto_turn: Callable[[str, AsyncIterator[ProviderEvent], TurnInbox], None],
        on_closed: Callable[[str, Any, str], None],
        on_subagent: Callable[[str, ProviderEvent], Awaitable[None]] | None = None,
    ) -> None:
        self._slots: dict[str, EngineSlot] = {}
        self._on_task = on_task
        self._on_usage = on_usage
        self._on_auto_turn = on_auto_turn
        self._on_closed = on_closed
        self._on_subagent = on_subagent
        self._reaper: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    # ---- lookup ----

    def slot(self, sid: str) -> EngineSlot | None:
        s = self._slots.get(sid)
        return s if s is not None and s.engine.alive else None

    def describe(self) -> list[dict[str, Any]]:
        now = time.monotonic()
        return [
            {
                "session_id": sid,
                "pid": s.engine._proc.pid if s.engine._proc else None,
                "model": s.engine.model,
                "mode": s.engine.mode,
                "turn_active": s.engine.turn_active,
                "running_tasks": len(s.engine.running_tasks),
                "idle_s": int(now - s.engine.last_activity),
                "account": getattr(s.lease, "label", None),
                "account_id": getattr(s.lease, "account_id", None),
                "cost_total_usd": round(s.engine.cost_total, 4),
                "stale": bool(s.meta.get("stale_binary")),  # started before a CLI upgrade (retire_stale)
            }
            for sid, s in self._slots.items()
            if s.engine.alive
        ]

    # ---- spawn / reuse ----

    async def ensure(
        self,
        sid: str,
        *,
        make_engine: Callable[[Any], Awaitable[ClaudeEngine]],
        fingerprint: str,
        model: str,
        mode: str,
        permission_mode: str,
        acquire_lease: Callable[[], Any],
        release_lease: Callable[[Any], None],
    ) -> tuple[EngineSlot, bool, str | None]:
        """Return (slot, freshly_started, restart_note)."""
        async with self._lock:
            note = None
            slot = self.slot(sid)
            if slot is not None and slot.meta.get("stale_binary") and not slot.engine.running_tasks:
                await self.shutdown(sid, reason="cli upgraded")  # the CLI was upgraded: start the new binary
                slot = None
            if slot is not None and slot.engine.fingerprint == fingerprint:
                try:
                    await slot.engine.set_model(model)
                    await slot.engine.set_mode(permission_mode, mode)
                    return slot, False, None
                except EngineError:
                    pass  # fall through to a restart
            if slot is not None:
                running = len(slot.engine.running_tasks)
                note = (
                    f"Engine restarted to apply new settings — {running} background task(s) were stopped"
                    if running else None
                )
                await self.shutdown(sid, reason="settings changed")
            lease = await asyncio.to_thread(acquire_lease)  # may fetch plan usage
            try:
                engine = await make_engine(lease)
                await engine.start()
            except Exception:
                release_lease(lease)
                raise
            slot = EngineSlot(engine=engine, lease=lease)
            slot.dispatcher = asyncio.create_task(self._dispatch(sid, slot))
            self._slots[sid] = slot
            self._ensure_reaper()
            return slot, True, note

    # ---- turns ----

    async def turn(self, sid: str, slot: EngineSlot, envelope: bytes, inbox: TurnInbox | None) -> AsyncIterator[ProviderEvent]:
        """Send a user message and stream that turn's events (one-shot-compatible)."""
        engine = slot.engine
        if slot.sink is not None:
            # An auto turn is mid-flight (rare race with a background task
            # finishing): end its stream so it can't hang, then take over.
            await slot.sink.put(ProviderEvent(type="turn.complete", data={"text": "", "superseded": True}))
        sink: asyncio.Queue = asyncio.Queue()
        slot.sink = sink
        engine.turn_active = True
        feeder = asyncio.create_task(self._feed(engine, inbox)) if inbox is not None else None
        try:
            yield ProviderEvent(type="session.start", data={"provider": "claude", "model": engine.model, "workspace": engine.cwd})
            try:
                await engine.send_user(envelope)
            except EngineError:
                pass  # the process already died (e.g. stale --resume); its exit/error is in the stream
            async for ev in self._drain(sink, engine, inbox):
                yield ev
            if slot.sink is sink:
                slot.sink = None  # output from here on is a turn of Claude's own
            ctx = await self._context_event(engine)
            if ctx is not None:
                yield ctx
        finally:
            if feeder is not None:
                feeder.cancel()
            if inbox is not None:
                inbox.close()
            if slot.sink is sink:
                slot.sink = None
            engine.turn_active = False
            engine.interrupt_requested = False

    async def _drain(self, sink: asyncio.Queue, engine: ClaudeEngine, inbox: TurnInbox | None) -> AsyncIterator[ProviderEvent]:
        while True:
            ev: ProviderEvent = await sink.get()
            if ev.type == "engine.exit":
                yield ProviderEvent(type="error", data={
                    "code": "exec.cli.exited",
                    "message": (engine.stderr_tail() or "the Claude engine stopped unexpectedly")[-2000:],
                })
                return
            if ev.type == "error" and engine.interrupt_requested:
                # (keeps the stopped turn's usage / cost)
                ev = ProviderEvent(type="error", data={**ev.data, "code": "turn.interrupted", "message": "Stopped by user"})
            if ev.type in _TERMINAL and inbox is not None:
                inbox.close()  # later instructions become the next turn
            yield ev
            if ev.type in _TERMINAL:
                return

    @staticmethod
    async def _context_event(engine: ClaudeEngine) -> ProviderEvent | None:
        """After a turn: the CLI's own context count, window and auto-compact
        point (a local control request — no API call)."""
        if not engine.alive:
            return None
        info = await engine.context_usage()
        return ProviderEvent(type="context.update", data=cli_context(info)) if info else None

    async def _feed(self, engine: ClaudeEngine, inbox: TurnInbox) -> None:
        from app.providers.claude_code import ClaudeCodeProvider

        while True:
            msg: SteerMessage = await inbox.queue.get()
            try:
                await engine.send_user(ClaudeCodeProvider._envelope(msg.text, msg.attachments, inline_files=msg.inline_files))
                msg.resolve(True)
            except EngineError:
                msg.resolve(False)

    async def _auto_stream(self, sid: str, slot: EngineSlot, sink: asyncio.Queue, inbox: TurnInbox) -> AsyncIterator[ProviderEvent]:
        engine = slot.engine
        engine.turn_active = True
        feeder = asyncio.create_task(self._feed(engine, inbox))
        try:
            yield ProviderEvent(type="session.start", data={
                "provider": "claude", "model": engine.model, "workspace": engine.cwd, "trigger": "background",
            })
            async for ev in self._drain(sink, engine, inbox):
                yield ev
            if slot.sink is sink:
                slot.sink = None
            ctx = await self._context_event(engine)
            if ctx is not None:
                yield ctx
        finally:
            feeder.cancel()
            inbox.close()
            if slot.sink is sink:
                slot.sink = None
            engine.turn_active = False
            engine.interrupt_requested = False

    async def _dispatch(self, sid: str, slot: EngineSlot) -> None:
        engine = slot.engine
        while True:
            ev: ProviderEvent = await engine.events.get()
            if ev.type == "task.update":
                self._on_task(sid, ev.data)
                if slot.sink is not None:
                    await slot.sink.put(ev)  # also shown inside the running turn
                continue
            if ev.type == "usage.update":
                self._on_usage(sid, ev.data)
                continue
            if ev.type == "engine.exit":
                if slot.sink is not None:
                    await slot.sink.put(ev)
                if self._slots.get(sid) is slot:
                    self._slots.pop(sid, None)
                    self._on_closed(sid, slot.lease, "exited")
                return
            if slot.sink is not None:
                await slot.sink.put(ev)
                if ev.type in _TERMINAL:
                    # That turn is over: whatever comes next (Claude reacting to
                    # a background task the moment it ended) is a turn of its
                    # own — never queued into the finished one and lost.
                    slot.sink = None
                continue
            if ev.data.get("parent"):
                # A background subagent working while the chat is idle.
                if self._on_subagent is not None:
                    try:
                        await self._on_subagent(sid, ev)
                    except Exception:  # noqa: BLE001 - never stop the dispatcher
                        pass
                continue
            if ev.type in _TURN_START:
                # Claude started a turn on its own (e.g. a background task finished).
                sink: asyncio.Queue = asyncio.Queue()
                slot.sink = sink
                await sink.put(ev)
                inbox = TurnInbox()
                self._on_auto_turn(sid, self._auto_stream(sid, slot, sink, inbox), inbox)

    # ---- control ----

    async def interrupt(self, sid: str) -> bool:
        slot = self.slot(sid)
        if slot is None or not slot.engine.turn_active:
            return False
        try:
            await slot.engine.interrupt()
            return True
        except EngineError:
            return False

    async def stop_task(self, sid: str, task_id: str) -> bool:
        slot = self.slot(sid)
        if slot is None:
            return False
        try:
            await slot.engine.stop_task(task_id)
            return True
        except EngineError:
            return False

    async def shutdown(self, sid: str, *, reason: str = "closed") -> None:
        slot = self._slots.pop(sid, None)
        if slot is None:
            return
        await slot.engine.close()
        if slot.dispatcher is not None:
            slot.dispatcher.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await slot.dispatcher
        self._on_closed(sid, slot.lease, reason)

    async def shutdown_all(self) -> None:
        if self._reaper is not None:
            self._reaper.cancel()
        for sid in list(self._slots):
            await self.shutdown(sid, reason="server shutdown")

    async def retire_stale(self, reason: str = "cli upgraded") -> dict[str, int]:
        """The CLI binary changed: shut down idle engines now (the next turn starts the new one); busy ones (a
        turn or background tasks running) are marked and retired once idle — never cut off mid-work."""
        restarted = deferred = 0
        for sid, slot in list(self._slots.items()):
            e = slot.engine
            if not e.alive:
                continue
            if e.turn_active or e.running_tasks:
                slot.meta["stale_binary"] = True
                deferred += 1
            else:
                await self.shutdown(sid, reason=reason)
                restarted += 1
        if deferred:
            self._ensure_reaper()
        return {"restarted": restarted, "deferred": deferred}

    # ---- idle reaper ----

    def _ensure_reaper(self) -> None:
        if self._reaper is None or self._reaper.done():
            self._reaper = asyncio.create_task(self._reap())

    async def _reap(self) -> None:
        while self._slots:
            await asyncio.sleep(60)
            now = time.monotonic()
            for sid, slot in list(self._slots.items()):
                e = slot.engine
                if e.turn_active:
                    continue
                idle = now - e.last_activity
                if slot.meta.get("stale_binary") and not e.running_tasks:
                    await self.shutdown(sid, reason="cli upgraded")
                elif (not e.running_tasks and idle > IDLE_TIMEOUT_S) or idle > MAX_TASK_HOLD_S:
                    await self.shutdown(sid, reason="idle")
