"""The three model vendors reached with an API key, and what the harness knows about their models.

The model list itself comes from each vendor's API (``harness.models``); what an API doesn't say is filled in here:
which listed models are chat models an agent can drive, their reasoning levels, and a first guess at the context window
where the vendor doesn't report one (OpenAI). All of it can be corrected per model in the catalog.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Vendor:
    id: str
    label: str
    key_hint: str            # what a key looks like (placeholder text)
    keys_url: str            # where keys are made
    # Models switched on when the catalog is first filled, if the vendor lists them (newest first). Anything else
    # starts off: the user picks what this app may use.
    recommended: tuple[str, ...] = field(default_factory=tuple)


VENDORS: dict[str, Vendor] = {
    "anthropic": Vendor(
        "anthropic", "Anthropic", "sk-ant-api03-…", "https://console.anthropic.com/settings/keys",
        ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"),
    ),
    "openai": Vendor(
        "openai", "OpenAI", "sk-proj-…", "https://platform.openai.com/api-keys",
        ("gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"),
    ),
    "google": Vendor(
        "google", "Google", "AIza…", "https://aistudio.google.com/apikey",
        ("gemini-4-argon", "gemini-3.8-flash", "gemini-3.5-flash-lite"),
    ),
}
API_PROVIDERS: tuple[str, ...] = tuple(VENDORS)
# A mate talks more than it works: the vendor's mid model when it is switched on (catalog default otherwise).
MATE_MODELS = {"anthropic": "claude-sonnet-5-5", "openai": "gpt-6.1-terra", "google": "gemini-3.8-flash"}


def is_api_provider(provider: str | None) -> bool:
    return provider in VENDORS


# ---- which listed models an agent can drive ----

_OPENAI_CHAT = re.compile(r"^(gpt-|o\d|chatgpt-|codex-)")
_OPENAI_NOT = ("audio", "realtime", "tts", "transcribe", "whisper", "embedding", "image", "dall-e", "moderation",
               "instruct", "babbage", "davinci", "computer-use", "deep-research", "search-preview", "gpt-3.5",
               "gpt-4-", "gpt-4-turbo", "codex-mini-latest")
_GOOGLE_NOT = ("embedding", "tts", "image", "live", "audio", "robotics", "omni", "nano-banana", "aqa", "veo",
               "imagen", "lyria", "transcribe", "translate")
_DATED = re.compile(r"-(\d{8}|\d{4}-\d{2}-\d{2}|\d{3,4})$")


def chat_model(provider: str, model_id: str, *, actions: list[str] | None = None, lifecycle: str | None = None) -> bool:
    mid = model_id.lower()
    if provider == "anthropic":
        return mid.startswith("claude") and lifecycle != "retired"
    if provider == "openai":
        return bool(_OPENAI_CHAT.match(mid)) and not any(x in mid for x in _OPENAI_NOT)
    if provider == "google":
        return (mid.startswith("gemini") and not any(x in mid for x in _GOOGLE_NOT)
                and (actions is None or "generateContent" in actions))
    return False


def dated(model_id: str) -> bool:
    """A pinned snapshot (``…-20260401``) next to its alias: off by default, the alias moves forward."""
    return bool(_DATED.search(model_id))


# ---- reasoning levels ----

def effort_levels(provider: str, model_id: str, caps: dict | None = None) -> list[str]:
    """The reasoning levels a model takes, "default" first (= the vendor's own default); [] = none to choose."""
    mid = model_id.lower()
    caps = caps or {}
    if provider == "anthropic":
        effort = caps.get("effort") or {}
        if isinstance(effort, dict) and effort.get("supported"):
            return ["default", *[lv for lv in ("low", "medium", "high", "xhigh", "max")
                                 if (effort.get(lv) or {}).get("supported")]]
        if caps.get("effort") is None and re.match(r"claude-(opus|sonnet|fable|mythos|haiku)-[5-9]", mid):
            return ["default", "low", "medium", "high", "xhigh", "max"]
        return []
    if provider == "openai":
        if mid.startswith(("gpt-6", "gpt-5.")) and not mid.startswith("gpt-5-"):
            return ["default", "none", "low", "medium", "high", "xhigh"]
        if mid.startswith("gpt-5"):
            return ["default", "minimal", "low", "medium", "high"]
        if re.match(r"o\d", mid):
            return ["default", "low", "medium", "high"]
        return []
    if provider == "google":
        if not caps.get("thinking", True):
            return []
        if re.match(r"gemini-([3-9]|\d\d)", mid):
            return ["default", "minimal", "low", "medium", "high"] if "flash" in mid else ["default", "low", "high"]
        if mid.startswith("gemini-2.5"):
            return ["default", "low", "medium", "high"]
        return []
    return []


# ---- what an API doesn't report ----

def guess_limits(provider: str, model_id: str) -> tuple[int | None, int | None]:
    """(context window, max output tokens) for a model whose API doesn't say (OpenAI), else (None, None)."""
    mid = model_id.lower()
    if provider == "openai":
        if mid.startswith("gpt-6") or re.match(r"gpt-5\.([4-9]|\d\d)", mid):
            return 1_050_000, 128_000
        if mid.startswith("gpt-5"):
            return 400_000, 128_000
        if mid.startswith("gpt-4.1"):
            return 1_047_576, 32_768
        if mid.startswith(("gpt-4o", "chatgpt-4o")):
            return 128_000, 16_384
        if re.match(r"o\d", mid):
            return 200_000, 100_000
        return 128_000, 16_384
    return None, None


def reasoning_model(provider: str, model_id: str) -> bool:
    """OpenAI: takes ``reasoning`` (and returns reasoning items to send back)."""
    mid = model_id.lower()
    return provider == "openai" and (mid.startswith(("gpt-5", "gpt-6", "codex")) or bool(re.match(r"o\d", mid)))
