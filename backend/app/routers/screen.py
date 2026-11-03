"""Consent-bound device screen responses and periodic observation. No OS capture on the web server."""
from fastapi import APIRouter, HTTPException, Request
from app.mate.capture import CaptureError

router = APIRouter(prefix="/api/sessions")
internal = APIRouter(prefix="/api/internal/screen")


@router.post("/{sid}/screen/{rid}/result")
async def result(sid: str, rid: str, request: Request):
    try:
        request.app.state.session_service.get(sid)
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("expected object")
        if not request.app.state.screen_service.resolve(sid, rid, body):
            raise HTTPException(404, "Capture request expired or does not belong to this window")
    except KeyError as exc:
        raise HTTPException(404, "Session not found") from exc
    except (ValueError, CaptureError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True}


@router.post("/{sid}/screen/observe")
async def observe(sid: str, request: Request):
    try:
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("device"), str):
            raise ValueError("expected device")
        return await request.app.state.screen_service.observe(sid, body["device"][:80], force=body.get("force") is True)
    except CaptureError as exc:
        raise HTTPException(409, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(404, "Session not found") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@internal.post("/call")
async def call(request: Request):
    svc = request.app.state.screen_service
    sid = svc.token_info(request.headers.get("x-screen-token"))
    if sid is None or not request.app.state.session_service.exists(sid):
        raise HTTPException(401, "Invalid screen token")
    body = await request.json()
    args = body.get("arguments") if isinstance(body, dict) else None
    if not isinstance(args, dict):
        raise HTTPException(400, "expected arguments object")
    return await svc.tool(sid, args)


@router.post("/{sid}/screen/cancel")
async def cancel(sid: str, request: Request):
    request.app.state.screen_service.broker.cancel_session(sid)
    return {"ok": True}

@router.get("/{sid}/screen/status")
async def status(sid: str, request: Request):
    svc=request.app.state.screen_service
    try: return svc.triggers.current(sid)
    except KeyError as exc: raise HTTPException(404,"Session not found") from exc

@router.get("/screen/geny-preset")
async def geny_preset():
    from app.mate.trigger.defaults import default_manifest
    return default_manifest().model_dump()
