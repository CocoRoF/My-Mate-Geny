"""Settings → 디바이스 인증 (docs/geny-net.md): a phone signs in by scanning a QR code.

Local execution (the desktop app) — Geny Net, app/net/service.py:

* ``GET /api/net/status`` — on/off, how it's reached (LAN addresses, the router's forwarded port), paired devices,
  requests waiting.
  Over Geny Net itself it also says which device is asking (``here``).
* ``POST /api/net/offer`` — a pairing QR code (``geny://link?…``; one device, 5 minutes); starts Geny Net.
* ``DELETE /api/net/offer/{id}`` — the code shown is closed.
* ``POST /api/net/requests/{id}`` ``{allow}`` — the user's answer to a device that scanned it (the same six digits
  on both screens).
* ``PATCH /api/net/devices/{id}`` ``{name}`` · ``DELETE /api/net/devices/{id}`` — rename, remove (its connections
  end at once).
* ``GET /api/net/where`` — how a paired phone reaches this node now (it asks over the link itself).
* ``PUT /api/net/settings`` ``{lan?, upnp?}``.
* ``POST /api/net/pair/request`` · ``POST /api/net/pair/result`` — the device's side of pairing: only over a Geny Net
  connection without a certificate (app/net/ingress.py).

Server execution: ``POST /api/net/login-code`` ``{origin}`` → ``geny://login?…`` — this server's address and a
one-time code (5 minutes) the app turns into this account's session (``GET /auth/exchange``);
``POST /api/net/login-code/cancel`` ``{code}``.

Everything here but ``status`` and the pairing pair is this machine's own: a paired device can't reach it.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode, urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.net.service import PairError

router = APIRouter(prefix="/api/net")

LOGIN_CODE_TTL_S = 300


def _net(request: Request):
    net = getattr(request.app.state, "net", None)
    if net is None:
        raise HTTPException(404, "Geny Net runs in the desktop app (local execution)")
    return net


def _here(request: Request):
    return request.scope.get("geny_net")


def _own(request: Request):
    """this machine's own window, not a request that came over Geny Net"""
    if _here(request) is not None:
        raise HTTPException(404, "not found")
    return _net(request)


def _pair_error(e: PairError) -> JSONResponse:
    status = {"expired": 410, "gone": 404, "busy": 429, "full": 409}.get(e.code, 400)
    return JSONResponse({"detail": str(e), "code": e.code}, status_code=status)


@router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    if settings.execution_mode != "local":
        return {"mode": "server"}
    out = {"mode": "local"} | _net(request).status()
    peer = _here(request)
    if peer is not None:
        out = {"mode": "local", "here": {"device": peer.device_id, "via": peer.via}, "name": out["name"]}
    return out


@router.get("/where")
async def where(request: Request) -> dict[str, Any]:
    """how a paired phone reaches this node now: its LAN addresses and port, and the router's public ``ip:port``
    (the phone asks over the link it has, so it follows a home address that changed — GenyNet.java)"""
    return _net(request).where()


@router.post("/offer")
async def offer(request: Request) -> dict[str, Any]:
    return await _own(request).new_offer()


@router.delete("/offer/{offer_id}")
async def close_offer(offer_id: str, request: Request) -> dict[str, Any]:
    _own(request).cancel_offer(offer_id)
    return {"ok": True}


class Decision(BaseModel):
    allow: bool


@router.post("/requests/{request_id}")
async def decide(request_id: str, body: Decision, request: Request) -> Any:
    try:
        return _own(request).decide(request_id, body.allow)
    except PairError as e:
        return _pair_error(e)


class Rename(BaseModel):
    name: str = Field(min_length=1, max_length=60)


@router.patch("/devices/{device_id}")
async def rename(device_id: str, body: Rename, request: Request) -> dict[str, Any]:
    if not _own(request).rename(device_id, body.name):
        raise HTTPException(404, "no such device")
    return {"ok": True}


@router.delete("/devices/{device_id}")
async def remove(device_id: str, request: Request) -> dict[str, Any]:
    if not await _own(request).revoke(device_id):
        raise HTTPException(404, "no such device")
    return {"ok": True}


class NetSettings(BaseModel):
    lan: bool | None = None
    upnp: bool | None = None


@router.put("/settings")
async def put_settings(body: NetSettings, request: Request) -> dict[str, Any]:
    net = _own(request)
    try:
        await net.apply_settings(body.model_dump(exclude_none=True))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"mode": "local"} | net.status()


# -- the device's side of pairing (over Geny Net, no certificate yet) -------------------------------------------------

def _pairing(request: Request):
    peer = _here(request)
    if peer is None or peer.scope != "pair":
        raise HTTPException(404, "not found")
    return _net(request)


@router.post("/pair/request")
async def pair_request(request: Request) -> Any:
    net = _pairing(request)
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        return JSONResponse({"detail": "bad request", "code": "bad_request"}, status_code=400)
    try:
        return net.pair_request(body)
    except PairError as e:
        return _pair_error(e)


@router.post("/pair/result")
async def pair_result(request: Request) -> Any:
    net = _pairing(request)
    try:
        body = await request.json()
    except ValueError:
        body = {}
    try:
        return await net.pair_result(str((body or {}).get("request") or ""))
    except PairError as e:
        return _pair_error(e)


# -- server execution: a sign-in QR code -------------------------------------------------------------------------------

class LoginCodeBody(BaseModel):
    origin: str = Field(max_length=300)  # the address this page was opened at (location.origin + the base path)


@router.post("/login-code")
async def login_code(body: LoginCodeBody, request: Request) -> dict[str, Any]:
    if settings.execution_mode == "local":
        raise HTTPException(404, "the desktop app pairs devices instead (POST /api/net/offer)")
    base = body.origin.strip().rstrip("/")
    u = urlsplit(base)
    if u.scheme not in ("http", "https") or not u.hostname or u.query or u.fragment:
        raise HTTPException(400, "not this server's address")
    auth = request.app.state.auth
    code = auth.create_exchange_code(auth.issue_token(auth.username), ttl=LOGIN_CODE_TTL_S)
    uri = "geny://login?" + urlencode({"v": "1", "u": base, "c": code}, quote_via=quote)
    return {"uri": uri, "code": code, "expires_in": LOGIN_CODE_TTL_S, "server": base, "username": auth.username}


class CancelBody(BaseModel):
    code: str = Field(max_length=200)


@router.post("/login-code/cancel")
async def cancel_login_code(body: CancelBody, request: Request) -> dict[str, Any]:
    request.app.state.auth.discard_exchange_code(body.code)
    return {"ok": True}
