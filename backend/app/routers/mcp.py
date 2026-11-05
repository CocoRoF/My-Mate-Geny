from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import ValidationError

from app.mcp_runtime.store import Definition

router = APIRouter(prefix="/api/mcp")
internal = APIRouter(prefix="/api/internal/mcp")


def _fail(exc):
    if isinstance(exc, ValidationError):
        return HTTPException(
            422,
            detail="invalid_config: "
            + ", ".join(".".join(map(str, e["loc"])) for e in exc.errors()),
        )
    return HTTPException(404 if isinstance(exc, KeyError) else 400, detail=str(exc).strip("'"))


@router.get("")
async def catalog(request: Request):
    return request.app.state.mcp.catalog()


@router.post("")
async def create(body: dict, request: Request):
    try:
        return await request.app.state.mcp.save(body)
    except (ValueError, KeyError) as exc:
        raise _fail(exc) from None


@router.get("/{mid}/tools")
async def tools(
    mid: str, request: Request, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100)
):
    try:
        return request.app.state.mcp.tool_page(mid, offset, limit)
    except KeyError as exc:
        raise _fail(exc) from None


@router.post("/import")
async def import_config(body: dict, request: Request):
    """Validate all entries first; existing names are skipped, never overwritten."""
    service = request.app.state.mcp
    raw = body.get("mcpServers")
    if not isinstance(raw, dict) or not raw or len(raw) > 100:
        raise HTTPException(422, detail="mcpServers_required")
    staged, skipped = [], []
    names = {x["name"] for x in service.catalog()["items"]}
    for name, spec in raw.items():
        if name in names:
            skipped.append(name)
            continue
        if not isinstance(spec, dict):
            raise HTTPException(422, detail="invalid_config")
        transport = (
            "stdio" if spec.get("command") else "sse" if spec.get("type") == "sse" else "http"
        )
        try:
            value = {k: v for k, v in spec.items() if k in Definition.model_fields}
            value.update(name=name, transport=transport)
            if "timeout_s" not in value and isinstance(spec.get("timeout"), int):
                value["timeout_s"] = (spec["timeout"] + 999) // 1000
            # Import saves as disabled: the user decides when to launch a downloaded command.
            value["enabled"] = False
            Definition.model_validate(value)
            staged.append(value)
        except ValueError as exc:
            raise _fail(exc) from None
    if len(service.store.ids()) + len(staged) > 100:
        raise HTTPException(400, detail="catalog_full")
    created = [await service.save(spec) for spec in staged]
    return {"items": created, "skipped": skipped}


@router.patch("/{mid}")
async def update(mid: str, body: dict, request: Request):
    try:
        return await request.app.state.mcp.save(body, mid)
    except (ValueError, KeyError) as exc:
        raise _fail(exc) from None


@router.delete("/{mid}")
async def delete(mid: str, request: Request):
    try:
        await request.app.state.mcp.delete(mid)
        return {"ok": True}
    except KeyError as exc:
        raise _fail(exc) from None


@router.post("/{mid}/reconnect")
async def reconnect(mid: str, request: Request):
    try:
        return await request.app.state.mcp.connect(mid, force=True)
    except KeyError as exc:
        raise _fail(exc) from None


@internal.post("/call")
async def call(body: dict, request: Request):
    service = request.app.state.mcp
    key = service.token_info(request.headers.get("x-mcp-token"))
    if key is None:
        raise HTTPException(401, detail="invalid_mcp_token")
    try:
        if not isinstance(body.get("params", {}), dict):
            raise ValueError("invalid_params")
        request_id = body.get("request_id")
        if request_id is not None and (not isinstance(request_id, str) or len(request_id) > 256):
            raise ValueError("invalid_request_id")
        return await service.request(*key, body.get("method"), body.get("params") or {}, request_id)
    except PermissionError:
        raise HTTPException(403, detail="mcp_disabled_for_session") from None
    except asyncio.CancelledError:
        raise HTTPException(409, detail="mcp_call_cancelled") from None
    except Exception:
        raise HTTPException(502, detail="mcp_call_failed_check_system_logs") from None


@internal.post("/cancel")
async def cancel(body: dict, request: Request):
    service = request.app.state.mcp
    key = service.token_info(request.headers.get("x-mcp-token"))
    if key is None:
        raise HTTPException(401, detail="invalid_mcp_token")
    request_id = body.get("request_id")
    if not isinstance(request_id, str) or len(request_id) > 256:
        raise HTTPException(400, detail="invalid_request_id")
    return {"cancelled": service.cancel_request(*key, request_id)}
