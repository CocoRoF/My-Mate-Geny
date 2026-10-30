"""History — persisted events/messages for a session (replay on reload)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.routers._deps import session_service
from app.services.session_service import SessionService

router = APIRouter(prefix="/api/history")
tasks_router = APIRouter(prefix="/api/tasks")


@tasks_router.get("")
async def all_tasks(svc: SessionService = Depends(session_service)) -> list[dict]:
    """Background tasks across every chat (newest first)."""
    return svc.list_tasks(None, limit=300)


@router.get("/{sid}")
async def get_history(sid: str, svc: SessionService = Depends(session_service)) -> dict:
    try:
        session = svc.get(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "session_id": sid,
        "session": session,
        "running": svc.is_running(sid),
        "messages": svc.messages(sid),
        "events": svc.events(sid),
    }
