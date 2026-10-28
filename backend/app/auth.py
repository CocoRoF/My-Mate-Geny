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

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timezone

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.db import Database

COOKIE_NAME = "hrh_session"

# Paths reachable without a session (login flow + health only).
_PUBLIC_PREFIXES = ("/login", "/api/auth/login", "/api/auth/logout", "/health", "/favicon.ico")


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
        return f.read_bytes().strip()
    f.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_bytes(32)
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(base64.urlsafe_b64encode(key))
    return base64.urlsafe_b64encode(key)


class AuthManager:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._secret = _load_session_secret()

    # ---- client ip (behind cloudflare/nginx) ----

    @staticmethod
    def client_ip(request: Request) -> str:
        cf = request.headers.get("cf-connecting-ip")
        if cf:
            return cf.strip()
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    # ---- session token ----

    def issue_token(self, sub: str) -> str:
        exp = _now() + settings.session_ttl_days * 86400
        payload = _b64e(json.dumps({"sub": sub, "exp": exp}).encode())
        sig = _b64e(hmac.new(self._secret, payload.encode(), hashlib.sha256).digest())
        return f"{payload}.{sig}"

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
        u_ok = hmac.compare_digest(username, settings.auth_username)
        p_ok = hmac.compare_digest(password, settings.auth_password)
        return u_ok and p_ok

    # ---- ip ban tracking ----

    def is_banned(self, ip: str) -> bool:
        row = self._db.query_one(
            "SELECT banned_until FROM login_attempts WHERE ip = ?", (ip,)
        )
        if not row or not row["banned_until"]:
            return False
        return row["banned_until"] > _iso(_now())

    def record_failure(self, ip: str) -> bool:
        """Increment failure count; ban when threshold reached. Returns is_banned."""
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
        self._db.execute("DELETE FROM login_attempts WHERE ip = ?", (ip,))

    def cookie_kwargs(self) -> dict:
        return {
            "key": COOKIE_NAME,
            "httponly": True,
            "secure": settings.cookie_secure,
            "samesite": "lax",
            "max_age": settings.session_ttl_days * 86400,
            "path": "/",
        }


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

        if path.startswith(_PUBLIC_PREFIXES):
            return await call_next(request)

        if auth.verify_token(request.cookies.get(COOKIE_NAME)):
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
