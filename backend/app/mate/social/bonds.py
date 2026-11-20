"""Who among the user's mates knows whom, and how each feels about the other (docs/mate-social.md).

Nobody is set up to know anybody. A mate comes to know another when the user tells her about them (``told``) or when they talk
(``talked``); all she knows besides is that the user talks with other mates too. Once they have talked, how she feels about the
other is a relationship like the one with the user — the same numbers and the same engine (app/mate/affinity.py: affinity
−100 – 100 with its stages, trust, respect, romance), moved by what the other says to her, cooling when they don't talk, ill
feeling mending slowly. No ceiling: it can grow as far as with the user, or further (since 2026-11-20). Romance only where it is
on (메이트 공통 설정 → 메이트끼리 설렘: ``fits``).

Pure functions over one JSON document (``new``); no I/O.
"""

from __future__ import annotations

import random
from datetime import datetime
from typing import Any

from app.mate import affinity as A

VERSION = 2  # (1: ties set up in advance, the built-in mates knowing each other — gone: everyone starts as strangers)
HOWS = ("told", "talked")
THREADS_MAX, EVENTS_MAX, PLANS_MAX, LOG_KEEP = 60, 120, 20, 60


def new(now: datetime) -> dict[str, Any]:
    return {"v": VERSION, "at": A._iso(now), "known": {}, "rel": {}, "threads": [], "plans": [], "events": [], "checked": {}}


def normalized(doc: Any, now: datetime) -> dict[str, Any]:
    """A stored document; one from before (or anything malformed) starts over: nobody knows anybody."""
    if not isinstance(doc, dict) or doc.get("v") != VERSION or A._t(doc.get("at")) is None:
        return new(now)
    out = new(now) | {"at": doc["at"]}
    for me, row in (doc.get("known") or {}).items():
        if isinstance(row, dict):
            out["known"][me] = {o: k for o, k in row.items() if isinstance(k, dict) and k.get("how") in HOWS and o != me}
    for me, row in (doc.get("rel") or {}).items():
        if isinstance(row, dict):
            out["rel"][me] = {o: A.normalized(r) for o, r in row.items() if isinstance(r, dict) and o != me}
    out["threads"] = [t for t in doc.get("threads") or [] if isinstance(t, dict) and t.get("id") and len(t.get("who") or []) == 2][-THREADS_MAX:]
    out["plans"] = [p for p in doc.get("plans") or [] if isinstance(p, dict) and p.get("id") and A._t(p.get("at"))][-PLANS_MAX:]
    out["events"] = [e for e in doc.get("events") or [] if isinstance(e, dict) and e.get("id") and A._t(e.get("at"))][-EVENTS_MAX:]
    out["checked"] = {k: v for k, v in (doc.get("checked") or {}).items() if isinstance(v, str)}
    return out


def rng(*parts: Any) -> random.Random:
    return random.Random("social|" + "|".join(str(p) for p in parts))


def knows(doc: dict[str, Any], me: str, other: str) -> dict[str, Any] | None:
    return (doc["known"].get(me) or {}).get(other)


def know(doc: dict[str, Any], me: str, other: str, how: str, at: datetime, note: str = "") -> dict[str, Any]:
    """She knows of them from now on (``told``), or knows them (``talked``: it only goes that way)."""
    row = doc["known"].setdefault(me, {})
    k = row.get(other)
    if k is None:
        k = row[other] = {"how": how, "since": A._iso(at), "note": note[:200]}
    else:
        if how == "talked":
            k["how"] = "talked"
        if note:
            k["note"] = note[:200]
    return k


def rel_of(doc: dict[str, Any], me: str, other: str) -> dict[str, Any] | None:
    """How she feels about them (an affinity document), once they have talked."""
    return (doc["rel"].get(me) or {}).get(other)


def _rel(doc: dict[str, Any], me: str, other: str, at: datetime) -> dict[str, Any]:
    row = doc["rel"].setdefault(me, {})
    if other not in row:
        r = A.new()
        r["started_at"] = A._iso(at)
        row[other] = r
    return row[other]


def fits(r: dict[str, Any], at: datetime, tz: Any, *, romance: bool = True) -> None:
    """No romance where it is off (메이트끼리 설렘); the stage follows."""
    if not romance:
        r["romance"] = 0.0
    A.refresh(r, at, tz)


def heard(doc: dict[str, Any], me: str, other: str, said: str, answered: str, at: datetime, tz: Any, *, name: str = "",
          romance: bool = True) -> dict[str, Any]:
    """They said something to her (and this was her answer): it moves how she feels about them, the way the user's messages move
    how she feels about the user."""
    r = _rel(doc, me, other, at)
    A.advance(r, at, tz)
    A.credit_turn(r, at, tz, said, answered, name)
    fits(r, at, tz, romance=romance)
    r["log"], r["bonds_log"] = r["log"][-LOG_KEEP:], (r.get("bonds_log") or [])[-LOG_KEEP:]
    return r


def moved(doc: dict[str, Any], me: str, other: str, delta: float, why: str, at: datetime, tz: Any, *, romance: bool = True) -> None:
    """Something they did together (an outing) moves how she feels about them."""
    r = _rel(doc, me, other, at)
    A.advance(r, at, tz)
    A._bump(r, delta, why, at)
    fits(r, at, tz, romance=romance)


def drift(doc: dict[str, Any], now: datetime, tz: Any, romance: bool = True) -> None:
    """Their days go by: quiet days cool it (never into ill feeling), ill feeling mends slowly."""
    for row in doc["rel"].values():
        for r in row.values():
            A.advance(r, now, tz)
            fits(r, now, tz, romance=romance)


def forget(doc: dict[str, Any], mate_id: str) -> None:
    """She is gone, or starts over: whom she knew and how she felt, and what she shared with them, from both sides."""
    doc["known"].pop(mate_id, None)
    doc["rel"].pop(mate_id, None)
    for row in (*doc["known"].values(), *doc["rel"].values()):
        row.pop(mate_id, None)
    doc["threads"] = [t for t in doc["threads"] if mate_id not in t["who"]]
    doc["plans"] = [p for p in doc["plans"] if mate_id not in (p.get("who") or [])]
    doc["events"] = [e for e in doc["events"] if mate_id not in (e.get("who") or [])]


def words(r: dict[str, Any] | None) -> str:
    """How she feels about them, as she is told it."""
    if r is None:
        return "you haven't really talked yet"
    w = A.bond_words(r)
    stage = A.STAGE_WORDS.get(r["stage"], r["stage"])
    return f"{stage}; trust {w['trust']}" + (f"; romance {w['romance']}" if w["romance"] not in ("none",) else "")


def summary(r: dict[str, Any] | None) -> dict[str, Any] | None:
    """For the user: the same numbers as their own relationship shows."""
    if r is None:
        return None
    return {"affinity": round(float(r["affinity"]), 1), "stage": r["stage"], "trust": round(float(r.get("trust") or 0), 1),
            "respect": round(float(r.get("respect") or 0), 1), "romance": round(float(r.get("romance") or 0), 1)}


def friends(doc: dict[str, Any], a: str, b: str, at_least: float = 20.0) -> bool:
    """They like each other enough to go out together (both ways)."""
    ra, rb = rel_of(doc, a, b), rel_of(doc, b, a)
    return bool(ra and rb and min(float(ra["affinity"]), float(rb["affinity"])) >= at_least)
