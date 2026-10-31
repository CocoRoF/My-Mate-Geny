"""Authentication: single-user login, signed 7-day session cookie, IP banning.

Credentials, highest precedence first (docs/auth.md):

1. stored in the DB (set in Admin -> Security; the password is kept only as a
   salted scrypt hash in ``app_kv['auth_credentials']``),
2. env ``AUTH_USERNAME`` / ``AUTH_PASSWORD``,
3. the built-in defaults ``admin`` / ``geny-admin`` — a fresh install can sign
   in, but every page (and the startup log) warns until it is changed.

* A successful login persists in the browser for 7 days (signed sliding cookie
  ``hrh_session``); native clients get the same token in the JSON body and send
  it as ``Authorization: Bearer`` / ``?token=`` (WebSocket).
* After 3+ failed attempts an IP is blocked (for ``ban_hours``), persisted in
  SQLite so a restart doesn't forget the ban.
* Native connect pages (Electron file://, Capacitor) log in cross-origin and
  turn the result into a first-party cookie through a one-time exchange code
  (``POST /api/auth/login {exchange: true}`` -> ``GET /auth/exchange``).

The session cookie is a compact HMAC-signed token ``<payload>.<sig>`` where
payload is base64url(JSON{sub, exp}). No server-side session store needed — the
signature + expiry are self-validating, and the signing key persists across
restarts so existing logins survive a redeploy. The signing key is derived from
the credentials, so changing them (or "sign out everywhere") ends every session.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timezone

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from app.config import settings
from app.db import Database


COOKIE_NAME = "hrh_session"

# Zero-config credentials (precedence: DB > env > these). Public knowledge, so
# the UI and the startup log warn for as long as they are in use.
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "geny-admin"
MIN_PASSWORD_LEN = 8
MAX_FIELD_LEN = 1024
_CRED_KEY = "auth_credentials"

# One-time login exchange codes (native connect pages -> first-party cookie).
EXCHANGE_TTL_S = 60
_EXCHANGE_MAX = 256

# Wrong "current password" on the credential change form (an attacker with a
# stolen session must not be able to brute-force it into a permanent takeover).
_CHANGE_FAILS = 5
_CHANGE_WINDOW_S = 900

# Paths reachable without a session (login flow + health only). Exact
# matches: a prefix test would also open e.g. "/login-anything".
_PUBLIC_PATHS = frozenset({
    "/login", "/api/auth/login", "/api/auth/logout", "/auth/exchange", "/health", "/favicon.ico",
    # Icons + web manifest: fetched without cookies (and on the login page).
    "/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png",
    "/icon-maskable-512.png", "/manifest.webmanifest", "/logo.png",
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


# ---- password hashing (stdlib only) -------------------------------------------

# scrypt N=2^15, r=8, p=1: ~32 MiB and ~0.1 s per hash. Logins are rare on a
# single-user server; a semaphore bounds concurrent hashing (memory) anyway.
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2**15, 8, 1
_SCRYPT_MAXMEM = 64 * 1024 * 1024
_hash_slots = threading.BoundedSemaphore(2)


def hash_password(password: str) -> str:
    """``scrypt$N$r$p$<salt b64>$<hash b64>`` (salted, self-describing)."""
    salt = secrets.token_bytes(16)
    with _hash_slots:
        dk = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P,
                            maxmem=_SCRYPT_MAXMEM, dklen=32)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64e(salt)}${_b64e(dk)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, *rest = encoded.split("$")
        if algo == "scrypt":
            n, r, p, salt, want = rest
            with _hash_slots:
                dk = hashlib.scrypt(password.encode(), salt=_b64d(salt), n=int(n), r=int(r), p=int(p),
                                    maxmem=_SCRYPT_MAXMEM, dklen=len(_b64d(want)))
        elif algo == "pbkdf2_sha256":
            iters, salt, want = rest
            dk = hashlib.pbkdf2_hmac("sha256", password.encode(), _b64d(salt), int(iters), len(_b64d(want)))
        else:
            return False
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, _b64d(want))


def password_problem(password: str, username: str = "") -> str | None:
    """Why a new password is refused (None = acceptable)."""
    if len(password) < MIN_PASSWORD_LEN:
        return f"password must be at least {MIN_PASSWORD_LEN} characters"
    if len(password) > MAX_FIELD_LEN:
        return "password is too long"
    if password == DEFAULT_PASSWORD:
        return "that is the public default password — choose another"
    if username and password.lower() == username.lower():
        return "password must differ from the username"
    return None


def username_problem(username: str) -> str | None:
    if not username or len(username) > 64:
        return "username must be 1-64 characters"
    if any(c.isspace() or ord(c) < 32 for c in username):
        return "username must not contain spaces or control characters"
    return None


def request_is_https(request: Request) -> bool:
    """https directly, or behind a TLS-terminating proxy / Cloudflare."""
    if request.url.scheme == "https":
        return True
    xfp = request.headers.get("x-forwarded-proto", "")
    if xfp.split(",")[0].strip().lower() == "https":
        return True
    return '"https"' in request.headers.get("cf-visitor", "").replace(" ", "")


def safe_next(next_path: str | None) -> str:
    """Only same-origin relative paths (``/...``); anything else -> ``/``."""
    from urllib.parse import urlsplit

    p = (next_path or "").strip()
    if not p.startswith("/") or p.startswith("//") or "\\" in p:
        return "/"
    if any(ord(c) < 32 or ord(c) == 127 for c in p):
        return "/"
    try:
        parts = urlsplit(p)
    except ValueError:
        return "/"
    if parts.scheme or parts.netloc:
        return "/"
    return p


class AuthManager:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._base_secret = _load_session_secret()
        self._db.execute("CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self._global_fails: deque[float] = deque()
        self._exchange: dict[str, tuple[float, str]] = {}
        self._change_fails: deque[float] = deque()
        self._stored = self._load_stored()
        self._derive_secret()

    def _generation(self) -> str:
        row = self._db.query_one("SELECT value FROM app_kv WHERE key = 'session_generation'")
        return row["value"] if row else "0"

    def _derive_secret(self) -> None:
        # Tokens are bound to: the key file, a generation counter ("sign out
        # everywhere" bumps it) and the credentials (changing them ends sessions).
        if self._stored:
            fp = hashlib.sha256(f"{self._stored['username']}\0{self._stored['hash']}".encode()).hexdigest()
            binding = f"gen:{self._generation()}:db:{fp}"
        else:
            # Unchanged formula for env/default credentials: sessions issued
            # before DB credentials existed keep working across the upgrade.
            pw = hashlib.sha256(self._fallback_password().encode()).hexdigest()
            binding = f"gen:{self._generation()}:pw:{pw}"
        self._secret = hmac.new(self._base_secret, binding.encode(), hashlib.sha256).digest()

    def revoke_all(self) -> None:
        gen = str(int(self._generation()) + 1)
        self._db.execute(
            "INSERT INTO app_kv (key, value) VALUES ('session_generation', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (gen,))
        self._derive_secret()

    # ---- credential sources: DB > env > defaults ----

    def _load_stored(self) -> dict | None:
        row = self._db.query_one("SELECT value FROM app_kv WHERE key = ?", (_CRED_KEY,))
        if not row:
            return None
        try:
            data = json.loads(row["value"])
        except ValueError:
            return None
        if not isinstance(data, dict) or not data.get("username") or not data.get("hash"):
            return None
        return data

    @staticmethod
    def _fallback_password() -> str:
        return settings.auth_password or DEFAULT_PASSWORD

    @property
    def source(self) -> str:
        """Where the active credentials come from: ``db`` | ``env`` | ``default``."""
        if self._stored:
            return "db"
        return "env" if settings.auth_password else "default"

    @property
    def username(self) -> str:
        if self._stored:
            return self._stored["username"]
        return settings.auth_username or DEFAULT_USERNAME

    @property
    def using_default_password(self) -> bool:
        return not self._stored and self._fallback_password() == DEFAULT_PASSWORD

    def credentials_info(self) -> dict:
        return {
            "username": self.username,
            "source": self.source,
            "default_password": self.using_default_password,
            "updated_at": (self._stored or {}).get("updated_at"),
            "min_password_length": MIN_PASSWORD_LEN,
        }

    def warn_if_default(self) -> None:
        if self.using_default_password:
            # uvicorn's logger: shown on the console and (via the log bridge)
            # in Admin -> Error logs.
            logging.getLogger("uvicorn.error").warning(
                "auth: the DEFAULT password is in use (user '%s' / '%s'). Anyone who can reach this "
                "server can sign in — change it in Admin -> Security (or set AUTH_PASSWORD).",
                self.username, DEFAULT_PASSWORD,
            )

    def set_credentials(self, username: str, password: str) -> None:
        """Store new credentials (DB source from now on). A fresh salt makes
        the binding change even for an identical password, so every existing
        session ends."""
        record = {
            "username": username,
            "hash": hash_password(password),
            "updated_at": _iso(_now()),
            "version": int((self._stored or {}).get("version", 0)) + 1,
        }
        self._db.execute(
            "INSERT INTO app_kv (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (_CRED_KEY, json.dumps(record)))
        self._stored = record
        self._exchange.clear()
        self._derive_secret()

    def clear_stored_credentials(self) -> None:
        """Back to env / default credentials (recovery; ends every session)."""
        self._db.execute("DELETE FROM app_kv WHERE key = ?", (_CRED_KEY,))
        self._stored = None
        self._exchange.clear()
        self._derive_secret()

    # ---- credential change throttle ----

    def change_blocked(self) -> bool:
        now = time.monotonic()
        while self._change_fails and now - self._change_fails[0] > _CHANGE_WINDOW_S:
            self._change_fails.popleft()
        return len(self._change_fails) >= _CHANGE_FAILS

    def note_change_failure(self) -> None:
        self._change_fails.append(time.monotonic())

    # ---- one-time exchange codes ----

    def create_exchange_code(self, token: str) -> str:
        now = time.monotonic()
        for c, (exp, _t) in list(self._exchange.items()):
            if exp <= now:
                del self._exchange[c]
        while len(self._exchange) >= _EXCHANGE_MAX:  # oldest first
            del self._exchange[next(iter(self._exchange))]
        code = secrets.token_urlsafe(32)
        self._exchange[code] = (now + EXCHANGE_TTL_S, token)
        return code

    def consume_exchange_code(self, code: str | None) -> str | None:
        """The session token behind a code: single use, 60 s, and only while
        the token itself is still valid (credentials unchanged)."""
        if not code:
            return None
        entry = self._exchange.pop(code, None)
        if entry is None:
            return None
        exp, token = entry
        if exp <= time.monotonic() or not self.verify_token(token):
            return None
        return token

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
        # Bytes, not str: compare_digest raises on non-ASCII str (e.g. a
        # password typed with a Korean IME), which used to 500 the login.
        u_ok = hmac.compare_digest(username.encode(), self.username.encode())
        if self._stored:
            # Always hash (even for a wrong username): no timing oracle.
            p_ok = verify_password(password, self._stored["hash"])
        else:
            p_ok = hmac.compare_digest(password.encode(), self._fallback_password().encode())
        return u_ok and p_ok

    async def check_credentials_async(self, username: str, password: str) -> bool:
        """scrypt off the event loop."""
        return await asyncio.to_thread(self.check_credentials, username, password)

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

    def cookie_kwargs(self, request: Request | None = None) -> dict:
        return {
            "key": COOKIE_NAME,
            "httponly": True,
            # COOKIE_SECURE=true forces it; otherwise (auto/false) Secure whenever
            # the browser reached us over https (directly, TLS proxy, Cloudflare)
            # — never on plain http, so LAN servers work.
            "secure": settings.cookie_secure is True or (request is not None and request_is_https(request)),
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
            response.set_cookie(value=auth.issue_token(auth.username), **auth.cookie_kwargs(request))
            return response

        # Unauthenticated: redirect browsers to the login page, 401 for API/WS.
        accept = request.headers.get("accept", "")
        if request.method == "GET" and "text/html" in accept:
            return RedirectResponse("/login", status_code=302)
        return JSONResponse({"detail": "authentication required"}, status_code=401)


# Endpoints a native "connect" page on any origin may call — Electron file://
# (Origin "null"), Capacitor https://localhost / capacitor://localhost, a local
# probe page. Answered with ``Access-Control-Allow-Origin: *`` and never with
# credentials: the browser drops the Set-Cookie, the page reads the token /
# exchange code from the body. Everything else keeps the strict CORS policy.
OPEN_CORS_PATHS: dict[str, str] = {
    "/health": "GET, OPTIONS",
    "/api/auth/login": "POST, OPTIONS",
}
_CORS_STRIP = ("access-control-allow-origin", "access-control-allow-credentials")


class OpenCORSMiddleware:
    """Pure ASGI, outermost: preflights for OPEN_CORS_PATHS are answered here
    (before the credentialed CORSMiddleware could reject an unknown origin),
    and their responses — including 401/403 from the ban gate — get ``*``."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] not in OPEN_CORS_PATHS:
            await self.app(scope, receive, send)
            return
        methods = OPEN_CORS_PATHS[scope["path"]]
        req = Headers(scope=scope)
        if scope["method"] == "OPTIONS" and "access-control-request-method" in req:
            headers = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": methods,
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Max-Age": "600",
            }
            # Chromium Private Network Access: a server on a LAN / loopback
            # address may be probed from a "more public" connect page.
            if req.get("access-control-request-private-network") == "true":
                headers["Access-Control-Allow-Private-Network"] = "true"
            await Response(status_code=204, headers=headers)(scope, receive, send)
            return

        async def send_open(message):
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                for k in _CORS_STRIP:
                    del h[k]
                h["Access-Control-Allow-Origin"] = "*"
            await send(message)

        await self.app(scope, receive, send_open)


def _cli(argv: list[str]) -> int:  # pragma: no cover - manual recovery tool
    """``python -m app.auth reset-credentials``: forget the credentials set in
    Admin (back to env AUTH_USERNAME/AUTH_PASSWORD, else admin/geny-admin)."""
    if argv[:1] != ["reset-credentials"]:
        print("usage: python -m app.auth reset-credentials")
        return 2
    db = Database()
    db.bootstrap()
    auth = AuthManager(db)
    auth.clear_stored_credentials()
    print(f"stored credentials removed; now using {auth.source} credentials (user '{auth.username}'). "
          "Restart the backend so the running server picks this up.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    raise SystemExit(_cli(sys.argv[1:]))
