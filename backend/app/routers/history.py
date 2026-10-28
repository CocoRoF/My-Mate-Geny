"""History — persisted events/messages for a session (replay on reload)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.routers._deps import session_service
from app.services.session_service import SessionService

router = APIRouter(prefix="/api/history")


@router.get("/{sid}")
async def get_history(sid: str, svc: SessionService = Depends(session_service)) -> dict:
    try:
        svc.get(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "session_id": sid,
        "messages": svc.messages(sid),
        "events": svc.events(sid),
    }
