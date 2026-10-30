from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.services.git_service import GitError

router = APIRouter(prefix="/api/git")


class GitConnect(BaseModel):
    provider: str
    token: str
    host: str | None = None
    label: str | None = None


class CloneBody(BaseModel):
    full_name: str
    clone_url: str


def _svc(request: Request):
    return request.app.state.git_service


@router.get("/accounts")
async def list_accounts(request: Request) -> list[dict]:
    return _svc(request).list()


@router.post("/accounts")
async def connect(body: GitConnect, request: Request) -> dict:
    try:
        return _svc(request).connect(body.provider, body.token, host=body.host, label=body.label)
    except GitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/accounts/{aid}")
async def delete(aid: str, request: Request) -> dict:
    _svc(request).delete(aid)
    return {"ok": True}


@router.get("/accounts/{aid}/repos")
async def repos(aid: str, request: Request, q: str = "") -> list[dict]:
    try:
        return _svc(request).repos(aid, q)
    except GitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/accounts/{aid}/clone")
async def clone(aid: str, body: CloneBody, request: Request) -> dict:
    try:
        return _svc(request).clone(aid, body.full_name, body.clone_url)
    except GitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
