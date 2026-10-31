"""Internal API for the mate MCP bridge (app/mate/mcp_bridge.py).

Not reachable with the user's cookie: the auth gate (app.auth) admits
``/api/internal/`` only from loopback, without proxy headers, and with a
valid per-conversation ``X-Mate-Token``. The token says which mate and
conversation is calling.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/internal/mate")

TOKEN_HEADER = "x-mate-token"


@router.post("/call")
async def call_tool(request: Request) -> dict:
    svc = request.app.state.mate_service
    ctx = svc.token_info(request.headers.get(TOKEN_HEADER))
    if ctx is None:  # (the gate already checked; never trust one layer)
        raise HTTPException(status_code=401, detail="invalid mate token")
    try:
        body = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="expected JSON") from exc
    if not isinstance(body, dict) or not isinstance(body.get("name"), str):
        raise HTTPException(status_code=400, detail="expected {name, arguments}")
    text, is_error = await svc.call_tool(ctx, body["name"], body.get("arguments") or {})
    return {"text": text, "is_error": is_error}
