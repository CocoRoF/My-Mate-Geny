"""A chat's Git repository — the top bar's Git button (app/services/session_git.py)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.services.session_git import _WS, GitOpError, SessionGit

router = APIRouter(prefix="/api/sessions/{sid}/git")


def _svc(request: Request) -> SessionGit:
    return request.app.state.session_git


class ConnectBody(BaseModel):
    path: str
    add_folder: bool = False  # a repo outside the chat's folders (a fresh clone): connect its folder too
    connection_id: str | None = None  # its host (null = this server; not sent = the workspace's host)


class CheckoutBody(BaseModel):
    branch: str
    track: bool = False  # a remote branch: create the local tracking branch


class CloneBody(BaseModel):
    clone_url: str                     # https, no credentials in it
    connection_id: str | None = None   # where to clone (null = this server; not sent = the workspace's host)
    account_id: str | None = None      # a Git account's token (else: anonymous, a public repo)
    full_name: str | None = None       # owner/repo (the account's repo list)
    parent: str | None = None          # folder to clone into (default: ~/repos on an SSH host)


def _host(body: BaseModel):
    return body.connection_id if "connection_id" in body.model_fields_set else _WS


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
    return await _call(_svc(request).connect(sid, body.path, body.add_folder, _host(body)))


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


@router.post("/clone")
async def clone(sid: str, body: CloneBody, request: Request) -> dict:
    """Clone onto this server or an SSH host (the token never stays there), then connect it."""
    return await _call(_svc(request).clone(
        sid, clone_url=body.clone_url, connection_id=_host(body), account_id=body.account_id,
        full_name=body.full_name, parent=body.parent))
