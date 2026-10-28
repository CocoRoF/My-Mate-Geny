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
from typing import Any, AsyncIterator

from app.db import Database
from app.providers import get_provider
from app.providers.base import ProviderEvent, TurnRequest
from app.services._ids import new_id, now_iso
from app.services.provider_service import ProviderService
from app.services.workspace_service import WorkspaceService


class SessionService:
    def __init__(
        self,
        db: Database,
        providers: ProviderService,
        workspaces: WorkspaceService,
    ) -> None:
        self._db = db
        self._providers = providers
        self._workspaces = workspaces

    # ---- CRUD ----

    def create(
        self,
        *,
        provider: str,
        model: str = "",
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
                (id, title, provider, model, connection_id, workspace_path,
                 cli_session_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (sid, title, provider, model, connection_id, workspace_path, now, now),
        )
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

    def messages(self, sid: str) -> list[dict[str, Any]]:
        rows = self._db.query(
            "SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at",
            (sid,),
        )
        return [dict(r) for r in rows]

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

    def _add_message(self, sid: str, role: str, content: str) -> None:
        self._db.execute(
            "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (new_id("msg_"), sid, role, content, now_iso()),
        )
        self._db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now_iso(), sid))

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

    async def run_turn(self, sid: str, user_input: str) -> AsyncIterator[ProviderEvent]:
        session = self.get(sid)
        self._add_message(sid, "user", user_input)

        connector = self._workspaces.connector_for(session["connection_id"])
        try:
            cwd = await connector.resolve_cwd(session["workspace_path"])
            mcp_config = await connector.mcp_config(session["workspace_path"])
        except Exception as exc:  # noqa: BLE001 - surface as a normalized error event
            ev = ProviderEvent(
                type="error", data={"code": "exec.workspace.unresolved", "message": str(exc)}
            )
            self._add_event(sid, ev)
            yield ev
            return

        history = self.messages(sid)
        api_key = self._providers.resolved_api_key(session["provider"])
        provider = get_provider(session["provider"])

        req = TurnRequest(
            messages=[{"role": m["role"], "content": m["content"]} for m in history],
            model=session["model"],
            cwd=cwd,
            cli_session_id=session.get("cli_session_id"),
            mcp_config=mcp_config,
            api_key=api_key,
        )

        final_text = ""
        async for ev in provider.run_turn_stream(req):
            self._add_event(sid, ev)
            if ev.type == "turn.complete":
                final_text = ev.data.get("text", "")
                self._set_cli_session(sid, ev.data.get("cli_session_id"))
            yield ev

        if final_text:
            self._add_message(sid, "assistant", final_text)
