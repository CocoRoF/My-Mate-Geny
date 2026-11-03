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
from app.providers.accounts import (
    ACCOUNT_OUTCOMES,
    PRIMARY_LABEL,
    PRIMARY_PREFIX,
    AccountPool,
    AccountUnavailable,
    classify_error,
    fmt_clock,
    limit_name,
    link_shared_state,
)
from app.providers._inline_files import prepare_inline
from app.providers.base import ProviderEvent, SteerMessage, TurnInbox, TurnRequest
from app.providers.catalog import (
    DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL, clean_auto_compact_window, context_limits,
)
from app.providers.claude_code import CLI_ENV as CLAUDE_ENV
from app.providers.claude_code import ClaudeCodeProvider
from app.providers.claude_engine import ClaudeEngine
from app.higgsfield.agent import HiggsfieldAgent, clean_settings, session_settings
from app.services._ids import new_id, now_iso
from app.services.turn_cost import needs_normalizing, normalize_events
from app.services.history_aggregates import SessionAggregates
from app.services.history_page import HistoryPager
from app.services.context_handoff import build_blocks, catchup_preamble, handoff_preamble, ENGINE_LABEL
from app.services.engines import EngineManager
from app.services import changes as change_tracker
from app.services import folder_routing
from app.services import folders as folder_model
from app.services.provider_service import ProviderService
from app.services.workspace_service import WorkspaceService

if TYPE_CHECKING:
    from app.services.attachment_service import AttachmentService
    from app.services.log_service import LogService

MODES = ("agent", "plan")
MAX_EXTRA_DIRS = folder_model.MAX_FOLDERS


def _inside(p: str, root: str) -> bool:
    p, root = p.rstrip("/") or "/", root.rstrip("/") or "/"
    return p == root or root == "/" or p.startswith(root + "/")

# A stored provider session that no longer exists (deleted transcript, other
# machine…): retry once from a full handoff instead of failing the turn.
_STOPPED = re.compile(r"doesn't want to proceed|tool use was rejected|interrupted to apply", re.I)
_STALE_RESUME = re.compile(r"no conversation found|no rollout found|thread/resume failed", re.I)
# Task fields the engine reports for a running subagent (task_progress) that
# bg_tasks doesn't keep: passed through on the live task.state message.
_LIVE_TASK_FIELDS = ("subagent_type", "activity", "last_tool_name", "tool_uses", "total_tokens", "duration_ms",
                     "parent_task_id")
# Sent (instead of the original message) when a turn that already did work is
# continued on another account after the first one hit its limit: the CLI
# session on disk holds everything up to the refused call.
_CONTINUE_AFTER_FAILOVER = (
    "[The previous request was refused because the account hit its usage limit; the conversation "
    "has moved to another account.] Continue exactly where you left off."
)
_OVERLOADED = re.compile(r"overloaded", re.I)


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
        # History pages' session-wide numbers, folded once per chat and extended
        # as events arrive (services/history_aggregates.py).
        self.history_aggregates = SessionAggregates()
        # Turns currently executing (sid -> info), surfaced on the admin page.
        self.active_runs: dict[str, dict[str, Any]] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        # Session-list change feed (/ws/sessions): every device's sidebar
        # refetches only when this version moves. Seeded from the clock so a
        # restarted server never reuses a version a client already saw.
        self._list_version = int(time.time() * 1000)
        self._list_subs: set[asyncio.Queue] = set()
        self._list_loop: asyncio.AbstractEventLoop | None = None
        # mates (persona / avatar / voice / memories) changed: same feed, own version
        self._mates_version = int(time.time() * 1000)
        self._inboxes: dict[str, TurnInbox] = {}  # running turns that accept steering
        # Chat sockets showing their chat on screen right now (sid -> socket keys): a run ending there is seen at
        # once — no "Complete" badge for the chat the user is looking at (docs/architecture.md).
        self._viewers: dict[str, set[Any]] = {}
        # Mate conversations (sessions.kind = 'mate'): hidden from the chat
        # list and its change feed. The Mate layer configures their engine
        # (``mate_engine(session, req)``) and listens for turn ends.
        self._mate_sids: set[str] = set()
        # Avatar Create conversations (kind = 'avatar', docs/avatar-create.md): hidden like mates; their engine is
        # configured by ``engine_hooks["avatar"]`` (app.avatar.service).
        self._avatar_sids: set[str] = set()
        self.engine_hooks: dict[str, Any] = {}
        # the client_msg_id of the last message a person sent (sid -> id; ``…~<device>``, frontend
        # mate/voiceOwner.ts): where the user talks from — the mate's screen capture asks that device first
        self._last_client: dict[str, str] = {}
        self.mate_engine: Any = None
        self._turn_end_listeners: list[Any] = []
        self.persistent_engines = True  # Claude: one long-lived CLI process per chat
        # Higgsfield for the chats' agents (app.higgsfield.agent; main.py sets it). None = not wired.
        self.higgsfield: HiggsfieldAgent | None = None
        self._hf_note: dict[str, str] = {}  # sid -> the Higgsfield note Codex was last told (in its message)
        # Latest plan usage an engine reported (rate_limit_event), per account
        # (admin view) and per chat (the composer shows only its own chat's).
        self.live_usage: dict[str, dict[str, Any]] = {}
        self._live_usage_by_session: dict[str, dict[str, Any]] = {}
        # Context window + auto-compact point each chat's engine last reported.
        self._ctx_limits: dict[str, dict[str, Any]] = {}
        self._engines = EngineManager(
            on_task=self._on_task,
            on_usage=self._on_usage,
            on_auto_turn=self._on_auto_turn,
            on_closed=self._on_engine_closed,
            on_subagent=self._on_subagent,
        )
        try:
            self._mate_sids = {r["id"] for r in self._db.query("SELECT id FROM sessions WHERE kind = 'mate'")}
            self._avatar_sids = {r["id"] for r in self._db.query("SELECT id FROM sessions WHERE kind = 'avatar'")}
        except Exception:  # noqa: BLE001 - very old test DBs
            pass
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
        folders: list[dict[str, Any]] | None = None,
        kind: str = "chat",
        mate_id: str | None = None,
    ) -> dict[str, Any]:
        get_provider(provider)  # validate
        model = _default_model(provider, model)
        sid = new_id("sess_")
        now = now_iso()
        wanted = folder_model.normalize(folders or [], None) + folder_model.normalize(extra_dirs or [], connection_id)
        dirs = self._clean_folders(connection_id, workspace_path, wanted)
        self._db.execute(
            """
            INSERT INTO sessions
                (id, title, provider, model, effort, connection_id, workspace_path,
                 cli_session_id, mode, extra_dirs, kind, mate_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
            """,
            (sid, title, provider, model, effort, connection_id, workspace_path,
             mode if mode in MODES else "agent", json.dumps(dirs), kind if kind in ("mate", "avatar") else "chat",
             mate_id, now, now),
        )
        if kind == "mate":
            self._mate_sids.add(sid)
        elif kind == "avatar":
            self._avatar_sids.add(sid)
        self.list_changed("created", sid)
        return self.get(sid)

    def _clean_folders(self, connection_id: str | None, workspace_path: str,
                       wanted: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Validate a chat's folders: this server's must exist here; an SSH host's must be one of the
        user's connections, with an absolute (or ~) path. The workspace itself and duplicates drop out."""
        known: set[str] | None = None
        out: list[dict[str, Any]] = []
        seen = {folder_model.key(folder_model.folder(workspace_path, connection_id))}
        for f in wanted:
            path, cid = (f.get("path") or "").strip(), f.get("connection_id") or None
            if not path:
                continue
            if cid is None:
                path = os.path.abspath(os.path.expanduser(path))
                if not os.path.isdir(path):
                    raise ValueError(f"not a directory: {path}")
            else:
                if known is None:
                    known = {c["id"] for c in self._workspaces.connections()}
                if cid not in known:
                    raise ValueError(f"unknown connection: {cid}")
                if not folder_model.is_abs(path):
                    raise ValueError(f"use an absolute path on that server: {path}")
                path = folder_model.norm_remote(path)
            item = folder_model.folder(path, cid)
            k = folder_model.key(item)
            if k in seen:
                continue
            seen.add(k)
            out.append(item)
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
        folders: list[dict[str, Any]] | None = None,
        title: str | None = None,
        auto_compact_window: int | None = None,
        account_id: str | None = None,
        higgsfield: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Change engine/model/think level/mode/folders mid-conversation.
        Switching provider resets the provider-side session id.

        ``auto_compact_window``: tokens, 0 = the CLI's default, -1 = back to
        the global default (applies at the next turn: the engine restarts).
        ``account_id``: run this chat on that account from the next turn
        (a manual switch; the balancer keeps it there while it's usable).
        ``higgsfield``: {enabled?, max_credits?} — off takes the chat's
        Higgsfield credentials away at once (a running engine included)."""
        session = self.get(sid)
        sets: list[str] = []
        params: list[Any] = []
        if higgsfield is not None:
            hf = clean_settings(higgsfield, session.get("higgsfield"))
            sets.append("higgsfield = ?")
            params.append(json.dumps(hf))
            if not hf["enabled"] and self.higgsfield is not None:
                self.higgsfield.revoke(sid)
        if auto_compact_window is not None:
            sets.append("auto_compact_window = ?")
            params.append(None if auto_compact_window < 0 else clean_auto_compact_window(auto_compact_window))
        if account_id is not None:
            prov = provider or session["provider"]
            if self._pool is None or not self._pool_enabled(prov):
                raise ValueError("turn on load balancing to choose an account")
            if account_id not in self._pool.labels(prov):
                raise ValueError(f"unknown account: {account_id}")
            accounts = dict(session.get("accounts") or {})
            accounts[prov] = {**(accounts.get(prov) or {}), "id": account_id, "manual": True, "at": now_iso()}
            sets.append("accounts = ?")
            params.append(json.dumps(accounts))
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
            params.append(_default_model(provider or session["provider"], model))
        if effort is not None:
            sets.append("effort = ?")
            params.append(effort)
        if mode is not None:
            if mode not in MODES:
                raise ValueError(f"unknown mode: {mode}")
            sets.append("mode = ?")
            params.append(mode)
        if folders is not None or extra_dirs is not None:
            cid = session["connection_id"]
            wanted = (folder_model.normalize(folders, None) if folders is not None
                      else folder_model.merge_legacy(session["folders"], extra_dirs or [], cid))
            dirs = self._clean_folders(cid, session["workspace_path"], wanted)
            sets.append("extra_dirs = ?")
            params.append(json.dumps(dirs))
            # the Git button's repo was in a folder that's gone: back to the workspace's own
            # (only where the paths compare as written: absolute ones — remote "~/x" folders are left alone)
            repo = session.get("git_repo")
            if repo:
                rhost = session.get("git_repo_host")
                roots = [session["workspace_path"]] if (rhost or None) == (cid or None) else []
                roots += [f["path"] for f in dirs if (f["connection_id"] or None) == (rhost or None)]
                if all(r.startswith("/") for r in roots) and not any(_inside(repo, r) for r in roots):
                    sets += ["git_repo = NULL", "git_repo_conn = NULL"]
        if title is not None and title.strip():
            sets.append("title = ?")
            params.append(title.strip()[:200])
        if sets:
            sets.append("updated_at = ?")
            params.append(now_iso())
            params.append(sid)
            self._db.execute(f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?", params)
            self.list_changed("updated", sid)
        return self.get(sid)

    def set_git_repo(self, sid: str, path: str | None, connection_id: str | None = None) -> dict[str, Any]:
        """The top bar's Git repo: a path, ``""`` = none (disconnected), None = the workspace's (auto);
        ``connection_id``: the host it is on (None = this server)."""
        self.get(sid)
        host = (connection_id or "local") if path else None
        self._db.execute("UPDATE sessions SET git_repo = ?, git_repo_conn = ?, updated_at = ? WHERE id = ?",
                         (path, host, now_iso(), sid))
        self.list_changed("updated", sid)
        return self.get(sid)

    @staticmethod
    def git_repo_host(session: dict[str, Any]) -> str | None:
        """The host of the chat's chosen Git repo: a connection id, or None = this server
        (a repo chosen before hosts were stored: the workspace's host)."""
        h = session.get("git_repo_conn")
        if h is None:
            return session.get("connection_id") or None
        return None if h == "local" else h

    def _row(self, row: Any) -> dict[str, Any]:
        d = dict(row)
        for key, empty in (("cli_info", {}), ("cli_sessions", {}), ("accounts", {})):
            try:
                d[key] = json.loads(d.get(key) or json.dumps(empty))
            except ValueError:
                d[key] = empty
        # additional folders: (host, path) pairs; ``extra_dirs`` stays the old view (the workspace's host only)
        d["folders"] = folder_model.normalize(d.get("extra_dirs") or "[]", d.get("connection_id"))
        d["extra_dirs"] = folder_model.legacy_paths(d["folders"], d.get("connection_id"))
        if d.get("git_repo"):
            d["git_repo_host"] = self.git_repo_host(d)
        d.pop("git_repo_conn", None)
        d["higgsfield"] = session_settings(d)
        d["running"] = d["id"] in self._tasks
        d["result_unseen"] = _unseen(d.get("last_result"), d.get("last_result_at"), d.get("last_seen_at"))
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
            FROM sessions s WHERE COALESCE(s.kind, 'chat') NOT IN ('mate', 'avatar') ORDER BY s.updated_at DESC
            """
        )
        # Background tasks still running (subagents, background shells): the
        # chat is still working even when no turn is (the sidebar shows it).
        bg = {
            r["session_id"]: r["n"]
            for r in self._db.query(
                "SELECT session_id, COUNT(*) AS n FROM bg_tasks WHERE status IN ('running', 'pending') GROUP BY session_id"
            )
        }
        out = []
        for r in rows:
            d = self._row(r)
            d.pop("cli_info", None)  # large; fetched per session
            d["background"] = bg.get(d["id"], 0)
            out.append(d)
        return out

    def delete(self, sid: str) -> None:
        task = self._tasks.get(sid)
        if task is not None and not task.done():
            task.cancel()
        self._retire_engine(sid, "session deleted")
        self._live_usage_by_session.pop(sid, None)
        self._viewers.pop(sid, None)
        self.history_aggregates.drop(sid)
        self._hf_note.pop(sid, None)
        if self.higgsfield is not None:
            self.higgsfield.forget(sid)
        self._db.execute("DELETE FROM sessions WHERE id = ?", (sid,))
        if self._attachments is not None:
            self._attachments.purge_session(sid)
        self.list_changed("deleted", sid)
        self._mate_sids.discard(sid)
        self._avatar_sids.discard(sid)

    def messages(self, sid: str) -> list[dict[str, Any]]:
        rows = self._db.query(
            "SELECT id, role, content, provider, model, meta, created_at FROM messages WHERE session_id = ? "
            "ORDER BY created_at",
            (sid,),
        )
        by_msg = self._attachments.by_message(sid) if self._attachments is not None else {}
        return [{**dict(r), "meta": _json_or_none(r["meta"]), "attachments": by_msg.get(r["id"], [])} for r in rows]

    def events(self, sid: str, after: int = 0) -> list[dict[str, Any]]:
        # Insertion order (row id), NOT seq: seq restarts at 1 every turn.
        rows = self._db.query(
            "SELECT id, seq, type, data, created_at FROM events WHERE session_id = ? AND id > ? ORDER BY id",
            (sid, after),
        )
        out = [
            {"eid": r["id"], "seq": r["seq"], "type": r["type"], "data": json.loads(r["data"]),
             "timestamp": r["created_at"]}
            for r in rows
        ]
        if any(needs_normalizing(e["type"], e["data"]) for e in out):
            # Legacy turns hold the engine's running cost total: hand out per-turn
            # values (the same normalization the Usage page uses). A tail read
            # needs the session's earlier terminal events for the running total.
            prior = [] if not after else [
                json.loads(r["data"]) for r in self._db.query(
                    "SELECT data FROM events WHERE session_id = ? AND id <= ? "
                    "AND type IN ('turn.complete', 'error') ORDER BY id",
                    (sid, after),
                )
            ]
            normalize_events(out, prior)
        return out

    def history_page(self, sid: str, *, turns: int | None = None, before: str | None = None,
                     since: str | None = None, lite: bool = False) -> dict[str, Any]:
        """A slice of the history, whole turns at a time (services/history_page.py);
        ``lite``: big tool payloads as previews etc. (services/history_lite.py)."""
        pager = HistoryPager(self._db, self._attachments.by_message if self._attachments is not None else None,
                             self.history_aggregates)
        running = [] if before is not None else [
            dict(r) for r in self._db.query(
                "SELECT tool_use_id, started_at FROM bg_tasks WHERE session_id = ? "
                "AND status IN ('running', 'pending') AND tool_use_id IS NOT NULL",
                (sid,),
            )
        ]
        return pager.page(sid, turns=turns, before=before, since=since, running_tasks=running,
                          lite=lite, running=self.is_running(sid))

    def events_by_id(self, sid: str, eids: list[int]) -> list[dict[str, Any]]:
        """These events of this chat as stored (what a lite page previewed),
        terminal events normalized per turn like every history read."""
        out: list[dict[str, Any]] = []
        want = sorted({int(e) for e in eids})
        terminal: dict[int, dict[str, Any]] | None = None
        for k in range(0, len(want), 500):
            chunk = want[k:k + 500]
            for r in self._db.query(
                "SELECT id, seq, type, data, created_at FROM events "
                f"WHERE session_id = ? AND id IN ({','.join('?' * len(chunk))}) ORDER BY id",
                (sid, *chunk),
            ):
                data = json.loads(r["data"])
                if r["type"] in ("turn.complete", "error"):
                    if terminal is None:
                        terminal = self.history_aggregates.get(self._db, sid).terminal_by_eid
                    data = dict(terminal.get(r["id"], data))
                out.append({"eid": r["id"], "seq": r["seq"], "type": r["type"], "data": data,
                            "timestamp": r["created_at"]})
        return out

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

    def seed_message(self, sid: str, role: str, content: str, *, meta: dict[str, Any] | None = None,
                     provider: str | None = None, model: str | None = None) -> str:
        """A message no engine has to be told about (e.g. a mate's scripted
        greeting, which its system prompt already mentions): kept in history,
        left out of context handoffs."""
        mid = self._add_message(sid, role, content, provider, model, meta)
        row = self._db.query_one("SELECT created_at FROM messages WHERE id = ?", (mid,))
        self._db.execute("UPDATE sessions SET context_floor = ? WHERE id = ?", (row["created_at"], sid))
        return mid

    # ---- persistence helpers ----

    def _add_message(
        self, sid: str, role: str, content: str, provider: str | None = None, model: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> str:
        mid = new_id("msg_")
        self._db.execute(
            "INSERT INTO messages (id, session_id, role, content, provider, model, meta, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (mid, sid, role, content, provider, model, json.dumps(meta) if meta else None, now_iso()),
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
        if msg.get("type") == "run.state":
            self.list_changed("running" if msg["data"].get("running") else "idle", sid)

    # ---- session-list change feed (/ws/sessions) ----

    @property
    def list_version(self) -> int:
        return self._list_version

    def subscribe_list(self) -> asyncio.Queue:
        self._list_loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._list_subs.add(q)
        return q

    def unsubscribe_list(self, q: asyncio.Queue) -> None:
        self._list_subs.discard(q)

    def list_changed(self, reason: str, sid: str | None = None) -> None:
        """The session list changed (created / renamed / deleted / a turn
        started or ended / account moved): tell every open sidebar. Only a
        version is sent — clients coalesce bursts and refetch once.
        Mate conversations aren't in that list: their changes aren't announced."""
        if sid is not None and self.is_hidden(sid):
            return
        self._list_version += 1
        self._publish_list({"type": "sessions.changed",
                            "data": {"version": self._list_version, "reason": reason, "sid": sid}})

    @property
    def mates_version(self) -> int:
        return self._mates_version

    def mates_changed(self, reason: str, mate_id: str | None = None) -> None:
        """A mate was created / changed / deleted (or its memories, or the
        global voice settings): every open window (overlay, quick chat, other
        devices) refetches GET /api/mates — otherwise a window keeps the mate it
        loaded at startup (e.g. the old voice volume). Only a version is sent."""
        self._mates_version += 1
        self._publish_list({"type": "mates.changed",
                            "data": {"version": self._mates_version, "reason": reason, "mate_id": mate_id}})

    def broadcast_list(self, msg: dict[str, Any]) -> None:
        """Push another message type on this feed (e.g. ``cli.changed`` / ``cli.log``, services/cli_tools)."""
        self._publish_list(msg)

    def _publish_list(self, msg: dict[str, Any]) -> None:
        loop = self._list_loop
        if loop is None or loop.is_closed():
            return
        try:
            here = asyncio.get_running_loop()
        except RuntimeError:
            here = None
        if here is loop:
            self._fan_out_list(msg)
        else:  # called from a worker thread
            loop.call_soon_threadsafe(self._fan_out_list, msg)

    def _fan_out_list(self, msg: dict[str, Any]) -> None:
        for q in list(self._list_subs):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:  # a stuck socket drops out; it resyncs on reconnect
                self._list_subs.discard(q)

    def is_running(self, sid: str) -> bool:
        return sid in self._tasks

    def is_mate_session(self, sid: str) -> bool:
        return sid in self._mate_sids

    def is_hidden(self, sid: str) -> bool:
        """Not a chat (a mate's or an Avatar Create conversation): never in the chat list or its feed."""
        return sid in self._mate_sids or sid in self._avatar_sids

    def running_task_count(self, sid: str) -> int:
        """Background tasks the chat's live engine is still running."""
        slot = self._engines.slot(sid)
        return len(slot.engine.running_tasks) if slot is not None else 0

    def add_turn_end_listener(self, cb: Any) -> None:
        """``cb(sid, outcome)`` after every turn (user, mate or auto) ends;
        outcome = {status: ok|error|stopped, text, error, trigger: turn|auto,
        input + meta (a turn started by a message: what was sent, and its meta)}."""
        self._turn_end_listeners.append(cb)

    def _turn_ended(self, sid: str, outcome: dict[str, Any]) -> None:
        for cb in list(self._turn_end_listeners):
            try:
                cb(sid, outcome)
            except Exception as exc:  # noqa: BLE001 - a listener must never break the turn loop
                self._log("error", "system", f"turn-end listener failed: {exc}", code="turn.listener_failed",
                          detail={"traceback": traceback.format_exc()}, session_id=sid)

    # ---- "Complete" until seen: how the last run ended, and whether anyone has looked since ----

    def set_viewing(self, sid: str, key: Any, visible: bool) -> None:
        """A chat socket says whether its chat is on screen (``key``: the socket). Shown → what ended there is
        seen now; a run ending while it stays shown is seen as it ends."""
        if visible:
            self._viewers.setdefault(sid, set()).add(key)
            with contextlib.suppress(KeyError):  # (deleted meanwhile)
                self.mark_seen(sid)
        else:
            keys = self._viewers.get(sid)
            if keys is not None:
                keys.discard(key)
                if not keys:
                    self._viewers.pop(sid, None)

    def is_viewed(self, sid: str) -> bool:
        return bool(self._viewers.get(sid))

    def mark_seen(self, sid: str) -> bool:
        """The chat was opened: its last result is no longer new (announced on the list feed when it was)."""
        row = self._db.query_one("SELECT last_result, last_result_at, last_seen_at FROM sessions WHERE id = ?", (sid,))
        if row is None:
            raise KeyError(f"session not found: {sid}")
        if not _unseen(row["last_result"], row["last_result_at"], row["last_seen_at"]):
            return False
        self._db.execute("UPDATE sessions SET last_seen_at = ? WHERE id = ?", (now_iso(), sid))
        self.list_changed("seen", sid)
        return True

    def _record_result(self, sid: str, outcome: dict[str, Any]) -> None:
        """A run ended (a turn, or one Claude started on its own after background work): how, and when — the
        sidebar shows it until the chat is opened (seen at once when it is on screen now). Before the run's
        idle state is announced, so that list fetch already has it. Mate conversations aren't listed: skipped."""
        if self.is_hidden(sid):
            return
        status = outcome.get("status")
        if outcome.get("trigger") == "auto" and status == "error" and not outcome.get("error"):
            return  # an auto turn with no ending of its own (a user turn took over): that turn's result counts
        result = status if status in ("ok", "error", "stopped") else "error"
        at = now_iso()
        try:
            if self.is_viewed(sid):
                self._db.execute("UPDATE sessions SET last_result = ?, last_result_at = ?, last_seen_at = ? WHERE id = ?",
                                 (result, at, at, sid))
            else:
                self._db.execute("UPDATE sessions SET last_result = ?, last_result_at = ? WHERE id = ?",
                                 (result, at, sid))
        except Exception:  # noqa: BLE001 - e.g. the session was just deleted; never breaks the turn loop
            pass

    def add_notice(self, sid: str, code: str, message: str, level: str = "info", **extra: Any) -> dict[str, Any]:
        """Persist + publish an inline notice in a session."""
        ev = ProviderEvent(type="notice", data={"level": level, "code": code, "message": message, **extra})
        self._add_event(sid, ev)
        self._publish(sid, ev.to_dict())
        return ev.to_dict()

    # ---- background turns ----

    def start_turn(
        self,
        sid: str,
        user_input: str,
        attachment_ids: list[str] | None = None,
        client_msg_id: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> None:
        """Validate and launch a turn in the background. Raises
        ``TurnBusyError`` / ``AttachmentError`` / ``KeyError`` synchronously.
        ``meta`` is kept with the user message (and sent on its
        ``user.message`` event): ``via`` = sent by a mate, ``internal`` =
        made by the system, not typed."""
        if sid in self._tasks:
            raise TurnBusyError("a turn is already running in this session")
        self.get(sid)
        rows = (
            self._attachments.pending(sid, attachment_ids)
            if attachment_ids and self._attachments is not None
            else []
        )
        task = asyncio.create_task(self._drive(sid, user_input, rows, client_msg_id, meta))
        self._tasks[sid] = task
        self._note_client(sid, client_msg_id)

    def _note_client(self, sid: str, client_msg_id: Any) -> None:
        if isinstance(client_msg_id, str) and client_msg_id:
            self._last_client[sid] = client_msg_id[:200]

    def last_client_device(self, sid: str) -> str | None:
        """The device (``…~<device>`` of its client_msg_id) the latest typed message came from; None: unknown."""
        cid = self._last_client.get(sid) or ""
        dev = cid.rsplit("~", 1)[1] if "~" in cid else ""
        return dev if dev and len(dev) <= 80 else None

    async def steer(
        self,
        sid: str,
        text: str,
        attachment_ids: list[str] | None = None,
        client_msg_id: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> bool:
        """Deliver extra instructions into the RUNNING turn. Returns False when
        the turn can't take input any more (caller sends it as the next turn).
        Raises ``AttachmentError`` for invalid attachments."""
        inbox = self._inboxes.get(sid)
        if inbox is None or not inbox.open:
            return False
        session = self.get(sid)
        self._note_client(sid, client_msg_id)
        rows = (
            self._attachments.pending(sid, attachment_ids)
            if attachment_ids and self._attachments is not None
            else []
        )
        atts = [self._attachments.to_provider(r) for r in rows] if self._attachments else []
        inline = session.get("kind") in ("mate", "avatar")  # no file tools: contents go into the message
        if atts and inline:
            await asyncio.to_thread(prepare_inline, atts)
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
            mid = self._add_message(sid, "steer", text, meta=meta)
            if rows and self._attachments is not None:
                self._attachments.link([r["id"] for r in rows], mid)
            ev = ProviderEvent(type="user.steer", data={
                "text": text,
                "client_msg_id": client_msg_id,
                "message_id": mid,
                "attachments": [self._attachments.out(r) for r in rows] if self._attachments else [],
                **(meta or {}),
            })
            self._add_event(sid, ev)
            self._publish(sid, ev.to_dict())

        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        msg = SteerMessage(text=text, attachments=atts, delivered=fut, on_delivered=record, inline_files=inline)
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
        self, sid: str, user_input: str, rows: list[dict[str, Any]], client_msg_id: str | None,
        meta: dict[str, Any] | None = None,
    ) -> None:
        self._publish(sid, {"type": "run.state", "data": {"running": True}})
        outcome: dict[str, Any] = {"status": "error", "text": "", "error": None, "trigger": "turn",
                                   "input": (user_input or "")[:4000], "meta": meta}
        try:
            async for ev in self.run_turn(sid, user_input, rows=rows, client_msg_id=client_msg_id, meta=meta):
                _note_outcome(outcome, ev)
                self._publish(sid, ev.to_dict())
        except asyncio.CancelledError:
            ev = ProviderEvent(type="error", data={"code": "turn.interrupted", "message": "Stopped by user"})
            _note_outcome(outcome, ev)
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
            _note_outcome(outcome, ev)
            self._add_event(sid, ev)
            self._publish(sid, ev.to_dict())
        finally:
            self._tasks.pop(sid, None)
            self._record_result(sid, outcome)
            self._publish(sid, {"type": "run.state", "data": {"running": False}})
            self._turn_ended(sid, outcome)

    async def run_turn(
        self,
        sid: str,
        user_input: str,
        attachment_ids: list[str] | None = None,
        *,
        rows: list[dict[str, Any]] | None = None,
        client_msg_id: str | None = None,
        meta: dict[str, Any] | None = None,
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
        msg_id = self._add_message(sid, "user", user_input, meta=meta)
        if rows and self._attachments is not None:
            self._attachments.link([r["id"] for r in rows], msg_id)
        attachments = [self._attachments.to_provider(r) for r in rows] if self._attachments else []
        if attachments and session.get("kind") in ("mate", "avatar"):
            # A mate can't open files: their readable text goes into the message.
            await asyncio.to_thread(prepare_inline, attachments)
        # Other tabs/devices watching this session render the user's bubble.
        self._publish(sid, {"type": "user.message", "data": {
            "message_id": msg_id, "client_msg_id": client_msg_id, "text": user_input,
            "attachments": [self._attachments.out(r) for r in rows] if self._attachments else [],
            **(meta or {}),
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
        try:
            cwd = await connector.resolve_cwd(session["workspace_path"])
            # the chat's folders on this server and on SSH hosts: --add-dir paths, the remote
            # bridge (one allow-listed entry per host) and the agent's note (services/folder_routing.py)
            routing = await folder_routing.plan(
                session, self._workspaces,
                uploads_remote=f"~/.hr-harnessor/uploads/{sid}" if session["connection_id"] else None)
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

        mcp_config = routing.mcp_config
        local_extra = routing.local_dirs
        if routing.missing:
            ev = ProviderEvent(type="notice", data={
                "level": "warning", "code": "folders.missing",
                "message": "Skipped missing folder(s): " + ", ".join(routing.missing),
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
        holder: dict[str, Any] = {"notices": []}
        if not persistent and self._pool is not None:
            # Sticky like an engine; may fetch plan usage over HTTPS: off the event loop.
            try:
                lease = await asyncio.to_thread(
                    self._pool.select, provider_name, prefer=self._sticky_account(session, provider_name),
                    begin_turn=True,
                )
            except AccountUnavailable as exc:
                ev = self._unavailable_event(provider_name, exc)
                self._add_event(sid, ev)
                yield ev
                return
            if lease is not None:
                self._remember_account(sid, provider_name, lease)
                note = self._switch_notice(lease)
                if note is not None:
                    holder["notices"].append(note)
                self._log_lease(sid, provider_name, lease, ctx, "turn")
        if not persistent:  # (an engine says which account it holds once it's up)
            ctx.update(self._account_ref(provider_name, lease, api_key))
        if lease is not None:
            if not lease.is_primary:
                await asyncio.to_thread(link_shared_state, provider_name, lease.account_id)
                if provider_name == "claude":
                    extra_env["CLAUDE_CONFIG_DIR"] = lease.config_dir
                elif provider_name == "codex":
                    extra_env["CODEX_HOME"] = lease.config_dir
            if lease.auth_mode == "api_key" and lease.api_key:
                api_key = lease.api_key
        run = self.active_runs.get(sid)
        if run is not None and ctx.get("account"):
            run["account"] = ctx["account"]

        # Context: this engine's own session + whatever of the chat it hasn't
        # seen (full handoff after a provider switch, catch-up when returning).
        resume_id, preamble, ctx_kind, ctx_n = self._context_for(session, provider_name, msg_id)

        uploads_dir = None
        if self._attachments is not None:
            d = self._attachments.session_dir(sid)
            d.mkdir(parents=True, exist_ok=True)
            uploads_dir = str(d)

        hf = await self._higgsfield_launch(sid, session, provider_name)
        for note in (hf.notices if hf is not None else []):
            holder["notices"].append(ProviderEvent(type="notice", data=note))

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
            folders_note=routing.note,
            inbox=TurnInbox(),
            preamble=preamble,
            uploads_dir=uploads_dir,
            inline_files=session.get("kind") in ("mate", "avatar"),
            auto_compact_window=self.auto_compact_window(session) if provider_name == "claude" else 0,
            tool_env=dict(hf.env) if hf is not None else {},
            system_append=hf.prompt if hf is not None else "",
            plugin_dirs=list(hf.plugin_dirs) if hf is not None else [],
        )
        if provider_name == "codex" and req.system_append:
            # Codex hears the note in its message: in a new thread, or when it changed since it was told
            req.note_in_prompt = not resume_id or self._hf_note.get(sid) != req.system_append
            self._hf_note[sid] = req.system_append
        if session.get("kind") == "mate" and self.mate_engine is not None:
            # A Mate's engine: its own system prompt, no built-in tools, only
            # the mate MCP bridge (see app.mate.service).
            self.mate_engine(session, req)
        elif session.get("kind") in self.engine_hooks:
            # Avatar Create: its own prompt and only its own tools (app.avatar.service)
            self.engine_hooks[session["kind"]](session, req)
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
        if hf is not None and hf.enabled:
            st["hf"] = {"account": hf.account_id, "since": hf.started_at}
        st["changes"] = await self._snapshot_before(session, connector)
        noted = False
        stale_retried = failed_over = False
        worked = False  # the turn did something (tool call, text…) on any attempt
        try:
            for attempt in range(3):  # first try + at most one stale-session retry + one account failover
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
                    if ev.type == "error" and persistent and not failed_over:
                        moved = await self._failover(sid, req, holder, ev, ctx, st, worked)
                        if moved:
                            # The account hit its limit: the same turn continues
                            # on another account (resumed), once.
                            failed_over = retry = True
                            break
                        for note in holder.pop("after", []):
                            await self._record_event(sid, note, st)
                            yield note
                    if (
                        ev.type == "error" and not stale_retried and req.cli_session_id and not progressed
                        and not worked and _STALE_RESUME.search(str(ev.data.get("message") or ""))
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
                        stale_retried = retry = True
                        break
                    if ev.type == "session.start":
                        if attempt == 0:
                            await self._record_event(sid, ev, st)
                            yield ev
                        # (a retry continues the turn: it already has its start event)
                        for note in holder["notices"]:  # account switch / engine restart, right after the start
                            self._add_event(sid, note)
                            yield note
                        holder["notices"] = []
                        continue
                    if ev.type in ("turn.complete", "error") and st.get("carry_cost"):
                        # Spent on the account that hit its limit, earlier in this turn.
                        ev.data = {**ev.data, "cost_usd": round(float(ev.data.get("cost_usd") or 0) + st["carry_cost"], 6)}
                    if ev.type not in ("session.start", "task.update", "context.update"):
                        if ev.type != "notice":
                            worked = True
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
                        spent = await self._higgsfield_spent(st)
                        if spent is not None:
                            await self._record_event(sid, spent, st)
                            yield spent
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
            if self._pool is not None and outcome_lease is not None:
                self._pool.end_turn(outcome_lease)  # the engine keeps its lease; the turn is over

    # ---- Higgsfield (app.higgsfield.agent) ----

    def is_live(self, sid: str) -> bool:
        """A turn runs or the chat's engine is up: its agent may still call a CLI."""
        return sid in self._tasks or sid in self.active_runs or self._engines.slot(sid) is not None

    def exists(self, sid: str) -> bool:
        return self._db.query_one("SELECT 1 FROM sessions WHERE id = ?", (sid,)) is not None

    async def _higgsfield_launch(self, sid: str, session: dict[str, Any], provider: str) -> Any:
        """What this turn's engine gets from Higgsfield (None: not connected, a Mate, or not wired). Never fails
        the turn."""
        if self.higgsfield is None or session.get("kind") in ("mate", "avatar"):
            return None
        try:
            return await self.higgsfield.launch(sid, session, provider=provider)
        except Exception as exc:  # noqa: BLE001
            self._log("warning", "higgsfield", f"could not prepare Higgsfield for the chat: {type(exc).__name__}",
                      code="higgsfield.launch_failed", session_id=sid)
            return None

    def _higgsfield_account(self, session: dict[str, Any]) -> str | None:
        if self.higgsfield is None or session.get("kind") in ("mate", "avatar") or not session_settings(session)["enabled"]:
            return None
        return self.higgsfield.service.default_id()

    async def _higgsfield_spent(self, st: dict[str, Any]) -> ProviderEvent | None:
        """After a turn that ran the higgsfield CLI: what it spent (from the account's transactions), as a notice.
        Once per turn."""
        hf = st.get("hf")
        if not hf or not hf.get("used") or hf.get("reported") or self.higgsfield is None:
            return None
        hf["reported"] = True
        try:
            # (the turn's answer waits for this: kept short)
            spent = await asyncio.wait_for(self.higgsfield.spent_since(hf["account"], hf["since"]), timeout=8)
        except Exception:  # noqa: BLE001 - (a timeout too) it's only a notice
            return None
        if spent is None:
            return None
        used, bal = spent["credits_used"], spent["balance"]
        msg = f"Higgsfield: {used:g} credits used this turn"
        if isinstance(bal, (int, float)):
            msg += f" · {bal:,.2f} left"
        return ProviderEvent(type="notice", data={"level": "info", "code": "higgsfield.spend", "message": msg, **spent})

    # ---- shared turn bookkeeping (user turns and auto turns) ----

    @staticmethod
    def _turn_state(ctx: dict[str, Any], provider_name: str, model: str) -> dict[str, Any]:
        return {"ctx": ctx, "provider": provider_name, "model": model, "tool_calls": {},
                "started": time.monotonic(), "final_text": "", "err_code": None, "err_msg": None}

    def _session_info(self, sid: str, ev: ProviderEvent, ctx: dict[str, Any]) -> ProviderEvent:
        info = {**ev.data, "account": ctx.get("account")}
        self._db.execute("UPDATE sessions SET cli_info = ? WHERE id = ?", (json.dumps(info), sid))
        return ProviderEvent(type="session.info", data=info, seq=ev.seq, timestamp=ev.timestamp)

    def _screen_result(self, sid: str, ev: ProviderEvent, st: dict[str, Any]) -> bool:
        """A mate's ``see_screen`` result (docs/mate.md §4 "Seeing the screen"): the picture is already the
        conversation's attachment (the desktop app uploaded it) — the engine's echo of it (base64 in the tool
        result; Codex: inside a JSON dump) is never stored again: the event keeps the text and refers to that
        attachment, so the conversation shows it and no second copy lands on disk, in the events or in logs."""
        if ev.type != "tool.result" or sid not in self._mate_sids:
            return False
        call = st["tool_calls"].get(str(ev.data.get("id"))) or {}
        if not str(call.get("name") or "").endswith("__see_screen"):
            return False
        out = ev.data.get("output")
        text = out if isinstance(out, str) else ""
        try:  # (Codex: the MCP result as JSON — keep only its text parts)
            parsed = json.loads(text) if text.lstrip().startswith(("{", "[")) else None
        except ValueError:
            parsed = None
        if parsed is not None:
            parts = parsed.get("content") if isinstance(parsed, dict) else parsed
            text = "\n".join(str(p.get("text") or "") for p in (parts if isinstance(parts, list) else [])
                             if isinstance(p, dict) and p.get("type") == "text")
        elif text.lstrip().startswith(("{", "[")):  # (a dump cut short: its first text part)
            m = re.search(r'"text":\s*"((?:[^"\\]|\\.)*)"', text)
            try:
                text = json.loads(f'"{m.group(1)}"') if m else ""
            except ValueError:
                text = ""
        text = re.sub(r"[A-Za-z0-9+/=]{2000,}", "…", text)[:4000]  # (never a stray base64 run)
        images = []
        if self._attachments is not None:
            for aid in dict.fromkeys(re.findall(r"\b(att_[A-Za-z0-9_-]+)", text)):
                row = self._attachments.get(aid)
                if row is not None and row["session_id"] == sid and row["kind"] == "image":
                    images.append(self._attachments.out(row))
        data = {k: v for k, v in ev.data.items() if k != "images"}
        data["output"] = text
        if images:
            data["images"] = images
        ev.data = data
        return True

    async def _store_images(self, sid: str, ev: ProviderEvent) -> None:
        """Images a tool returned become artifacts (the event keeps references)."""
        if ev.type != "tool.result" or not ev.data.get("images") or self._attachments is None:
            return
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

    async def _record_event(self, sid: str, ev: ProviderEvent, st: dict[str, Any]) -> None:
        """Persist one turn event + side effects (assistant message, engine
        watermark, admin logs, artifact images)."""
        ctx = st["ctx"]
        if ev.type == "context.update":
            ev.data = self._context_data(sid, ev.data, st["model"])
        if not self._screen_result(sid, ev, st):
            await self._store_images(sid, ev)
        if ev.type in ("turn.complete", "error"):
            ev.data = {**ev.data, "provider": st["provider"]}  # usage is attributed per turn
        elif ev.type == "session.start":
            # Which account ran this turn — kept with the chat, so it's auditable.
            ev.data = {**ev.data, "account": ctx.get("account"), "account_id": ctx.get("account_id")}
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
            if "hf" in st and HiggsfieldAgent.ran_cli(ev.data.get("input")):
                st["hf"]["used"] = True
            run = self.active_runs.get(sid)
            if run is not None:
                run["tools"] += 1
        elif ev.type == "tool.result" and ev.data.get("is_error") and not _STOPPED.search(str(ev.data.get("output") or "")):
            # (a call cut off by Stop is the user's action, not a malfunction)
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
            st["api_error"] = ev.data.get("api_error")
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
            outcome = classify_error(st["err_code"], st["err_msg"], st.get("api_error"))
            self._pool.record_outcome(lease, ok=False, code=outcome, error=st["err_msg"],
                                      until=_reset_of(st.get("api_error")))
            self._log("warning", "account", f"{provider_name} account '{lease.label}' failed a turn ({outcome})",
                      code=f"account.{outcome}", detail={**ctx, "error": st["err_msg"]}, session_id=sid)
        else:
            self._pool.record_outcome(lease, ok=True)
        if release:
            self._pool.release(lease)

    # ---- context window (meter) ----

    def auto_compact_window(self, session: dict[str, Any]) -> int:
        """The chat's auto-compact window: its own value, else the global
        default (Providers page), else 0 = the CLI's default."""
        own = session.get("auto_compact_window")
        if own is not None:
            return int(own)
        if self._pool is not None:
            return int(self._pool.settings("claude").get("auto_compact_window") or 0)
        return 0

    def _context_data(self, sid: str, data: dict[str, Any], model: str) -> dict[str, Any]:
        """Complete a ``context.update``: per-call sizes get the window and the
        auto-compact point the engine last reported (the CLI's own numbers),
        or — before it has — what the model and settings imply."""
        out = {**data, "at": now_iso()}
        keys = ("window", "model_window", "threshold", "auto_compact", "window_source")
        if data.get("source") == "cli" and data.get("window"):
            self._ctx_limits[sid] = {k: data.get(k) for k in keys}
            return out
        known = self._ctx_limits.get(sid)
        if known is None:
            try:
                session = self.get(sid)
            except KeyError:
                return out
            lim = context_limits(data.get("model") or model or session["model"], self.auto_compact_window(session))
            known = {**lim, "auto_compact": True, "window_source": "estimate"}
        for k in keys:
            if out.get(k) is None and known.get(k) is not None:
                out[k] = known[k]
        return out

    # ---- accounts: sticky choice, switches, failover ----

    def _pool_enabled(self, provider: str) -> bool:
        return self._pool is not None and self._pool.enabled(provider)

    @staticmethod
    def _sticky_account(session: dict[str, Any], provider: str) -> str | None:
        """The account this chat ran on last (balancing reuses it while it's
        usable). Chats from before stickiness: the last turn's account."""
        rec = (session.get("accounts") or {}).get(provider) or {}
        return rec.get("id") or None

    def _remember_account(self, sid: str, provider: str, lease: Any) -> None:
        try:
            session = self.get(sid)
        except KeyError:
            return
        accounts = dict(session.get("accounts") or {})
        cur = accounts.get(provider) or {}
        if cur.get("id") == lease.account_id and not cur.get("manual"):
            return
        accounts[provider] = {"id": lease.account_id, "label": lease.label, "at": now_iso()}
        self._db.execute("UPDATE sessions SET accounts = ? WHERE id = ?", (json.dumps(accounts), sid))
        self.list_changed("account", sid)

    def _switch_notice(self, lease: Any, *, failover: dict[str, Any] | None = None) -> ProviderEvent | None:
        """The notice for a chat moving to another account (None if it didn't)."""
        if failover is not None:
            return ProviderEvent(type="notice", data={
                "level": "warning", "code": "account.failover",
                "message": f"Account {failover['label']} {failover['why']} — continued on {lease.label}",
                "from": failover["label"], "from_id": failover["id"], "to": lease.label, "to_id": lease.account_id,
                "resets_at": failover.get("resets_at"),
            })
        if not lease.previous_id:
            return None
        prev = lease.previous_label or "the previous account"
        if lease.previous_why == "manual":
            msg = f"Switched account: {prev} → {lease.label} (chosen by hand)"
        else:
            msg = f"Switched account: {prev} → {lease.label} — {prev} {lease.previous_why or 'is unavailable'}"
        return ProviderEvent(type="notice", data={
            "level": "info", "code": "account.switched", "message": msg,
            "from": lease.previous_label, "from_id": lease.previous_id, "to": lease.label, "to_id": lease.account_id,
        })

    @staticmethod
    def _unavailable_event(provider: str, exc: AccountUnavailable, prefix: str = "") -> ProviderEvent:
        return ProviderEvent(type="error", data={
            "code": "account.unavailable", "message": prefix + str(exc),
            "earliest": _iso_or_none(exc.earliest), "provider": provider,
        })

    def _log_lease(self, sid: str, provider: str, lease: Any, ctx: dict[str, Any], what: str) -> None:
        name = "Claude engine" if what == "engine" else f"{provider} turn"
        why = {"sticky": "the chat's account", "strategy": "picked by the pool strategy"}.get(lease.reason, lease.reason)
        self._log("info", "account", f"{name} started on account '{lease.label}' ({why})",
                  code="account.leased",
                  detail={**ctx, "account": lease.label, "account_id": lease.account_id, "reason": lease.reason,
                          "previous": lease.previous_label, "previous_id": lease.previous_id,
                          "previous_why": lease.previous_why},
                  session_id=sid)

    async def _failover(self, sid: str, req: TurnRequest, holder: dict[str, Any], ev: ProviderEvent,
                        ctx: dict[str, Any], st: dict[str, Any], worked: bool) -> bool:
        """The engine's account refused the turn (usage limit, rate limit,
        signed out): cool it down until its reset, retire the engine and let
        the turn continue on another account (``--resume``: same conversation).
        Returns False (the error stands) when that isn't possible or wise."""
        slot = holder.get("slot")
        lease = getattr(slot, "lease", None)
        if lease is None or self._pool is None or not self._pool_enabled("claude"):
            return False
        code, msg = ev.data.get("code"), str(ev.data.get("message") or "")
        api_error = ev.data.get("api_error")
        outcome = classify_error(code, msg, api_error)
        if outcome not in ACCOUNT_OUTCOMES or (outcome == "rate_limited" and _OVERLOADED.search(msg)):
            return False  # not about the account (or a service-wide overload another account won't fix)
        reset = _reset_of(api_error) or (self._pool.limit_info(lease.account_id) or {}).get("resets_at")
        info = (api_error or {}).get("rate_limit_info") or self._pool.limit_info(lease.account_id) or {}
        kind = info.get("rateLimitType") or info.get("type")
        if outcome == "provider_auth":
            why = "is signed out (authentication failed)"
        elif reset:
            why = f"hit its {limit_name(kind)} (resets {fmt_clock(reset)})"
        else:
            why = "hit a usage limit" if outcome == "provider_quota" else "is rate-limited"
        self._pool.record_outcome(lease, ok=False, code=outcome, error=msg, until=reset)
        self._log("warning", "account", f"Claude account '{lease.label}' {why}", code=f"account.{outcome}",
                  detail={**ctx, "error": msg, "api_error": api_error}, session_id=sid)
        running = len(slot.engine.running_tasks)
        if running:
            # Moving means restarting the engine, which stops its background
            # work: never do that on our own — say so, and let the user decide.
            holder.setdefault("after", []).append(ProviderEvent(type="notice", data={
                "level": "warning", "code": "account.failover_held",
                "message": (f"Account {lease.label} {why}. Not switching accounts automatically: "
                            f"{running} background task{'s' if running != 1 else ''} would be stopped. "
                            "Send a message to continue on another account (this stops them)."),
            }))
            return False
        if slot.engine.cli_session_id:
            self._set_cli_session(sid, slot.engine.cli_session_id, "claude")
            req.cli_session_id = slot.engine.cli_session_id
        st["carry_cost"] = round(float(st.get("carry_cost") or 0) + float(ev.data.get("cost_usd") or 0), 6)
        await self._engines.shutdown(sid, reason="account limit")  # releases its lease
        holder["slot"] = None
        holder["avoid"] = {lease.account_id}
        holder["failover"] = {"id": lease.account_id, "label": lease.label, "why": why,
                              "resets_at": _iso_or_none(reset)}
        # The conversation (incl. this turn so far) is in the resumed session:
        # resend the request only if nothing happened yet, else ask to go on.
        holder["envelope"] = (
            None if not worked else ClaudeCodeProvider._envelope(_CONTINUE_AFTER_FAILOVER, [])
        )
        req.preamble = ""
        req.inbox = TurnInbox()
        self._inboxes[sid] = req.inbox
        return True

    def _move_reason(self, sid: str, session: dict[str, Any], slot: Any) -> str | None:
        """Why the chat's live engine should move to another account before
        this turn: its account can't serve requests (refused / signed out /
        disabled / removed), or the user picked another one."""
        if self._pool is None or slot is None or slot.lease is None or not self._pool_enabled("claude"):
            return None
        rec = (session.get("accounts") or {}).get("claude") or {}
        if rec.get("manual") and rec.get("id") and rec["id"] != slot.lease.account_id:
            return "manual"
        why, phrase = self._pool.peek("claude", slot.lease.account_id)
        if why:
            return phrase
        # Near a plan limit (e.g. 5-hour ≥ the "Move at" %) while another
        # account has headroom: move now, not only once it's refused at 100 %.
        # Not while background tasks run — a restart would kill them; the
        # next turn checks again.
        if not getattr(slot.engine, "running_tasks", None):
            soft, phrase = self._pool.near_limit_move("claude", slot.lease.account_id)
            if soft:
                return phrase
        return None

    async def _engine_turn(self, sid: str, provider: Any, req: TurnRequest, holder: dict[str, Any],
                           ctx: dict[str, Any]) -> AsyncIterator[ProviderEvent]:
        """One turn on the session's persistent Claude engine (spawned on demand)."""
        session = self.get(sid)
        live = self._engines.slot(sid)
        move = self._move_reason(sid, session, live)
        moved_from = None
        if move is not None and live is not None:
            running = len(live.engine.running_tasks)
            moved_from = live.lease
            self._log("info", "account", f"moving the chat off account '{live.lease.label}' ({move})",
                      code="account.moving", detail={**ctx, "reason": move}, session_id=sid)
            await self._engines.shutdown(sid, reason="account change")
            if running:
                holder["notices"].append(ProviderEvent(type="notice", data={
                    "level": "warning", "code": "engine.restarted",
                    "message": f"Engine restarted on another account — {running} background task(s) were stopped",
                }))
        failover = holder.pop("failover", None)
        avoid = holder.pop("avoid", set())
        prefer = self._sticky_account(session, "claude")

        def acquire() -> Any:
            if self._pool is None:
                return None
            return self._pool.select("claude", prefer=prefer, avoid=avoid, begin_turn=True)

        async def make(lease: Any) -> ClaudeEngine:
            env: dict[str, str] = {**CLAUDE_ENV, **provider.engine_env(req)}
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
                fingerprint=provider.engine_fingerprint(req), model=req.model or DEFAULT_CLAUDE_MODEL,
                mode=req.mode,
            )

        try:
            slot, fresh, note = await self._engines.ensure(
                sid,
                make_engine=make,
                fingerprint=provider.engine_fingerprint(req),
                model=req.model or DEFAULT_CLAUDE_MODEL,
                mode=req.mode,
                permission_mode=provider.permission_mode(req.mode),
                acquire_lease=acquire,
                release_lease=lambda lease: self._pool.release(lease) if self._pool else None,
            )
        except AccountUnavailable as exc:
            prefix = f"Account {failover['label']} {failover['why']}. " if failover else ""
            yield ProviderEvent(type="session.start", data={"provider": "claude", "model": req.model, "workspace": req.cwd})
            yield self._unavailable_event("claude", exc, prefix)
            return
        holder["slot"] = slot
        if note:
            holder["notices"].append(ProviderEvent(type="notice", data={
                "level": "warning", "code": "engine.restarted", "message": note}))
        # The engine keeps the account it leased at spawn for its whole life.
        if fresh or "account" not in slot.meta:
            slot.meta["account"] = self._account_ref("claude", slot.lease, req.api_key)
        ctx.update(slot.meta["account"])
        if fresh:
            self._ctx_limits.pop(sid, None)  # a new process may have other limits
            lease = slot.lease
            if lease is not None:
                self._remember_account(sid, "claude", lease)
                if moved_from is not None and moved_from.account_id != lease.account_id and not failover:
                    lease.previous_id, lease.previous_label = moved_from.account_id, moved_from.label
                    lease.previous_why = move
                switched = self._switch_notice(lease, failover=failover)
                if switched is not None:
                    holder["notices"].append(switched)
                self._log_lease(sid, "claude", lease, {**ctx, "pid": getattr(slot.engine._proc, "pid", None)}, "engine")
            else:
                self._log("info", "account", f"Claude engine started on account '{ctx['account']}'",
                          code="account.leased", detail={**ctx, "pid": getattr(slot.engine._proc, "pid", None)},
                          session_id=sid)
        elif self._pool is not None:
            self._pool.begin_turn(slot.lease)  # (a fresh lease counts its turn from the pick)
        run = self.active_runs.get(sid)
        if run is not None:
            run["account"] = ctx["account"]
        envelope = holder.pop("envelope", None) or provider.envelope(req)
        async for ev in self._engines.turn(sid, slot, envelope, req.inbox):
            yield ev

    # ---- per-turn file changes (git snapshots) ----

    def _change_runner(self, session: dict[str, Any], connection_id: str | None) -> change_tracker.ShellRunner | None:
        """A shell on the host of ``connection_id`` (None = this server)."""
        if not connection_id:
            return change_tracker.local_runner()
        try:
            prefix = getattr(self._workspaces.connector_for(connection_id), "ssh_prefix", None)
        except KeyError:
            return None
        return change_tracker.ShellRunner(prefix()) if prefix else None

    async def _snapshot_before(self, session: dict[str, Any], connector: Any = None) -> dict[str, Any] | None:
        """Git snapshots of the chat's folders before a turn — on each of their hosts."""
        by_host: dict[str | None, dict[str, Any]] = {}
        for host, roots in folder_model.roots_by_host(session).items():
            try:
                runner = self._change_runner(session, host)
                if runner is None:
                    continue
                before = await change_tracker.snapshot_all(runner, roots)
            except Exception:  # noqa: BLE001 - tracking is best-effort, never blocks a turn
                continue
            if before:
                by_host[host] = {"runner": runner, "before": before}
        return {"by_host": by_host} if by_host else None

    async def _changes_event(self, st: dict[str, Any]) -> ProviderEvent | None:
        snap = st.pop("changes", None)  # once per turn
        if not snap:
            return None
        repos = []
        for host, part in snap["by_host"].items():
            runner, before = part["runner"], part["before"]
            try:
                for root, tree in before.items():
                    after = await change_tracker.snapshot(runner, root)
                    if after is None:
                        continue
                    summary = await change_tracker.summarize(runner, root, tree, after[1])
                    if summary is not None:
                        repos.append({**summary, "connection_id": host})
            except Exception:  # noqa: BLE001
                continue
        if not repos:
            return None
        return ProviderEvent(type="turn.changes", data={
            "repos": repos,
            "files": sum(len(r["files"]) for r in repos),
            "added": sum(r["added"] for r in repos),
            "removed": sum(r["removed"] for r in repos),
        })

    @staticmethod
    def _repo_host(session: dict[str, Any], r: dict[str, Any]) -> str | None:
        # (records from before hosts were stored: the workspace's host)
        return r.get("connection_id", session.get("connection_id")) or None

    def _change_record(self, sid: str, eid: int) -> tuple[dict[str, Any], dict[str, Any]]:
        row = self._db.query_one(
            "SELECT data FROM events WHERE id = ? AND session_id = ? AND type = 'turn.changes'", (eid, sid))
        if row is None:
            raise KeyError("changes not found")
        return self.get(sid), json.loads(row["data"])

    async def changes_patch(self, sid: str, eid: int, repo: int, path: str | None) -> str:
        session, data = self._change_record(sid, eid)
        r = data["repos"][repo]
        runner = self._change_runner(session, self._repo_host(session, r))
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
        reverted: list[str] = []
        for i, r in enumerate(data["repos"]):
            if repo is not None and i != repo:
                continue
            runner = self._change_runner(session, self._repo_host(session, r))
            if runner is None:
                raise KeyError("workspace unavailable")
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
        running = self._tasks.get(sid)
        if running is not None:
            # Never two drivers for one session. The previous turn's driver is
            # usually just wrapping up (Claude reacted to a background task the
            # moment the turn ended): its events wait in the auto turn's queue
            # and are shown once that driver is done — not dropped.
            asyncio.create_task(self._drive_auto_after(sid, running, stream, inbox))
            return
        self._inboxes[sid] = inbox
        self._tasks[sid] = asyncio.create_task(self._drive_auto(sid, stream, inbox))

    async def _drive_auto_after(self, sid: str, running: asyncio.Task, stream: AsyncIterator[ProviderEvent],
                                inbox: TurnInbox) -> None:
        with contextlib.suppress(Exception, asyncio.CancelledError):
            await asyncio.wait_for(asyncio.shield(running), timeout=30)
        if sid in self._tasks:  # a user turn took over (it superseded this stream)
            await _drain_quietly(stream)
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
               "trigger": "background", **self._engine_account(slot)}
        self.active_runs[sid] = {**ctx, "session_id": sid, "title": session["title"], "started_at": now_iso(),
                                 "tools": 0, "attachments": 0}
        st = self._turn_state(ctx, "claude", session["model"])
        hf_account = self._higgsfield_account(session)
        if hf_account:
            st["hf"] = {"account": hf_account, "since": now_iso()}
        if self._pool is not None and slot is not None:
            self._pool.begin_turn(slot.lease)  # an active turn on the engine's account
        self._publish(sid, {"type": "run.state", "data": {"running": True}})
        outcome: dict[str, Any] = {"status": "error", "text": "", "error": None, "trigger": "auto"}
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
                    spent = await self._higgsfield_spent(st)
                    if spent is not None:
                        await self._record_event(sid, spent, st)
                        self._publish(sid, spent.to_dict())
                await self._record_event(sid, ev, st)
                _note_outcome(outcome, ev)
                self._publish(sid, ev.to_dict())
        except asyncio.CancelledError:
            ev = ProviderEvent(type="error", data={"code": "turn.interrupted", "message": "Stopped by user"})
            _note_outcome(outcome, ev)
            self._add_event(sid, ev)
            self._publish(sid, ev.to_dict())
        except Exception as exc:  # noqa: BLE001
            self._log("error", "ws", f"auto turn crashed: {exc}", code="exec.autoturn.crashed",
                      detail={"traceback": traceback.format_exc()}, session_id=sid)
            outcome.update(status="error", error=str(exc)[:1000])
        finally:
            if self._inboxes.get(sid) is inbox:
                self._inboxes.pop(sid, None)
            self._tasks.pop(sid, None)
            self.active_runs.pop(sid, None)
            self._report_outcome("claude", slot.lease if slot else None, st, ctx, sid, release=False)
            if self._pool is not None and slot is not None:
                self._pool.end_turn(slot.lease)
            self._record_result(sid, outcome)
            self._publish(sid, {"type": "run.state", "data": {"running": False}})
            self._turn_ended(sid, outcome)

    def _on_task(self, sid: str, task: dict[str, Any]) -> None:
        prev = self._db.query_one("SELECT status FROM bg_tasks WHERE session_id = ? AND task_id = ?",
                                  (sid, task.get("task_id")))
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
            # Started or ended: the sidebar's "working" covers background work too.
            active = ("running", "pending")
            was = prev is not None and prev["status"] in active
            if prev is None or was != (row["status"] in active):
                self.list_changed("background", sid)
            # Subagent progress (activity, tool count) is shown live, not stored.
            live = {k: task[k] for k in _LIVE_TASK_FIELDS if task.get(k) is not None}
            self._publish(sid, {"type": "task.state", "data": {**self._task_out(row), **live}})

    async def _on_subagent(self, sid: str, ev: ProviderEvent) -> None:
        """A background subagent's step while no turn runs: stored and shown
        under the Agent call that launched it (an earlier turn)."""
        try:
            self.get(sid)
        except KeyError:
            return
        await self._store_images(sid, ev)
        self._add_event(sid, ev)
        self._publish(sid, ev.to_dict())

    def _on_usage(self, sid: str, info: dict[str, Any]) -> None:
        # The engine's own account: the numbers belong to it, and only this
        # chat's subscribers get them.
        data = {**info, **self._engine_account(self._engines.slot(sid)), "provider": "claude",
                "session_id": sid, "at": now_iso()}
        if self._pool is not None:
            # Fresh numbers for balancing (and a refused account cools down now).
            self._pool.record_live("claude", data.get("account_id"), info)
        self._live_usage_by_session[sid] = data
        self.live_usage[data.get("account_id") or "claude"] = data
        self._publish(sid, {"type": "usage.update", "data": data})

    # ---- which account a chat runs on ----

    def _account_ref(self, provider: str, lease: Any, api_key: str | None = None) -> dict[str, Any]:
        """{account, account_id} for a turn/engine. No lease (pool off, or no
        pool) means the host's own login — or the configured API key."""
        if lease is not None:
            return {"account": lease.label, "account_id": lease.account_id}
        if api_key:
            return {"account": "API key", "account_id": None}
        return {"account": PRIMARY_LABEL, "account_id": f"{PRIMARY_PREFIX}{provider}"}

    def _engine_account(self, slot: Any) -> dict[str, Any]:
        if slot is None:
            return {"account": None, "account_id": None}
        return slot.meta.get("account") or self._account_ref("claude", slot.lease)

    def session_account(self, sid: str) -> dict[str, Any] | None:
        """The account this chat runs on: its live engine's, else the one the
        last turn recorded (None before the first turn)."""
        slot = self._engines.slot(sid)
        if slot is not None:
            return {**self._engine_account(slot), "provider": "claude", "live": True}
        row = self._db.query_one(
            "SELECT data FROM events WHERE session_id = ? AND type = 'session.start' ORDER BY id DESC LIMIT 1", (sid,))
        if row is None:
            return None
        try:
            d = json.loads(row["data"])
        except ValueError:
            return None
        if not d.get("account"):
            return None
        return {"account": d.get("account"), "account_id": d.get("account_id"), "provider": d.get("provider"),
                "live": False}

    def live_usage_for(self, sid: str) -> dict[str, Any] | None:
        """The plan usage this chat's engine last reported (None if it hasn't)."""
        return self._live_usage_by_session.get(sid)

    def _on_engine_closed(self, sid: str, lease: Any, reason: str) -> None:
        if self._pool is not None and lease is not None:
            self._pool.release(lease)
        # The next engine may lease another account: don't show this one's numbers as current.
        self._live_usage_by_session.pop(sid, None)
        self._ctx_limits.pop(sid, None)
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
        if rows:
            self.list_changed("background", sid)
        if reason == "exited":
            self._log("warning", "provider", "Claude engine process exited", code="engine.exited", session_id=sid)

    # ---- background tasks API ----

    @staticmethod
    def _task_out(row: Any) -> dict[str, Any]:
        d = dict(row)
        d["is_backgrounded"] = bool(d.get("is_backgrounded"))
        d.pop("output_file", None)  # served through the API, never exposed as a path
        return d

    def list_tasks(self, sid: str | None = None, limit: int = 1000) -> list[dict[str, Any]]:
        if sid:
            # Every task still running (however old) + the newest others: the
            # UI treats a call whose task isn't listed as no longer running.
            rows = self._db.query(
                "SELECT * FROM bg_tasks WHERE session_id = ? AND status IN ('running', 'pending') "
                "UNION SELECT * FROM (SELECT * FROM bg_tasks WHERE session_id = ? ORDER BY started_at DESC LIMIT ?) "
                "ORDER BY started_at DESC", (sid, sid, limit))
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

    async def retire_engines(self, reason: str = "cli upgraded") -> dict[str, int]:
        """The Claude CLI binary changed: end every idle engine now and the busy ones as soon as they're idle,
        so each chat's next turn starts the new binary (``--resume`` keeps the conversation)."""
        return await self._engines.retire_stale(reason)

    async def shutdown(self) -> None:
        await self._engines.shutdown_all()


def _unseen(result: Any, result_at: Any, seen_at: Any) -> bool:
    """A run ended after the chat was last open (ISO UTC times compare as strings)."""
    return bool(result and result_at and (not seen_at or str(seen_at) < str(result_at)))


def _note_outcome(outcome: dict[str, Any], ev: ProviderEvent) -> None:
    """Track how a turn ended (its last terminal event) for turn-end listeners."""
    if ev.type == "turn.complete":
        if ev.data.get("superseded"):
            return
        outcome.update(status="ok", text=ev.data.get("text") or "", error=None)
    elif ev.type == "error":
        stopped = ev.data.get("code") == "turn.interrupted"
        outcome.update(status="stopped" if stopped else "error", error=ev.data.get("message") or ev.data.get("code"))


def _json_or_none(raw: Any) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


async def _drain_quietly(stream: AsyncIterator[ProviderEvent]) -> None:
    with contextlib.suppress(Exception):
        async for _ in stream:
            pass


def _reset_of(api_error: dict[str, Any] | None) -> float | None:
    """When the limit named by a typed API error resets (epoch seconds)."""
    info = (api_error or {}).get("rate_limit_info") or {}
    try:
        v = float(info.get("resetsAt") or 0)
    except (TypeError, ValueError):
        return None
    return v if v > time.time() else None


def _iso_or_none(ts: float | None) -> str | None:
    if not ts:
        return None
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _default_model(provider: str, model: str | None) -> str:
    """A chat without a model runs on the engine's default (Claude: Opus 5.5,
    Codex: GPT-6.1-Sol), recorded explicitly so the picker, the engine and the
    logs agree. ("default" stays: the Codex account's own default.)"""
    if not (model or "").strip():
        if provider == "claude":
            return DEFAULT_CLAUDE_MODEL
        if provider == "codex":
            return DEFAULT_CODEX_MODEL
    return model or ""


def _title_from(text: str) -> str:
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "New chat")
    return line[:60] + ("…" if len(line) > 60 else "")
