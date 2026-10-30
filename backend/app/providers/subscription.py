"""Subscription usage — the REAL plan limits (not $ cost), for both providers.

* Claude: ``GET api.anthropic.com/api/oauth/usage`` + ``/api/oauth/profile``
  (bearer = ``claudeAiOauth.accessToken`` from ``.claude/.credentials.json``).
* Codex: ``GET chatgpt.com/backend-api/codex/usage`` (bearer = ``tokens.access_token``
  + ``chatgpt-account-id`` header from ``.codex/auth.json``).

Both are normalized to a common shape: account + a list of usage ``windows``
(label, percent, resets_at) so the UI renders them uniformly.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

_ANTHROPIC = "https://api.anthropic.com"
_CHATGPT = "https://chatgpt.com/backend-api"


class UsageError(RuntimeError):
    pass


def _get_json(url: str, headers: dict[str, str]) -> Any:
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=12) as resp:
        return json.loads(resp.read().decode())


def _window(label: str, percent: Any, resets_at: str | None) -> dict:
    try:
        pct = round(float(percent), 0)
    except (TypeError, ValueError):
        pct = 0.0
    return {"label": label, "percent": pct, "resets_at": resets_at}


def _window_label_from_seconds(sec: int | None) -> str:
    if not sec:
        return "Usage"
    if sec <= 5 * 3600 + 60:
        return "Session (5hr)"
    if sec <= 26 * 3600:
        return "Daily"
    if sec <= 8 * 86400:
        return "Weekly (7 day)"
    return f"{sec // 86400}-day"


# ---------------------------------------------------------------- claude


def _read_claude_oauth(cred_dir: str) -> dict:
    path = os.path.join(cred_dir, ".credentials.json")
    if not os.path.exists(path):
        raise UsageError("not signed in")
    oauth = (json.load(open(path)).get("claudeAiOauth") or {})
    if not oauth.get("accessToken"):
        raise UsageError("no access token")
    return oauth


def _claude_plan(profile: dict, oauth: dict) -> str:
    acc = profile.get("account", {})
    if acc.get("has_claude_max"):
        return "Claude Max"
    if acc.get("has_claude_pro"):
        return "Claude Pro"
    sub = (oauth.get("subscriptionType") or "").strip()
    return f"Claude {sub.capitalize()}" if sub else "Claude"


def claude_subscription(cred_dir: str) -> dict[str, Any]:
    oauth = _read_claude_oauth(cred_dir)
    headers = {
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {oauth['accessToken']}",
    }
    try:
        usage = _get_json(f"{_ANTHROPIC}/api/oauth/usage", headers)
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise UsageError("token expired — re-authenticate this account") from exc
        raise UsageError(f"usage request failed ({exc.code})") from exc
    profile: dict = {}
    try:
        profile = _get_json(f"{_ANTHROPIC}/api/oauth/profile", headers)
    except urllib.error.HTTPError:
        pass

    five = usage.get("five_hour") or {}
    seven = usage.get("seven_day") or {}
    windows = [
        _window("Session (5hr)", five.get("utilization"), five.get("resets_at")),
        _window("Weekly (7 day)", seven.get("utilization"), seven.get("resets_at")),
    ]
    model_windows = [
        _window(l["scope"]["model"]["display_name"], l.get("percent"), l.get("resets_at"))
        for l in (usage.get("limits") or [])
        if (l.get("scope") or {}).get("model", {}).get("display_name")
    ]
    acc = profile.get("account", {})
    org = profile.get("organization", {})
    return {
        "provider": "claude",
        "available": True,
        "account": {
            "auth_method": "Claude AI",
            "email": acc.get("email") or "",
            "organization": org.get("name") or "",
            "plan": _claude_plan(profile, oauth),
        },
        "windows": windows,
        "model_windows": model_windows,
        "manage_url": "https://claude.ai/settings/usage",
    }


# ---------------------------------------------------------------- codex


def _read_codex_auth(cred_dir: str) -> dict:
    path = os.path.join(cred_dir, "auth.json")
    if not os.path.exists(path):
        raise UsageError("not signed in")
    return json.load(open(path))


def _codex_email(auth: dict) -> str:
    tok = auth.get("tokens") or {}
    idt = tok.get("id_token") or ""
    if idt and "." in idt:
        try:
            p = idt.split(".")[1]
            p += "=" * (-len(p) % 4)
            return json.loads(base64.urlsafe_b64decode(p)).get("email", "")
        except Exception:
            return ""
    return ""


def _iso_from_epoch(ts: Any) -> str | None:
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def codex_subscription(cred_dir: str) -> dict[str, Any]:
    auth = _read_codex_auth(cred_dir)
    tok = auth.get("tokens") or {}
    access = tok.get("access_token")
    account_id = tok.get("account_id") or ""
    if not access:
        raise UsageError("no access token")
    headers = {
        "Authorization": f"Bearer {access}",
        "chatgpt-account-id": account_id,
        "User-Agent": "codex-cli",
    }
    try:
        data = _get_json(f"{_CHATGPT}/codex/usage", headers)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise UsageError("token expired — re-authenticate this account") from exc
        raise UsageError(f"usage request failed ({exc.code})") from exc

    rl = data.get("rate_limit") or {}
    windows = []
    for key in ("primary_window", "secondary_window"):
        w = rl.get(key)
        if w:
            windows.append(
                _window(
                    _window_label_from_seconds(w.get("limit_window_seconds")),
                    w.get("used_percent"),
                    _iso_from_epoch(w.get("reset_at")),
                )
            )
    plan = (data.get("plan_type") or "").replace("_", " ").title() or "ChatGPT"
    return {
        "provider": "codex",
        "available": True,
        "account": {
            "auth_method": "ChatGPT",
            "email": data.get("email") or _codex_email(auth),
            "organization": "",
            "plan": f"ChatGPT {plan}" if not plan.lower().startswith("chatgpt") else plan,
        },
        "windows": windows,
        "model_windows": [],
        "manage_url": "https://chatgpt.com/#settings",
    }


def subscription_usage(provider: str, cred_dir: str) -> dict[str, Any]:
    if provider == "claude":
        return claude_subscription(cred_dir)
    if provider == "codex":
        return codex_subscription(cred_dir)
    raise UsageError(f"unsupported provider: {provider}")
