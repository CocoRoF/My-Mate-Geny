"""The Geny Net ingress (docs/geny-net.md "The ingress"): what a request that came over Geny Net may do.

The desktop's local backend listens on a second loopback socket (local_main.py) that only the node's own TLS pipes
connect to (app/net/service.py records the local port of each one first). This ASGI layer, outermost, looks at every
request on that socket:

* a connection the node didn't open (another program on this machine): refused;
* ``scope "pair"`` (a device that has no certificate yet): only the two pairing calls (and /health);
* ``scope "device"`` (a paired device): signed in as the owner — the session cookie is put on the request here, so the
  device never holds one (its only credential is the key in its keystore) — except for what is this machine's alone:
  ``/api/internal`` and ``/api/local`` (loopback-only calls), and the device list and pairing (``/api/net``, but the
  status and where to reach this node), so a device can't add another.

Requests on the backend's own socket can't reach the pairing calls at all.
"""

from __future__ import annotations

import json
from typing import Any

from app.auth import COOKIE_NAME

from .service import PAIR_PATHS, Peer

LINK_COOKIE = "geny_net"  # (the phone's own proxy key, app GenyNet.java: it never goes further than this)
_DROP_HEADERS = {b"cookie", b"authorization", b"x-forwarded-for", b"x-forwarded-proto", b"x-forwarded-host",
                 b"x-real-ip", b"cf-connecting-ip", b"forwarded"}
_DEVICE_DENY = ("/api/internal/", "/api/local/", "/api/net/")
_DEVICE_ALLOW = {("GET", "/api/net/status"), ("GET", "/api/net/where")}
RELAY_CLIENT = "100.64.0.1"  # (a relayed device's address as the app sees it: not loopback, not a LAN one)


class NetIngress:
    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        from app.config import settings

        port = settings.net_ingress_port
        server = scope.get("server") or ("", 0)
        path = scope.get("path", "")
        if not port or server[1] != port:
            if path in PAIR_PATHS:  # (pairing is only ever spoken over Geny Net)
                return await _deny(scope, receive, send, 404)
            return await self.app(scope, receive, send)

        net = getattr(scope["app"].state, "net", None)
        peer: Peer | None = net.peer_of(scope.get("client")) if net is not None else None
        if peer is None:
            return await _deny(scope, receive, send, 403)
        method = scope.get("method", "GET")
        if peer.scope == "pair":
            if path not in PAIR_PATHS and path != "/health":
                return await _deny(scope, receive, send, 404)
        elif peer.scope != "device" or (path.startswith(_DEVICE_DENY) and (method, path) not in _DEVICE_ALLOW):
            return await _deny(scope, receive, send, 404)

        scope = dict(scope)
        headers = [(k, v) for k, v in scope.get("headers", []) if k.lower() not in _DROP_HEADERS]
        kept = _other_cookies(scope.get("headers", []))
        if peer.scope == "device":
            auth = scope["app"].state.auth
            kept.append(f"{COOKIE_NAME}={auth.issue_token(auth.username)}")
        if kept:
            headers.append((b"cookie", "; ".join(kept).encode("latin-1")))
        scope["headers"] = headers
        scope["client"] = (peer.addr or RELAY_CLIENT, 0)
        scope["geny_net"] = peer
        if peer.scope != "device" or scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_no_session(message: dict) -> None:
            # (the sliding session cookie stays on this machine: the device is signed in by its key, every time)
            if message.get("type") == "http.response.start":
                message = dict(message)
                message["headers"] = [(k, v) for k, v in message.get("headers", [])
                                      if not (k.lower() == b"set-cookie" and v.startswith(COOKIE_NAME.encode() + b"="))]
            await send(message)

        await self.app(scope, receive, send_no_session)


def _other_cookies(headers: list) -> list[str]:
    out: list[str] = []
    for k, v in headers:
        if k.lower() != b"cookie":
            continue
        for part in v.decode("latin-1").split(";"):
            name = part.split("=", 1)[0].strip()
            if name and name not in (COOKIE_NAME, LINK_COOKIE):
                out.append(part.strip())
    return out


async def _deny(scope: dict, receive: Any, send: Any, status: int) -> None:
    if scope["type"] == "websocket":
        await send({"type": "websocket.close", "code": 4403 if status == 403 else 4404})
        return
    body = json.dumps({"detail": "not found" if status == 404 else "forbidden"}).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})
