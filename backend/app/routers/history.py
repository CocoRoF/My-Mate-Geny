"""History — persisted events/messages for a session (replay on reload).

Without ``turns`` / ``since``: the whole chat (the original response). With
them, whole turns at a time (services/history_page.py):

* ``?turns=5`` — the newest 5 turns + session-wide summaries;
* ``?turns=10&before=<cursor>`` — the 10 turns before ``page.cursor`` of the
  oldest page the client has;
* ``?since=<cursor>`` — everything from that cursor on (a reconnect reloading
  what it had; ``since=`` = from the beginning).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.routers._deps import session_service
from app.services.session_service import SessionService

router = APIRouter(prefix="/api/history")
tasks_router = APIRouter(prefix="/api/tasks")


@tasks_router.get("")
async def all_tasks(svc: SessionService = Depends(session_service)) -> list[dict]:
    """Background tasks across every chat (newest first)."""
    return svc.list_tasks(None, limit=300)


@router.get("/{sid}")
async def get_history(
    sid: str,
    turns: int | None = Query(None, ge=1, le=200),
    before: str | None = Query(None, max_length=64),
    since: str | None = Query(None, max_length=64),
    svc: SessionService = Depends(session_service),
) -> dict:
    try:
        session = svc.get(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if before is not None and (turns is None or since is not None):
        raise HTTPException(status_code=422, detail="before needs turns (and no since)")
    if turns is None and since is None:
        return {
            "session_id": sid,
            "session": session,
            "running": svc.is_running(sid),
            "messages": svc.messages(sid),
            "events": svc.events(sid),  # turn costs normalized to per turn
            # Which account this chat runs on + the plan usage its engine last
            # reported (this chat's only; None until known).
            "account": svc.session_account(sid),
            "live_usage": svc.live_usage_for(sid),
        }
    page = svc.history_page(sid, turns=turns, before=before, since=since)
    if before is not None:  # an older page: the slice + what precedes it
        return {"session_id": sid, **page}
    return {
        "session_id": sid,
        "session": session,
        "running": svc.is_running(sid),
        **page,
        "account": svc.session_account(sid),
        "live_usage": svc.live_usage_for(sid),
    }
