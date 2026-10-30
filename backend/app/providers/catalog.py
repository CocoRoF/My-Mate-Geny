"""Capability catalog per provider — models + think(effort) levels.

Surfaced at /api/config so the chat UI can populate the model picker and the
think-level chip (dex-style). ``default`` effort means "don't pass a flag".

Models are fetched LIVE from the provider so the picker shows exactly what the
connected account can run, not a hand-maintained guess:

* Claude: ``GET api.anthropic.com/v1/models`` with the account OAuth token.
  Returns real ids + display names (e.g. ``claude-opus-5-5`` / "Claude Opus
  5.5"). The ``claude`` CLI accepts full ids via ``--model``.
* Codex: the ``codex`` CLI only drives a small fixed set of reasoning models
  (the chatgpt web ``/models`` slugs are NOT CLI-compatible), so that list is
  curated.

Results are cached briefly so /api/config stays fast and we don't hammer the
provider. Any fetch failure falls back to the static list below — the picker
never ends up empty.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request

# ---- static fallbacks (used only if the live fetch fails) -------------------

_EFFORT_CLAUDE = ["default", "low", "medium", "high", "xhigh", "max"]
_EFFORT_CODEX = ["default", "minimal", "low", "medium", "high"]

_STATIC: dict[str, dict] = {
    "claude": {
        "label": "Claude Code",
        "models": [
            {"id": "opus", "label": "Opus (latest)"},
            {"id": "sonnet", "label": "Sonnet (latest)"},
            {"id": "haiku", "label": "Haiku (latest)"},
        ],
        "default_model": "sonnet",
        "effort": _EFFORT_CLAUDE,
        "default_effort": "default",
        "models_source": "static",
    },
    "codex": {
        "label": "Codex",
        "models": [
            {"id": "gpt-5-codex", "label": "GPT-5 Codex"},
            {"id": "gpt-5", "label": "GPT-5"},
            {"id": "o3", "label": "o3"},
        ],
        "default_model": "gpt-5-codex",
        "effort": _EFFORT_CODEX,
        "default_effort": "default",
        "models_source": "curated",
    },
}

_ANTHROPIC = "https://api.anthropic.com"
_CLI_UA = "claude-cli/2.1.204 (external, cli)"

# ---- cache ------------------------------------------------------------------

_TTL = 3600.0  # models change rarely; an hour is plenty
_lock = threading.Lock()
_cache: dict[str, tuple[float, list[dict]]] = {}


def _cached(key: str) -> list[dict] | None:
    hit = _cache.get(key)
    if hit and (time.monotonic() - hit[0]) < _TTL:
        return hit[1]
    return None


def _store(key: str, value: list[dict]) -> None:
    _cache[key] = (time.monotonic(), value)


# ---- claude live models -----------------------------------------------------


def _claude_token(cred_dir: str) -> str | None:
    path = os.path.join(cred_dir, ".credentials.json")
    try:
        oauth = (json.load(open(path)).get("claudeAiOauth") or {})
    except (OSError, ValueError):
        return None
    return oauth.get("accessToken") or None


def _fetch_claude_models(cred_dir: str) -> list[dict] | None:
    token = _claude_token(cred_dir)
    if not token:
        return None
    req = urllib.request.Request(
        f"{_ANTHROPIC}/v1/models?limit=100",
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "User-Agent": _CLI_UA,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, ValueError, TimeoutError):
        return None
    out = []
    for m in data.get("data", []):
        mid = m.get("id")
        if not mid:
            continue
        out.append({"id": mid, "label": m.get("display_name") or mid})
    return out or None


def _claude_default(models: list[dict]) -> str:
    # Prefer the newest Sonnet (balanced default), else the first model.
    for m in models:
        if "sonnet" in m["id"]:
            return m["id"]
    return models[0]["id"] if models else "sonnet"


def _claude_catalog(cred_dir: str) -> dict:
    models = _cached("claude")
    if models is None:
        models = _fetch_claude_models(cred_dir)
        if models:
            with _lock:
                _store("claude", models)
    if not models:
        return dict(_STATIC["claude"])
    return {
        "label": "Claude Code",
        "models": models,
        "default_model": _claude_default(models),
        "effort": _EFFORT_CLAUDE,
        "default_effort": "default",
        "models_source": "live",
    }


# ---- public -----------------------------------------------------------------


def build_catalog(
    claude_cred_dir: str | None = None,
    codex_cred_dir: str | None = None,
) -> dict[str, dict]:
    """Build the per-provider catalog, fetching live models where possible."""
    claude_dir = claude_cred_dir or os.path.expanduser("~/.claude")
    catalog = {
        "claude": _claude_catalog(claude_dir),
        "codex": dict(_STATIC["codex"]),
    }
    return catalog


# Back-compat: a plain static view (no network) for callers that just need the
# shape (e.g. effort levels). Prefer build_catalog() for the live model list.
PROVIDER_CATALOG = _STATIC


def catalog_for(provider: str) -> dict | None:
    return _STATIC.get(provider)
