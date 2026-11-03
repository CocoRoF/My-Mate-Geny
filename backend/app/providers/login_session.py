"""Login sessions: what each account is signed in with, read from the CLI's
own files — never a network call, never a token leaving this module.

* Claude: ``<config dir>/.credentials.json`` → ``claudeAiOauth`` (accessToken,
  refreshToken, expiresAt / refreshTokenExpiresAt in epoch ms, scopes,
  subscriptionType, rateLimitTier) — the file Claude Code itself reads and
  rewrites when it renews the token (on Linux there's no keychain: this file
  IS the store). Who the account is: ``oauthAccount`` in the CLI's
  ``.claude.json`` (``~/.claude.json`` for the host login, the account's own
  config dir otherwise).
* Codex: ``<CODEX_HOME>/auth.json`` → ``auth_mode`` (chatgpt | apikey),
  ``tokens`` (id_token / access_token JWTs, refresh_token, account_id),
  ``last_refresh``. The JWTs' payloads say when they expire and who it is.

:func:`classify` turns that into one health word for the card, the Settings
badge (only ``actionable`` ones) and the load balancer (``session_ok``).
"""

from __future__ import annotations

import base64
import json
import os
import time
from datetime import datetime, timezone
from typing import Any

# The access token's "expiring soon" (Claude Code renews it 5 min before; this
# is only information — the next use renews it).
EXPIRING_S = 15 * 60
# A refresh token this close to its end means a sign-in soon.
REFRESH_EXPIRING_S = 3 * 86400
# Claude Code renews when the access token is within this of expiring.
CLI_REFRESH_WINDOW_S = 300

HEALTHS = ("valid", "expiring", "expired", "refresh_failed", "needs_login", "no_credentials")
# What the user has to act on (the Settings badge; the balancer skips them).
ACTIONABLE = ("needs_login", "refresh_failed")


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _parse_iso(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        v = value.replace("Z", "+00:00")
        # codex writes nanoseconds: Python takes at most microseconds
        if "." in v:
            head, tail = v.split(".", 1)
            frac, rest = tail, ""
            for i, ch in enumerate(tail):
                if not ch.isdigit():
                    frac, rest = tail[:i], tail[i:]
                    break
            v = f"{head}.{frac[:6]}{rest}"
        dt = datetime.fromisoformat(v)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def _ms(value: Any) -> float | None:
    """Epoch milliseconds (the CLI's format) → seconds."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v <= 0:
        return None
    return v / 1000.0 if v > 1e11 else v


def read_json(path: str) -> dict | None:
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def file_signature(path: str) -> str:
    """Changes whenever the file is rewritten (renewed, signed in again)."""
    try:
        st = os.stat(path)
    except OSError:
        return ""
    return f"{st.st_mtime_ns}:{st.st_size}"


def jwt_claims(token: Any) -> dict:
    """A JWT's payload (unverified — only to read exp / email / plan locally)."""
    if not isinstance(token, str) or token.count(".") < 2:
        return {}
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        data = json.loads(base64.urlsafe_b64decode(part))
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}


def classify(
    *, now: float, present: bool, method: str, expires_at: float | None, has_refresh: bool,
    refresh_expires_at: float | None = None, renew_failure: dict | None = None, rejected: bool = False,
) -> tuple[str, str]:
    """(health, detail) of a login.

    health: valid | expiring | expired | refresh_failed | needs_login | no_credentials.
    ``expired`` = the access token has run out but a refresh token can renew
    it (the CLI does on its next use) — information, not a problem.
    ``refresh_failed`` = expired AND the last renewal failed (transiently);
    ``needs_login`` = it can't be renewed (no / expired / revoked refresh
    token, or the provider refused the account). ``renew_failure``: the last
    renewal's result while the credentials are still the ones it tried with;
    ``definitive`` = the provider said the refresh token is no good.
    """
    if not present:
        return "no_credentials", "not_signed_in"
    if method in ("api_key", "setup_token"):
        if expires_at is not None and expires_at <= now:
            return "needs_login", "token_expired"
        return "valid", method
    if renew_failure and renew_failure.get("definitive"):
        return "needs_login", str(renew_failure.get("code") or "revoked")
    if rejected:
        return "needs_login", "rejected"
    refresh_dead = refresh_expires_at is not None and refresh_expires_at <= now
    if expires_at is not None and expires_at <= now:
        if not has_refresh:
            return "needs_login", "no_refresh_token"
        if refresh_dead:
            return "needs_login", "refresh_token_expired"
        if renew_failure:
            return "refresh_failed", str(renew_failure.get("code") or "renew_failed")
        return "expired", "renews_on_use"
    if refresh_dead or (has_refresh is False and expires_at is not None and expires_at - now <= EXPIRING_S):
        return "expiring", "refresh_token_expired" if refresh_dead else "no_refresh_token"
    if expires_at is not None and expires_at - now <= EXPIRING_S:
        return "expiring", "renews_on_use"
    if refresh_expires_at is not None and refresh_expires_at - now <= REFRESH_EXPIRING_S:
        return "expiring", "refresh_token_expiring"
    return "valid", ""


# ---------------------------------------------------------------- claude


def _claude_plan(sub: str) -> str:
    sub = (sub or "").strip()
    return f"Claude {sub.capitalize()}" if sub else ""


def claude_facts(cfg_dir: str, *, identity_file: str | None = None) -> dict:
    """What the Claude credentials say (no secrets: presence flags only).
    ``access_fp`` is a short one-way fingerprint for change detection; it
    never leaves the backend (:func:`public` drops it)."""
    path = os.path.join(cfg_dir, ".credentials.json")
    doc = read_json(path)
    oauth = (doc or {}).get("claudeAiOauth") if doc else None
    oauth = oauth if isinstance(oauth, dict) else {}
    access = oauth.get("accessToken")
    present = bool(access)
    try:
        updated = os.path.getmtime(path) if doc is not None else None
    except OSError:
        updated = None
    expires = _ms(oauth.get("expiresAt"))
    refresh = oauth.get("refreshToken")
    method = "oauth"
    if present and not refresh and expires is None:
        method = "setup_token"  # a long-lived token (`claude setup-token`) written as credentials
    ident: dict = {}
    if identity_file:
        cfg = read_json(identity_file) or {}
        acct = cfg.get("oauthAccount") if isinstance(cfg.get("oauthAccount"), dict) else {}
        ident = {
            "email": acct.get("emailAddress") or "",
            "organization": acct.get("organizationName") or "",
            "display_name": acct.get("displayName") or "",
        }
    scopes = oauth.get("scopes")
    return {
        "provider": "claude",
        "file": path,
        "present": present,
        "method": method,
        "expires_at": expires,
        "has_refresh_token": bool(refresh),
        "refresh_expires_at": _ms(oauth.get("refreshTokenExpiresAt")),
        "updated_at": updated,
        "scopes": [s for s in scopes if isinstance(s, str)] if isinstance(scopes, list) else [],
        "plan": _claude_plan(oauth.get("subscriptionType") or ""),
        "rate_limit_tier": oauth.get("rateLimitTier") or "",
        "email": ident.get("email", ""),
        "organization": ident.get("organization", ""),
        "display_name": ident.get("display_name", ""),
        "access_fp": _fingerprint(access),
        "sig": file_signature(path),
    }


def _fingerprint(token: Any) -> str:
    if not isinstance(token, str) or not token:
        return ""
    import hashlib

    return hashlib.sha256(token.encode()).hexdigest()[:16]


# ---------------------------------------------------------------- codex


def codex_facts(codex_home: str) -> dict:
    path = os.path.join(codex_home, "auth.json")
    doc = read_json(path)
    tokens = (doc or {}).get("tokens") if doc else None
    tokens = tokens if isinstance(tokens, dict) else {}
    access = tokens.get("access_token")
    api_key = (doc or {}).get("OPENAI_API_KEY")
    mode = str((doc or {}).get("auth_mode") or "").lower()
    if mode in ("apikey", "api_key") or (api_key and not access):
        method = "api_key"
        present = bool(api_key)
    else:
        method = "chatgpt"
        present = bool(access)
    claims = jwt_claims(access)
    id_claims = jwt_claims(tokens.get("id_token"))
    auth_claims = id_claims.get("https://api.openai.com/auth") or claims.get("https://api.openai.com/auth") or {}
    plan = str(auth_claims.get("chatgpt_plan_type") or "").replace("_", " ").title()
    scopes = claims.get("scp") or claims.get("scope") or []
    if isinstance(scopes, str):
        scopes = scopes.split()
    exp = claims.get("exp")
    profile = claims.get("https://api.openai.com/profile") or {}
    return {
        "provider": "codex",
        "file": path,
        "present": present,
        "method": method,
        "expires_at": float(exp) if isinstance(exp, (int, float)) else None,
        "has_refresh_token": bool(tokens.get("refresh_token")),
        "refresh_expires_at": None,  # codex's refresh tokens don't say
        "updated_at": _parse_iso((doc or {}).get("last_refresh")) if doc else None,
        "scopes": [s for s in scopes if isinstance(s, str)] if isinstance(scopes, list) else [],
        "plan": f"ChatGPT {plan}" if plan else "",
        "rate_limit_tier": "",
        "email": id_claims.get("email") or (profile.get("email") if isinstance(profile, dict) else "") or "",
        "organization": "",
        "display_name": id_claims.get("name") or "",
        "access_fp": _fingerprint(access or api_key),
        "sig": file_signature(path),
    }


# ---------------------------------------------------------------- public view


def stored_key_facts(method: str) -> dict:
    """Facts for a login that lives in the app's vault / environment (an API
    key, a long-lived token): no file, no expiry the app can read."""
    return {"provider": "", "file": "", "present": True, "method": method, "expires_at": None,
            "has_refresh_token": False, "refresh_expires_at": None, "updated_at": None, "scopes": [],
            "plan": "", "rate_limit_tier": "", "email": "", "organization": "", "display_name": "",
            "access_fp": "", "sig": method}


def public(facts: dict, *, now: float | None = None, renew: dict | None = None, rejected: bool = False) -> dict:
    """The card's view of a login (no token, no fingerprint)."""
    now = now if now is not None else time.time()
    present = bool(facts.get("present"))
    method = facts.get("method") or "none"
    # a renewal result only counts while the file is the one it tried with
    failure = renew if renew and not renew.get("ok") and renew.get("sig") == facts.get("sig") else None
    health, detail = classify(
        now=now, present=present, method=method, expires_at=facts.get("expires_at"),
        has_refresh=bool(facts.get("has_refresh_token")), refresh_expires_at=facts.get("refresh_expires_at"),
        renew_failure=failure, rejected=rejected,
    )
    exp = facts.get("expires_at")
    renewable = (
        method in ("oauth", "chatgpt") and present and bool(facts.get("has_refresh_token"))
        and health != "needs_login"
    )
    out = {
        "method": method if present else "none",
        "email": facts.get("email") or "",
        "organization": facts.get("organization") or "",
        "plan": facts.get("plan") or "",
        "rate_limit_tier": facts.get("rate_limit_tier") or "",
        "expires_at": _iso(exp),
        "expires_in_s": int(exp - now) if exp else None,
        "has_refresh_token": bool(facts.get("has_refresh_token")),
        "refresh_expires_at": _iso(facts.get("refresh_expires_at")),
        "updated_at": _iso(facts.get("updated_at")),
        "scopes": list(facts.get("scopes") or []),
        "health": health,
        "detail": detail,
        "actionable": health in ACTIONABLE,
        "renewable": renewable,
        "checked_at": _iso(now),
    }
    if renew:
        out["last_renew"] = {k: renew.get(k) for k in ("at", "ok", "method", "code", "error")}
    return out
