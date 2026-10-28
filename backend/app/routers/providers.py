from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.routers._deps import provider_service
from app.schemas.models import ProviderConnect
from app.services.provider_service import ProviderService

router = APIRouter(prefix="/api/providers")


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
