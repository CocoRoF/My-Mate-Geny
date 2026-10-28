"""Non-streaming turn execution (collects the stream into one result).

Useful for simple REST clients that don't want a WebSocket. The streaming
path (``/ws/chat/{sid}``) is preferred for the UI.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.routers._deps import session_service
from app.services.session_service import SessionService

router = APIRouter(prefix="/api/execute")


class ExecuteRequest(BaseModel):
    input: str


@router.post("/{sid}")
async def execute(
    sid: str, body: ExecuteRequest, svc: SessionService = Depends(session_service)
) -> dict:
    if not body.input.strip():
        raise HTTPException(status_code=400, detail="input must not be empty")
    try:
        svc.get(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    events: list[dict] = []
    final: dict | None = None
    error: dict | None = None
    async for ev in svc.run_turn(sid, body.input.strip()):
        events.append(ev.to_dict())
        if ev.type == "turn.complete":
            final = ev.data
        elif ev.type == "error":
            error = ev.data

    return {
        "session_id": sid,
        "success": error is None,
        "result": final or {},
        "error": error or {},
        "event_count": len(events),
    }
