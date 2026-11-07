"""Her world, as data: ``builtin/life/<key>.json``. Checked when it is read: a mistake in it fails loudly, in the tests first."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.mate.life import sim

ROOT = Path(__file__).resolve().parents[1] / "builtin" / "life"
_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


def _check_event(event: dict[str, Any], doc: dict[str, Any]) -> None:
    name = event.get("id") or "?"
    if not event.get("id") or not (event.get("titles") or {}).get("ko") or not (event.get("titles") or {}).get("en") or not event.get("says"):
        raise ValueError(f"life: event {name} needs an id, its titles and what she is told")
    if not 0 < float(event.get("chance") or 0) <= 1:
        raise ValueError(f"life: event {name} needs a chance")
    when, effects = event.get("when") or {}, event.get("effects") or {}
    if when.get("place") and when["place"] not in doc["places"]:
        raise ValueError(f"life: event {name} is at an unknown place: {when['place']}")
    if when.get("activity") and when["activity"] not in doc["activities"]:
        raise ValueError(f"life: event {name} needs an unknown activity: {when['activity']}")
    for group, known in ((when.get("stats"), sim.STATS), (when.get("needs"), sim.NEEDS), (effects.get("stats"), sim.STATS), (effects.get("needs"), sim.NEEDS)):
        for key in group or {}:
            if key not in known:
                raise ValueError(f"life: event {name} names an unknown {key}")


def check(doc: dict[str, Any]) -> dict[str, Any]:
    places, activities = doc["places"], doc["activities"]
    for key, act in activities.items():
        if act["place"] not in places:
            raise ValueError(f"life: {key} is at an unknown place: {act['place']}")
        for need in act.get("needs") or {}:
            if need not in sim.NEEDS:
                raise ValueError(f"life: {key} changes an unknown need: {need}")
        for stat in act.get("stats") or {}:
            if stat not in sim.STATS:
                raise ValueError(f"life: {key} grows an unknown stat: {stat}")
    for block in doc.get("routine") or []:
        if block["activity"] not in activities:
            raise ValueError(f"life: the routine names an unknown activity: {block['activity']}")
    for item in doc.get("shop") or []:
        if not item.get("id") or not item.get("names"):
            raise ValueError(f"life: a gift needs its id and names: {item}")
        for need in item.get("needs") or {}:
            if need not in sim.NEEDS:
                raise ValueError(f"life: {item['id']} changes an unknown need: {need}")
        for stat in item.get("stats") or {}:
            if stat not in sim.STATS:
                raise ValueError(f"life: {item['id']} grows an unknown stat: {stat}")
    for event in doc.get("events") or []:
        _check_event(event, doc)
    if "rest" not in activities:
        raise ValueError("life: there must be a `rest` she can always fall back on")
    return doc


def load(key: str | None) -> dict[str, Any] | None:
    """The profile of a bundled mate, else the one anybody can have; None when there is none."""
    for name in (key, "default"):
        path = ROOT / f"{name}.json" if name else None
        if path is None or not path.is_file():
            continue
        mtime = path.stat().st_mtime
        cached = _cache.get(str(path))
        if cached and cached[0] == mtime:
            return cached[1]
        doc = json.loads(path.read_text(encoding="utf-8"))
        events = ROOT / f"{name}.events.json"
        if events.is_file():
            doc["events"] = json.loads(events.read_text(encoding="utf-8"))
        doc = check(doc)
        _cache[str(path)] = (mtime, doc)
        return doc
    return None


def own(key: str | None) -> bool:
    """She comes with a world of her own (the others can ask for the one anybody can have)."""
    return bool(key) and key != "default" and (ROOT / f"{key}.json").is_file()
