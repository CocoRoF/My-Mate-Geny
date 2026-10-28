from __future__ import annotations

from fastapi import APIRouter, Depends

from app import __version__
from app.providers import list_providers
from app.routers._deps import provider_service
from app.services.provider_service import ProviderService

router = APIRouter(prefix="/api")


@router.get("/config")
async def get_config(svc: ProviderService = Depends(provider_service)) -> dict:
    return {
        "version": __version__,
        "providers": list_providers(),
        "provider_status": await svc.status_all(),
    }
