from __future__ import annotations

from fastapi import APIRouter, Depends

import asyncio

from app import __version__
from app.config import settings
from app.providers import list_providers
from app.providers.catalog import build_catalog
from app.routers._deps import provider_service
from app.services.provider_service import ProviderService

router = APIRouter(prefix="/api")


@router.get("/config")
async def get_config(svc: ProviderService = Depends(provider_service)) -> dict:
    # build_catalog does a (cached) network fetch for the live model list;
    # run it off the event loop so /api/config never blocks on provider I/O.
    catalog = await asyncio.to_thread(build_catalog)
    return {
        "version": __version__,
        "execution_mode": settings.execution_mode,
        "providers": list_providers(),
        "provider_status": await svc.status_all(),
        "catalog": catalog,
    }
