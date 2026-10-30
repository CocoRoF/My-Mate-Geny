"""Subscription usage — the REAL plan limits (session 5h / weekly 7d), not $ cost.

For Claude Code (Max/Pro) and Codex (ChatGPT plan) the meaningful "usage" is the
rate-limit utilization the CLI shows in ``/usage``, not API dollars. This reads
the OAuth token from a credentials dir and calls the provider's usage endpoint:

* Claude: ``GET api.anthropic.com/api/oauth/usage`` + ``/api/oauth/profile``
  (bearer = ``claudeAiOauth.accessToken`` from ``.credentials.json``).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

_ANTHROPIC = "https://api.anthropic.com"
_CLAUDE_HEADERS = {
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
}


class UsageError(RuntimeError):
    pass


def _read_claude_oauth(cred_dir: str) -> dict:
    path = os.path.join(cred_dir, ".credentials.json")
    if not os.path.exists(path):
        raise UsageError("not signed in")
    with open(path) as fh:
        data = json.load(fh)
    oauth = data.get("claudeAiOauth") or {}
    if not oauth.get("accessToken"):
        raise UsageError("no access token")
    return oauth


def _plan_label(profile: dict, oauth: dict) -> str:
    acc = profile.get("account", {})
    if acc.get("has_claude_max"):
        return "Claude Max"
    if acc.get("has_claude_pro"):
        return "Claude Pro"
    sub = (oauth.get("subscriptionType") or "").strip()
    return f"Claude {sub.capitalize()}" if sub else "Claude"


def _get_json(url: str, headers: dict[str, str]) -> Any:
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=12) as resp:
        return json.loads(resp.read().decode())


def claude_subscription(cred_dir: str) -> dict[str, Any]:
    oauth = _read_claude_oauth(cred_dir)
    token = oauth["accessToken"]
    headers = {**_CLAUDE_HEADERS, "Authorization": f"Bearer {token}"}
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
    acc = profile.get("account", {})
    org = profile.get("organization", {})

    def pct(block: dict) -> float:
        u = block.get("utilization")
        return round(float(u), 0) if u is not None else 0.0

    return {
        "provider": "claude",
        "available": True,
        "account": {
            "auth_method": "Claude AI",
            "email": acc.get("email") or "",
            "organization": org.get("name") or "",
            "plan": _plan_label(profile, oauth),
        },
        "session": {"percent": pct(five), "resets_at": five.get("resets_at")},
        "weekly": {"percent": pct(seven), "resets_at": seven.get("resets_at")},
        "limits": [
            {
                "kind": l.get("kind"),
                "group": l.get("group"),
                "percent": l.get("percent"),
                "severity": l.get("severity"),
                "resets_at": l.get("resets_at"),
                "scope": l.get("scope"),
                "is_active": l.get("is_active"),
            }
            for l in (usage.get("limits") or [])
        ],
        "extra_usage": usage.get("extra_usage"),
        "manage_url": "https://claude.ai/settings/usage",
    }


def codex_subscription(cred_dir: str) -> dict[str, Any]:
    # Codex usage via ChatGPT plan is not exposed through a stable public
    # endpoint from the CLI creds; surface a clear "not available" for now.
    auth = os.path.join(cred_dir, "auth.json")
    if not os.path.exists(auth):
        raise UsageError("not signed in")
    return {
        "provider": "codex",
        "available": False,
        "account": {"auth_method": "ChatGPT", "email": "", "organization": "", "plan": "ChatGPT"},
        "detail": "Codex plan usage is not exposed by the CLI yet.",
    }


def subscription_usage(provider: str, cred_dir: str) -> dict[str, Any]:
    if provider == "claude":
        return claude_subscription(cred_dir)
    if provider == "codex":
        return codex_subscription(cred_dir)
    raise UsageError(f"unsupported provider: {provider}")
