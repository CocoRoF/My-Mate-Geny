from __future__ import annotations

import asyncio
import os
import time

from fastapi import APIRouter, HTTPException, Request

from app.providers.accounts import account_config_dir
from app.providers.subscription import UsageError, subscription_usage
from app.services.usage_service import UsageService

router = APIRouter(prefix="/api/usage")


@router.get("")
async def usage(request: Request, days: int = 14) -> dict:
    """Local token aggregation + API-equivalent cost (what the tokens would
    cost on the API; informational on a subscription), per turn."""
    svc = UsageService(request.app.state.db)
    return svc.summary(days=days)


def _cred_dir(provider: str, account_id: str | None) -> str:
    if account_id:
        return str(account_config_dir(provider, account_id))
    # default: the host credentials dir the CLI uses (HOME/.claude or HOME/.codex)
    sub = ".codex" if provider == "codex" else ".claude"
    return os.path.join(os.path.expanduser("~"), sub)


# Plan usage per (provider, account): the provider throttles its usage
# endpoint (429), and the Usage page asks for every account at once.
_SUB_TTL_S = 60.0
_sub_cache: dict[tuple[str, str | None], tuple[float, dict]] = {}


@router.get("/subscription")
async def subscription(request: Request, provider: str = "claude", account_id: str | None = None) -> dict:
    """The real plan usage (session 5h / weekly 7d), like the CLI's /usage."""
    key = (provider, account_id)
    hit = _sub_cache.get(key)
    if hit and time.time() - hit[0] < _SUB_TTL_S:
        return hit[1]
    try:
        # HTTPS call to the provider: off the event loop.
        out = await asyncio.to_thread(subscription_usage, provider, _cred_dir(provider, account_id))
    except UsageError as exc:
        if hit:  # keep showing the last good numbers, and say why they're old
            return {**hit[1], "stale": str(exc)}
        return {"provider": provider, "available": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"usage fetch failed: {exc}") from exc
    _sub_cache[key] = (time.time(), out)
    return out
