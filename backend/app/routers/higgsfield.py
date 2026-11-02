"""Higgsfield: sign-in, accounts, credits, quotes, the CLI and skills the chats get (docs/higgsfield.md).

Errors answer ``{"detail": "<code>"}`` or ``{"detail": "<code>: <redacted message>"}`` (the console translates the
code). No route returns a token; none spends credits (quotes are free) or buys anything.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.higgsfield.agent import HiggsfieldAgent
from app.higgsfield.oauth import REDIRECT_URI, HiggsfieldError
from app.higgsfield.service import HiggsfieldService

router = APIRouter(prefix="/api/higgsfield")


def _svc(request: Request) -> HiggsfieldService:
    return request.app.state.higgsfield


def _agent(request: Request) -> HiggsfieldAgent:
    return request.app.state.higgsfield_agent


def _fail(exc: HiggsfieldError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.text())


def _account_id(svc: HiggsfieldService, given: str | None) -> str:
    aid = given or svc.default_id()
    if not aid:
        raise _fail(HiggsfieldError("not_connected"))
    return aid


@router.get("")
async def status(request: Request, recheck: bool = False) -> dict[str, Any]:
    svc, agent = _svc(request), _agent(request)
    path = agent.cli_path(refresh=recheck)
    return {
        "connected": svc.connected(),
        "default_id": svc.default_id(),
        "accounts": svc.accounts(),
        "cli": {"available": path is not None, "path": path},
        "skills": agent.skills_state(),
        "redirect_uri": REDIRECT_URI,
    }


class LoginStart(BaseModel):
    account_id: str | None = None


@router.post("/login/start")
async def login_start(body: LoginStart, request: Request) -> dict[str, Any]:
    try:
        return _svc(request).start_login(body.account_id)
    except HiggsfieldError as exc:
        raise _fail(exc) from None


class LoginComplete(BaseModel):
    callback: str


@router.post("/login/complete")
async def login_complete(body: LoginComplete, request: Request) -> dict[str, Any]:
    try:
        return await _svc(request).complete_login(body.callback)
    except HiggsfieldError as exc:
        raise _fail(exc) from None


class Import(BaseModel):
    credentials: Any


@router.post("/import")
async def import_credentials(body: Import, request: Request) -> dict[str, Any]:
    try:
        return await _svc(request).import_credentials(body.credentials)
    except HiggsfieldError as exc:
        raise _fail(exc) from None


@router.post("/accounts/{aid}/refresh")
async def refresh(aid: str, request: Request) -> dict[str, Any]:
    try:
        return await _svc(request).refresh_profile(aid)
    except HiggsfieldError as exc:
        raise _fail(exc) from None


class AccountPatch(BaseModel):
    label: str | None = None
    workspace_id: str | None = None
    is_default: bool | None = None


@router.patch("/accounts/{aid}")
async def update_account(aid: str, body: AccountPatch, request: Request) -> dict[str, Any]:
    svc = _svc(request)
    try:
        acc = svc.account(aid)
        if body.label is not None:
            acc = svc.rename(aid, body.label)
        if body.workspace_id is not None:
            acc = svc.set_workspace(aid, body.workspace_id)
        if body.is_default:
            acc = svc.set_default(aid)
        return acc
    except HiggsfieldError as exc:
        raise _fail(exc) from None


@router.delete("/accounts/{aid}")
async def disconnect(aid: str, request: Request) -> dict[str, Any]:
    try:
        _svc(request).disconnect(aid)
    except HiggsfieldError as exc:
        raise _fail(exc) from None
    return {"ok": True}


@router.get("/accounts/{aid}/transactions")
async def transactions(aid: str, request: Request, size: int = 20, cursor: str | None = None) -> dict[str, Any]:
    try:
        return await _svc(request).transactions(aid, size=size, cursor=cursor)
    except HiggsfieldError as exc:
        raise _fail(exc) from None


@router.get("/usage")
async def usage(request: Request, size: int = 10) -> dict[str, Any]:
    """Settings → Usage: the default account (balance read again when older than a minute) and its latest credit
    transactions. Errors come back in ``error`` (the stored account is still shown)."""
    svc = _svc(request)
    aid = svc.default_id()
    if aid is None:
        return {"connected": False, "account": None, "transactions": [], "error": None}
    acc = await svc.fresh_account(aid)
    try:
        tx = (await svc.transactions(aid, size=size))["items"]
        error = None
    except HiggsfieldError as exc:
        tx, error = [], exc.text()
    return {"connected": True, "account": acc, "transactions": tx, "error": error}


@router.get("/job-types")
async def job_types(request: Request, account_id: str | None = None, force: bool = False) -> dict[str, Any]:
    svc = _svc(request)
    try:
        return {"job_types": await svc.job_types(_account_id(svc, account_id), force=force)}
    except HiggsfieldError as exc:
        raise _fail(exc) from None


class Quote(BaseModel):
    job_type: str
    params: dict[str, Any] = {}
    account_id: str | None = None


@router.post("/quote")
async def quote(body: Quote, request: Request) -> dict[str, Any]:
    """What a job would cost — Higgsfield's own estimate; nothing is created or spent."""
    svc = _svc(request)
    try:
        return await svc.quote(_account_id(svc, body.account_id), body.job_type, body.params)
    except HiggsfieldError as exc:
        raise _fail(exc) from None


@router.post("/skills/install")
async def install_skills(request: Request) -> dict[str, Any]:
    try:
        return await _agent(request).install_skills()
    except HiggsfieldError as exc:
        raise _fail(exc) from None


@router.delete("/skills")
async def remove_skills(request: Request) -> dict[str, Any]:
    return _agent(request).remove_skills()
