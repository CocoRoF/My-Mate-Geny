"""Phone calls with a mate (docs/mate-calls.md): start one, take or turn down hers, hang up — and the call's own socket.

HTTP::

    POST /api/mates/{id}/calls {device}        → {call, plan}   the user calls her (409 code=busy: a call is on)
    GET  /api/mate-calls/active                → {call | null}  (a page that comes back finds the call it was on)
    POST /api/mate-calls/{cid}/accept {device} → {call, plan}   she is calling: they pick up
    POST /api/mate-calls/{cid}/answering       → {call}         …on the phone's ringing: the app is coming up to take it
    POST /api/mate-calls/{cid}/decline         → {call}         …or turn it down
    POST /api/mate-calls/{cid}/hangup          → {call}
    GET  /api/mate-calls/link?device=          → text/event-stream: the Android app's background link (its foreground
         service): ``data: {"type": "hello", "calls", "mate", "ring"}`` · ``{"type": "call.ring", "data"}`` ·
         ``{"type": "call.update", "data"}`` · ``{"type": "policy", "calls", "mate"}`` · ``{"type": "ping"}`` (every
         calls.LINK_PING_S at least, so a dead line is noticed) · ``{"type": "bye"}`` (the server is stopping)

The line, ``/ws/mate-calls/{cid}`` (one screen at a time; a newer one takes over, a dropped one may come back within
calls.RESUME_S)::

    client → {"type": "say", "text"}                  what they said (one finished utterance)
             {"type": "barge", "rid", "heard"}        they talked over her reply ``rid``; ``heard``: what of it was said
             {"type": "metric", "rid", "first_audio_ms", "stt"}   end of their speech → her first sound, as the page saw it
             {"type": "hangup"} · {"type": "ping"}
    server → {"type": "state", "call"} · {"type": "reply", "rid", "greeting"} · {"type": "delta", "rid", "text"} ·
             {"type": "done", "rid", "text", "ttft_ms"} · {"type": "ended", "reason", "call"} · {"type": "pong"}

Ringing and every change of a call also go to every window on ``/ws/sessions``: ``call.ring`` (to the phone she calls),
``call.update``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse

from app.mate.calls import LINK_PING_S, CallError, CallService
from app.mate.store import MateError
from app.ws.gate import admit

router = APIRouter()


def _calls(request: Request | WebSocket) -> CallService:
    calls = getattr(request.app.state, "calls", None)
    if calls is None:
        raise HTTPException(status_code=503, detail="calls are not available")
    return calls


def _fail(exc: Exception) -> JSONResponse:
    if isinstance(exc, CallError):
        return JSONResponse({"detail": str(exc), "code": exc.code}, status_code=exc.status)
    if isinstance(exc, KeyError):
        return JSONResponse({"detail": str(exc).strip("'\""), "code": "gone"}, status_code=404)
    if isinstance(exc, MateError):
        return JSONResponse({"detail": str(exc), "code": "error"}, status_code=exc.status)
    raise exc


async def _body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _plan(request: Request, calls: CallService, mate_id: str) -> dict[str, Any]:
    return calls.plan(calls.store.get(mate_id), request.app.state.voice_service)


@router.post("/api/mates/{mate_id}/calls")
async def dial(mate_id: str, request: Request) -> Any:
    calls = _calls(request)
    body = await _body(request)
    try:
        call = await calls.dial(mate_id, str(body.get("device") or ""))
        return {"call": call.public(), "plan": _plan(request, calls, mate_id)}
    except (CallError, MateError, KeyError) as exc:
        return _fail(exc)


@router.get("/api/mate-calls/link")
async def link(request: Request, device: str = "") -> Any:
    """The phone app's background link: her ringing for this device and where every call stands, as server-sent events,
    for as long as it stays open."""
    calls = _calls(request)
    device = device.strip()[:80]
    if not device:
        return JSONResponse({"detail": "device is required", "code": "error"}, status_code=400)

    async def events() -> Any:
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        lk = calls.link(device, queue.put_nowait)
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=LINK_PING_S)
                except asyncio.TimeoutError:
                    msg = {"type": "ping"}
                yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
                if msg.get("type") == "bye":
                    return  # (the server is stopping: the app comes back to the next one)
        finally:
            calls.unlink(lk.id)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@router.get("/api/mate-calls/active")
async def active(request: Request) -> Any:
    call = _calls(request).active()
    return {"call": call.public() if call else None}


@router.post("/api/mate-calls/{cid}/{action}")
async def act(cid: str, action: str, request: Request) -> Any:
    calls = _calls(request)
    body = await _body(request)
    try:
        if action == "accept":
            call = await calls.accept(cid, str(body.get("device") or ""))
            return {"call": call.public(), "plan": _plan(request, calls, call.mate_id)}
        if action == "answering":
            return {"call": (await calls.answering(cid)).public()}
        if action == "decline":
            return {"call": (await calls.decline(cid)).public()}
        if action == "hangup":
            return {"call": (await calls.hangup(cid)).public()}
    except (CallError, MateError, KeyError) as exc:
        return _fail(exc)
    raise HTTPException(status_code=404, detail="unknown action")


@router.websocket("/ws/mate-calls/{cid}")
async def line(websocket: WebSocket, cid: str) -> None:
    if await admit(websocket) is None:
        return
    await websocket.accept()
    calls: CallService | None = getattr(websocket.app.state, "calls", None)
    call = calls.calls.get(cid) if calls is not None else None
    if call is None or call.status == "ended" or call.status == "ringing":
        await websocket.send_json({"type": "ended", "reason": "gone" if call is None or call.status == "ended" else "ringing",
                                   "call": call.public() if call else None})
        await websocket.close(code=4404)
        return
    queue: asyncio.Queue = asyncio.Queue()

    async def pump() -> None:
        while True:
            msg = await queue.get()
            await websocket.send_json(msg)
            if msg.get("type") == "ended":
                await websocket.close(code=1000)
                return

    pump_task = asyncio.create_task(pump())
    sock = calls.attach(call, queue.put_nowait)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict) and calls.calls.get(cid) is call:
                await calls.receive(call, msg)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        calls.detach(call, sock)
        # (let an "ended" already queued go out first)
        await asyncio.sleep(0)
        pump_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await pump_task
