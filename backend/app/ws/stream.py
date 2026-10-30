"""Streaming chat over WebSocket.

Turns run in the background (see :class:`SessionService`); a socket is just a
viewer + remote control, so closing the tab never kills the agent.

Protocol::

    client -> {"type": "attach", "after": <last eid seen>}   # on every (re)connect
    client -> {"type": "chat", "input": "<text>", "attachments": ["att_…"], "client_msg_id": "…"}
    client -> {"type": "stop"}

    server -> {"type": "run.state", "data": {"running": bool}}
    server -> {"type": "user.message", "data": {...}}         # a turn started (any tab)
    server -> normalized ProviderEvent ({type, seq, eid?, timestamp, data})

``attach`` replays persisted events with ``eid > after`` (what happened while
the client was away), then streams live; ``eid`` lets the client drop dupes.
"""

from __future__ import annotations

import asyncio
import json
import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.auth import COOKIE_NAME, AuthManager
from app.services.attachment_service import AttachmentError
from app.services.session_service import SessionService, TurnBusyError

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
    logs = websocket.app.state.logs

    try:
        svc.get(sid)
    except KeyError:
        await websocket.send_json(
            {"type": "error", "seq": 0, "data": {"code": "session.not_found", "message": sid}}
        )
        await websocket.close()
        return

    queue = svc.subscribe(sid)
    send_lock = asyncio.Lock()
    last_sent = 0  # highest eid delivered on this socket

    async def send(msg: dict) -> None:
        nonlocal last_sent
        eid = msg.get("eid")
        if eid is not None:
            if eid <= last_sent:
                return  # already delivered via replay
            last_sent = eid
        async with send_lock:
            await websocket.send_json(msg)

    async def pump() -> None:
        while True:
            await send(await queue.get())

    pump_task: asyncio.Task | None = None

    async def error(code: str, message: str) -> None:
        await send({"type": "error", "seq": 0, "data": {"code": code, "message": message}})

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")

            if kind == "attach":
                after = int(msg.get("after") or 0)
                # Subscribed before reading the backlog, so nothing falls in the
                # gap; the eid check in send() drops the overlap.
                for ev in svc.events(sid, after=after):
                    await send(ev)
                await send({"type": "run.state", "data": {"running": svc.is_running(sid)}})
                if pump_task is None:
                    pump_task = asyncio.create_task(pump())

            elif kind == "chat":
                if pump_task is None:  # old clients that never attach
                    pump_task = asyncio.create_task(pump())
                text = (msg.get("input") or "").strip()
                raw_ids = msg.get("attachments") or []
                ids = [str(a) for a in raw_ids if isinstance(a, str)] if isinstance(raw_ids, list) else []
                if not text and not ids:
                    continue
                try:
                    svc.start_turn(sid, text, ids, client_msg_id=msg.get("client_msg_id"))
                except TurnBusyError as exc:
                    await error("turn.busy", str(exc))
                except AttachmentError as exc:
                    logs.record(
                        "warning", "upload", str(exc), code="upload.invalid_on_send",
                        detail={"attachments": ids}, session_id=sid, ip=ip,
                    )
                    await error("attachment.invalid", str(exc))

            elif kind == "stop":
                svc.stop(sid)
    except WebSocketDisconnect:
        pass
    finally:
        svc.unsubscribe(sid, queue)
        if pump_task is not None:
            pump_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pump_task
