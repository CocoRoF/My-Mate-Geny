"""Per-turn API-equivalent cost — one place that knows how to read ``cost_usd``.

``cost_usd`` on a turn is what the turn's tokens would have cost on the API.
On a subscription that is informational only, never a charge.

Since ``cost_kind`` exists, terminal events carry the true per-turn value
(``"turn"``) or say the engine reports none (``"none"``, Codex). Older events
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
