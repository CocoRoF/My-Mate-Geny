"""Handshake gate shared by every WebSocket endpoint.

BaseHTTPMiddleware does not see WebSocket scopes, so the auth checks are
enforced explicitly at the handshake: banned IPs and unauthenticated sockets
are refused, and a cookie-authenticated socket must come from our own pages
(cross-site WebSocket hijacking).
"""

from __future__ import annotations

from fastapi import WebSocket

from app.auth import COOKIE_NAME, AuthManager, origin_allowed


async def admit(websocket: WebSocket) -> str | None:
    """Close the socket and return None if it may not connect; else the client IP."""
    auth: AuthManager = websocket.app.state.auth
    ip = auth.client_ip(websocket)  # type: ignore[arg-type]
    # Token from cookie (web) or ?token= query param (native clients).
    cookie = websocket.cookies.get(COOKIE_NAME)
    token = cookie or websocket.query_params.get("token")
    if auth.is_banned(ip) or not auth.verify_token(token):
        await websocket.close(code=4401)
        return None
    if cookie and not origin_allowed(websocket.headers.get("origin"), websocket.headers.get("host")):
        await websocket.close(code=4403)
        return None
    return ip
