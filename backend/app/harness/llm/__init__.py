"""Model calls, one adapter per vendor (``base`` has the shared shapes)."""

from __future__ import annotations

from app.harness.llm.base import Adapter


def adapter(provider: str) -> Adapter:
    """A fresh adapter (it remembers per-model fallbacks for the conversation it serves)."""
    if provider == "anthropic":
        from app.harness.llm.anthropic_api import AnthropicAdapter

        return AnthropicAdapter()
    if provider == "openai":
        from app.harness.llm.openai_api import OpenAIAdapter

        return OpenAIAdapter()
    if provider == "google":
        from app.harness.llm.google_api import GoogleAdapter

        return GoogleAdapter()
    raise KeyError(provider)
