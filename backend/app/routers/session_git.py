"""A chat's Git repository — the top bar's Git button (app/services/session_git.py)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.services.session_git import GitOpError, SessionGit

router = APIRouter(prefix="/api/sessions/{sid}/git")


def _svc(request: Request) -> SessionGit:
    return request.app.state.session_git


class ConnectBody(BaseModel):
    path: str
    add_folder: bool = False  # a repo outside the chat's folders (a fresh clone): connect its folder too


class CheckoutBody(BaseModel):
    branch: str
    track: bool = False  # a remote branch: create the local tracking branch


async def _call(coro):
    try:
        return await coro
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except GitOpError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    except ValueError as exc:  # e.g. too many folders
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("")
async def status(sid: str, request: Request) -> dict:
    return await _call(_svc(request).status(sid))


@router.put("")
async def connect(sid: str, body: ConnectBody, request: Request) -> dict:
    return await _call(_svc(request).connect(sid, body.path, body.add_folder))


@router.delete("")
async def disconnect(sid: str, request: Request) -> dict:
    try:
        return _svc(request).disconnect(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/branches")
async def branches(sid: str, request: Request) -> dict:
    return await _call(_svc(request).branches(sid))


@router.post("/checkout")
async def checkout(sid: str, body: CheckoutBody, request: Request) -> dict:
    return await _call(_svc(request).checkout(sid, body.branch, body.track))


@router.get("/detect")
async def detect(sid: str, request: Request) -> dict:
    return await _call(_svc(request).detect(sid))
