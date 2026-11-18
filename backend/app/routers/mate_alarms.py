"""Her alarms (app/mate/alarms.py): what is waiting, for the app's list — and calling one off."""
from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/mate-alarms")


def _clock(request: Request):
    calls = getattr(request.app.state, "calls", None)
    if calls is None:
        raise HTTPException(404, "calls are not available")
    return calls


@router.get("")
async def upcoming(request: Request):
    calls = _clock(request)
    tz = calls.store.tz()
    return {"alarms": [calls.alarms.public(a, tz) for a in calls.alarms.book.upcoming()], "wakes": calls.alarms.wakes()}


@router.delete("/{aid}")
async def cancel(aid: str, request: Request):
    calls = _clock(request)
    try:
        a = calls.alarms.book.cancel(aid)
    except KeyError as exc:
        raise HTTPException(404, "no such alarm") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    calls.alarms.poke()
    return calls.alarms.public(a, calls.store.tz())
