"""What a model call costs: list prices per million tokens, and the cost of one call's usage.

The CLIs report their own cost (Claude Code) or none (Codex on a subscription); a turn on an API key is billed per
token, so the harness works it out. These are the vendors' published standard-tier text prices (Anthropic as of
2026-10-06; OpenAI and Google as published 2026-11-09). Prices move: every model's price can be changed in the catalog,
and a model with no price gets none (its turns show tokens, not a guessed amount).

A price is ``{input, output, cache_read?, cache_write?, long_above?, long_input?, long_output?, long_cache_read?}`` in
USD per million tokens. ``long_*`` apply to a whole call whose prompt is above ``long_above`` tokens (OpenAI's long
context, Gemini Pro above 200k, Claude Haiku 5.5 above 100k).
"""

from __future__ import annotations

import re
from typing import Any

Price = dict[str, float]


def _p(inp: float, out: float, cache_read: float | None = None, **long: float) -> Price:
    price: Price = {"input": inp, "output": out}
    if cache_read is not None:
        price["cache_read"] = cache_read
    price.update(long)
    return price


def _long(above: int, inp: float, out: float, cache_read: float | None = None) -> dict[str, float]:
    d = {"long_above": float(above), "long_input": inp, "long_output": out}
    if cache_read is not None:
        d["long_cache_read"] = cache_read
    return d


DEFAULT_PRICES: dict[str, dict[str, Price]] = {
    "anthropic": {
        "claude-fable-5-1": _p(10, 50, 0.25),
        "claude-mythos-5-1": _p(10, 50, 0.25),
        "claude-fable-5": _p(10, 50, 1.0),
        "claude-opus-5-5": _p(4, 20, 0.20),
        "claude-opus-5": _p(5, 25, 0.5),
        "claude-opus-4-8": _p(5, 25, 0.5),
        "claude-opus-4-7": _p(5, 25, 0.5),
        "claude-opus-4-6": _p(5, 25, 0.5),
        "claude-sonnet-5-5": _p(2, 10, 0.20),
        "claude-sonnet-5": _p(2, 10, 0.20),
        "claude-sonnet-4-6": _p(3, 15, 0.3),
        "claude-haiku-5-5": _p(0.10, 0.50, 0.01, **_long(100_000, 0.50, 2.50, 0.05)),
        "claude-haiku-4-5": _p(1, 5, 0.1),
    },
    "openai": {
        "gpt-6-astra": _p(10, 50, 1.0, **_long(272_000, 20, 75, 2.0)),
        "gpt-6.1-sol": _p(2, 10, 0.10, **_long(272_000, 4, 15, 0.20)),
        "gpt-6.1-terra": _p(1, 5, 0.05, **_long(272_000, 2, 7.5, 0.10)),
        "gpt-6-luna": _p(0.10, 0.50, 0.01, **_long(272_000, 0.20, 0.75, 0.02)),
        "gpt-6-sol": _p(2, 10, 0.20, **_long(272_000, 4, 15, 0.40)),
        "gpt-5.6-sol": _p(4, 20, 0.40, **_long(272_000, 8, 30, 0.80)),
        "gpt-5.6-terra": _p(2, 12, 0.20, **_long(272_000, 4, 18, 0.40)),
        "gpt-5.6-luna": _p(0.20, 1.20, 0.02, **_long(272_000, 0.40, 1.80, 0.04)),
        "gpt-5.5-pro": _p(30, 180, None, **_long(272_000, 60, 270)),
        "gpt-5.5": _p(5, 30, 0.50, **_long(272_000, 10, 45, 1.0)),
        "gpt-5.4-pro": _p(30, 180, None, **_long(272_000, 60, 270)),
        "gpt-5.4-mini": _p(0.75, 4.50, 0.075),
        "gpt-5.4-nano": _p(0.20, 1.25, 0.02),
        "gpt-5.4": _p(2.5, 15, 0.25, **_long(272_000, 5, 22.5, 0.50)),
        "gpt-5.3-codex": _p(1.75, 14, 0.175),
        "gpt-5.2-pro": _p(21, 168),
        "gpt-5.2": _p(1.75, 14, 0.175),
        "gpt-5.1": _p(1.25, 10, 0.125),
        "gpt-5-pro": _p(15, 120),
        "gpt-5-mini": _p(0.25, 2, 0.025),
        "gpt-5-nano": _p(0.05, 0.40, 0.005),
        "gpt-5": _p(1.25, 10, 0.125),
        "gpt-4.1-mini": _p(0.40, 1.60, 0.10),
        "gpt-4.1": _p(2, 8, 0.50),
        "gpt-4o-mini": _p(0.15, 0.60, 0.075),
        "gpt-4o": _p(2.5, 10, 1.25),
        "o3-pro": _p(20, 80),
        "o3": _p(2, 8, 0.50),
        "chat-latest": _p(5, 30, 0.50),
    },
    "google": {
        "gemini-4-argon": _p(2, 10, 0.10),
        "gemini-3.8-flash": _p(0.75, 3.75, 0.075),
        "gemini-3.6-flash": _p(0.75, 3.75, 0.075),
        "gemini-3.5-flash-lite": _p(0.30, 2.50, 0.03),
        "gemini-3.1-flash-lite": _p(0.25, 1.50, 0.025),
        "gemini-3.1-pro-preview": _p(2, 12, 0.20, **_long(200_000, 4, 18, 0.40)),
        "gemini-3-flash-preview": _p(0.50, 3, 0.05),
        "gemini-2.5-pro": _p(1.25, 10, 0.125, **_long(200_000, 2.5, 15, 0.25)),
        "gemini-2.5-flash-lite": _p(0.10, 0.40, 0.01),
        "gemini-2.5-flash": _p(0.30, 2.50, 0.03),
    },
}

# (OpenAI and Google don't charge extra to put a prompt in their cache: a cache write costs what input costs)
for _vendor in ("openai", "google"):
    for _price in DEFAULT_PRICES[_vendor].values():
        _price.setdefault("cache_write", _price["input"])

_SNAPSHOT = re.compile(r"(-\d{8}|-\d{4}-\d{2}-\d{2}|@\d+|-latest|-preview-\d\d-\d{4})$")


def default_price(provider: str, model_id: str) -> Price | None:
    """The list price for a model: its id, a snapshot of it (``…-20260401``), or the longest known name it starts with
    (``gpt-5.4-mini`` before ``gpt-5.4``)."""
    table = DEFAULT_PRICES.get(provider) or {}
    mid = model_id.lower().removeprefix("models/")
    if mid in table:
        return dict(table[mid])
    base = _SNAPSHOT.sub("", mid)
    if base in table:
        return dict(table[base])
    for name in sorted(table, key=len, reverse=True):
        if mid.startswith(name + "-") or base.startswith(name + "-"):
            return dict(table[name])
    return None


def valid_price(raw: Any) -> Price | None:
    """A price as the catalog stores it, or None (cleared / not a price)."""
    if not isinstance(raw, dict):
        return None
    out: Price = {}
    for k in ("input", "output", "cache_read", "cache_write", "long_above", "long_input", "long_output", "long_cache_read"):
        v = raw.get(k)
        if v is None or v == "":
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f < 0 or f != f:
            continue
        out[k] = f
    return out if "input" in out and "output" in out else None


def call_cost(price: Price | None, usage: dict[str, int]) -> float | None:
    """USD for one model call. ``usage``: ``input_tokens`` (not from a cache), ``cache_read_input_tokens``,
    ``cache_creation_input_tokens``, ``output_tokens`` (reasoning included)."""
    if not price:
        return None
    fresh = int(usage.get("input_tokens") or 0)
    read = int(usage.get("cache_read_input_tokens") or 0)
    write = int(usage.get("cache_creation_input_tokens") or 0)
    out = int(usage.get("output_tokens") or 0)
    inp, outp = price["input"], price["output"]
    cache_read = price.get("cache_read", inp * 0.1)
    if price.get("long_above") and fresh + read + write > price["long_above"]:
        inp = price.get("long_input", inp)
        outp = price.get("long_output", outp)
        cache_read = price.get("long_cache_read", cache_read)
    cache_write = price.get("cache_write", inp * 1.25)
    return (fresh * inp + read * cache_read + write * cache_write + out * outp) / 1_000_000
