"""Streaming chat over WebSocket.

Protocol (mirrors geny-executor-web ``ws/stream.py``):

    client -> {"type": "chat", "input": "<text>"}
    server -> one normalized ProviderEvent JSON per message
              ({type, seq, timestamp, data})

The connection stays open across turns; send another ``chat`` message to
continue the conversation (the provider resumes via its cli_session_id).
"""

from __future__ import annotations

import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.auth import COOKIE_NAME, AuthManager
from app.services.session_service import SessionService

router = APIRouter()


@router.websocket("/ws/chat/{sid}")
async def chat_stream(websocket: WebSocket, sid: str) -> None:
    # BaseHTTPMiddleware does not see WebSocket scopes, so the auth gate is
    # enforced here explicitly: banned IPs and unauthenticated sockets are
    # rejected at the handshake.
    auth: AuthManager = websocket.app.state.auth
    ip = auth.client_ip(websocket)  # type: ignore[arg-type]
    # Token from cookie (web) or ?token= query param (native clients).
    token = websocket.cookies.get(COOKIE_NAME) or websocket.query_params.get("token")
    if auth.is_banned(ip) or not auth.verify_token(token):
        await websocket.close(code=4401)
        return

    await websocket.accept()
    svc: SessionService = websocket.app.state.session_service

    try:
        svc.get(sid)
    except KeyError:
        await websocket.send_json(
            {"type": "error", "seq": 0, "data": {"code": "session.not_found", "message": sid}}
        )
        await websocket.close()
        return

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") != "chat":
                continue
            text = (msg.get("input") or "").strip()
            if not text:
                continue

            try:
                async for ev in svc.run_turn(sid, text):
                    await websocket.send_json(ev.to_dict())
            except Exception as exc:  # noqa: BLE001 - never kill the socket on turn error
                await websocket.send_json(
                    {
                        "type": "error",
                        "seq": 0,
                        "data": {"code": "exec.turn.crashed", "message": str(exc)[:1000]},
                    }
                )
    except WebSocketDisconnect:
        return
