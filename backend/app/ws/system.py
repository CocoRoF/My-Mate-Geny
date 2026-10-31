"""Live system metrics for the Admin -> System page.

Protocol::

    server -> {"type": "hello", "data": {now, ring, cores, proc_hist, events, ranges, thresholds}}
    server -> {"type": "sample", "data": <snapshot>}        # every tick (2 s)
    server -> {"type": "event",  "data": <monitor log row>} # an alert fired / cleared
    client -> {"type": "ping"}                              # keep-alive
    server -> {"type": "pong"}

The sampler runs regardless (history + alerts); samples are only encoded and
sent while at least one socket is open. The page closes its socket while the
browser tab is hidden and reopens it (getting a fresh ``hello``) on return.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.ws.gate import admit

router = APIRouter()


@router.websocket("/ws/admin/system")
async def system_feed(websocket: WebSocket) -> None:
    if await admit(websocket) is None:
        return
    monitor = getattr(websocket.app.state, "system_monitor", None)
    await websocket.accept()
    if monitor is None:
        await websocket.send_json({"type": "error", "data": {"message": "system monitor is disabled"}})
        await websocket.close(code=1011)
        return
    queue = monitor.subscribe()
    send_lock = asyncio.Lock()

    async def send_text(text: str) -> None:
        async with send_lock:
            await websocket.send_text(text)

    async def pump() -> None:
        while True:
            await send_text(await queue.get())

    pump_task = asyncio.create_task(pump())
    try:
        hello = await asyncio.to_thread(monitor.hello)
        await send_text(json.dumps({"type": "hello", "data": hello}, separators=(",", ":"), default=str))
        while True:
            raw = await websocket.receive_text()
            with contextlib.suppress(json.JSONDecodeError, AttributeError):
                if json.loads(raw).get("type") == "ping":
                    await send_text('{"type":"pong"}')
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        monitor.unsubscribe(queue)
        pump_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await pump_task
