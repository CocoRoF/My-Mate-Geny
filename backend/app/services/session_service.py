"""Session lifecycle + turn execution.

A session binds a provider, a workspace (local or remote), and a conversation.
Running a turn:

1. persist the user message (+ link its attachments),
2. resolve cwd (+ optional MCP config) from the workspace connector,
3. resolve credentials from the provider service / account pool,
4. stream normalized events from the provider, persisting each,
5. on ``turn.complete`` persist the assistant message and remember the
   provider-side ``cli_session_id`` so the next turn resumes.

Turns run as **background tasks** (:meth:`start_turn`), decoupled from any
WebSocket: closing or refreshing the tab never kills the agent. Clients
subscribe to a session's live events and re-attach after a reconnect using the
events-table row id (``eid``) as a cursor. :meth:`stop` interrupts a turn
(kills the CLI's whole process group).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import dataclasses
import json
import os
import re
import time
import traceback
from typing import TYPE_CHECKING, Any, AsyncIterator

from app.db import Database
from app.providers import get_provider
from app.providers.accounts import AccountPool, classify_error, link_shared_state
from app.providers.base import ProviderEvent, SteerMessage, TurnInbox, TurnRequest
from app.providers.claude_engine import ClaudeEngine
from app.services._ids import new_id, now_iso
from app.services.context_handoff import build_blocks, catchup_preamble, handoff_preamble, ENGINE_LABEL
from app.services.engines import EngineManager
from app.services import changes as change_tracker
from app.services.provider_service import ProviderService
from app.services.workspace_service import WorkspaceService

if TYPE_CHECKING:
    from app.services.attachment_service import AttachmentService
    from app.services.log_service import LogService

MODES = ("agent", "plan")
MAX_EXTRA_DIRS = 20

# A stored provider session that no longer exists (deleted transcript, other
# machine…): retry once from a full handoff instead of failing the turn.
_STALE_RESUME = re.compile(r"no conversation found|no rollout found|thread/resume failed", re.I)


class TurnBusyError(RuntimeError):
    """A turn is already running for this session."""


class SessionService:
    def __init__(
        self,
        db: Database,
        providers: ProviderService,
        workspaces: WorkspaceService,
        pool: "AccountPool | None" = None,
        attachments: "AttachmentService | None" = None,
        logs: "LogService | None" = None,
    ) -> None:
        self._db = db
        self._providers = providers
        self._workspaces = workspaces
        self._pool = pool
        self._attachments = attachments
        self._logs = logs
        # Turns currently executing (sid -> info), surfaced on the admin page.
        self.active_runs: dict[str, dict[str, Any]] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        self._inboxes: dict[str, TurnInbox] = {}  # running turns that accept steering
        self.persistent_engines = True  # Claude: one long-lived CLI process per chat
        self.live_usage: dict[str, dict[str, Any]] = {}
        self._engines = EngineManager(
            on_task=self._on_task,
            on_usage=self._on_usage,
            on_auto_turn=self._on_auto_turn,
            on_closed=self._on_engine_closed,
        )
        # Engines don't survive a restart: tasks still marked running are gone.
        try:
            self._db.execute(
                "UPDATE bg_tasks SET status = 'lost', updated_at = ? WHERE status IN ('running', 'pending')",
                (now_iso(),),
            )
        except Exception:  # noqa: BLE001 - table may not exist on very old test DBs
            pass

    def _log(self, level: str, source: str, message: str, **kw: Any) -> None:
        if self._logs is not None:
            self._logs.record(level, source, message, **kw)

    # ---- CRUD ----

    def create(
        self,
        *,
        provider: str,
        model: str = "",
        effort: str = "default",
        connection_id: str | None = None,
        workspace_path: str,
        title: str = "New chat",
        mode: str = "agent",
        extra_dirs: list[str] | None = None,
    ) -> dict[str, Any]:
        get_provider(provider)  # validate
        sid = new_id("sess_")
        now = now_iso()
        dirs = self._clean_dirs(connection_id, extra_dirs or [])
        self._db.execute(
            """
            INSERT INTO sessions
                (id, title, provider, model, effort, connection_id, workspace_path,
                 cli_session_id, mode, extra_dirs, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
            """,
            (sid, title, provider, model, effort, connection_id, workspace_path,
             mode if mode in MODES else "agent", json.dumps(dirs), now, now),
        )
        return self.get(sid)

    @staticmethod
    def _clean_dirs(connection_id: str | None, dirs: list[str]) -> list[str]:
        out: list[str] = []
        for d in dirs:
            d = (d or "").strip()
            if not d:
                continue
            if not connection_id:  # local: must be a real directory on this host
                d = os.path.abspath(os.path.expanduser(d))
                if not os.path.isdir(d):
                    raise ValueError(f"not a directory: {d}")
            if d not in out:
                out.append(d)
        if len(out) > MAX_EXTRA_DIRS:
            raise ValueError(f"at most {MAX_EXTRA_DIRS} additional folders")
        return out

    def update(
        self,
        sid: str,
        *,
        provider: str | None = None,
        model: str | None = None,
        effort: str | None = None,
        mode: str | None = None,
        extra_dirs: list[str] | None = None,
        title: str | None = None,
    ) -> dict[str, Any]:
        """Change engine/model/think level/mode/folders mid-conversation.
        Switching provider resets the provider-side session id."""
        session = self.get(sid)
        sets: list[str] = []
        params: list[Any] = []
        if provider is not None and provider != session["provider"]:
            get_provider(provider)  # validate
            # Each engine keeps its own CLI session; the conversation itself is
            # carried over by the handoff/catch-up preamble on the next turn.
            state = self._cli_state(session)  # also persists a migrated legacy id
            own = state.get(provider, {})
            sets += ["provider = ?", "cli_session_id = ?", "cli_info = '{}'", "cli_sessions = ?"]
            params += [provider, own.get("id"), json.dumps(state)]
        if model is not None:
            sets.append("model = ?")
            params.append(model)
        if effort is not None:
            sets.append("effort = ?")
            params.append(effort)
        if mode is not None:
            if mode not in MODES:
                raise ValueError(f"unknown mode: {mode}")
            sets.append("mode = ?")
            params.append(mode)
        if extra_dirs is not None:
            sets.append("extra_dirs = ?")
            params.append(json.dumps(self._clean_dirs(session["connection_id"], extra_dirs)))
        if title is not None and title.strip():
            sets.append("title = ?")
            params.append(title.strip()[:200])
        if sets:
            sets.append("updated_at = ?")
            params.append(now_iso())
            params.append(sid)
            self._db.execute(f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?", params)
        return self.get(sid)

    def _row(self, row: Any) -> dict[str, Any]:
        d = dict(row)
        for key, empty in (("extra_dirs", []), ("cli_info", {}), ("cli_sessions", {})):
            try:
                d[key] = json.loads(d.get(key) or json.dumps(empty))
            except ValueError:
                d[key] = empty
        d["running"] = d["id"] in self._tasks
        return d

    def get(self, sid: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT * FROM sessions WHERE id = ?", (sid,))
        if row is None:
            raise KeyError(f"session not found: {sid}")
        return self._row(row)

    def list_all(self) -> list[dict[str, Any]]:
        rows = self._db.query(
            """
            SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
            FROM sessions s ORDER BY s.updated_at DESC
            """
        )
        out = []
        for r in rows:
            d = self._row(r)
            d.pop("cli_info", None)  # large; fetched per session
            out.append(d)
        return out

    def delete(self, sid: str) -> None:
        task = self._tasks.get(sid)
        if task is not None and not task.done():
            task.cancel()
        self._retire_engine(sid, "session deleted")
        self._db.execute("DELETE FROM sessions WHERE id = ?", (sid,))
        if self._attachments is not None:
            self._attachments.purge_session(sid)

    def messages(self, sid: str) -> list[dict[str, Any]]:
        rows = self._db.query(
            "SELECT id, role, content, provider, model, created_at FROM messages WHERE session_id = ? ORDER BY created_at",
            (sid,),
        )
        by_msg = self._attachments.by_message(sid) if self._attachments is not None else {}
        return [{**dict(r), "attachments": by_msg.get(r["id"], [])} for r in rows]

    def events(self, sid: str, after: int = 0) -> list[dict[str, Any]]:
        # Insertion order (row id), NOT seq: seq restarts at 1 every turn.
        rows = self._db.query(
            "SELECT id, seq, type, data, created_at FROM events WHERE session_id = ? AND id > ? ORDER BY id",
            (sid, after),
        )
        return [
            {"eid": r["id"], "seq": r["seq"], "type": r["type"], "data": json.loads(r["data"]),
             "timestamp": r["created_at"]}
            for r in rows
        ]

    def reset_context(self, sid: str) -> dict[str, Any]:
        """``/clear``: the next turn starts a fresh provider conversation."""
        if sid in self._tasks:
            raise TurnBusyError("stop the running turn first")
        self.get(sid)
        self._db.execute(
            "UPDATE sessions SET cli_session_id = NULL, cli_sessions = '{}', context_floor = ? WHERE id = ?",
            (now_iso(), sid),
        )
        # A live engine still holds the old conversation: retire it.
        self._retire_engine(sid, "context cleared")
        ev = ProviderEvent(type="notice", data={
            "level": "info", "code": "context.reset",
            "message": "Context cleared — the agent starts a fresh conversation from here.",
        })
        self._add_event(sid, ev)
        self._publish(sid, ev.to_dict())
        return ev.to_dict()

    # ---- persistence helpers ----

    def _add_message(
        self, sid: str, role: str, content: str, provider: str | None = None, model: str | None = None
    ) -> str:
        mid = new_id("msg_")
        self._db.execute(
            "INSERT INTO messages (id, session_id, role, content, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (mid, sid, role, content, provider, model, now_iso()),
        )
        self._db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now_iso(), sid))
        return mid

    def _add_event(self, sid: str, ev: ProviderEvent) -> None:
        ev.eid = self._db.insert(
            "INSERT INTO events (session_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
            (sid, ev.seq, ev.type, json.dumps(ev.data), ev.timestamp),
        )

    def _set_cli_session(self, sid: str, cli_session_id: str | None, provider: str | None = None) -> None:
        """Remember an engine's CLI session and that it has now seen the whole
        conversation up to this point (its catch-up watermark)."""
        if not cli_session_id:
            return
        session = self.get(sid)
        provider = provider or session["provider"]
        state = self._cli_state(session)
        state[provider] = {"id": cli_session_id, "seen": now_iso()}
        self._db.execute(
            "UPDATE sessions SET cli_sessions = ?, cli_session_id = CASE WHEN provider = ? THEN ? ELSE cli_session_id END WHERE id = ?",
            (json.dumps(state), provider, cli_session_id, sid),
        )

    def _drop_cli_session(self, sid: str, provider: str) -> None:
        session = self.get(sid)
        state = self._cli_state(session)
        state.pop(provider, None)
        self._db.execute(
            "UPDATE sessions SET cli_sessions = ?, cli_session_id = CASE WHEN provider = ? THEN NULL ELSE cli_session_id END WHERE id = ?",
            (json.dumps(state), provider, sid),
        )

    def _cli_state(self, session: dict[str, Any]) -> dict[str, dict[str, Any]]:
        state = session.get("cli_sessions")
        if isinstance(state, str):
            try:
                state = json.loads(state or "{}")
            except ValueError:
                state = {}
        state = dict(state or {})
        if not state and session.get("cli_session_id"):
            # Chats from before per-engine sessions: the stored id belongs to the
            # current engine. Trust it only if that engine ran the whole chat —
            # otherwise its session lacks the earlier turns, so start it fresh
            # with a full handoff.
            engines = {
                json.loads(r["data"]).get("provider")
                for r in self._db.query(
                    "SELECT data FROM events WHERE session_id = ? AND type = 'session.start'", (session["id"],)
                )
            } - {None}
            if engines <= {session["provider"]}:
                state[session["provider"]] = {"id": session["cli_session_id"], "seen": now_iso()}
        return state

    def _context_for(
        self, session: dict[str, Any], provider: str, current_msg_id: str, *, fresh: bool = False
    ) -> tuple[str | None, str, str, int]:
        """(resume id, preamble, kind, n_messages) for the engine about to run."""
        own = {} if fresh else self._cli_state(session).get(provider, {})
        floor = session.get("context_floor") or ""
        msgs = [
            m for m in self.messages(session["id"])
            if m["id"] != current_msg_id and m["created_at"] > floor
        ]
        resume_id = own.get("id")
        if resume_id:
            seen = own.get("seen") or ""
            msgs = [m for m in msgs if m["created_at"] > seen]
        if not msgs:
            return resume_id, "", "", 0
        since = min(m["created_at"] for m in msgs)
        events = [e for e in self.events(session["id"]) if e["timestamp"] >= since]
        blocks = build_blocks(msgs, events)
        if not blocks:
            return resume_id, "", "", 0
        if resume_id:
            return resume_id, catchup_preamble(provider, blocks), "catchup", len(msgs)
        return None, handoff_preamble(provider, blocks), "handoff", len(msgs)

    # ---- live subscription (WebSocket fan-out) ----

    def subscribe(self, sid: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=10000)
        self._subscribers.setdefault(sid, set()).add(q)
        return q

    def unsubscribe(self, sid: str, q: asyncio.Queue) -> None:
        subs = self._subscribers.get(sid)
        if subs is not None:
            subs.discard(q)
            if not subs:
                self._subscribers.pop(sid, None)

    def _publish(self, sid: str, msg: dict[str, Any]) -> None:
        for q in list(self._subscribers.get(sid, ())):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:  # a stuck client must not stall the agent
                self.unsubscribe(sid, q)

    def is_running(self, sid: str) -> bool:
        return sid in self._tasks

    # ---- background turns ----

    def start_turn(
        self,
        sid: str,
        user_input: str,
        attachment_ids: list[str] | None = None,
        client_msg_id: str | None = None,
    ) -> None:
        """Validate and launch a turn in the background. Raises
        ``TurnBusyError`` / ``AttachmentError`` / ``KeyError`` synchronously."""
        if sid in self._tasks:
            raise TurnBusyError("a turn is already running in this session")
        self.get(sid)
        rows = (
            self._attachments.pending(sid, attachment_ids)
            if attachment_ids and self._attachments is not None
            else []
        )
        task = asyncio.create_task(self._drive(sid, user_input, rows, client_msg_id))
        self._tasks[sid] = task

    async def steer(
        self,
        sid: str,
        text: str,
        attachment_ids: list[str] | None = None,
        client_msg_id: str | None = None,
    ) -> bool:
        """Deliver extra instructions into the RUNNING turn. Returns False when
        the turn can't take input any more (caller sends it as the next turn).
        Raises ``AttachmentError`` for invalid attachments."""
        inbox = self._inboxes.get(sid)
        if inbox is None or not inbox.open:
            return False
        session = self.get(sid)
        rows = (
            self._attachments.pending(sid, attachment_ids)
            if attachment_ids and self._attachments is not None
            else []
        )
        atts = [self._attachments.to_provider(r) for r in rows] if self._attachments else []
        if atts and session["connection_id"]:
            try:
                remote = await self._workspaces.connector_for(session["connection_id"]).upload_files(
                    sid, [(a.id, a.path, a.name) for a in atts]
                )
                for a in atts:
                    a.remote_path = remote.get(a.id)
            except Exception as exc:  # noqa: BLE001
                self._log("warning", "upload", f"could not copy attachments to the remote host: {exc}",
                          code="upload.remote_copy_failed", session_id=sid)
        def record() -> None:
            # Kept as its own role so history pairing (user -> assistant turn)
            # is untouched; the event places it inside the running turn.
            mid = self._add_message(sid, "steer", text)
            if rows and self._attachments is not None:
                self._attachments.link([r["id"] for r in rows], mid)
            ev = ProviderEvent(type="user.steer", data={
                "text": text,
                "client_msg_id": client_msg_id,
                "message_id": mid,
                "attachments": [self._attachments.out(r) for r in rows] if self._attachments else [],
            })
            self._add_event(sid, ev)
            self._publish(sid, ev.to_dict())

        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        msg = SteerMessage(text=text, attachments=atts, delivered=fut, on_delivered=record)
        if not inbox.offer(msg):
            return False
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=30)
        except asyncio.TimeoutError:
            return False

    def stop(self, sid: str) -> bool:
        task = self._tasks.get(sid)
        if task is None or task.done():
            return False
        slot = self._engines.slot(sid)
        if slot is not None and slot.engine.turn_active:
            # Interrupt keeps the engine (and its background tasks) alive.
            asyncio.create_task(self._interrupt_or_cancel(sid, task))
        else:
            task.cancel()
        return True

    def _retire_engine(self, sid: str, reason: str) -> None:
        if self._engines.slot(sid) is None:
            return
        try:
            asyncio.get_running_loop().create_task(self._engines.shutdown(sid, reason=reason))
        except RuntimeError:  # no loop (sync caller): nothing can be running then
            pass

    async def _interrupt_or_cancel(self, sid: str, task: asyncio.Task) -> None:
        if await self._engines.interrupt(sid):
            with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError, Exception):
                await asyncio.wait_for(asyncio.shield(task), timeout=12)
            if task.done():
                return
        # The engine didn't wind down in time: hard stop (kills the process).
        task.cancel()
        await self._engines.shutdown(sid, reason="stop timeout")

    async def _drive(
        self, sid: str, user_input: str, rows: list[dict[str, Any]], client_msg_id: str | None
    ) -> None:
        self._publish(sid, {"type": "run.state", "data": {"running": True}})
        try:
            async for ev in self.run_turn(sid, user_input, rows=rows, client_msg_id=client_msg_id):
                self._publish(sid, ev.to_dict())
        except asyncio.CancelledError:
            ev = ProviderEvent(type="error", data={"code": "turn.interrupted", "message": "Stopped by user"})
            self._add_event(sid, ev)
            self._publish(sid, ev.to_dict())
        except Exception as exc:  # noqa: BLE001 - surface + log, never crash the loop
            self._log(
                "error", "ws", f"chat turn crashed: {exc}", code="exec.turn.crashed",
                detail={"exception": type(exc).__name__, "traceback": traceback.format_exc(),
                        "input_preview": user_input[:500]},
                session_id=sid,
            )
            ev = ProviderEvent(type="error", data={"code": "exec.turn.crashed", "message": str(exc)[:1000]})
            self._add_event(sid, ev)
            self._publish(sid, ev.to_dict())
        finally:
            self._tasks.pop(sid, None)
            self._publish(sid, {"type": "run.state", "data": {"running": False}})

    async def run_turn(
        self,
        sid: str,
        user_input: str,
        attachment_ids: list[str] | None = None,
        *,
        rows: list[dict[str, Any]] | None = None,
        client_msg_id: str | None = None,
    ) -> AsyncIterator[ProviderEvent]:
        """Run one turn, yielding events. Raises ``AttachmentError`` (before
        anything is persisted) when the referenced attachments are invalid."""
        session = self.get(sid)
        if rows is None:
            rows = (
                self._attachments.pending(sid, attachment_ids)
                if attachment_ids and self._attachments is not None
                else []
            )
        msg_id = self._add_message(sid, "user", user_input)
        if rows and self._attachments is not None:
            self._attachments.link([r["id"] for r in rows], msg_id)
        attachments = [self._attachments.to_provider(r) for r in rows] if self._attachments else []
        # Other tabs/devices watching this session render the user's bubble.
        self._publish(sid, {"type": "user.message", "data": {
            "message_id": msg_id, "client_msg_id": client_msg_id, "text": user_input,
            "attachments": [self._attachments.out(r) for r in rows] if self._attachments else [],
        }})
        if session["title"] in ("", "New chat") or session["title"] == os.path.basename(
            session["workspace_path"].rstrip("/")
        ):
            if user_input.strip() and self._first_turn(sid):
                self.update(sid, title=_title_from(user_input))

        ctx = {
            "provider": session["provider"],
            "model": session["model"],
            "effort": session.get("effort"),
            "mode": session.get("mode"),
            "connection_id": session["connection_id"],
            "workspace": session["workspace_path"],
        }
        self.active_runs[sid] = {
            **ctx,
            "session_id": sid,
            "title": session["title"],
            "started_at": now_iso(),
            "tools": 0,
            "attachments": len(attachments),
        }
        try:
            async for ev in self._run_turn(sid, session, attachments, ctx, msg_id):
                yield ev
        finally:
            self.active_runs.pop(sid, None)

    def _first_turn(self, sid: str) -> bool:
        row = self._db.query_one(
            "SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = 'user'", (sid,)
        )
        return bool(row) and row["c"] == 1

    async def _run_turn(
        self, sid: str, session: dict[str, Any], attachments: list, ctx: dict[str, Any], msg_id: str
    ) -> AsyncIterator[ProviderEvent]:
        connector = self._workspaces.connector_for(session["connection_id"])
        extra_dirs: list[str] = list(session.get("extra_dirs") or [])
        try:
            cwd = await connector.resolve_cwd(session["workspace_path"], extra_dirs)
            mcp_config = await connector.mcp_config(session["workspace_path"])
        except Exception as exc:  # noqa: BLE001 - surface as a normalized error event
            self._log(
                "error", "workspace", str(exc), code="exec.workspace.unresolved",
                detail={**ctx, "exception": type(exc).__name__}, session_id=sid,
            )
            ev = ProviderEvent(
                type="error", data={"code": "exec.workspace.unresolved", "message": str(exc)}
            )
            self._add_event(sid, ev)
            yield ev
            return

        if session["connection_id"]:
            # Remote: extra folders are remote paths (named in the scratch-dir
            # guide), not local --add-dir targets.
            local_extra: list[str] = []
        else:
            local_extra = [d for d in extra_dirs if os.path.isdir(d)]
            missing = [d for d in extra_dirs if d not in local_extra]
            if missing:
                ev = ProviderEvent(type="notice", data={
                    "level": "warning", "code": "folders.missing",
                    "message": "Skipped missing folder(s): " + ", ".join(missing),
                })
                self._add_event(sid, ev)
                yield ev

        # Remote workspace: also ship the attachments to the remote host so
        # remote tools can use them (local copies stay readable either way).
        if attachments and session["connection_id"]:
            try:
                remote = await connector.upload_files(
                    sid, [(a.id, a.path, a.name) for a in attachments]
                )
                for a in attachments:
                    a.remote_path = remote.get(a.id)
            except Exception as exc:  # noqa: BLE001 - degrade to local paths only
                self._log(
                    "warning", "upload", f"could not copy attachments to the remote host: {exc}",
                    code="upload.remote_copy_failed",
                    detail={**ctx, "files": [a.name for a in attachments]}, session_id=sid,
                )

        history = self.messages(sid)
        provider_name = session["provider"]
        api_key = self._providers.resolved_api_key(provider_name)
        provider = get_provider(provider_name)
        # Claude runs in a persistent engine (background tasks, auto turns,
        # live interrupt); everything else is one process per turn.
        persistent = self.persistent_engines and hasattr(provider, "engine_argv")

        # Multi-account pool. One-shot turns lease per turn; a persistent
        # engine leases when it starts and keeps its account. Only the
        # credentials dir differs per account — HOME stays the real one and
        # everything else is shared with the host config (link_shared_state).
        lease = None
        extra_env: dict[str, str] = {}
        if not persistent and self._pool is not None:
            # May fetch plan usage over HTTPS (most_remaining): off the event loop.
            lease = await asyncio.to_thread(self._pool.acquire, provider_name)
        if lease is not None:
            ctx["account"] = lease.label
            if not lease.is_primary:
                await asyncio.to_thread(link_shared_state, provider_name, lease.account_id)
                if provider_name == "claude":
                    extra_env["CLAUDE_CONFIG_DIR"] = lease.config_dir
                elif provider_name == "codex":
                    extra_env["CODEX_HOME"] = lease.config_dir
            if lease.auth_mode == "api_key" and lease.api_key:
                api_key = lease.api_key
            run = self.active_runs.get(sid)
            if run is not None:
                run["account"] = lease.label

        # Context: this engine's own session + whatever of the chat it hasn't
        # seen (full handoff after a provider switch, catch-up when returning).
        resume_id, preamble, ctx_kind, ctx_n = self._context_for(session, provider_name, msg_id)

        uploads_dir = None
        if self._attachments is not None:
            d = self._attachments.session_dir(sid)
            d.mkdir(parents=True, exist_ok=True)
            uploads_dir = str(d)

        req = TurnRequest(
            messages=[{"role": m["role"], "content": m["content"]} for m in history],
            model=session["model"],
            effort=session.get("effort") or "default",
            cwd=cwd,
            cli_session_id=resume_id,
            mcp_config=mcp_config,
            api_key=api_key,
            extra_env=extra_env,
            attachments=attachments,
            mode=session.get("mode") or "agent",
            extra_dirs=local_extra,
            inbox=TurnInbox(),
            preamble=preamble,
            uploads_dir=uploads_dir,
        )
        self._inboxes[sid] = req.inbox

        def context_notice() -> ProviderEvent | None:
            if not ctx_kind:
                return None
            engine = ENGINE_LABEL.get(provider_name, provider_name)
            msg = (
                f"Handed the conversation so far ({ctx_n} message{'s' if ctx_n != 1 else ''}) over to {engine}"
                if ctx_kind == "handoff"
                else f"Caught {engine} up on {ctx_n} message{'s' if ctx_n != 1 else ''} from the other engine"
            )
            return ProviderEvent(type="notice", data={"level": "info", "code": f"context.{ctx_kind}", "message": msg})

        st = self._turn_state(ctx, provider_name, session["model"])
        st["changes"] = await self._snapshot_before(session, connector)
        holder: dict[str, Any] = {}
        noted = False
        try:
            for attempt in (0, 1):
                progressed = False  # anything beyond start/info: no silent retry after that
                retry = False
                stream = (
                    self._engine_turn(sid, provider, req, holder, ctx)
                    if persistent else provider.run_turn_stream(req)
                )
                async for ev in stream:
                    if ev.type == "session.info":
                        yield self._session_info(sid, ev, ctx)
                        continue
                    if (
                        ev.type == "error" and attempt == 0 and req.cli_session_id and not progressed
                        and _STALE_RESUME.search(str(ev.data.get("message") or ""))
                    ):
                        # The engine lost that session: start it fresh with the
                        # whole conversation handed over, transparently.
                        self._log("warning", "provider", f"stale {provider_name} session, starting fresh: {ev.data.get('message')}",
                                  code="context.stale_session", detail=ctx, session_id=sid)
                        self._drop_cli_session(sid, provider_name)
                        _, preamble2, kind2, n2 = self._context_for(self.get(sid), provider_name, msg_id, fresh=True)
                        req.cli_session_id, req.preamble = None, preamble2
                        ctx_kind, ctx_n = kind2, n2
                        req.inbox = TurnInbox()
                        self._inboxes[sid] = req.inbox
                        retry = True
                        break
                    if ev.type == "session.start" and attempt == 1:
                        continue  # the turn already has its start event
                    if ev.type not in ("session.start", "task.update"):
                        if not progressed and not noted:
                            # Say what context the engine got — once, right before
                            # its first real output (after any stale-session retry).
                            noted = True
                            note = context_notice()
                            if note is not None:
                                self._add_event(sid, note)
                                yield note
                        progressed = True
                    if ev.type in ("turn.complete", "error"):
                        changed = await self._changes_event(st)
                        if changed is not None:
                            await self._record_event(sid, changed, st)
                            yield changed
                    await self._record_event(sid, ev, st)
                    yield ev
                if not retry:
                    break
        finally:
            if self._inboxes.get(sid) is req.inbox:
                self._inboxes.pop(sid, None)
            req.inbox.close()
            slot = holder.get("slot") if persistent else None
            if slot is not None and slot.engine.alive and slot.engine.cli_session_id:
                # A live engine has seen this turn whatever its outcome (stopped,
                # failed): its session is current — no handoff to itself next time.
                self._set_cli_session(sid, slot.engine.cli_session_id, provider_name)
            outcome_lease = slot.lease if slot is not None else lease
            self._report_outcome(provider_name, outcome_lease, st, ctx, sid, release=not persistent)

    # ---- shared turn bookkeeping (user turns and auto turns) ----

    @staticmethod
    def _turn_state(ctx: dict[str, Any], provider_name: str, model: str) -> dict[str, Any]:
        return {"ctx": ctx, "provider": provider_name, "model": model, "tool_calls": {},
                "started": time.monotonic(), "final_text": "", "err_code": None, "err_msg": None}

    def _session_info(self, sid: str, ev: ProviderEvent, ctx: dict[str, Any]) -> ProviderEvent:
        info = {**ev.data, "account": ctx.get("account")}
        self._db.execute("UPDATE sessions SET cli_info = ? WHERE id = ?", (json.dumps(info), sid))
        return ProviderEvent(type="session.info", data=info, seq=ev.seq, timestamp=ev.timestamp)

    async def _record_event(self, sid: str, ev: ProviderEvent, st: dict[str, Any]) -> None:
        """Persist one turn event + side effects (assistant message, engine
        watermark, admin logs, artifact images)."""
        ctx = st["ctx"]
        if ev.type == "tool.result" and ev.data.get("images") and self._attachments is not None:
            stored = []
            for k, img in enumerate(ev.data["images"]):
                try:
                    raw = base64.b64decode(img.get("data") or "")
                    ext = (img.get("media_type") or "image/png").split("/")[-1].replace("jpeg", "jpg")
                    stored.append(await self._attachments.save_bytes(
                        sid, f"tool-image-{k + 1}.{ext}", img.get("media_type") or "image/png", raw,
                        tag=f"artifact:{ev.data.get('id')}",
                    ))
                except Exception:  # noqa: BLE001 - an unreadable image must not break the turn
                    continue
            ev.data = {**ev.data, "images": stored}
        if ev.type == "turn.complete":
            ev.data = {**ev.data, "provider": st["provider"]}  # usage is attributed per turn
        self._add_event(sid, ev)
        if ev.type == "turn.complete":
            final_text = ev.data.get("text", "")
            st["final_text"] = final_text
            # Answer first, then the watermark: the engine has seen
            # everything up to and including its own reply.
            if final_text:
                self._add_message(sid, "assistant", final_text, st["provider"], ev.data.get("model") or st["model"])
            self._set_cli_session(sid, ev.data.get("cli_session_id"), st["provider"])
        elif ev.type == "tool.use":
            st["tool_calls"][str(ev.data.get("id"))] = {"name": ev.data.get("name"), "input": ev.data.get("input")}
            run = self.active_runs.get(sid)
            if run is not None:
                run["tools"] += 1
        elif ev.type == "tool.result" and ev.data.get("is_error"):
            call = st["tool_calls"].get(str(ev.data.get("id")), {})
            output = str(ev.data.get("output") or "")
            first = next((ln for ln in output.splitlines() if ln.strip()), "tool returned an error")
            self._log(
                "warning", "tool", first[:300],
                code=str(call.get("name") or ev.data.get("name") or "tool"),
                detail={**ctx, "tool_use_id": ev.data.get("id"), "input": call.get("input"), "output": output},
                session_id=sid,
            )
        elif ev.type == "notice" and ev.data.get("level") == "warning":
            self._log("warning", "provider", str(ev.data.get("message")),
                      code=str(ev.data.get("code") or "provider.notice"), detail=ctx, session_id=sid)
        elif ev.type == "error":
            st["err_code"] = ev.data.get("code")
            st["err_msg"] = ev.data.get("message")
            if st["err_code"] != "turn.interrupted":
                self._log(
                    "error", "provider", str(st["err_msg"] or st["err_code"]),
                    code=str(st["err_code"] or "exec.error"),
                    detail={**ctx, "elapsed_s": round(time.monotonic() - st["started"], 1),
                            "tools_run": len(st["tool_calls"])},
                    session_id=sid,
                )

    def _report_outcome(self, provider_name: str, lease: Any, st: dict[str, Any], ctx: dict[str, Any],
                        sid: str, *, release: bool) -> None:
        if lease is None or self._pool is None:
            return
        failed = st["err_code"] is not None and st["err_code"] != "turn.interrupted"
        if failed:
            outcome = classify_error(st["err_code"], st["err_msg"])
            self._pool.record_outcome(lease, ok=False, code=outcome, error=st["err_msg"])
            self._log("warning", "account", f"{provider_name} account '{lease.label}' failed a turn ({outcome})",
                      code=f"account.{outcome}", detail={**ctx, "error": st["err_msg"]}, session_id=sid)
        else:
            self._pool.record_outcome(lease, ok=True)
        if release:
            self._pool.release(lease)

    async def _engine_turn(self, sid: str, provider: Any, req: TurnRequest, holder: dict[str, Any],
                           ctx: dict[str, Any]) -> AsyncIterator[ProviderEvent]:
        """One turn on the session's persistent Claude engine (spawned on demand)."""

        async def make(lease: Any) -> ClaudeEngine:
            env: dict[str, str] = {}
            key = req.api_key
            if lease is not None:
                if not lease.is_primary:
                    await asyncio.to_thread(link_shared_state, "claude", lease.account_id)
                    env["CLAUDE_CONFIG_DIR"] = lease.config_dir
                if lease.auth_mode == "api_key" and lease.api_key:
                    key = lease.api_key
            if key:
                env["ANTHROPIC_API_KEY"] = key
            launch = dataclasses.replace(req, api_key=key)
            return ClaudeEngine(
                binary=provider._binary, argv=provider.engine_argv(launch), cwd=req.cwd, env_extras=env,
                fingerprint=provider.engine_fingerprint(req), model=req.model or "sonnet", mode=req.mode,
            )

        slot, _fresh, note = await self._engines.ensure(
            sid,
            make_engine=make,
            fingerprint=provider.engine_fingerprint(req),
            model=req.model or "sonnet",
            mode=req.mode,
            permission_mode=provider.permission_mode(req.mode),
            acquire_lease=lambda: self._pool.acquire("claude") if self._pool else None,
            release_lease=lambda lease: self._pool.release(lease) if self._pool else None,
        )
        holder["slot"] = slot
        if slot.lease is not None:
            ctx["account"] = slot.lease.label
            run = self.active_runs.get(sid)
            if run is not None:
                run["account"] = slot.lease.label
        first = True
        async for ev in self._engines.turn(sid, slot, provider.envelope(req), req.inbox):
            yield ev
            if first and note:
                first = False
                notice = ProviderEvent(type="notice", data={"level": "warning", "code": "engine.restarted", "message": note})
                yield notice

    # ---- per-turn file changes (git snapshots) ----

    def _change_runner(self, session: dict[str, Any], connector: Any) -> change_tracker.ShellRunner | None:
        if not session["connection_id"]:
            return change_tracker.local_runner()
        prefix = getattr(connector, "ssh_prefix", None)
        return change_tracker.ShellRunner(prefix()) if prefix else None

    async def _snapshot_before(self, session: dict[str, Any], connector: Any) -> dict[str, Any] | None:
        runner = self._change_runner(session, connector)
        if runner is None:
            return None
        roots = [session["workspace_path"], *(session.get("extra_dirs") or [])]
        try:
            before = await change_tracker.snapshot_all(runner, roots)
        except Exception:  # noqa: BLE001 - tracking is best-effort, never blocks a turn
            return None
        return {"runner": runner, "before": before} if before else None

    async def _changes_event(self, st: dict[str, Any]) -> ProviderEvent | None:
        snap = st.pop("changes", None)  # once per turn
        if not snap:
            return None
        runner, before = snap["runner"], snap["before"]
        repos = []
        try:
            for root, tree in before.items():
                after = await change_tracker.snapshot(runner, root)
                if after is None:
                    continue
                summary = await change_tracker.summarize(runner, root, tree, after[1])
                if summary is not None:
                    repos.append(summary)
        except Exception:  # noqa: BLE001
            return None
        if not repos:
            return None
        return ProviderEvent(type="turn.changes", data={
            "repos": repos,
            "files": sum(len(r["files"]) for r in repos),
            "added": sum(r["added"] for r in repos),
            "removed": sum(r["removed"] for r in repos),
        })

    def _change_record(self, sid: str, eid: int) -> tuple[dict[str, Any], dict[str, Any]]:
        row = self._db.query_one(
            "SELECT data FROM events WHERE id = ? AND session_id = ? AND type = 'turn.changes'", (eid, sid))
        if row is None:
            raise KeyError("changes not found")
        return self.get(sid), json.loads(row["data"])

    async def changes_patch(self, sid: str, eid: int, repo: int, path: str | None) -> str:
        session, data = self._change_record(sid, eid)
        r = data["repos"][repo]
        runner = self._change_runner(session, self._workspaces.connector_for(session["connection_id"]))
        if runner is None:
            raise KeyError("workspace unavailable")
        paths = [path] if path else []
        if path:
            f = next((x for x in r["files"] if x["path"] == path), None)
            if f is None:
                raise KeyError("file not in this change set")
            if f.get("old_path"):
                paths.append(f["old_path"])
        return await change_tracker.patch(runner, r["root"], r["before"], r["after"], paths)

    async def revert_changes(self, sid: str, eid: int, repo: int | None, paths: list[str] | None) -> dict[str, Any]:
        if sid in self._tasks:
            raise TurnBusyError("stop the running turn first")
        session, data = self._change_record(sid, eid)
        runner = self._change_runner(session, self._workspaces.connector_for(session["connection_id"]))
        if runner is None:
            raise KeyError("workspace unavailable")
        reverted: list[str] = []
        for i, r in enumerate(data["repos"]):
            if repo is not None and i != repo:
                continue
            reverted += await change_tracker.revert(runner, r, paths)
        ev = ProviderEvent(type="notice", data={
            "level": "info", "code": "changes.reverted",
            "message": f"Reverted {len(reverted)} file{'s' if len(reverted) != 1 else ''} to how they were before that turn",
        })
        self._add_event(sid, ev)
        self._publish(sid, ev.to_dict())
        return {"reverted": reverted}

    # ---- engine callbacks: auto turns, background tasks, live usage ----

    def _on_auto_turn(self, sid: str, stream: AsyncIterator[ProviderEvent], inbox: TurnInbox) -> None:
        if sid in self._tasks:  # never two drivers for one session
            asyncio.create_task(_drain_quietly(stream))
            return
        self._inboxes[sid] = inbox
        self._tasks[sid] = asyncio.create_task(self._drive_auto(sid, stream, inbox))

    async def _drive_auto(self, sid: str, stream: AsyncIterator[ProviderEvent], inbox: TurnInbox) -> None:
        """A turn Claude started on its own (e.g. a background task finished)."""
        try:
            session = self.get(sid)
        except KeyError:
            return
        slot = self._engines.slot(sid)
        ctx = {"provider": "claude", "model": session["model"], "mode": session.get("mode"),
               "connection_id": session["connection_id"], "workspace": session["workspace_path"],
               "trigger": "background", "account": getattr(slot.lease, "label", None) if slot else None}
        self.active_runs[sid] = {**ctx, "session_id": sid, "title": session["title"], "started_at": now_iso(),
                                 "tools": 0, "attachments": 0}
        st = self._turn_state(ctx, "claude", session["model"])
        self._publish(sid, {"type": "run.state", "data": {"running": True}})
        try:
            with contextlib.suppress(Exception):
                st["changes"] = await self._snapshot_before(
                    session, self._workspaces.connector_for(session["connection_id"]))
            async for ev in stream:
                if ev.type == "session.info":
                    self._publish(sid, self._session_info(sid, ev, ctx).to_dict())
                    continue
                if ev.type in ("turn.complete", "error"):
                    changed = await self._changes_event(st)
                    if changed is not None:
                        await self._record_event(sid, changed, st)
                        self._publish(sid, changed.to_dict())
                await self._record_event(sid, ev, st)
                self._publish(sid, ev.to_dict())
        except asyncio.CancelledError:
            ev = ProviderEvent(type="error", data={"code": "turn.interrupted", "message": "Stopped by user"})
            self._add_event(sid, ev)
            self._publish(sid, ev.to_dict())
        except Exception as exc:  # noqa: BLE001
            self._log("error", "ws", f"auto turn crashed: {exc}", code="exec.autoturn.crashed",
                      detail={"traceback": traceback.format_exc()}, session_id=sid)
        finally:
            if self._inboxes.get(sid) is inbox:
                self._inboxes.pop(sid, None)
            self._tasks.pop(sid, None)
            self.active_runs.pop(sid, None)
            self._report_outcome("claude", slot.lease if slot else None, st, ctx, sid, release=False)
            self._publish(sid, {"type": "run.state", "data": {"running": False}})

    def _on_task(self, sid: str, task: dict[str, Any]) -> None:
        try:
            self._db.execute(
                """
                INSERT INTO bg_tasks (session_id, task_id, tool_use_id, description, task_type, is_backgrounded,
                                      status, output_file, summary, started_at, ended_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, task_id) DO UPDATE SET
                    tool_use_id = COALESCE(excluded.tool_use_id, tool_use_id),
                    description = COALESCE(excluded.description, description),
                    task_type = COALESCE(excluded.task_type, task_type),
                    is_backgrounded = MAX(excluded.is_backgrounded, is_backgrounded),
                    status = excluded.status,
                    output_file = COALESCE(excluded.output_file, output_file),
                    summary = COALESCE(excluded.summary, summary),
                    ended_at = COALESCE(excluded.ended_at, ended_at),
                    updated_at = excluded.updated_at
                """,
                (sid, task.get("task_id"), task.get("tool_use_id"), task.get("description"), task.get("task_type"),
                 1 if task.get("is_backgrounded") else 0, task.get("status") or "running", task.get("output_file"),
                 task.get("summary"), task.get("started_at"), task.get("ended_at"), now_iso()),
            )
        except Exception:  # noqa: BLE001 - e.g. the session was just deleted
            return
        row = self._db.query_one("SELECT * FROM bg_tasks WHERE session_id = ? AND task_id = ?", (sid, task.get("task_id")))
        if row is not None:
            self._publish(sid, {"type": "task.state", "data": self._task_out(row)})

    def _on_usage(self, sid: str, info: dict[str, Any]) -> None:
        self.live_usage["claude"] = {**info, "at": now_iso()}
        self._publish(sid, {"type": "usage.update", "data": info})

    def _on_engine_closed(self, sid: str, lease: Any, reason: str) -> None:
        if self._pool is not None and lease is not None:
            self._pool.release(lease)
        rows = self._db.query(
            "SELECT * FROM bg_tasks WHERE session_id = ? AND status IN ('running', 'pending')", (sid,)
        )
        for r in rows:
            self._db.execute(
                "UPDATE bg_tasks SET status = 'killed', ended_at = ?, updated_at = ? WHERE session_id = ? AND task_id = ?",
                (time.time(), now_iso(), sid, r["task_id"]),
            )
            row = self._db.query_one("SELECT * FROM bg_tasks WHERE session_id = ? AND task_id = ?", (sid, r["task_id"]))
            if row is not None:
                self._publish(sid, {"type": "task.state", "data": self._task_out(row)})
        if reason == "exited":
            self._log("warning", "provider", "Claude engine process exited", code="engine.exited", session_id=sid)

    # ---- background tasks API ----

    @staticmethod
    def _task_out(row: Any) -> dict[str, Any]:
        d = dict(row)
        d["is_backgrounded"] = bool(d.get("is_backgrounded"))
        d.pop("output_file", None)  # served through the API, never exposed as a path
        return d

    def list_tasks(self, sid: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        if sid:
            rows = self._db.query(
                "SELECT * FROM bg_tasks WHERE session_id = ? ORDER BY started_at DESC LIMIT ?", (sid, limit))
        else:
            rows = self._db.query("SELECT * FROM bg_tasks ORDER BY started_at DESC LIMIT ?", (limit,))
        return [self._task_out(r) for r in rows]

    def task_output(self, sid: str, task_id: str, tail: int = 65536) -> dict[str, Any]:
        row = self._db.query_one("SELECT * FROM bg_tasks WHERE session_id = ? AND task_id = ?", (sid, task_id))
        if row is None:
            raise KeyError(task_id)
        path = row["output_file"]
        if not path or not os.path.exists(path):
            return {"task_id": task_id, "output": "", "truncated": False, "available": False}
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > tail:
                fh.seek(size - tail)
            data = fh.read()
        return {"task_id": task_id, "output": data.decode(errors="replace"), "truncated": size > tail,
                "size": size, "available": True}

    async def stop_task(self, sid: str, task_id: str) -> bool:
        return await self._engines.stop_task(sid, task_id)

    def engines(self) -> list[dict[str, Any]]:
        return self._engines.describe()

    async def shutdown(self) -> None:
        await self._engines.shutdown_all()


async def _drain_quietly(stream: AsyncIterator[ProviderEvent]) -> None:
    with contextlib.suppress(Exception):
        async for _ in stream:
            pass


def _title_from(text: str) -> str:
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "New chat")
    return line[:60] + ("…" if len(line) > 60 else "")
