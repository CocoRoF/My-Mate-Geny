"""Capability catalog per provider — models + think(effort) levels.

Surfaced at /api/config so the chat UI can populate the model picker and the
think-level chip (dex-style). ``default`` effort means "don't pass a flag".

Models are fetched LIVE from the provider so the picker shows exactly what the
connected account can run, not a hand-maintained guess:

* Claude: ``GET api.anthropic.com/v1/models`` with the account OAuth token.
  Returns real ids + display names (e.g. ``claude-opus-5-5`` / "Claude Opus
  5.5"). The ``claude`` CLI accepts full ids via ``--model``.
* Codex: ``GET chatgpt.com/backend-api/codex/models?client_version=<cli>`` —
  the same list the ``codex`` CLI itself uses (NOT the chatgpt web ``/models``
  slugs). Only ``visibility == "list"`` models, ordered by ``priority``; each
  carries its own supported reasoning levels.

Results are cached briefly so /api/config stays fast and we don't hammer the
provider. Any fetch failure falls back to the static list below — the picker
never ends up empty.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any

# ---- static fallbacks (used only if the live fetch fails) -------------------

_EFFORT_CLAUDE = ["default", "low", "medium", "high", "xhigh", "max"]
_EFFORT_CODEX = ["default", "low", "medium", "high", "xhigh"]

# What a new Claude chat runs on unless the user picks something else (also
# the fallback when a session has no model stored).
DEFAULT_CLAUDE_MODEL = "claude-opus-5-5"

_STATIC: dict[str, dict] = {
    "claude": {
        "label": "Claude Code",
        "models": [
            {"id": DEFAULT_CLAUDE_MODEL, "label": "Claude Opus 5.5"},
            {"id": "opus", "label": "Opus (latest)"},
            {"id": "sonnet", "label": "Sonnet (latest)"},
            {"id": "haiku", "label": "Haiku (latest)"},
        ],
        "default_model": DEFAULT_CLAUDE_MODEL,
        "effort": _EFFORT_CLAUDE,
        "default_effort": "default",
        "models_source": "static",
    },
    "codex": {
        "label": "Codex",
        # Fallback only: "default" lets the CLI pick the account's own default.
        "models": [{"id": "default", "label": "Codex default"}],
        "default_model": "default",
        "effort": _EFFORT_CODEX,
        "default_effort": "default",
        "models_source": "static",
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
    # Opus 5.5 when the account offers it, else the newest Opus (the API lists
    # newest first), else the first model.
    ids = [m["id"] for m in models]
    if DEFAULT_CLAUDE_MODEL in ids:
        return DEFAULT_CLAUDE_MODEL
    for mid in ids:
        if "opus" in mid:
            return mid
    return ids[0] if ids else DEFAULT_CLAUDE_MODEL


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


# ---- codex live models ------------------------------------------------------

_CHATGPT = "https://chatgpt.com/backend-api"
_codex_version_cache: tuple[float, str] | None = None


def _codex_client_version() -> str:
    """Version of the installed codex CLI (the models API requires it)."""
    global _codex_version_cache
    if _codex_version_cache and time.monotonic() - _codex_version_cache[0] < _TTL:
        return _codex_version_cache[1]
    import re
    import subprocess

    from app.config import settings

    version = "0.166.0"
    try:
        out = subprocess.run([settings.codex_binary, "--version"], capture_output=True, text=True, timeout=8)
        m = re.search(r"(\d+\.\d+\.\d+)", out.stdout or out.stderr or "")
        if m:
            version = m.group(1)
    except (OSError, subprocess.TimeoutExpired):
        pass
    _codex_version_cache = (time.monotonic(), version)
    return version


def _fetch_codex_models(cred_dir: str) -> list[dict] | None:
    try:
        auth = json.load(open(os.path.join(cred_dir, "auth.json")))
    except (OSError, ValueError):
        return None
    tokens = auth.get("tokens") or {}
    token = tokens.get("access_token")
    if not token:
        return None
    version = _codex_client_version()
    req = urllib.request.Request(
        f"{_CHATGPT}/codex/models?client_version={version}",
        headers={
            "Authorization": f"Bearer {token}",
            "chatgpt-account-id": tokens.get("account_id") or "",
            "User-Agent": f"codex_cli_rs/{version}",
            "originator": "codex_cli_rs",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, ValueError, TimeoutError):
        return None
    raw = data.get("models", []) if isinstance(data, dict) else []
    listed = sorted(
        (m for m in raw if m.get("slug") and m.get("visibility") == "list"),
        key=lambda m: m.get("priority", 999),
    )
    out = []
    for m in listed:
        levels = [
            (lv.get("effort") if isinstance(lv, dict) else lv)
            for lv in (m.get("supported_reasoning_levels") or [])
        ]
        out.append({
            "id": m["slug"],
            "label": m.get("display_name") or m["slug"],
            "description": m.get("description") or "",
            "effort": ["default", *[lv for lv in levels if lv]],
            "default_effort": m.get("default_reasoning_level") or "default",
            "context_window": m.get("context_window"),
        })
    return out or None


def _codex_catalog(cred_dir: str) -> dict:
    models = _cached("codex")
    if models is None:
        models = _fetch_codex_models(cred_dir)
        if models:
            with _lock:
                _store("codex", models)
    if not models:
        return dict(_STATIC["codex"])
    return {
        "label": "Codex",
        "models": models,
        "default_model": models[0]["id"],  # priority 1 = the account's default
        "effort": _EFFORT_CODEX,
        "default_effort": "default",
        "models_source": "live",
    }


def codex_model_known(model: str | None) -> bool | None:
    """True/False when the live list is cached, None when we can't tell."""
    models = _cached("codex")
    if not models or not model:
        return None
    return any(m["id"] == model for m in models)


# ---- context window (Claude) --------------------------------------------------

# The CLI compacts a conversation once its context reaches the effective
# window minus this buffer (room for the summary + output). Measured on
# Claude Code 2.1.314 with ``get_context_usage``: window 100k -> 67k,
# 300k -> 267k, 1M -> 967k. The engine reports the real threshold after every
# turn; this is only the fallback before it has.
AUTOCOMPACT_BUFFER = 33_000
# Auto-compact window choices offered in the UI (0 = the CLI's default: the
# model's full window, same as Claude Code itself).
AUTO_COMPACT_PRESETS = (0, 200_000, 400_000, 600_000)
_MIN_AUTO_COMPACT = 100_000

_FAMILY = re.compile(r"(opus|sonnet|haiku|fable)-(\d+)", re.I)


def context_window(model: str | None) -> int:
    """The model's full context window (tokens). ``[1m]`` variants and the
    5.x generation run at 1M; older models at 200k."""
    m = (model or "").lower()
    if "[1m]" in m:
        return 1_000_000
    if m in ("", "default", "opus", "sonnet", "haiku", "fable", "best", "opusplan"):
        return 1_000_000  # aliases resolve to the current (5.x) models
    hit = _FAMILY.search(m)
    if hit and int(hit.group(2)) >= 5:
        return 1_000_000
    return 200_000


def clean_auto_compact_window(value: Any) -> int:
    """A stored/posted auto-compact window: 0 (CLI default) or >= 100k tokens."""
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        raise ValueError("auto-compact window must be a number of tokens") from None
    if n <= 0:
        return 0
    if n < _MIN_AUTO_COMPACT:
        raise ValueError(f"auto-compact window must be at least {_MIN_AUTO_COMPACT:,} tokens")
    return n


def context_limits(model: str | None, auto_compact_window: int = 0) -> dict[str, int]:
    """{window, threshold} the CLI will use: the configured auto-compact
    window caps the model's window (the CLI ignores a bigger value)."""
    full = context_window(model)
    window = min(full, auto_compact_window) if auto_compact_window else full
    return {"window": window, "model_window": full, "threshold": max(0, window - AUTOCOMPACT_BUFFER)}


# ---- public -----------------------------------------------------------------


def build_catalog(
    claude_cred_dir: str | None = None,
    codex_cred_dir: str | None = None,
) -> dict[str, dict]:
    """Build the per-provider catalog, fetching live models where possible."""
    claude_dir = claude_cred_dir or os.path.expanduser("~/.claude")
    codex_dir = codex_cred_dir or os.path.expanduser("~/.codex")
    claude = _claude_catalog(claude_dir)
    claude["models"] = [{**m, "context_window": m.get("context_window") or context_window(m["id"])}
                        for m in claude["models"]]
    claude["auto_compact_presets"] = list(AUTO_COMPACT_PRESETS)
    claude["auto_compact_buffer"] = AUTOCOMPACT_BUFFER
    catalog = {
        "claude": claude,
        "codex": _codex_catalog(codex_dir),
    }
    return catalog


# Back-compat: a plain static view (no network) for callers that just need the
# shape (e.g. effort levels). Prefer build_catalog() for the live model list.
PROVIDER_CATALOG = _STATIC


def catalog_for(provider: str) -> dict | None:
    return _STATIC.get(provider)
