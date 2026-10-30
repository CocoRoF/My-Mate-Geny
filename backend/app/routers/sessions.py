from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.routers._deps import session_service
from app.schemas.models import SessionCreate, SessionUpdate
from app.services.session_service import SessionService

router = APIRouter(prefix="/api/sessions")


@router.get("")
async def list_sessions(svc: SessionService = Depends(session_service)) -> list[dict]:
    return svc.list_all()


@router.post("")
async def create_session(body: SessionCreate, svc: SessionService = Depends(session_service)) -> dict:
    try:
        return svc.create(
            provider=body.provider,
            model=body.model,
            effort=body.effort,
            connection_id=body.connection_id,
            workspace_path=body.workspace_path,
            title=body.title,
        )
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/{sid}")
async def update_session(
    sid: str, body: SessionUpdate, svc: SessionService = Depends(session_service)
) -> dict:
    try:
        return svc.update(sid, provider=body.provider, model=body.model, effort=body.effort)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{sid}")
async def get_session(sid: str, svc: SessionService = Depends(session_service)) -> dict:
    try:
        return svc.get(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{sid}/messages")
async def get_messages(sid: str, svc: SessionService = Depends(session_service)) -> list[dict]:
    return svc.messages(sid)


@router.get("/{sid}/events")
async def get_events(sid: str, svc: SessionService = Depends(session_service)) -> list[dict]:
    return svc.events(sid)


@router.delete("/{sid}")
async def delete_session(sid: str, svc: SessionService = Depends(session_service)) -> dict:
    svc.delete(sid)
    return {"id": sid, "deleted": True}
