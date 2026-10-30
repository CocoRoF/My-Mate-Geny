"""Static capability catalog per provider — models + think(effort) levels.

Surfaced at /api/config so the chat UI can populate the model picker and the
think-level chip (dex-style). ``default`` effort means "don't pass a flag".
"""

from __future__ import annotations

PROVIDER_CATALOG: dict[str, dict] = {
    "claude": {
        "label": "Claude Code",
        "models": [
            {"id": "sonnet", "label": "Sonnet"},
            {"id": "opus", "label": "Opus"},
            {"id": "haiku", "label": "Haiku"},
        ],
        "default_model": "sonnet",
        # Maps to `--effort <level>`.
        "effort": ["default", "low", "medium", "high", "xhigh", "max"],
        "default_effort": "default",
    },
    "codex": {
        "label": "Codex",
        "models": [
            {"id": "gpt-5-codex", "label": "GPT-5 Codex"},
            {"id": "gpt-5", "label": "GPT-5"},
            {"id": "o3", "label": "o3"},
        ],
        "default_model": "gpt-5-codex",
        # Maps to `-c model_reasoning_effort=<level>`.
        "effort": ["default", "minimal", "low", "medium", "high"],
        "default_effort": "default",
    },
}


def catalog_for(provider: str) -> dict | None:
    return PROVIDER_CATALOG.get(provider)
