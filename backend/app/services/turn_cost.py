"""Per-turn API-equivalent cost — one place that knows how to read ``cost_usd``.

``cost_usd`` on a turn is what the turn's tokens would have cost on the API.
On a subscription that is informational only, never a charge.

Since ``cost_kind`` exists, terminal events carry the true per-turn value
(``"turn"``), an API-equivalent worked out from the tokens at the model's price
(``"estimated"``: Codex on a subscription, since 1.0) or say the engine reports
none (``"none"``: Codex without a known price; older Codex turns are estimated
when they are read, ``costed``). Older events
are unmarked, and for the persistent Claude engine (one CLI process serving
many turns) they hold the CLI's ``total_cost_usd`` — the process's running
total, not the turn's share. A chat that really cost ~$64 summed to $308.

:class:`TurnCostNormalizer` turns one session's unmarked values back into
per-turn values, best effort: within one engine process the total only grows,
so a value >= the previous one is that process continuing (the turn's cost is
the difference) and a smaller value is a fresh process (the value is all
new). An engine respawned after an idle reap / restart whose first turn cost
more than the old process's total is indistinguishable and is undercounted.

Used by the usage roll-up and by every history/replay read, so the Usage page
and the chat show the same numbers.
"""

from __future__ import annotations

from typing import Any, Iterable

COST_EVENTS = ("turn.complete", "error")


def engine_of(model: str | None) -> str | None:
    """Which engine a model id belongs to (for turns that didn't record it)."""
    m = (model or "").lower()
    if m.startswith("claude") or m in ("sonnet", "opus", "haiku", "fable"):
        return "claude"
    if m.startswith(("gpt", "o3", "o4", "codex")):
        return "codex"
    return None


def _num(v: Any) -> float:
    try:
        return float(v or 0.0)
    except (TypeError, ValueError):
        return 0.0


def needs_normalizing(type_: str, data: dict[str, Any]) -> bool:
    return type_ in COST_EVENTS and "cost_usd" in data and not data.get("cost_kind")


class TurnCostNormalizer:
    """Feed ONE session's terminal events in order; get them back per turn."""

    def __init__(self) -> None:
        self._prev: float | None = None  # last raw total of the legacy engine run

    def feed(self, data: dict[str, Any]) -> dict[str, Any]:
        if data.get("cost_kind"):
            # Recorded per turn at the source. Those come from a newer backend,
            # i.e. a later engine process: an older run can't continue past it.
            self._prev = None
            return data
        if "cost_usd" not in data:
            return data  # no cost at all (superseded auto turn, plain error)
        provider = data.get("provider") or engine_of(data.get("model"))
        if provider == "codex":
            return {**data, "cost_kind": "none"}
        raw = _num(data.get("cost_usd"))
        if data.get("provider") != "claude":
            # Turns recorded before the persistent engine (they carry no
            # provider): each was its own CLI process, so already per turn.
            return {**data, "cost_kind": "turn"}
        if self._prev is not None and raw >= self._prev:
            cost = raw - self._prev
        else:
            cost = raw
        self._prev = raw
        return {**data, "cost_usd": round(cost, 6), "cost_kind": "turn",
                "cost_reported_usd": raw, "cost_normalized": True}


def turn_cost(data: dict[str, Any]) -> float | None:
    """A normalized event's per-turn cost; None when the engine reports none."""
    if data.get("cost_kind") == "none" or "cost_usd" not in data:
        return None
    return _num(data.get("cost_usd"))


def tokens(usage: Any) -> dict[str, int]:
    """One turn's tokens by kind: input (not from a cache), cache_read, cache_write, output. Claude reports cache reads and
    writes apart from input; Codex counts its cached input inside ``input_tokens`` (``cached_input_tokens``) — split the
    same way here (``lib/usage.tokenBreakdown`` in the UI)."""
    if not isinstance(usage, dict):
        return {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0}

    def num(k: str) -> int:
        try:
            return max(0, int(float(usage.get(k) or 0)))
        except (TypeError, ValueError, OverflowError):
            return 0

    inp, read, write, out = num("input_tokens"), num("cache_read_input_tokens"), num("cache_creation_input_tokens"), num("output_tokens")
    if not read and usage.get("cached_input_tokens") is not None:
        read = num("cached_input_tokens")
        inp = max(0, inp - read)
    return {"input": inp, "cache_read": read, "cache_write": write, "output": out}


def estimate(data: dict[str, Any], price: dict[str, float] | None) -> float | None:
    """What a turn whose engine reports no cost (Codex on a subscription) would have cost on the API: its tokens at the
    model's price (the catalog's, else the list price). None without a price: tokens, never a guessed amount."""
    if not price:
        return None
    from app.harness.pricing import call_cost

    t = tokens(data.get("usage"))
    if not any(t.values()):
        return None
    # (a turn is many calls summed: a long-context rate is for one call over its size, so the base rates; an estimate
    # that reads a little low when calls really were that long)
    price = {k: v for k, v in price.items() if not k.startswith("long_")}
    return call_cost(price, {"input_tokens": t["input"], "cache_read_input_tokens": t["cache_read"],
                             "cache_creation_input_tokens": t["cache_write"], "output_tokens": t["output"]})


class Prices:
    """The price of an OpenAI model a Codex turn ran on (the catalog's, else the list price), looked up once per model."""

    def __init__(self, db: Any) -> None:
        self._db = db
        self._known: dict[str, dict[str, float] | None] = {}

    def __call__(self, model: str | None) -> dict[str, float] | None:
        m = (model or "").strip()
        if not m:
            return None
        if m not in self._known:
            try:
                from app.harness.models import ModelCatalog

                self._known[m] = ModelCatalog(self._db).info("openai", m).get("price")
            except Exception:  # noqa: BLE001 - no price is a price unknown
                from app.harness.pricing import default_price

                self._known[m] = default_price("openai", m)
        return self._known[m]


def costed(data: dict[str, Any], prices: Prices) -> tuple[float | None, bool]:
    """A normalized event's cost, and whether it is an estimate (a Codex turn priced from its tokens)."""
    cost = turn_cost(data)
    if cost is not None:
        return cost, data.get("cost_kind") == "estimated"
    if (data.get("provider") or engine_of(data.get("model"))) == "codex":
        est = estimate(data, prices(data.get("model")))
        if est is not None:
            return est, True
    return None, False


def normalize_events(events: list[dict[str, Any]], prior: Iterable[dict[str, Any]] = ()) -> list[dict[str, Any]]:
    """Normalize ``events`` (dicts with ``type``/``data``, in order) in place.
    ``prior``: the session's earlier terminal events' data, when ``events`` is
    a tail (replay after a cursor) — they only set up the running total."""
    norm = TurnCostNormalizer()
    for data in prior:
        norm.feed(data)
    for e in events:
        if e.get("type") in COST_EVENTS and isinstance(e.get("data"), dict):
            e["data"] = norm.feed(e["data"])
    return events
