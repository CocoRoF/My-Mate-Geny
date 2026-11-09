"""Multi-account pool management + per-account OAuth."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.providers.accounts import (
    PRIMARY_PREFIX,
    account_config_dir,
    ensure_account_dirs,
    write_claude_credentials,
)
from app.providers.catalog import clean_auto_compact_window

router = APIRouter(prefix="/api/providers")

from app.harness.vendors import API_PROVIDERS, is_api_provider

_SUPPORTED = {"claude", "codex", *API_PROVIDERS}


class AccountCreate(BaseModel):
    label: str
    auth_mode: str = "oauth"  # oauth | api_key
    weight: int = 1
    max_concurrency: int = 8
    api_key: str | None = None


class AccountUpdate(BaseModel):
    label: str | None = None
    enabled: bool | None = None
    weight: int | None = None
    max_concurrency: int | None = None


class PoolUpdate(BaseModel):
    enabled: bool | None = None
    strategy: str | None = None
    primary_mode: str | None = None       # host login: normal | fallback | off
    near_5h: float | None = None          # avoid accounts at/above this 5-hour %
    near_7d: float | None = None          # ... and this 7-day %
    limit_priority: str | None = None     # which window decides: balanced | seven_day | five_hour
    auto_compact_window: int | None = None  # Claude: default auto-compact window (0 = CLI default)


class OAuthCode(BaseModel):
    code: str


def _check(provider: str) -> None:
    if provider not in _SUPPORTED:
        raise HTTPException(status_code=400, detail=f"unsupported provider: {provider}")


@router.get("/{provider}/pool")
async def get_pool(provider: str, request: Request) -> dict:
    _check(provider)
    store = request.app.state.account_store
    pool = request.app.state.account_pool
    # public_accounts fetches plan usage per account over HTTPS: off the loop.
    return {"pool": store.pool(provider), "accounts": await asyncio.to_thread(pool.public_accounts, provider)}


@router.put("/{provider}/pool")
async def set_pool(provider: str, body: PoolUpdate, request: Request) -> dict:
    _check(provider)
    store = request.app.state.account_store
    fields = body.model_dump(exclude_none=True)
    try:
        if "auto_compact_window" in fields:
            fields["auto_compact_window"] = clean_auto_compact_window(fields["auto_compact_window"])
        return store.set_pool(provider, **fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{provider}/accounts")
async def create_account(provider: str, body: AccountCreate, request: Request) -> dict:
    _check(provider)
    store = request.app.state.account_store
    acc = store.create(
        provider,
        label=body.label,
        auth_mode=body.auth_mode,
        weight=body.weight,
        max_concurrency=body.max_concurrency,
        api_key=body.api_key,
    )
    if not is_api_provider(provider):  # (a key needs no login folder)
        ensure_account_dirs(provider, acc["id"])
    # First account added -> enable the pool for convenience.
    if len(store.list(provider)) == 1:
        store.set_pool(provider, enabled=True)
    return (await asyncio.to_thread(request.app.state.account_pool.public_accounts, provider))[-1]


@router.patch("/{provider}/accounts/{account_id}")
async def update_account(provider: str, account_id: str, body: AccountUpdate, request: Request) -> dict:
    _check(provider)
    request.app.state.account_store.update(account_id, **body.model_dump(exclude_none=True))
    return {"ok": True}


@router.delete("/{provider}/accounts/{account_id}")
async def delete_account(provider: str, account_id: str, request: Request) -> dict:
    _check(provider)
    request.app.state.account_store.delete(account_id)
    return {"ok": True}


@router.post("/{provider}/accounts/{account_id}/cooldown/clear")
async def clear_cooldown(provider: str, account_id: str, request: Request) -> dict:
    _check(provider)
    request.app.state.account_pool.clear_cooldown(account_id)
    return {"ok": True}


# ---- login session (docs/providers.md → Login sessions) ----

def _known_account(request: Request, provider: str, account_id: str) -> None:
    if account_id == f"{PRIMARY_PREFIX}{provider}":
        return
    acc = request.app.state.account_store.get(account_id)
    if acc is None or acc["provider"] != provider:
        raise HTTPException(status_code=404, detail="no such account")


@router.get("/{provider}/accounts/{account_id}/session")
async def account_session(provider: str, account_id: str, request: Request) -> dict:
    """The account's login (method, who, expiry, refresh token yes/no,
    health) — read from its credentials file; no token is ever returned."""
    _check(provider)
    _known_account(request, provider, account_id)
    return request.app.state.account_pool.session_info(provider, account_id)


@router.post("/{provider}/accounts/{account_id}/session/renew")
async def renew_account_session(provider: str, account_id: str, request: Request) -> dict:
    """Renew the login the CLI's way (Claude: the CLI itself when due, else
    the token endpoint under the CLI's own locks; Codex: the CLI). The
    answer: ok, how, an error code/message, and the session afterwards."""
    _check(provider)
    _known_account(request, provider, account_id)
    return await asyncio.to_thread(request.app.state.account_pool.renew_session, provider, account_id)


# ---- per-account OAuth ----

@router.post("/{provider}/accounts/{account_id}/oauth/start")
async def account_oauth_start(provider: str, account_id: str, request: Request) -> dict:
    _check(provider)
    oauth = request.app.state.oauth
    home, cfg = ensure_account_dirs(provider, account_id)
    if provider == "claude":
        env = {"HOME": str(home), "CLAUDE_CONFIG_DIR": str(cfg)}
        return await asyncio.to_thread(oauth.start_claude, key=account_id, env_extra=env)
    env = {"HOME": str(home), "CODEX_HOME": str(cfg)}
    # Waits (up to ~25s) for the device code: never on the event loop.
    return await asyncio.to_thread(oauth.start_codex, key=account_id, env_extra=env)


@router.get("/{provider}/accounts/{account_id}/oauth/status")
async def account_oauth_status(provider: str, account_id: str, request: Request) -> dict:
    _check(provider)
    import os

    cfg = account_config_dir(provider, account_id)
    files = [cfg / f for f in (".credentials.json", "credentials.json", "auth.json")]
    st = request.app.state.oauth.session_state(account_id)
    if st is not None:
        # Connected only if THIS sign-in produced fresh credentials — an old
        # (expired) file from before must not flip the account back to ready.
        fresh = any(os.path.exists(f) and os.path.getmtime(f) >= st["started_at"] - 1 for f in files)
        if fresh or st["ok"]:
            request.app.state.account_store.update(account_id, status="ready")
            request.app.state.account_pool.note_signed_in(account_id)
            return {"status": "connected"}
        if st["done"]:
            return {"status": "failed", "error": st["error"] or "sign-in did not complete"}
        return {"status": "pending"}
    ok = any(os.path.exists(f) for f in files)
    return {"status": "connected" if ok else "pending"}


@router.post("/{provider}/accounts/{account_id}/oauth/complete")
async def account_oauth_complete(
    provider: str, account_id: str, body: OAuthCode, request: Request
) -> dict:
    _check(provider)
    if provider != "claude":
        raise HTTPException(status_code=400, detail="complete step is only for claude")
    res = await asyncio.to_thread(request.app.state.oauth.complete_claude, body.code, key=account_id)
    store = request.app.state.account_store
    if res.get("ok") and res.get("credentials"):
        # Write OAuth creds to the account's isolated dir; the CLI refreshes them.
        write_claude_credentials(account_id, res["credentials"])
        store.update(account_id, status="ready")
        request.app.state.account_pool.note_signed_in(account_id)
    return {"ok": res.get("ok", False), "error": res.get("error", "")}
