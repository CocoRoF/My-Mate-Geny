"""Who among the user's mates knows whom (docs/mate-social.md): a tie between two mates, how fond each is of the other (``fond``:
one number each way, so one can like the other more), how close they are (``close``: one number, what they have been through
together) and, where it is on and fits, a spark (``spark``: one each way). What they do together (social/outings.py) moves them;
time apart cools them a little. Like everything about a mate: words to her, bars for the user, never numbers in her mouth.

The built-in mates already know each other (builtin/social/ties.json); any other mate meets them over time or is introduced by the
user. Pure functions over one JSON document (``new``); no I/O.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta
from typing import Any

from app.mate import affinity as A

HOWS = ("builtin", "introduced", "met")
#: where a new tie starts (a built-in one says its own)
FOND_START = {"introduced": 56.0, "met": 52.0}
CLOSE_START = {"introduced": 10.0, "met": 6.0}
#: how close and how fond (both ways, the lower counts) each stage takes; below AWKWARD either way they are awkward together
STAGES = ("awkward", "acquainted", "friend", "close", "best")
STAGE_AT = (("best", 80.0, 75.0), ("close", 55.0, 60.0), ("friend", 25.0, 45.0))
AWKWARD = 30.0
#: a spark (only where it is on and fits: ``romance_fits``): from SPARK_AT one way it is a crush, both ways 썸; it goes no further
SPARK_AT, SPARK_MAX = 40.0, 70.0
#: time apart: after CLOSE_IDLE_DAYS without doing anything together closeness fades a little each day, never below its floor;
#: fondness drifts back towards FOND_REST; a spark fades unless something feeds it
CLOSE_IDLE_DAYS, CLOSE_FADE = 14, 0.25
CLOSE_FLOOR = {"builtin": 25.0, "introduced": 5.0, "met": 5.0}
FOND_REST, FOND_SETTLE, SPARK_FADE = 50.0, 0.01, 0.4
DRIFT_DAYS_MAX = 120
LOG_MAX, EVENTS_MAX, PLANS_MAX, HIGHLIGHTS_MAX = 30, 120, 20, 8


def key(a: str, b: str) -> str:
    return "|".join(sorted((a, b)))


def new(now: datetime) -> dict[str, Any]:
    return {"v": 1, "at": A._iso(now), "drift_day": now.strftime("%Y-%m-%d"), "ties": {}, "plans": [], "events": [],
            "seen": {}, "checked": {}}


def normalized(doc: Any, now: datetime) -> dict[str, Any]:
    """A stored document, whatever a past version left: anything malformed is dropped, never fatal."""
    if not isinstance(doc, dict) or A._t(doc.get("at")) is None:
        return new(now)
    out = new(now) | {k: doc[k] for k in ("at", "drift_day") if isinstance(doc.get(k), str)}
    for k, tie in (doc.get("ties") or {}).items():
        if not isinstance(tie, dict) or not isinstance(tie.get("fond"), dict):
            continue
        a, b = tie.get("a"), tie.get("b")
        if not a or not b or a == b or key(a, b) != k:
            continue
        out["ties"][k] = {
            "a": a, "b": b, "since": tie.get("since") or out["at"], "how": tie.get("how") if tie.get("how") in HOWS else "met",
            "story": dict(tie.get("story") or {}),
            "fond": {m: _pct(tie["fond"].get(m, FOND_REST)) for m in (a, b)},
            "close": _pct(tie.get("close", 0.0)),
            "spark": {m: min(SPARK_MAX, _pct((tie.get("spark") or {}).get(m, 0.0))) for m in (a, b)},
            "last": tie.get("last"), "together": int(tie.get("together") or 0), "boost_until": tie.get("boost_until"),
            "log": [e for e in tie.get("log") or [] if isinstance(e, dict)][-LOG_MAX:],
            "highlights": [e for e in tie.get("highlights") or [] if isinstance(e, str)][-HIGHLIGHTS_MAX:],
        }
    out["plans"] = [p for p in doc.get("plans") or [] if isinstance(p, dict) and p.get("id") and A._t(p.get("at"))][-PLANS_MAX:]
    out["events"] = [e for e in doc.get("events") or [] if isinstance(e, dict) and e.get("id") and A._t(e.get("at"))][-EVENTS_MAX:]
    out["seen"] = {k: v for k, v in (doc.get("seen") or {}).items() if isinstance(v, str)}
    out["checked"] = {k: v for k, v in (doc.get("checked") or {}).items() if isinstance(v, str)}
    return out


def _pct(v: Any) -> float:
    try:
        return max(0.0, min(100.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


def tie_of(doc: dict[str, Any], a: str, b: str) -> dict[str, Any] | None:
    return doc["ties"].get(key(a, b))


def other(tie: dict[str, Any], me: str) -> str:
    return tie["b"] if tie["a"] == me else tie["a"]


def ties_of(doc: dict[str, Any], me: str) -> list[dict[str, Any]]:
    return [t for t in doc["ties"].values() if me in (t["a"], t["b"])]


def make(doc: dict[str, Any], a: str, b: str, *, how: str, at: datetime, story: dict[str, str] | None = None,
         fond: dict[str, float] | None = None, close: float | None = None) -> dict[str, Any]:
    """A new tie between them (an existing one stays as it is)."""
    k = key(a, b)
    if k in doc["ties"]:
        return doc["ties"][k]
    start = FOND_START.get(how, 50.0)
    tie = {"a": min(a, b), "b": max(a, b), "since": A._iso(at), "how": how, "story": dict(story or {}),
           "fond": {m: _pct((fond or {}).get(m, start)) for m in (a, b)}, "close": _pct(close if close is not None else CLOSE_START.get(how, 5.0)),
           "spark": {a: 0.0, b: 0.0}, "last": None, "together": 0, "boost_until": None, "log": [], "highlights": []}
    doc["ties"][k] = tie
    return tie


def stage(tie: dict[str, Any]) -> str:
    """What they are to each other: awkward | acquainted | friend | close | best (both ways at once: the lower fondness counts)."""
    fond = min(tie["fond"].values())
    if fond < AWKWARD:
        return "awkward"
    for name, close, both in STAGE_AT:
        if tie["close"] >= close and fond >= both:
            return name
    return "acquainted"


def spark(tie: dict[str, Any], me: str) -> str:
    """none | crush (hers, one way) | mutual (both ways) | theirs (the other one has a crush on her, unbeknown)."""
    mine, theirs = tie["spark"].get(me, 0.0) >= SPARK_AT, tie["spark"].get(other(tie, me), 0.0) >= SPARK_AT
    return "mutual" if mine and theirs else "crush" if mine else "theirs" if theirs else "none"


def bump(tie: dict[str, Any], at: datetime, why: str, *, fond: dict[str, float] | None = None, close: float = 0.0,
         spark: dict[str, float] | None = None) -> None:
    """Something between them moves the numbers; it is logged with its reason."""
    d: dict[str, Any] = {}
    for m, v in (fond or {}).items():
        if m in tie["fond"] and v:
            tie["fond"][m] = _pct(tie["fond"][m] + v)
            d[f"fond:{m}"] = round(v, 2)
    if close:
        tie["close"] = _pct(tie["close"] + close)
        d["close"] = round(close, 2)
    for m, v in (spark or {}).items():
        if m in tie["spark"] and v:
            tie["spark"][m] = max(0.0, min(SPARK_MAX, tie["spark"][m] + v))
            d[f"spark:{m}"] = round(v, 2)
    if d:
        tie["log"] = [*tie["log"], {"at": A._iso(at), "why": why, "d": d}][-LOG_MAX:]


def drift(doc: dict[str, Any], now: datetime, tz: Any) -> None:
    """Whole days since it last ran: closeness fades after a while apart, fondness settles back, a spark fades."""
    today = now.astimezone(tz).strftime("%Y-%m-%d")
    try:
        last = datetime.strptime(doc.get("drift_day") or today, "%Y-%m-%d")
    except ValueError:
        last = datetime.strptime(today, "%Y-%m-%d")
    days = min(DRIFT_DAYS_MAX, (datetime.strptime(today, "%Y-%m-%d") - last).days)
    doc["drift_day"] = today
    if days <= 0:
        return
    for tie in doc["ties"].values():
        seen = A._t(tie.get("last")) or A._t(tie.get("since")) or now
        idle = (now - seen).days
        fading = max(0, min(days, idle - CLOSE_IDLE_DAYS))
        floor = CLOSE_FLOOR.get(tie["how"], 5.0)
        if fading and tie["close"] > floor:
            tie["close"] = max(floor, tie["close"] - CLOSE_FADE * fading)
        keep = (1 - FOND_SETTLE) ** days
        for m in tie["fond"]:
            tie["fond"][m] = FOND_REST + (tie["fond"][m] - FOND_REST) * keep
        for m in tie["spark"]:
            tie["spark"][m] = max(0.0, tie["spark"][m] - SPARK_FADE * days)


def forget(doc: dict[str, Any], mate_id: str) -> None:
    """She is gone (or starts again): every tie, plan and shared moment of hers."""
    doc["ties"] = {k: t for k, t in doc["ties"].items() if mate_id not in (t["a"], t["b"])}
    doc["plans"] = [p for p in doc["plans"] if mate_id not in (p.get("who") or [])]
    doc["events"] = [e for e in doc["events"] if mate_id not in (e.get("who") or [])]
    doc["seen"].pop(mate_id, None)
    doc["checked"] = {k: v for k, v in doc["checked"].items() if mate_id not in k.split("|")}


def rng(doc: dict[str, Any], *parts: Any) -> random.Random:
    return random.Random("social|" + "|".join(str(p) for p in parts))


def fond_word(v: float) -> str:
    """How fond she is of them, as she is told it ("you …")."""
    return ("can't stand them" if v < 15 else "find them hard to be around" if v < AWKWARD else "feel so-so about them" if v < 45
            else "like them" if v < 65 else "like them a lot" if v < 82 else "adore them")


STAGE_WORDS = {"awkward": "things are awkward between you lately", "acquainted": "someone you know", "friend": "a friend of yours",
               "close": "a close friend of yours", "best": "your best friend"}


def recent(doc: dict[str, Any], a: str, b: str, *, limit: int = 4) -> list[dict[str, Any]]:
    """What they did together lately, newest first."""
    return [e for e in reversed(doc["events"]) if set(e.get("who") or []) == {a, b}][:limit]


def idle_days(tie: dict[str, Any], now: datetime) -> int:
    seen = A._t(tie.get("last")) or A._t(tie.get("since")) or now
    return max(0, (now - seen).days)


def boosted(tie: dict[str, Any], now: datetime) -> bool:
    """Just introduced: they mean to meet soon."""
    until = A._t(tie.get("boost_until"))
    return until is not None and now < until


def boost(tie: dict[str, Any], now: datetime, days: int = 7) -> None:
    tie["boost_until"] = A._iso(now + timedelta(days=days))
