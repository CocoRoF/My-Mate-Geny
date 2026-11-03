"""Session-list change feed over WebSocket — keeps every device's sidebar in
sync without polling.

Protocol::

    server -> {"type": "hello", "data": {"version": <int>}}            # on connect
    server -> {"type": "sessions.changed", "data": {"version", "reason", "sid"}}
    server -> {"type": "mates.changed", "data": {"version", "reason", "mate_id"}}   # GET /api/mates again
    client -> {"type": "sync"}                                        # "are you there?" (back from background)
    server -> {"type": "pong", "data": {"version": <int>, "mates_version": <int>}}
    client -> {"type": "client", "device", "surface", "desktop", "capture", "active"}   # who this window is
    server -> {"type": "capture.request", "data": {...}} / {"type": "capture.cancel", "data": {"id"}}
                                                                      # the mate wants to see the screen (app/mate/capture.py)

``hello`` carries ``mates_version`` too, so a window that reconnects after
missing a mate change (sleep, network) still notices it.

The client refetches ``GET /api/sessions`` (which reports its version in the
``X-Sessions-Version`` header) only when a version newer than the list it has
arrives — bursts collapse into one fetch, an idle app sends nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.session_service import SessionService
from app.ws.gate import admit

router = APIRouter()


@router.websocket("/ws/sessions")
async def sessions_feed(websocket: WebSocket) -> None:
    if await admit(websocket) is None:
        return
    await websocket.accept()
    svc: SessionService = websocket.app.state.session_service
    queue = svc.subscribe_list()
    send_lock = asyncio.Lock()

    async def send(msg: dict) -> None:
        async with send_lock:
            await websocket.send_json(msg)

    async def pump() -> None:
        while True:
            await send(await queue.get())

    pump_task = asyncio.create_task(pump())
    mates = getattr(websocket.app.state, "mate_service", None)
    broker = getattr(mates, "capture", None)
    conn = broker.connect(queue.put_nowait) if broker is not None else None
    try:
        await send({"type": "hello", "data": {"version": svc.list_version, "mates_version": svc.mates_version}})
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "client" and conn is not None:
                broker.hello(conn, msg)
                screen=getattr(websocket.app.state,'screen_service',None)
                if screen:
                    screen.mate_service=mates
                    ids=screen.device_events.ingest(broker._clients[conn],msg)
                    if ids:await send({'type':'device.events.ack','data':{'ids':ids}})
                    asyncio.create_task(screen.device_events.drain())
                if msg.get("screen_ready") is True:
                    await send({"type":"capture.ready","data":{"shares":list(broker._clients[conn].shares)}})
            elif msg.get("type") == "sync":
                await send({"type": "pong", "data": {"version": svc.list_version, "mates_version": svc.mates_version}})
    except WebSocketDisconnect:
        pass
    finally:
        if conn is not None:
            broker.disconnect(conn)
        svc.unsubscribe_list(queue)
        pump_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await pump_task
