"""Session lifecycle + turn execution.

A session binds a provider, a workspace (local or remote), and a conversation.
Running a turn:

1. persist the user message,
2. resolve cwd (+ optional MCP config) from the workspace connector,
3. resolve credentials from the provider service,
4. stream normalized events from the provider, persisting each,
5. on ``turn.complete`` persist the assistant message and remember the
   provider-side ``cli_session_id`` so the next turn resumes.
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any, AsyncIterator

from app.db import Database
from app.providers import get_provider
from app.providers.base import ProviderEvent, TurnRequest
from app.services._ids import new_id, now_iso
from app.services.provider_service import ProviderService
from app.services.workspace_service import WorkspaceService
from app.providers.accounts import AccountPool, classify_error

if TYPE_CHECKING:
    from app.services.attachment_service import AttachmentService
    from app.services.log_service import LogService


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
    ) -> dict[str, Any]:
        get_provider(provider)  # validate
        sid = new_id("sess_")
        now = now_iso()
        self._db.execute(
            """
            INSERT INTO sessions
                (id, title, provider, model, effort, connection_id, workspace_path,
                 cli_session_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (sid, title, provider, model, effort, connection_id, workspace_path, now, now),
        )
        return self.get(sid)

    def update(
        self,
        sid: str,
        *,
        provider: str | None = None,
        model: str | None = None,
        effort: str | None = None,
    ) -> dict[str, Any]:
        """Change engine/model/think level mid-conversation. Switching provider
        resets the provider-side session id (the new engine starts fresh, but
        the message history is still replayed as context)."""
        session = self.get(sid)
        sets: list[str] = []
        params: list[Any] = []
        if provider is not None and provider != session["provider"]:
            get_provider(provider)  # validate
            sets += ["provider = ?", "cli_session_id = NULL"]
            params.append(provider)
        if model is not None:
            sets.append("model = ?")
            params.append(model)
        if effort is not None:
            sets.append("effort = ?")
            params.append(effort)
        if sets:
            sets.append("updated_at = ?")
            params.append(now_iso())
            params.append(sid)
            self._db.execute(f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?", params)
        return self.get(sid)

    def get(self, sid: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT * FROM sessions WHERE id = ?", (sid,))
        if row is None:
            raise KeyError(f"session not found: {sid}")
        return dict(row)

    def list_all(self) -> list[dict[str, Any]]:
        rows = self._db.query("SELECT * FROM sessions ORDER BY updated_at DESC")
        out = []
        for r in rows:
            d = dict(r)
            cnt = self._db.query_one(
                "SELECT COUNT(*) AS c FROM messages WHERE session_id = ?", (r["id"],)
            )
            d["message_count"] = cnt["c"] if cnt else 0
            out.append(d)
        return out

    def delete(self, sid: str) -> None:
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

    def events(self, sid: str) -> list[dict[str, Any]]:
        rows = self._db.query(
            "SELECT seq, type, data, created_at FROM events WHERE session_id = ? ORDER BY seq",
            (sid,),
        )
        return [
            {"seq": r["seq"], "type": r["type"], "data": json.loads(r["data"]), "timestamp": r["created_at"]}
            for r in rows
        ]

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
        self._db.execute(
            "INSERT INTO events (session_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
            (sid, ev.seq, ev.type, json.dumps(ev.data), ev.timestamp),
        )

    def _set_cli_session(self, sid: str, cli_session_id: str | None) -> None:
        if cli_session_id:
            self._db.execute(
                "UPDATE sessions SET cli_session_id = ? WHERE id = ?", (cli_session_id, sid)
            )

    # ---- turn execution ----

    async def run_turn(
        self, sid: str, user_input: str, attachment_ids: list[str] | None = None
    ) -> AsyncIterator[ProviderEvent]:
        """Run one turn. Raises ``AttachmentError`` (before anything is
        persisted) when the referenced attachments are invalid."""
        session = self.get(sid)
        rows = (
            self._attachments.pending(sid, attachment_ids)
            if attachment_ids and self._attachments is not None
            else []
        )
        msg_id = self._add_message(sid, "user", user_input)
        if rows and self._attachments is not None:
            self._attachments.link([r["id"] for r in rows], msg_id)
        attachments = [self._attachments.to_provider(r) for r in rows] if self._attachments else []

        ctx = {
            "provider": session["provider"],
            "model": session["model"],
            "effort": session.get("effort"),
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

    async def _run_turn(
        self, sid: str, session: dict[str, Any], attachments: list, ctx: dict[str, Any]
    ) -> AsyncIterator[ProviderEvent]:
        connector = self._workspaces.connector_for(session["connection_id"])
        try:
            cwd = await connector.resolve_cwd(session["workspace_path"])
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

        # Multi-account pool: lease an account when the pool is enabled. Each
        # account's auth is injected per turn so switching accounts/providers
        # always uses the right credentials.
        lease = self._pool.acquire(provider_name) if self._pool else None
        extra_env: dict[str, str] = {}
        if lease is not None:
            ctx["account"] = lease.label
            if provider_name == "claude":
                if not lease.is_primary:
                    # Pooled account: isolated creds dir (CLI reads+refreshes there).
                    extra_env["HOME"] = lease.home
                    extra_env["CLAUDE_CONFIG_DIR"] = lease.config_dir
                # Primary (host) account: no override -> uses this machine's auth.
            elif provider_name == "codex":
                extra_env["HOME"] = lease.home
                extra_env["CODEX_HOME"] = lease.config_dir
            if lease.auth_mode == "api_key" and lease.api_key:
                api_key = lease.api_key

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
        )

        final_text = ""
        err_code = err_msg = None
        tool_calls: dict[str, dict[str, Any]] = {}
        started = time.monotonic()
        try:
            async for ev in provider.run_turn_stream(req):
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
