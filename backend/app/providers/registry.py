"""Provider registry — name -> singleton instance."""

from __future__ import annotations

from app.providers.base import Provider
from app.providers.claude_code import ClaudeCodeProvider
from app.providers.codex import CodexProvider

_PROVIDERS: dict[str, Provider] = {
    "claude": ClaudeCodeProvider(),
    "codex": CodexProvider(),
}


def get_provider(name: str) -> Provider:
    try:
        return _PROVIDERS[name]
    except KeyError:
        raise KeyError(f"unknown provider: {name!r} (have {list(_PROVIDERS)})") from None


def list_providers() -> list[str]:
    return list(_PROVIDERS)
