from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request

from app.services.usage_service import UsageService

router = APIRouter(prefix="/api/usage")

@router.get("/week")
async def usage_week(request: Request, tz: str = "UTC") -> dict:
    from app.services.usage_week import week
    from zoneinfo import ZoneInfoNotFoundError
    try:
        return await asyncio.to_thread(week, request.app.state.db, tz)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise HTTPException(400, "Invalid timezone") from exc


@router.get("")
async def usage(request: Request, days: int = 14) -> dict:
    """Local token aggregation + API-equivalent cost (what the tokens would
    cost on the API; informational on a subscription), per turn."""
    svc = UsageService(request.app.state.db)
    return svc.summary(days=days)


@router.get("/subscription")
async def subscription(request: Request, provider: str = "claude", account_id: str | None = None,
                       refresh: bool = False) -> dict:
    """The real plan usage (session 5h / weekly 7d), like the CLI's /usage.

    The same per-account fetcher as the Providers cards and the balancer
    (providers/plan_fetch.py): one request per account per couple of
    minutes, Retry-After / backoff on errors, the last numbers served with
    ``fetched_at`` + ``stale_reason`` / ``retry_at`` when they're old.
    ``refresh`` asks now unless that account is backing off."""
    if provider not in ("claude", "codex"):
        raise HTTPException(status_code=400, detail=f"unsupported provider: {provider}")
    pool = request.app.state.account_pool
    return await asyncio.to_thread(pool.subscription, provider, account_id, force=refresh)
