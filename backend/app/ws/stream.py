"""Streaming chat over WebSocket.

Turns run in the background (see :class:`SessionService`); a socket is just a
viewer + remote control, so closing the tab never kills the agent.

Protocol::

    client -> {"type": "attach", "after": <last eid seen>, "visible": bool}   # on every (re)connect
    client -> {"type": "view", "visible": bool}                # the chat went off / on screen (tab hidden…)
              # visible: the chat is on screen — its last run's result is seen now, and a run ending while it
              # stays on screen is seen as it ends (no "Complete" badge in the sidebar for the chat in view)
    client -> {"type": "chat", "input": "<text>", "attachments": ["att_…"], "client_msg_id": "…"}
    client -> {"type": "steer", "input": "<text>", "attachments": [...], "client_msg_id": "…"}
              # extra instructions for the RUNNING turn (Claude: injected at its next
              # step; Codex: current step interrupted, same thread resumed)
    client -> {"type": "stop"}

    server -> {"type": "run.state", "data": {"running": bool}}
    server -> {"type": "user.message", "data": {...}}         # a turn started (any tab)
    server -> {"type": "steer.rejected", "data": {client_msg_id, reason}}  # too late: send as next turn
    server -> normalized ProviderEvent ({type, seq, eid?, timestamp, data})

``attach`` replays persisted events with ``eid > after`` (what happened while
the client was away), then streams live; ``eid`` lets the client drop dupes.
"""

from __future__ import annotations

import asyncio
import json
import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.attachment_service import AttachmentError
from app.services.session_service import SessionService, TurnBusyError
from app.ws.gate import admit

router = APIRouter()


@router.websocket("/ws/chat/{sid}")
async def chat_stream(websocket: WebSocket, sid: str) -> None:
    ip = await admit(websocket)
    if ip is None:
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
    steer_tasks: set[asyncio.Task] = set()

    async def do_steer(text: str, ids: list[str], client_msg_id: str | None) -> None:
        try:
            ok = await svc.steer(sid, text, ids, client_msg_id=client_msg_id)
            reason = None if ok else "the turn is finishing — sending it as the next message"
        except AttachmentError as exc:
            ok, reason = False, str(exc)
        except Exception as exc:  # noqa: BLE001
            logs.record("error", "ws", f"steer failed: {exc}", code="steer.failed", session_id=sid, ip=ip)
            ok, reason = False, "could not deliver the instruction"
        if not ok:
            with contextlib.suppress(Exception):
                await send({"type": "steer.rejected", "data": {"client_msg_id": client_msg_id, "reason": reason}})

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

            if kind == "view" or (kind == "attach" and isinstance(msg.get("visible"), bool)):
                svc.set_viewing(sid, websocket, bool(msg.get("visible")))

            if kind == "attach":
                after = int(msg.get("after") or 0)
                # Subscribed before reading the backlog, so nothing falls in the
                # gap; the eid check in send() drops the overlap.
                for ev in svc.events(sid, after=after):
                    await send(ev)
                await send({"type": "run.state", "data": {"running": svc.is_running(sid)}})
                live = svc.live_usage_for(sid)  # this chat's engine's plan usage, if it reported any
                if live:
                    await send({"type": "usage.update", "data": live})
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

            elif kind == "steer":
                if pump_task is None:
                    pump_task = asyncio.create_task(pump())
                text = (msg.get("input") or "").strip()
                raw_ids = msg.get("attachments") or []
                ids = [str(a) for a in raw_ids if isinstance(a, str)] if isinstance(raw_ids, list) else []
                if text or ids:
                    # Delivery can take a moment (Codex waits for its thread id);
                    # don't block this loop — a Stop must still get through.
                    steer_tasks.add(asyncio.create_task(do_steer(text, ids, msg.get("client_msg_id"))))
                    steer_tasks = {t for t in steer_tasks if not t.done()}

            elif kind == "stop":
                svc.stop(sid)
    except WebSocketDisconnect:
        pass
    finally:
        svc.set_viewing(sid, websocket, False)
        svc.unsubscribe(sid, queue)
        for t in steer_tasks:
            t.cancel()
        if pump_task is not None:
            pump_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pump_task
