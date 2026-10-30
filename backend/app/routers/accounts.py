"""Multi-account pool management + per-account OAuth."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.providers.accounts import account_config_dir, ensure_account_dirs

router = APIRouter(prefix="/api/providers")

_SUPPORTED = {"claude", "codex"}


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
    return {"pool": store.pool(provider), "accounts": pool.public_accounts(provider)}


@router.put("/{provider}/pool")
async def set_pool(provider: str, body: PoolUpdate, request: Request) -> dict:
    _check(provider)
    store = request.app.state.account_store
    return store.set_pool(provider, enabled=body.enabled, strategy=body.strategy)


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
    ensure_account_dirs(provider, acc["id"])
    # First account added -> enable the pool for convenience.
    if len(store.list(provider)) == 1:
        store.set_pool(provider, enabled=True)
    return request.app.state.account_pool.public_accounts(provider)[-1]


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


# ---- per-account OAuth ----

@router.post("/{provider}/accounts/{account_id}/oauth/start")
async def account_oauth_start(provider: str, account_id: str, request: Request) -> dict:
    _check(provider)
    oauth = request.app.state.oauth
    home, cfg = ensure_account_dirs(provider, account_id)
    if provider == "claude":
        env = {"HOME": str(home), "CLAUDE_CONFIG_DIR": str(cfg)}
        return oauth.start_claude(key=account_id, env_extra=env)
    env = {"HOME": str(home), "CODEX_HOME": str(cfg)}
    return oauth.start_codex(key=account_id, env_extra=env)


@router.get("/{provider}/accounts/{account_id}/oauth/status")
async def account_oauth_status(provider: str, account_id: str, request: Request) -> dict:
    _check(provider)
    import os

    cfg = account_config_dir(provider, account_id)
    ok = any(os.path.exists(cfg / f) for f in (".credentials.json", "credentials.json", "auth.json"))
    if ok:
        request.app.state.account_store.update(account_id, status="ready")
    return {"status": "connected" if ok else "pending"}


@router.post("/{provider}/accounts/{account_id}/oauth/complete")
async def account_oauth_complete(
    provider: str, account_id: str, body: OAuthCode, request: Request
) -> dict:
    _check(provider)
    if provider != "claude":
        raise HTTPException(status_code=400, detail="complete step is only for claude")
    cfg = account_config_dir(provider, account_id)
    res = request.app.state.oauth.complete_claude(body.code, key=account_id, check_dir=str(cfg))
    store = request.app.state.account_store
    if res.get("ok") and res.get("token"):
        # Long-lived token -> vault; injected as CLAUDE_CODE_OAUTH_TOKEN per turn.
        store.set_oauth_token(account_id, res["token"])
    elif res.get("ok"):
        store.update(account_id, status="ready")
    return {"ok": res.get("ok", False), "error": res.get("error", "")}
