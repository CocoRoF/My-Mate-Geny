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
import json
import os
import time
import traceback
from typing import TYPE_CHECKING, Any, AsyncIterator

from app.db import Database
from app.providers import get_provider
from app.providers.accounts import AccountPool, classify_error, link_shared_state
from app.providers.base import ProviderEvent, TurnRequest
from app.services._ids import new_id, now_iso
from app.services.provider_service import ProviderService
from app.services.workspace_service import WorkspaceService

if TYPE_CHECKING:
    from app.services.attachment_service import AttachmentService
    from app.services.log_service import LogService

MODES = ("agent", "plan")
MAX_EXTRA_DIRS = 20


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
            sets += ["provider = ?", "cli_session_id = NULL", "cli_info = '{}'"]
            params.append(provider)
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
        for key, empty in (("extra_dirs", []), ("cli_info", {})):
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
        self.stop(sid)
        self._db.execute("DELETE FROM sessions WHERE id = ?", (sid,))
        if self._attachments is not None:
            self._attachments.purge_session(sid)

    def messages(self, sid: str) -> list[dict[str, Any]]:
        rows = self._db.query(
            "SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at",
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
        self._db.execute("UPDATE sessions SET cli_session_id = NULL WHERE id = ?", (sid,))
        ev = ProviderEvent(type="notice", data={
            "level": "info", "code": "context.reset",
            "message": "Context cleared — the agent starts a fresh conversation from here.",
        })
        self._add_event(sid, ev)
        self._publish(sid, ev.to_dict())
        return ev.to_dict()

    # ---- persistence helpers ----

    def _add_message(self, sid: str, role: str, content: str) -> str:
        mid = new_id("msg_")
        self._db.execute(
            "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (mid, sid, role, content, now_iso()),
        )
        self._db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now_iso(), sid))
        return mid

    def _add_event(self, sid: str, ev: ProviderEvent) -> None:
        ev.eid = self._db.insert(
            "INSERT INTO events (session_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
            (sid, ev.seq, ev.type, json.dumps(ev.data), ev.timestamp),
        )

    def _set_cli_session(self, sid: str, cli_session_id: str | None) -> None:
        if cli_session_id:
            self._db.execute(
                "UPDATE sessions SET cli_session_id = ? WHERE id = ?", (cli_session_id, sid)
            )

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

    def stop(self, sid: str) -> bool:
        task = self._tasks.get(sid)
        if task is None or task.done():
            return False
        task.cancel()
        return True

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
            async for ev in self._run_turn(sid, session, attachments, ctx):
                yield ev
        finally:
            self.active_runs.pop(sid, None)

    def _first_turn(self, sid: str) -> bool:
        row = self._db.query_one(
            "SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = 'user'", (sid,)
        )
        return bool(row) and row["c"] == 1

    async def _run_turn(
        self, sid: str, session: dict[str, Any], attachments: list, ctx: dict[str, Any]
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

        # Multi-account pool: lease an account when the pool is enabled. Only
        # the credentials dir differs per account — HOME stays the real one
        # (so ~/.ssh, ~/.gitconfig, caches all work) and everything except the
        # credentials is shared with the host config (link_shared_state).
        lease = self._pool.acquire(provider_name) if self._pool else None
        extra_env: dict[str, str] = {}
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

        req = TurnRequest(
            messages=[{"role": m["role"], "content": m["content"]} for m in history],
            model=session["model"],
            effort=session.get("effort") or "default",
            cwd=cwd,
            cli_session_id=session.get("cli_session_id"),
            mcp_config=mcp_config,
            api_key=api_key,
            extra_env=extra_env,
            attachments=attachments,
            mode=session.get("mode") or "agent",
            extra_dirs=local_extra,
        )

        final_text = ""
        err_code = err_msg = None
        tool_calls: dict[str, dict[str, Any]] = {}
        started = time.monotonic()
        try:
            async for ev in provider.run_turn_stream(req):
                if ev.type == "session.info":
                    info = {**ev.data, "account": ctx.get("account")}
                    self._db.execute("UPDATE sessions SET cli_info = ? WHERE id = ?", (json.dumps(info), sid))
                    yield ProviderEvent(type="session.info", data=info, seq=ev.seq, timestamp=ev.timestamp)
                    continue
                self._add_event(sid, ev)
                if ev.type == "turn.complete":
                    final_text = ev.data.get("text", "")
                    self._set_cli_session(sid, ev.data.get("cli_session_id"))
                elif ev.type == "tool.use":
                    tool_calls[str(ev.data.get("id"))] = {
                        "name": ev.data.get("name"), "input": ev.data.get("input"),
                    }
                    run = self.active_runs.get(sid)
                    if run is not None:
                        run["tools"] += 1
                elif ev.type == "tool.result" and ev.data.get("is_error"):
                    call = tool_calls.get(str(ev.data.get("id")), {})
                    output = str(ev.data.get("output") or "")
                    first = next((ln for ln in output.splitlines() if ln.strip()), "tool returned an error")
                    self._log(
                        "warning", "tool", first[:300],
                        code=str(call.get("name") or ev.data.get("name") or "tool"),
                        detail={**ctx, "tool_use_id": ev.data.get("id"),
                                "input": call.get("input"), "output": output},
                        session_id=sid,
                    )
                elif ev.type == "notice" and ev.data.get("level") == "warning":
                    self._log(
                        "warning", "provider", str(ev.data.get("message")),
                        code=str(ev.data.get("code") or "provider.notice"), detail=ctx, session_id=sid,
                    )
                elif ev.type == "error":
                    err_code = ev.data.get("code")
                    err_msg = ev.data.get("message")
                    self._log(
                        "error", "provider", str(err_msg or err_code),
                        code=str(err_code or "exec.error"),
                        detail={**ctx, "elapsed_s": round(time.monotonic() - started, 1),
                                "tools_run": len(tool_calls)},
                        session_id=sid,
                    )
                yield ev
        finally:
            if lease is not None and self._pool is not None:
                if err_code is not None:
                    outcome = classify_error(err_code, err_msg)
                    self._pool.report(lease, ok=False, code=outcome, error=err_msg)
                    self._log(
                        "warning", "account",
                        f"{provider_name} account '{lease.label}' failed a turn ({outcome})",
                        code=f"account.{outcome}", detail={**ctx, "error": err_msg},
                        session_id=sid,
                    )
                else:
                    self._pool.report(lease, ok=True)

        if final_text:
            self._add_message(sid, "assistant", final_text)


def _title_from(text: str) -> str:
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "New chat")
    return line[:60] + ("…" if len(line) > 60 else "")
