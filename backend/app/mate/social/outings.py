"""What two of the user's mates do together once they are friends (docs/mate-social.md): they make plans a few hours to a day and a half ahead, in time
both of their days have free, go (each in her own day: social/runtime.py moves them with ``sim.meet``), and afterwards both
remember it: what they did together the same way, and each a small part only she knows (which book she picked, what she drank),
so neither knows everything about it. How it went moves how each feels about the other (social/bonds.py); they become friends
first, by talking (social/talk.py). What they can do is data (builtin/social/outings.json); a built-in mate has her own small parts (details.json). Pure, seeded.
"""

from __future__ import annotations

import json
import random
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from app.mate import josa as J

ROOT = Path(__file__).resolve().parents[1] / "builtin" / "social"
MOODS = ("great", "good", "okay", "awkward")
#: how often two friends make plans: a chance per waking hour from how fond of each other they are (the lower of the two); never
#: within GAP_DAYS of the last time, one outing a day each; only once both like the other enough (bonds.friends)
PLAN_BASE, PLAN_FOND = 0.03, 0.3
PLAN_HOURS = (9, 23)
GAP_DAYS = 2
#: plans are for between two hours and a day and a half ahead, starting on the half hour
AHEAD_MIN, AHEAD_MAX, STEP = timedelta(hours=2), timedelta(hours=36), timedelta(minutes=30)
#: someone without a day of her own is free in these hours
FREE_HOURS = (10, 22)
#: what how it went does to how each feels about the other (affinity; an awkward one costs one of them more)
EFFECTS = {"great": 1.2, "good": 0.7, "okay": 0.2, "awkward": -1.5}
_cache: dict[str, tuple[float, Any]] = {}
_FILL = re.compile(r"\{(a|b)(?::([^{}]+))?\}")


def _load(name: str) -> Any:
    path = ROOT / f"{name}.json"
    mtime = path.stat().st_mtime
    cached = _cache.get(name)
    if cached and cached[0] == mtime:
        return cached[1]
    doc = json.loads(path.read_text(encoding="utf-8"))
    if name == "outings":
        _check(doc)
    _cache[name] = (mtime, doc)
    return doc


def _check(doc: dict[str, Any]) -> None:
    for kind in doc["kinds"]:
        name = kind.get("id") or "?"
        if not kind.get("id") or not (kind.get("names") or {}).get("ko") or not (kind.get("names") or {}).get("en"):
            raise ValueError(f"social: {name} needs an id and its names")
        if not kind.get("shared") or not kind.get("own") or len(kind.get("hours") or []) != 2 or len(kind.get("minutes") or []) != 2:
            raise ValueError(f"social: {name} needs shared and own lines, its hours and how long")
        for line in [*kind["shared"], *kind["own"]]:
            if not line.get("ko") or not line.get("en"):
                raise ValueError(f"social: {name} has a line without ko and en")
    for mood in MOODS:
        if not doc["moods"].get(mood):
            raise ValueError(f"social: no lines for how a {mood} outing went")


def kinds() -> dict[str, dict[str, Any]]:
    return {k["id"]: k for k in _load("outings")["kinds"]}


def details(builtin: str | None) -> dict[str, list[dict[str, str]]]:
    return dict(_load("details").get(builtin or "") or {}) if builtin else {}


def fill(text: str, a: str, b: str) -> str:
    """{a} and {b} are their names; {a:과} puts the right particle after one (josa.py)."""
    return _FILL.sub(lambda m: (a if m.group(1) == "a" else b) + (J.particle(a if m.group(1) == "a" else b, m.group(2)) if m.group(2) else ""), text)


def _both(line: dict[str, str], a: str, b: str) -> dict[str, str]:
    return {lang: fill(text, a, b) for lang, text in line.items() if lang in ("ko", "en")}


# ---- where each of them is in it ----

def _home(profile: dict[str, Any]) -> str:
    return (profile.get("start") or {}).get("place") or "home"


def activity_for(kind: dict[str, Any], profile: dict[str, Any]) -> str | None:
    """Her own activity for what they do, if her day has one like it: by the place first, else by what her body does (at home for
    a call or a game online; away from home when it says so). None: she has nothing like it (out, she is simply with the friend)."""
    match, home = kind.get("match") or {}, _home(profile)
    best: tuple[float, str] | None = None
    for key, act in profile["activities"].items():
        if key in ("commute", "outing"):
            continue
        place = act.get("place")
        if (kind.get("remote") or match.get("home")) and place != home:
            continue
        if match.get("free") and not act.get("free"):
            continue
        if key in (match.get("activity") or []):
            score = 3.0
        elif place in (match.get("place") or []):
            score = 2.0
        elif (act.get("body") or "") in (match.get("body") or []) and not (match.get("away") and place == home):
            score = 1.0
        else:
            continue
        score += float(act.get("likes") or 0) * 0.1
        if best is None or score > best[0]:
            best = (score, key)
    return best[1] if best else None


def possible(kind: dict[str, Any], profiles: list[dict[str, Any] | None], sky: str) -> bool:
    """Whether they can do it: out of doors not in rain or snow; from home only when each one's day has it (someone without a day of
    her own can do anything); out, at least one of them must have such a place."""
    if kind.get("outdoor") and sky in ("rain", "snow"):
        return False
    have = [activity_for(kind, p) is not None for p in profiles if p is not None]
    if kind.get("remote"):
        return all(have)
    return any(have) or not have


def likes(kind: dict[str, Any], profile: dict[str, Any] | None) -> float:
    key = activity_for(kind, profile) if profile else None
    return float((profile or {}).get("activities", {}).get(key or "", {}).get("likes") or 0) if key else 0.0


def pick_kind(rng: random.Random, profiles: list[dict[str, Any] | None], sky: str) -> dict[str, Any] | None:
    """What they feel like doing: what both of them like, weighed with a seeded bit of chance."""
    options = [k for k in kinds().values() if possible(k, profiles, sky)]
    if not options:
        return None
    weights = [max(0.05, float(k.get("weight") or 1) * (1 + sum(likes(k, p) for p in profiles))) for k in options]
    return rng.choices(options, weights=weights)[0]


def pick_time(rng: random.Random, kind: dict[str, Any], now_local: datetime, free: Callable[[datetime, datetime], bool]
              ) -> tuple[datetime, datetime] | None:
    """When: a start on the half hour between two hours and a day and a half from now, within the kind's hours, that both of
    them have free (``free``)."""
    first = now_local + AHEAD_MIN
    first = (first + timedelta(minutes=(-first.minute) % 30)).replace(second=0, microsecond=0)
    lo, hi = (int(x[:2]) * 60 + int(x[3:]) for x in kind["hours"])
    low, high = (int(x) for x in kind["minutes"])
    starts = []
    t = first
    while t <= now_local + AHEAD_MAX:
        minute = t.hour * 60 + t.minute
        if lo <= minute <= hi:
            length = timedelta(minutes=rng.randint(low, high))
            if free(t, t + length):
                starts.append((t, t + length))
        t += STEP
    return rng.choice(starts) if starts else None


def plan_chance(fond: float) -> float:
    """A chance per waking hour that two friends make plans now (``fond``: the lower of how fond each is of the other)."""
    return (PLAN_BASE + PLAN_FOND * max(0.0, fond) / 100) / (PLAN_HOURS[1] - PLAN_HOURS[0])


# ---- how it went ----

def mood(rng: random.Random, fond: float, stress: tuple[float, float] = (0.0, 0.0)) -> str:
    """Fond friends mostly have a good time; stress and a cool tie make an awkward one likelier (``fond``: the lower of the two)."""
    f = max(0.0, min(1.0, fond / 100))
    great = 0.15 + 0.45 * f
    awkward = max(0.03, 0.16 - 0.14 * f + 0.12 * max(stress))
    okay = 0.22
    r = rng.random()
    if r < awkward:
        return "awkward"
    if r < awkward + great:
        return "great"
    if r < awkward + great + okay:
        return "okay"
    return "good"


def compose(rng: random.Random, kind: dict[str, Any], what: str, a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """What they remember of it: {text: {ko, en} (both alike), own: {id: {ko, en}} (each her own small part), mood_line: {ko, en}}.
    ``a``/``b``: {id, name, builtin}."""
    pool = _load("outings")
    shared = _both(rng.choice(kind["shared"]), a["name"], b["name"])
    own = {}
    for who in (a, b):
        mine = details(who.get("builtin")).get(kind["id"]) or []  # (hers first, mostly)
        own[who["id"]] = _both(rng.choice(mine if mine and rng.random() < 0.7 else kind["own"]), a["name"], b["name"])
    return {"text": shared, "own": own, "mood_line": dict(rng.choice(pool["moods"][what]))}

