"""One model call, the same way for every vendor.

The harness keeps its conversation in one neutral shape (``harness.transcript``); an adapter turns it into a vendor's
request, streams the answer back as :class:`LLMEvent` s, and ends with the assistant message in the neutral shape again
— carrying what that vendor needs to see again next time (Claude's thinking signatures, OpenAI's encrypted reasoning,
Gemini's thought signatures), which only goes back to the same vendor and model.

Neutral message::

    {"role": "user", "content": [
        {"type": "text", "text": ...},
        {"type": "image", "media_type": ..., "data": <base64>} | {..., "path": <file>},
        {"type": "tool_result", "tool_use_id": ..., "name": ..., "content": [text/image blocks], "is_error": bool}]}
    {"role": "assistant", "provider": ..., "model": ..., "content": [
        {"type": "thinking", "text": ..., "signature"?: ..., "redacted"?: ...},
        {"type": "text", "text": ..., "signature"?: ...},
        {"type": "tool_use", "id": ..., "name": ..., "input": {...}, "signature"?: ...}],
     "vendor"?: {...}}
"""

from __future__ import annotations

import base64
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.config import settings


@dataclass
class ToolSpec:
    name: str
    description: str
    schema: dict[str, Any]


@dataclass
class LLMCall:
    model: str
    system: str
    messages: list[dict[str, Any]]
    tools: list[ToolSpec] = field(default_factory=list)
    effort: str = "default"
    max_tokens: int | None = None
    caps: dict[str, Any] = field(default_factory=dict)   # what the catalog knows about the model
    cache_key: str = ""     # keeps one conversation on one prompt cache (OpenAI)
    web_search: bool = False  # the vendor's own web search instead of our tools (WebSearch)
    show_thinking: bool = True


# ---- what a call streams ----

@dataclass
class TextDelta:
    text: str


@dataclass
class ThinkingStart:
    id: str


@dataclass
class ThinkingDelta:
    id: str
    text: str


@dataclass
class ThinkingEnd:
    id: str


@dataclass
class ToolInputDelta:
    id: str
    name: str
    partial: str


@dataclass
class Done:
    message: dict[str, Any]           # the assistant message, neutral
    usage: dict[str, int]             # input_tokens (not cached), cache_read_input_tokens, cache_creation_input_tokens, output_tokens
    stop_reason: str                  # end_turn | tool_use | max_tokens | refusal | pause_turn
    citations: list[dict[str, str]] = field(default_factory=list)  # web search sources: {url, title}
    raw: Any = None  # the vendor's own content (to continue a paused answer exactly as it was)


LLMEvent = TextDelta | ThinkingStart | ThinkingDelta | ThinkingEnd | ToolInputDelta | Done


class LLMError(Exception):
    """A call that failed. ``kind``: auth | quota | rate_limit | overloaded | server | network | context | bad_request |
    not_found | bad_response. ``retry_after``: seconds the vendor asked to wait."""

    def __init__(self, kind: str, message: str, *, status: int | None = None, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return self.kind in ("overloaded", "server", "network", "bad_response")

    @property
    def account_outcome(self) -> str | None:
        """How the key that made the call fared (providers.accounts.ACCOUNT_OUTCOMES)."""
        return {"auth": "provider_auth", "quota": "provider_quota", "rate_limit": "rate_limited"}.get(self.kind)


class Adapter(Protocol):
    provider: str

    def stream(self, call: LLMCall, key: str) -> AsyncIterator[LLMEvent]: ...

    async def list_models(self, key: str) -> list[dict[str, Any]]: ...


def base_url(provider: str) -> str | None:
    """Another endpoint for a vendor (a proxy, a compatible gateway, the tests' fake vendor)."""
    return getattr(settings, f"api_{provider}_base_url", "") or os.environ.get(f"HRH_{provider.upper()}_BASE_URL") or None


# ---- shared helpers ----

def image_bytes(block: dict[str, Any]) -> tuple[str, bytes] | None:
    """(media type, bytes) of an image block, or None when its file is gone."""
    if block.get("data"):
        return block.get("media_type") or "image/png", base64.b64decode(block["data"])
    path = block.get("path")
    if path and os.path.isfile(path):
        with open(path, "rb") as fh:
            return block.get("media_type") or "image/png", fh.read()
    return None


def image_b64(block: dict[str, Any]) -> tuple[str, str] | None:
    got = image_bytes(block)
    if got is None:
        return None
    return got[0], base64.b64encode(got[1]).decode()


def result_text(block: dict[str, Any]) -> str:
    """A tool result's text parts, joined."""
    parts = [c.get("text", "") for c in block.get("content") or [] if c.get("type") == "text"]
    return "\n".join(p for p in parts if p) or ("(no output)" if not block.get("is_error") else "Error")


def same_model(message: dict[str, Any], provider: str, model: str) -> bool:
    """Whether a past answer's vendor data (signatures, encrypted reasoning) can go back to this call."""
    return message.get("provider") == provider and message.get("model") == model


def retry_after(headers: Any) -> float | None:
    try:
        raw = headers.get("retry-after") if headers is not None else None
        return float(raw) if raw else None
    except (TypeError, ValueError):
        return None


_CONTEXT = ("prompt is too long", "context length", "context_length", "maximum context", "too many tokens",
            "input token count", "exceeds the maximum number of tokens", "context window")
_QUOTA = ("credit balance", "insufficient_quota", "billing", "quota exceeded", "exceeded your current quota",
          "spending limit", "payment")


def classify(status: int | None, message: str, code: str = "") -> str:
    low = f"{message} {code}".lower()
    if any(x in low for x in _CONTEXT):
        return "context"
    if any(x in low for x in _QUOTA):
        return "quota"
    if status in (401, 403):
        return "auth"
    if status == 404:
        return "not_found"
    if status == 429:
        return "rate_limit"
    if status in (529, 503) or "overloaded" in low:
        return "overloaded"
    if status is not None and status >= 500:
        return "server"
    if status is None:
        return "network"
    return "bad_request"
