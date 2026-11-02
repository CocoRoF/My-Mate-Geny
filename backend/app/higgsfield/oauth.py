"""Higgsfield sign-in: the official CLI's OAuth client, and reading what the user pastes back.

Higgsfield opens its account API only to its own CLI's OAuth client (Clerk, PKCE, callback
``http://localhost:8765/callback``). A server can't receive that callback, so the user finishes the login in a browser
and pastes the (unopened) localhost address back — or the CLI's ``credentials.json`` (``higgsfield auth login``). The
desktop app may also catch the callback on localhost:8765 itself and hand it over the same way.

Tokens are kept as ``{access, refresh, issued_at, expires_at}`` (ISO times); access tokens live about a day, and the
refresh token may change on every use — so only the server refreshes (service.py), never an agent.
(Ported from the Ailism AI hub, ai_hub/higgsfield.py.)
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

CLIENT_ID = "sRGCQJvvJkPrrtRj"
REDIRECT_URI = "http://localhost:8765/callback"
SCOPES = "email profile offline_access user:org:read"
#: A started login can be finished for this long.
PENDING_TTL_S = 15 * 60


class HiggsfieldError(Exception):
    """A failure the API answers as ``{"detail": {"code", "message"}}``; ``message`` is already redacted."""

    STATUS = {
        "not_connected": 404, "reauth_required": 409, "invalid_callback": 400, "oauth_denied": 400,
        "login_expired": 400, "import_failed": 400, "unknown_workspace": 400, "invalid_params": 400,
        "unknown_job_type": 404,
        "token_exchange_failed": 502, "network": 502, "api_error": 502, "bad_json": 502, "skills_failed": 502,
    }

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.message = message

    @property
    def status(self) -> int:
        return self.STATUS.get(self.code, 502)

    def text(self) -> str:
        return f"{self.code}: {self.message}" if self.message else self.code


# ---- redaction: nothing a provider says back may carry a credential into a log, an error or the UI ----

_REDACT = [
    (re.compile(r"\b(oat_)[A-Za-z0-9_\-]{4,}"), r"\1…"),  # Clerk OAuth access tokens
    (re.compile(r"(Bearer\s+)[^\s\"']+", re.I), r"\1…"),
    (re.compile(r"((?:access_token|refresh_token|id_token|code_verifier|code|token|secret|password|authorization)"
                r"\"?\s*[=:]\s*\"?)[^\s,;&\"']+", re.I), r"\1…"),
    (re.compile(r"://[^/\s:@]+:[^/\s@]+@"), "://…:…@"),
    (re.compile(r"\?[^\s\"']*"), "?…"),
]


def redact(text: Any, *known: str | None, limit: int = 300) -> str:
    """``text`` without the given secrets and anything that looks like a credential, on one line, shortened."""
    out = str(text or "")
    for s in known:
        if s and len(s) >= 4:
            out = out.replace(s, "…")
    for pattern, repl in _REDACT:
        out = pattern.sub(repl, out)
    return " ".join(out.split())[:limit]


# ---- PKCE ----


def pkce() -> tuple[str, str]:
    """(verifier, S256 challenge)"""
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def authorize_url(base: str, state: str, challenge: str) -> str:
    query = urlencode({
        "client_id": CLIENT_ID, "code_challenge": challenge, "code_challenge_method": "S256",
        "redirect_uri": REDIRECT_URI, "response_type": "code", "scope": SCOPES, "state": state,
    })
    return f"{base}?{query}"


def parse_callback(value: str) -> tuple[str, str | None]:
    """The pasted callback address (or just its query, or the bare code) → (code, state)."""
    raw = (value or "").strip()
    if not raw:
        raise HiggsfieldError("invalid_callback")
    query = urlparse(raw).query if "://" in raw else raw.split("?", 1)[-1]
    params = parse_qs(query)
    if "error" in params:
        said = params.get("error_description", params["error"])[0]
        raise HiggsfieldError("oauth_denied", redact(said))
    if "code" in params:
        code = params["code"][0].strip()
        if not code:
            raise HiggsfieldError("invalid_callback")
        return code, (params.get("state") or [None])[0]
    if "=" in raw or "/" in raw or " " in raw or "\n" in raw:
        raise HiggsfieldError("invalid_callback")
    return raw, None


# ---- tokens ----


def parse_time(value: Any) -> datetime | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 10_000_000_000 else value  # (milliseconds)
        try:
            return datetime.fromtimestamp(seconds, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    return None


def normalize_tokens(data: Any, *, now: datetime | None = None) -> dict[str, Any] | None:
    """Tokens as ``{access, refresh, issued_at, expires_at}`` from an OAuth token answer, the CLI's credentials.json
    (``access_token``, ``refresh_token``, ``expires_at`` in epoch seconds) or our own shape. None = no access token."""
    if isinstance(data, (str, bytes)):
        try:
            data = json.loads(data)
        except ValueError:
            return None
    if not isinstance(data, dict):
        return None
    access = data.get("access") or data.get("access_token")
    if not isinstance(access, str) or not access.strip():
        return None
    refresh = data.get("refresh") or data.get("refresh_token")
    issued = parse_time(data.get("issued_at")) or now or datetime.now(timezone.utc)
    expires = parse_time(data.get("expires_at"))
    if expires is None and isinstance(data.get("expires_in"), (int, float)) and not isinstance(data["expires_in"], bool):
        expires = issued + timedelta(seconds=int(data["expires_in"]))
    return {
        "access": access.strip(),
        "refresh": refresh.strip() if isinstance(refresh, str) and refresh.strip() else None,
        "issued_at": issued.isoformat(),
        "expires_at": expires.isoformat() if expires else None,
    }


def needs_refresh(tokens: dict[str, Any], at: datetime | None = None, *, keep: timedelta = timedelta(0)) -> bool:
    """Within 10 minutes of expiry or the last 20 % of the token's life (whichever is shorter) — or, with ``keep``,
    with less than that much left (at most half the life): a token handed to an agent must outlast a long job."""
    expires = parse_time(tokens.get("expires_at"))
    if expires is None:
        return False
    issued = parse_time(tokens.get("issued_at")) or expires
    life = max(expires - issued, timedelta(0))
    margin = min(timedelta(minutes=10), life * 0.2)
    if keep:
        margin = max(margin, min(keep, life * 0.5))
    return expires - margin <= (at or datetime.now(timezone.utc))


def cli_credentials(access: str, scope: str = SCOPES) -> dict[str, Any]:
    """The credentials.json an agent's `higgsfield` CLI gets: the access token ONLY. No refresh token (the CLI would
    rotate it and sign the server out) and no expiry (near an expiry the CLI tries to refresh, and without a refresh
    token it deletes the file) — the server rewrites the file with a fresh token well before this one expires."""
    return {"auth_version": 2, "access_token": access, "token_type": "bearer", "scope": scope}
