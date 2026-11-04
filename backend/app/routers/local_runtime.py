"""Native-owned loopback bootstrap. Never enabled on a server deployment."""
from __future__ import annotations

import hmac
from fastapi import APIRouter, HTTPException, Request
from app.auth import COOKIE_NAME, internal_caller_ok
from app.config import settings

router = APIRouter(prefix="/api/local")


def authorize_native(request: Request) -> None:
    secret = settings.local_bootstrap_secret
    supplied = request.headers.get("x-geny-local-bootstrap", "")
    if settings.execution_mode != "local" or not secret or not internal_caller_ok(request):
        raise HTTPException(404, "not found")
    # Reject alternate Host names (DNS rebinding) even when the socket peer is loopback.
    if request.headers.get("host", "") != f"127.0.0.1:{settings.port}":
        raise HTTPException(404, "not found")
    if request.headers.get("origin") or not hmac.compare_digest(secret, supplied):
        raise HTTPException(403, "native bootstrap required")


@router.post("/bootstrap")
async def bootstrap(request: Request):
    authorize_native(request)
    auth = request.app.state.auth
    return {"name": COOKIE_NAME, "token": auth.issue_token(auth.username), "expires": settings.session_ttl_days * 86400}


@router.post("/shutdown")
async def shutdown(request: Request):
    authorize_native(request)
    shutdown = getattr(request.app.state, "local_shutdown", None)
    if shutdown is not None:
        shutdown()
    return {"ok": True}
