from __future__ import annotations

from fastapi import APIRouter, Request

from app.services.usage_service import UsageService

router = APIRouter(prefix="/api/usage")


@router.get("")
async def usage(request: Request, days: int = 14) -> dict:
    svc = UsageService(request.app.state.db)
    return svc.summary(days=days)
