"""Settings → Providers for the API-key providers (Anthropic, OpenAI, Google): keys and the model catalog.

Keys are accounts of the provider's pool (``/api/providers/{p}/pool``, ``…/accounts`` list, edit and delete them as for
the CLIs); here they are added, tested and used to fetch the vendor's models. The catalog is ``app.harness.models``.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.harness.keys import check_key
from app.harness.llm.base import LLMError
from app.harness.models import ModelCatalog
from app.harness.vendors import VENDORS, is_api_provider

router = APIRouter(prefix="/api/providers", tags=["providers"])


class KeyCreate(BaseModel):
    label: str = Field(default="", max_length=80)
    api_key: str = Field(min_length=8, max_length=500)
    weight: int = Field(default=1, ge=1, le=100)
    max_concurrency: int = Field(default=8, ge=1, le=64)


class ModelPatch(BaseModel):
    enabled: bool | None = None
    label: str | None = Field(default=None, max_length=120)
    price: dict[str, Any] | None = None
    clear_price: bool = False
    context_window: int | None = None
    clear_context_window: bool = False


class ModelsBulk(BaseModel):
    enabled: bool
    ids: list[str] | None = None


class ModelAdd(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    label: str = Field(default="", max_length=120)


def _check(provider: str) -> None:
    if not is_api_provider(provider):
        raise HTTPException(status_code=404, detail=f"not an API-key provider: {provider}")


def _catalog(request: Request) -> ModelCatalog:
    return ModelCatalog(request.app.state.db)


def _usable_key(request: Request, provider: str, account_id: str | None = None) -> tuple[dict, str]:
    store = request.app.state.account_store
    accounts = [a for a in store.list(provider) if a["auth_mode"] == "api_key" and a.get("secret_ref")]
    if account_id:
        accounts = [a for a in accounts if a["id"] == account_id]
    else:
        accounts = [a for a in accounts if a["enabled"]]
        accounts.sort(key=lambda a: (a["status"] == "expired", a["status"] == "cooldown"))
    for a in accounts:
        key = store.api_key(a)
        if key:
            return a, key
    raise HTTPException(status_code=400, detail=f"No {VENDORS[provider].label} API key to use. Add one first.")


def _record(request: Request, provider: str, account_id: str, result: dict) -> None:
    pool = request.app.state.account_pool
    if result.get("ok"):
        pool.record_check(provider, account_id, ok=True)
    elif result.get("outcome") or result.get("kind") in ("auth", "quota", "rate_limit"):
        pool.record_check(provider, account_id, ok=False, code=result.get("outcome"), error=result.get("error"))


async def _test(request: Request, provider: str, account: dict, key: str) -> dict:
    cat = _catalog(request)
    model = cat.default_model(provider) or None
    result = await check_key(provider, key, model=model)
    _record(request, provider, account["id"], result)
    return result


@router.post("/{provider}/keys")
async def add_key(provider: str, body: KeyCreate, request: Request) -> dict:
    """Add a key: it is tested, and the first key that works fills the model catalog."""
    _check(provider)
    store = request.app.state.account_store
    key = body.api_key.strip()
    label = body.label.strip() or f"Key …{key[-4:]}"
    acc = store.create(provider, label=label, auth_mode="api_key", weight=body.weight,
                       max_concurrency=body.max_concurrency, api_key=key)
    if len(store.list(provider)) == 1:
        store.set_pool(provider, enabled=True)
    cat = _catalog(request)
    catalog: dict[str, Any] | None = None
    if not cat.models(provider):
        try:
            catalog = await cat.refresh(provider, key)
        except LLMError as exc:
            catalog = {"error": str(exc)[:500]}
    check = await _test(request, provider, acc, key)
    request.app.state.session_service.providers_changed()
    accounts = await asyncio.to_thread(request.app.state.account_pool.public_accounts, provider)
    return {"account": next((a for a in accounts if a["id"] == acc["id"]), None), "check": check, "catalog": catalog}


@router.post("/{provider}/accounts/{account_id}/test")
async def test_key(provider: str, account_id: str, request: Request) -> dict:
    _check(provider)
    acc, key = _usable_key(request, provider, account_id)
    result = await _test(request, provider, acc, key)
    request.app.state.session_service.providers_changed()
    return result


@router.get("/{provider}/models")
async def list_models(provider: str, request: Request) -> dict:
    _check(provider)
    cat = _catalog(request)
    return {"models": cat.models(provider), "state": cat.state(provider)}


@router.post("/{provider}/models/refresh")
async def refresh_models(provider: str, request: Request, account_id: str | None = None) -> dict:
    _check(provider)
    _acc, key = _usable_key(request, provider, account_id)
    cat = _catalog(request)
    try:
        result = await cat.refresh(provider, key)
    except LLMError as exc:
        raise HTTPException(status_code=502, detail=f"{VENDORS[provider].label}: {exc}") from exc
    request.app.state.session_service.providers_changed()
    return {**result, "models": cat.models(provider), "state": cat.state(provider)}


@router.patch("/{provider}/models/{model_id:path}")
async def update_model(provider: str, model_id: str, body: ModelPatch, request: Request) -> dict:
    _check(provider)
    patch: dict[str, Any] = {}
    if body.enabled is not None:
        patch["enabled"] = body.enabled
    if body.label is not None:
        patch["label"] = body.label
    if body.clear_price:
        patch["price"] = None
    elif body.price is not None:
        patch["price"] = body.price
    if body.clear_context_window:
        patch["context_window"] = None
    elif body.context_window is not None:
        patch["context_window"] = body.context_window
    try:
        model = _catalog(request).update(provider, model_id, patch)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"no such model: {model_id}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    request.app.state.session_service.providers_changed()
    return model


@router.post("/{provider}/models/bulk")
async def bulk_models(provider: str, body: ModelsBulk, request: Request) -> dict:
    _check(provider)
    cat = _catalog(request)
    cat.set_all(provider, body.enabled, body.ids)
    request.app.state.session_service.providers_changed()
    return {"models": cat.models(provider)}


@router.post("/{provider}/models")
async def add_model(provider: str, body: ModelAdd, request: Request) -> dict:
    _check(provider)
    try:
        model = _catalog(request).add(provider, body.id, body.label)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    request.app.state.session_service.providers_changed()
    return model


@router.delete("/{provider}/models/{model_id:path}")
async def delete_model(provider: str, model_id: str, request: Request) -> dict:
    _check(provider)
    _catalog(request).remove(provider, model_id)
    request.app.state.session_service.providers_changed()
    return {"ok": True}
