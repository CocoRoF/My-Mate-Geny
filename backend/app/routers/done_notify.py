"""“끝나면 알려 줘” (app/services/done_notify.py): the chat's state and the bell by its message box, and the chat agent's tool."""
from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/sessions")
internal = APIRouter(prefix="/api/internal/notify")


def _svc(request: Request):
    svc = getattr(request.app.state, "done_notify", None)
    if svc is None:
        raise HTTPException(404, "not available")
    return svc


@router.get("/{sid}/notify-done")
async def state(sid: str, request: Request):
    svc = _svc(request)
    try:
        request.app.state.session_service.get(sid)
    except KeyError as exc:
        raise HTTPException(404, "Session not found") from exc
    return svc.state(sid)


@router.post("/{sid}/notify-done")
async def arm(sid: str, request: Request):
    svc = _svc(request)
    try:
        body = await request.json()
    except ValueError:
        body = {}
    try:
        return svc.arm(sid, str((body or {}).get("note") or "") if isinstance(body, dict) else "", by="user")
    except KeyError as exc:
        raise HTTPException(404, "Session not found") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.delete("/{sid}/notify-done")
async def disarm(sid: str, request: Request):
    return _svc(request).disarm(sid)


@internal.post("/call")
async def call(request: Request):
    svc = _svc(request)
    sid = svc.token_info(request.headers.get("x-notify-token"))
    if sid is None or not request.app.state.session_service.exists(sid):
        raise HTTPException(401, "Invalid notify token")
    body = await request.json()
    args = body.get("arguments") if isinstance(body, dict) else None
    if not isinstance(args, dict):
        raise HTTPException(400, "expected arguments object")
    return await svc.tool(sid, args)
