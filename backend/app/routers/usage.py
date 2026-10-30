from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request

from app.providers.accounts import account_config_dir
from app.providers.subscription import UsageError, subscription_usage
from app.services.usage_service import UsageService

router = APIRouter(prefix="/api/usage")


@router.get("")
async def usage(request: Request, days: int = 14) -> dict:
    """Local token/cost aggregation (secondary; mainly for API-key users)."""
    svc = UsageService(request.app.state.db)
    return svc.summary(days=days)


def _cred_dir(provider: str, account_id: str | None) -> str:
    if account_id:
        return str(account_config_dir(provider, account_id))
    # default: the host credentials dir the CLI uses (HOME/.claude or HOME/.codex)
    sub = ".codex" if provider == "codex" else ".claude"
    return os.path.join(os.path.expanduser("~"), sub)


@router.get("/subscription")
async def subscription(request: Request, provider: str = "claude", account_id: str | None = None) -> dict:
    """The real plan usage (session 5h / weekly 7d), like the CLI's /usage."""
    try:
        return subscription_usage(provider, _cred_dir(provider, account_id))
    except UsageError as exc:
        return {"provider": provider, "available": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"usage fetch failed: {exc}") from exc
