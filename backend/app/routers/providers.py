from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.routers._deps import provider_service
from app.schemas.models import ProviderConnect
from app.services.provider_service import ProviderService

router = APIRouter(prefix="/api/providers")


class OAuthCode(BaseModel):
    code: str


@router.get("")
async def list_status(svc: ProviderService = Depends(provider_service)) -> list[dict]:
    return await svc.status_all()


@router.get("/{provider}")
async def get_status(provider: str, svc: ProviderService = Depends(provider_service)) -> dict:
    try:
        st = await svc.status(provider)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "provider": st.provider,
        "connected": st.connected,
        "auth_mode": st.auth_mode,
        "detail": st.detail,
    }


@router.post("/{provider}/connect")
async def connect(
    provider: str, body: ProviderConnect, svc: ProviderService = Depends(provider_service)
) -> dict:
    try:
        if body.auth_mode == "api_key":
            if not body.api_key:
                raise HTTPException(status_code=400, detail="api_key required for api_key mode")
            svc.connect_api_key(provider, body.api_key)
        else:
            svc.mark_oauth(provider)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return await get_status(provider, svc)


@router.post("/{provider}/disconnect")
async def disconnect(provider: str, svc: ProviderService = Depends(provider_service)) -> dict:
    svc.disconnect(provider)
    return {"provider": provider, "connected": False}


# ---- web OAuth (browser-driven CLI login) ----

@router.post("/{provider}/oauth/start")
async def oauth_start(provider: str, request: Request) -> dict:
    oauth = request.app.state.oauth
    if provider == "codex":
        return await asyncio.to_thread(oauth.start_codex)
    if provider == "claude":
        return await asyncio.to_thread(oauth.start_claude)
    raise HTTPException(status_code=400, detail=f"oauth not supported for {provider}")


@router.get("/{provider}/oauth/status")
async def oauth_status(
    provider: str, request: Request, svc: ProviderService = Depends(provider_service)
) -> dict:
    oauth = request.app.state.oauth
    if provider == "codex":
        st = oauth.codex_status()
        if st.get("status") == "connected":
            svc.mark_oauth("codex")
        return st
    if provider == "claude":
        connected = oauth.claude_logged_in()
        if connected:
            svc.mark_oauth("claude")
        return {"status": "connected" if connected else "pending"}
    raise HTTPException(status_code=400, detail=f"oauth not supported for {provider}")


@router.post("/{provider}/oauth/complete")
async def oauth_complete(
    provider: str, body: OAuthCode, request: Request, svc: ProviderService = Depends(provider_service)
) -> dict:
    oauth = request.app.state.oauth
    if provider != "claude":
        raise HTTPException(status_code=400, detail="complete step is only for claude")
    res = await asyncio.to_thread(oauth.complete_claude, body.code)
    if res.get("ok") and res.get("credentials"):
        # Provider-level sign-in updates this machine's ~/.claude — merged, so
        # fields the CLI keeps there (rateLimitTier, …) survive.
        import os

        from app.providers.accounts import merge_claude_credentials

        merge_claude_credentials(os.path.expanduser("~/.claude/.credentials.json"), res["credentials"])
        svc.mark_oauth("claude")
    return {"ok": res.get("ok", False), "error": res.get("error", "")}
