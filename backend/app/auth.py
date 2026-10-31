"""Authentication: single-user login, signed 7-day session cookie, IP banning.

Requirements:
* id ``admin`` / password from env (``AUTH_PASSWORD``).
* A successful login persists in the browser for 7 days (signed cookie).
* After 3+ failed attempts an IP is blocked (for ``ban_hours``), persisted in
  SQLite so a restart doesn't forget the ban.

The session cookie is a compact HMAC-signed token ``<payload>.<sig>`` where
payload is base64url(JSON{sub, exp}). No server-side session store needed — the
signature + expiry are self-validating, and the signing key persists across
restarts so existing logins survive a redeploy.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import time
from collections import deque
from datetime import datetime, timezone

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.db import Database

COOKIE_NAME = "hrh_session"

# Paths reachable without a session (login flow + health only). Exact
# matches: a prefix test would also open e.g. "/login-anything".
_PUBLIC_PATHS = frozenset({
    "/login", "/api/auth/login", "/api/auth/logout", "/health", "/favicon.ico",
    # Icons + web manifest: fetched without cookies (and on the login page).
    "/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png",
    "/icon-maskable-512.png", "/manifest.webmanifest",
})
_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Distributed guessing (many IPs): above this many failures in the window,
# every login attempt is slowed down (tarpit) — the owner is never locked out.
_GLOBAL_WINDOW_S = 600
_GLOBAL_FAILS = 30
_TARPIT_S = 3.0


def _now() -> int:
    return int(time.time())


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _load_session_secret() -> bytes:
    if settings.session_secret:
        return settings.session_secret.encode()
    f = settings.session_key_file
    if f.exists():
        key = f.read_bytes().strip()
        if len(key) >= 32:
            return key
        # Empty/truncated key file (e.g. crash mid-write) would make tokens
        # forgeable: replace it (existing logins end once).
    f.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_bytes(32)
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(base64.urlsafe_b64encode(key))
    return base64.urlsafe_b64encode(key)


def _is_private(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return host in ("testclient", "localhost")
    return ip.is_private or ip.is_loopback


def ban_key(ip: str) -> str:
    """IPv6 clients are banned per /64 (one client = a whole /64 to rotate in)."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if addr.version == 6:
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return ip


class AuthManager:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._base_secret = _load_session_secret()
        self._db.execute("CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self._global_fails: deque[float] = deque()
        self._derive_secret()

    def _generation(self) -> str:
        row = self._db.query_one("SELECT value FROM app_kv WHERE key = 'session_generation'")
        return row["value"] if row else "0"

    def _derive_secret(self) -> None:
        # Tokens are bound to: the key file, a generation counter ("sign out
        # everywhere" bumps it) and the password (changing it ends sessions).
        pw = hashlib.sha256(settings.auth_password.encode()).hexdigest()
        self._secret = hmac.new(self._base_secret, f"gen:{self._generation()}:pw:{pw}".encode(), hashlib.sha256).digest()

    def revoke_all(self) -> None:
        gen = str(int(self._generation()) + 1)
        self._db.execute(
            "INSERT INTO app_kv (key, value) VALUES ('session_generation', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (gen,))
        self._derive_secret()

    # ---- client ip (behind cloudflare/nginx) ----

    @staticmethod
    def client_ip(request: Request) -> str:
        peer = request.client.host if request.client else "unknown"
        # Forwarding headers are only believed from our own proxy hop (the
        # tunnel / nginx on the private docker network); anyone talking to
        # the backend directly could otherwise pick any IP.
        if _is_private(peer):
            cf = request.headers.get("cf-connecting-ip")
            if cf:
                return cf.strip()
            xff = request.headers.get("x-forwarded-for")
            if xff:
                return xff.split(",")[0].strip()
        return peer

    # ---- distributed-guessing tarpit ----

    def note_global_failure(self) -> None:
        self._global_fails.append(time.monotonic())

    async def tarpit(self) -> None:
        now = time.monotonic()
        while self._global_fails and now - self._global_fails[0] > _GLOBAL_WINDOW_S:
            self._global_fails.popleft()
        if len(self._global_fails) >= _GLOBAL_FAILS:
            await asyncio.sleep(_TARPIT_S)

    # ---- session token ----

    def issue_token(self, sub: str) -> str:
        exp = _now() + settings.session_ttl_days * 86400
        payload = _b64e(json.dumps({"sub": sub, "exp": exp}).encode())
        sig = _b64e(hmac.new(self._secret, payload.encode(), hashlib.sha256).digest())
        return f"{payload}.{sig}"

    def token_from_request(self, request: Request) -> str | None:
        """Session token from the cookie (web) or an Authorization: Bearer
        header (mobile/native clients that can't hold HttpOnly cookies)."""
        cookie = request.cookies.get(COOKIE_NAME)
        if cookie:
            return cookie
        authz = request.headers.get("authorization", "")
        if authz.lower().startswith("bearer "):
            return authz[7:].strip()
        return None

    def verify_token(self, token: str | None) -> bool:
        if not token or "." not in token:
            return False
        payload, sig = token.rsplit(".", 1)
        expected = _b64e(hmac.new(self._secret, payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return False
        try:
            data = json.loads(_b64d(payload))
        except Exception:
            return False
        return int(data.get("exp", 0)) > _now()

    # ---- credentials ----

    def check_credentials(self, username: str, password: str) -> bool:
        if not settings.auth_password:
            # Misconfiguration guard: refuse all logins rather than allow-all.
            return False
        # Bytes, not str: compare_digest raises on non-ASCII str (e.g. a
        # password typed with a Korean IME), which used to 500 the login.
        u_ok = hmac.compare_digest(username.encode(), settings.auth_username.encode())
        p_ok = hmac.compare_digest(password.encode(), settings.auth_password.encode())
        return u_ok and p_ok

    # ---- ip ban tracking ----

    def is_banned(self, ip: str) -> bool:
        row = self._db.query_one(
            "SELECT banned_until FROM login_attempts WHERE ip = ?", (ban_key(ip),)
        )
        if not row or not row["banned_until"]:
            return False
        return row["banned_until"] > _iso(_now())

    def record_failure(self, ip: str) -> bool:
        """Increment failure count; ban when threshold reached. Returns is_banned."""
        ip = ban_key(ip)
        self.note_global_failure()
        row = self._db.query_one("SELECT fails FROM login_attempts WHERE ip = ?", (ip,))
        fails = (row["fails"] if row else 0) + 1
        banned_until = None
        if fails >= settings.max_login_fails:
            banned_until = _iso(_now() + settings.ban_hours * 3600)
        self._db.execute(
            """
            INSERT INTO login_attempts (ip, fails, banned_until, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(ip) DO UPDATE SET
                fails=excluded.fails, banned_until=excluded.banned_until,
                updated_at=excluded.updated_at
            """,
            (ip, fails, banned_until, _iso(_now())),
        )
        return banned_until is not None

    def clear_failures(self, ip: str) -> None:
        self._db.execute("DELETE FROM login_attempts WHERE ip IN (?, ?)", (ip, ban_key(ip)))

    def cookie_kwargs(self) -> dict:
        return {
            "key": COOKIE_NAME,
            "httponly": True,
            "secure": settings.cookie_secure,
            "samesite": "lax",
            "max_age": settings.session_ttl_days * 86400,
            "path": "/",
        }


def origin_allowed(origin: str | None, host: str | None) -> bool:
    """Same-origin (or a configured CORS origin). No Origin header = not a
    browser cross-site request (curl, native apps) -> allowed."""
    if not origin:
        return True
    if origin == "null":  # sandboxed/opaque origins never carry our cookie legitimately
        return False
    try:
        from urllib.parse import urlsplit

        o = urlsplit(origin)
    except ValueError:
        return False
    if host and o.netloc.lower() == host.lower():
        return True
    return origin.rstrip("/") in {x.rstrip("/") for x in settings.cors_origin_list}


INTERNAL_PREFIX = "/api/internal/"
_PROXY_HEADERS = ("x-forwarded-for", "x-real-ip", "cf-connecting-ip", "forwarded")


def internal_caller_ok(request: Request) -> bool:
    """A request straight from this host (the TCP peer itself is loopback and
    nothing forwarded it — a proxy/tunnel on localhost adds its headers)."""
    peer = request.client.host if request.client else ""
    try:
        if not ipaddress.ip_address(peer).is_loopback:
            return False
    except ValueError:
        return False
    return not any(h in request.headers for h in _PROXY_HEADERS)


class AuthMiddleware(BaseHTTPMiddleware):
    """Gate every request: banned IPs are blocked; everyone else needs a session."""

    async def dispatch(self, request: Request, call_next):
        auth: AuthManager = request.app.state.auth
        path = request.url.path
        ip = AuthManager.client_ip(request)

        # Banned IPs are blocked everywhere (not just the login route).
        if auth.is_banned(ip):
            return JSONResponse(
                {"detail": "too many failed attempts — IP temporarily blocked"},
                status_code=403,
            )

        if path in _PUBLIC_PATHS:
            return await call_next(request)

        if path.startswith(INTERNAL_PREFIX):
            # The mate MCP bridge (a child of the backend): loopback only, no
            # proxy hop, and a live per-conversation token — never the cookie.
            if not internal_caller_ok(request):
                return JSONResponse({"detail": "not found"}, status_code=404)
            mates = getattr(request.app.state, "mate_service", None)
            if mates is None or mates.token_info(request.headers.get("x-mate-token")) is None:
                return JSONResponse({"detail": "invalid mate token"}, status_code=401)
            return await call_next(request)

        if auth.verify_token(auth.token_from_request(request)):
            # CSRF: a cookie-authenticated, state-changing request must come
            # from our own pages (sibling subdomains are "same-site" for Lax).
            if (
                request.method in _UNSAFE_METHODS
                and request.cookies.get(COOKIE_NAME)
                and not origin_allowed(request.headers.get("origin"), request.headers.get("host"))
            ):
                return JSONResponse({"detail": "cross-origin request blocked"}, status_code=403)
            # Sliding session: every authenticated hit re-issues the cookie, so a
            # browser that returns within the 7-day window stays logged in
            # indefinitely. Only true 7-day inactivity logs it out.
            response = await call_next(request)
            response.set_cookie(value=auth.issue_token(settings.auth_username), **auth.cookie_kwargs())
            return response

        # Unauthenticated: redirect browsers to the login page, 401 for API/WS.
        accept = request.headers.get("accept", "")
        if request.method == "GET" and "text/html" in accept:
            return RedirectResponse("/login", status_code=302)
        return JSONResponse({"detail": "authentication required"}, status_code=401)
