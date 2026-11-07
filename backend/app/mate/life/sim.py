"""The simulation of her day: pure functions over one JSON document (``new``) and a profile (profile.py). No I/O.

``advance`` replays the time since it last ran, so it doesn't matter who asks or how long she was left alone. Being away costs
nothing: needs have a ceiling, and she looks after herself.

What she does next: an obligation that is due (work, sleep, a raid night), else what relieves her most, what she likes and what she
can afford, with a seeded bit of chance. Nothing here is about what she says or decides in a conversation: this is the world around her.
"""

from __future__ import annotations

import hashlib
import random
from datetime import datetime, timedelta
from typing import Any

from app.mate import affinity as A

NEEDS = ("hunger", "sleep", "affection", "fun", "stress")
STATS = ("work", "gaming", "stamina", "cooking", "sense", "courage")
#: per hour, whatever she is doing; ``affection`` also grows with how close they are (``closeness``)
DRIFT = {"hunger": 0.11, "sleep": 0.045, "affection": 0.008, "fun": 0.03, "stress": 0.0}
AFFECTION_CLOSE = 0.01
#: nobody starves in here
CEILING = {"hunger": 0.95, "sleep": 0.95, "affection": 0.8, "fun": 0.9, "stress": 0.9}
START_NEEDS = {"hunger": 0.25, "sleep": 0.2, "affection": 0.3, "fun": 0.3, "stress": 0.15}
STEP = timedelta(minutes=5)
#: longer than this alone, only the end of it is played
MAX_GAP = timedelta(days=14)
#: an urgent need ends what she is doing in her free time, once she has been at it this long
URGENT, URGENT_AFTER = 0.8, timedelta(minutes=15)
#: on the street for shorter than this she is simply there
WALK_MINUTES = 10
TIMELINE_MAX = 120
OUTING_UNTIL, OUTINGS_A_DAY = 21, 2
WORDS = ((0.75, "badly"), (0.5, "quite"), (0.3, "a little"))
#: how each need feels, for her <context>
BODY_WORDS = {"hunger": "hungry", "sleep": "tired", "affection": "wanting warmth and attention", "fun": "bored", "stress": "stressed"}
SLOTS = (("morning", 5, 11), ("day", 11, 17), ("evening", 17, 20))
WOKEN_FOR = timedelta(minutes=20)
#: a message of theirs, on her needs
HEARD_AFFECTION, HEARD_WARM, HEARD_FUN, HEARD_RUDE_STRESS = 0.05, 0.12, 0.015, 0.08
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
#: together: the way there goes this much faster, being there does this per hour on top, and while they keep talking she stays
TOGETHER_FASTER = 5
TOGETHER = {"affection": -0.3, "fun": -0.15, "stress": -0.05}
STILL_TALKING, STAY_ON = timedelta(minutes=20), timedelta(minutes=15)
PLAN_MINUTES = (5, 480)
#: what they can send her with, for talking to her: never taken away, and nothing they must keep up
COINS_START, COINS_FIRST_MESSAGE, COINS_MESSAGE, COINS_A_DAY = 500, 200, 5, 300
KEPT_MAX, NOTES_MAX = 20, 5
#: her day ends and the next begins at this hour, whatever the calendar says
DAY_TURNS = 4
DAYS_KEPT, RECENT_KEPT = 60, 12
#: how fast skills come overall: a year of her life, not a week
GROWTH = 0.4
#: a suggestion for her time: when it counts, and how much it leans her (what they ask for weighs more than a whim, not more than being exhausted)
PLAN_SLOTS = {"evening": ("19:00", "23:00"), "day": ("11:00", "18:00")}
PLAN_LEAN = 1.6
#: story events: not on top of each other
EVENT_GAP = timedelta(hours=3)


# ---- the document ----

def new(profile: dict[str, Any], now: datetime, tz: Any, seed: str) -> dict[str, Any]:
    start = profile.get("start") or {}
    doc = {"seed": seed, "at": A._iso(now), "needs": dict(START_NEEDS), "stats": {s: float((start.get("stats") or {}).get(s) or 0) for s in STATS},
           "money": int(start.get("money") or 0), "place": start.get("place") or next(iter(profile["places"])), "activity": None,
           "since": A._iso(now), "until": None, "going": None, "paid": None, "timeline": [], "day": _her_day(now, tz),
           "woken": None, "heard": None, "heard_at": None, "plan": None, "with_user": None, "coins": COINS_START, "coins_day": None, "coins_today": 0,
           "kept": [], "notes": [], "week": {}, "days": [], "recent": [], "fired": {}, "flags": [], "last_event": None, "born": A._iso(now),
           "day_stats": None, "day_money": None}
    _next(doc, profile, now, tz, [], first=True)
    return doc


def normalized(doc: Any, profile: dict[str, Any]) -> dict[str, Any] | None:
    """A stored document, whatever a past version or the profile has become since. None: start again."""
    if not isinstance(doc, dict) or A._t(doc.get("at")) is None:
        return None
    doc = dict(doc)
    needs, stats = doc.get("needs") or {}, doc.get("stats") or {}
    doc["needs"] = {n: _clamp(float(needs.get(n, START_NEEDS[n])), n) for n in NEEDS}
    doc["stats"] = {s: float(stats.get(s) or 0) for s in STATS}
    doc["timeline"] = doc["timeline"] if isinstance(doc.get("timeline"), list) else []
    doc["coins"] = int(doc.get("coins", COINS_START) or 0)
    for key in ("kept", "notes", "days", "recent", "flags"):
        doc[key] = doc[key] if isinstance(doc.get(key), list) else []
    for key in ("week", "fired"):
        doc[key] = doc[key] if isinstance(doc.get(key), dict) else {}
    doc["week"] = {k: v for k, v in doc["week"].items() if v in profile["activities"]}
    doc.setdefault("born", doc["at"])
    plan = doc.get("plan") if isinstance(doc.get("plan"), dict) else None
    doc["plan"] = plan if plan and A._t(plan.get("until")) is not None and plan.get("activity") in profile["activities"] else None
    if doc.get("place") not in profile["places"]:
        doc["place"] = (profile.get("start") or {}).get("place") or next(iter(profile["places"]))
    if doc.get("activity") not in profile["activities"]:
        doc["activity"], doc["until"], doc["going"] = None, None, None
    return doc


def _her_day(t: datetime, tz: Any) -> str:
    return (t.astimezone(tz) - timedelta(hours=DAY_TURNS)).strftime("%Y-%m-%d")


def _clamp(v: float, need: str) -> float:
    return max(0.0, min(CEILING[need], v))


def _rng(doc: dict[str, Any], *parts: Any) -> random.Random:
    raw = "|".join(str(p) for p in (doc.get("seed"), *parts))
    return random.Random(int(hashlib.sha256(raw.encode()).hexdigest()[:16], 16))


# ---- the clock of her week ----

def _minutes(text: str) -> int:
    h, m = text.split(":")
    return int(h) * 60 + int(m)


def _day_matches(spec: str | None, local: datetime) -> bool:
    if not spec or spec == "all":
        return True
    day = local.weekday()
    if spec == "weekday":
        return day < 5
    if spec == "weekend":
        return day >= 5
    return WEEKDAYS[day] in spec.split(",")


def _in_window(window: list[str] | None, minute: int) -> bool:
    if not window:
        return True
    a, b = _minutes(window[0]), _minutes(window[1])
    return a <= minute < b if a <= b else minute >= a or minute < b


def _midnight(local: datetime) -> datetime:
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


def place_open(place: dict[str, Any], local: datetime) -> bool:
    return _day_matches(place.get("days"), local) and _in_window(place.get("open"), local.hour * 60 + local.minute)


def travel_minutes(profile: dict[str, Any], a: str, b: str) -> int:
    if a == b:
        return 0
    pa, pb = profile["places"][a], profile["places"][b]
    near = (pa.get("near") or {}).get(b, (pb.get("near") or {}).get(a))
    return int(near) if near is not None else int(pa.get("minutes") or 0) + int(pb.get("minutes") or 0)


def _blocks(doc: dict[str, Any], profile: dict[str, Any], local: datetime) -> list[dict[str, Any]]:
    """Her obligations on this day: {activity, place, start, end, weight}."""
    day = _midnight(local)
    date = day.strftime("%Y-%m-%d")
    out = []
    for b in profile.get("routine") or []:
        if not _day_matches(b.get("days"), day):
            continue
        late = _rng(doc, "block", date, b["activity"]).randint(0, int(b["jitter"])) if b.get("jitter") else 0
        out.append({"activity": b["activity"], "place": profile["activities"][b["activity"]]["place"], "weight": int(b.get("weight") or 0),
                    "start": day + timedelta(minutes=_minutes(b["from"]) + late), "end": day + timedelta(minutes=_minutes(b["to"]))})
    return out


def _due(doc: dict[str, Any], profile: dict[str, Any], t: datetime, tz: Any) -> dict[str, Any] | None:
    """The strongest obligation she has to be getting to or be at, now."""
    local = t.astimezone(tz)
    best = None
    for b in _blocks(doc, profile, local):
        lead = timedelta(minutes=travel_minutes(profile, doc["place"], b["place"]))
        if b["start"] - lead <= local < b["end"] and (best is None or b["weight"] > best["weight"]):
            best = b
    return best


def _upcoming(doc: dict[str, Any], profile: dict[str, Any], t: datetime, tz: Any, *, other_than: str | None = None) -> dict[str, Any] | None:
    """The next obligation that hasn't started, today or tomorrow."""
    local = t.astimezone(tz)
    ahead = [b for b in _blocks(doc, profile, local) + _blocks(doc, profile, local + timedelta(days=1)) if b["start"] > local and b["activity"] != other_than]
    return min(ahead, key=lambda b: b["start"]) if ahead else None


def weather(doc: dict[str, Any], local: datetime) -> str:
    """Today's sky: made up, the same all day (clear, cloudy, rain, or snow in winter)."""
    r = _rng(doc, "weather", local.strftime("%Y-%m-%d")).random()
    if r < 0.6:
        return "clear"
    if r < 0.8:
        return "cloudy"
    return "snow" if local.month in (12, 1, 2) else "rain"


# ---- what she does next ----

def _room(doc: dict[str, Any], profile: dict[str, Any], key: str, act: dict[str, Any], t: datetime, tz: Any) -> datetime | None:
    """How long she could do this if she chose it now, as when it would have to end. None: she can't, or not for long enough."""
    place = profile["places"][act["place"]]
    low, high = act.get("minutes") or [30, 30]
    arrive = t.astimezone(tz) + timedelta(minutes=travel_minutes(profile, doc["place"], act["place"]))
    if not place_open(place, arrive):
        return None
    latest = arrive + timedelta(minutes=int(high))
    if place.get("open"):
        close = _midnight(arrive) + timedelta(minutes=_minutes(place["open"][1]))
        if close > arrive:
            latest = min(latest, close)
    coming = _upcoming(doc, profile, t, tz)
    if coming and coming["activity"] != key:
        latest = min(latest, coming["start"] - timedelta(minutes=travel_minutes(profile, act["place"], coming["place"])))
    return latest if latest >= arrive + timedelta(minutes=int(low)) else None


def _fits(doc: dict[str, Any], act: dict[str, Any], minute: int) -> bool:
    return (bool(act.get("free")) and _in_window(act.get("hours"), minute) and doc["money"] >= int(act.get("cost") or 0)
            and all(doc["needs"].get(n, 0) >= v for n, v in (act.get("when") or {}).items()))


def _hours_today(doc: dict[str, Any], key: str, local: datetime, tz: Any) -> float:
    start = _midnight(local)
    total = 0.0
    for e in doc["timeline"][-30:]:
        a, b = A._t(e.get("from")), A._t(e.get("to"))
        if e.get("activity") == key and a is not None and b is not None and b.astimezone(tz) >= start:
            total += (b - max(a, start)).total_seconds() / 3600
    return max(0.0, total)


def _feels_like_going_out(doc: dict[str, Any], profile: dict[str, Any], local: datetime, tz: Any) -> bool:
    """Some days, she does: not late at night, and not all day."""
    outing = profile.get("outing") or {}
    if local.hour >= OUTING_UNTIL or local.hour < 5:
        return False
    home, today = (profile.get("start") or {}).get("place"), local.strftime("%Y-%m-%d")
    outings = {e.get("place") for e in doc["timeline"][-12:] if e.get("place") not in (home, "street") and profile["activities"].get(e.get("activity"), {}).get("free")
               and (A._t(e.get("to")) or local).astimezone(tz).strftime("%Y-%m-%d") == today}
    return len(outings) < OUTINGS_A_DAY and _rng(doc, "out", today).random() < float(outing.get("weekend" if local.weekday() >= 5 else "weekday") or 0)


def _score(doc: dict[str, Any], profile: dict[str, Any], key: str, act: dict[str, Any], t: datetime, tz: Any) -> float:
    local = t.astimezone(tz)
    minutes = sum(act.get("minutes") or [30, 30]) / 2
    # (what it really takes off, after what the hour puts on: sleep only slows hunger down, it doesn't feed her)
    relief = sum(doc["needs"][n] ** 2 * min(1.0, -(rate + DRIFT[n]) * minutes / 60) * 3.5 for n, rate in (act.get("needs") or {}).items() if rate + DRIFT[n] < 0)
    if act.get("body") == "sleep":
        relief -= max(0.0, doc["needs"]["hunger"] - 0.5) * 4  # (she eats something first)
    place = profile["places"][act["place"]]
    trip = travel_minutes(profile, doc["place"], act["place"]) / 60
    shy = float(place.get("crowded") or 0) * (1 - doc["stats"]["courage"] / 100)
    dear = 0.5 if doc["money"] < int(act.get("cost") or 0) * 4 else 0.0
    wet = 1.0 if place.get("outdoor") and weather(doc, local) in ("rain", "snow") else 0.0
    asked = PLAN_LEAN if doc["week"].get(plan_slot(local) or "") == key else 0.0
    good_at = doc["stats"].get(act.get("skill") or "", 0.0) / 100 * 0.8
    noise = _rng(doc, "pick", local.strftime("%Y-%m-%d-%H"), key).uniform(-0.3, 0.3)
    again = min(1.2, _hours_today(doc, key, local, tz) * 0.3) + (1.0 if key == doc.get("activity") and act.get("cost") else 0.0)
    out = float((profile.get("outing") or {}).get("bonus") or 0) if act["place"] != (profile.get("start") or {}).get("place") and _feels_like_going_out(doc, profile, local, tz) else 0.0
    return float(act.get("likes") or 0) + relief + noise + out + asked + good_at - trip * 0.7 - shy - dear - again - wet


def plan_slot(local: datetime) -> str | None:
    """The slot of the week this moment belongs to: mon_evening … fri_evening, sat_day, sat_evening, sun_day, sun_evening."""
    minute = local.hour * 60 + local.minute
    day = WEEKDAYS[local.weekday()]
    for name, window in PLAN_SLOTS.items():
        if _in_window(list(window), minute) and (local.weekday() >= 5 or name == "evening"):
            return f"{day}_{name}"
    return None


def plan_slots() -> list[str]:
    return [f"{d}_evening" for d in WEEKDAYS[:5]] + ["sat_day", "sat_evening", "sun_day", "sun_evening"]


def set_plan(doc: dict[str, Any], profile: dict[str, Any], slot_id: Any, activity: Any) -> bool:
    """They suggest how she spends this slot of the week (None: it's up to her). She mostly goes along; it isn't an order."""
    if slot_id not in plan_slots():
        return False
    if activity is None or activity == "":
        doc["week"].pop(slot_id, None)
        return True
    act = profile["activities"].get(activity) if isinstance(activity, str) else None
    if not act or not act.get("free"):
        return False
    doc["week"][slot_id] = activity
    return True


def _pick(doc: dict[str, Any], profile: dict[str, Any], t: datetime, tz: Any) -> tuple[str, datetime | None]:
    local = t.astimezone(tz)
    minute = local.hour * 60 + local.minute
    best, best_room, top = "rest", None, -1e9
    for key, act in profile["activities"].items():
        if not _fits(doc, act, minute):
            continue
        room = _room(doc, profile, key, act, t, tz)
        if room is None:
            continue
        s = _score(doc, profile, key, act, t, tz)
        if s > top:
            best, best_room, top = key, room, s
    return best, best_room


def _close(doc: dict[str, Any], t: datetime) -> None:
    """What she was doing goes into the record of her day."""
    if doc.get("activity"):
        entry = {"activity": doc["activity"], "place": doc["place"], "from": doc["since"], "to": A._iso(t)}
        doc["timeline"] = [*doc["timeline"], entry][-TIMELINE_MAX:]


def _settle(doc: dict[str, Any], profile: dict[str, Any], key: str, until: datetime | None, room: datetime | None, t: datetime,
            out: list[dict[str, Any]]) -> None:
    """She is there, and starts."""
    act = profile["activities"][key]
    if doc["place"] != act["place"]:
        out.append({"type": "moved", "place": act["place"], "activity": key})
    if until is None:
        low, high = act.get("minutes") or [30, 30]
        until = t + timedelta(minutes=_rng(doc, "len", A._iso(t), key).randint(int(low), int(high)))
        if room is not None:
            until = min(until, room)
    doc.update(activity=key, place=act["place"], since=A._iso(t), until=A._iso(until), going=None)
    out.append({"type": "started", "activity": key, "place": act["place"]})


def _begin(doc: dict[str, Any], profile: dict[str, Any], key: str, until: datetime | None, room: datetime | None, t: datetime,
           out: list[dict[str, Any]], *, first: bool = False) -> None:
    _close(doc, t)
    target = profile["activities"][key]["place"]
    trip = 0 if first else travel_minutes(profile, doc["place"], target)
    if trip < WALK_MINUTES or "commute" not in profile["activities"]:
        _settle(doc, profile, key, until, room, t, out)
        return
    doc["going"] = {"activity": key, "until": A._iso(until) if until else None, "room": A._iso(room) if room else None}
    street = profile["activities"]["commute"]["place"]
    trip = max(1, round(trip / TOGETHER_FASTER)) if doc.get("with_user") else trip
    doc.update(activity="commute", place=street, since=A._iso(t), until=A._iso(t + timedelta(minutes=trip)))
    out.append({"type": "moved", "place": street, "activity": "commute", "to": target})


def _next(doc: dict[str, Any], profile: dict[str, Any], t: datetime, tz: Any, out: list[dict[str, Any]], *, first: bool = False) -> None:
    due = _due(doc, profile, t, tz)
    if due:
        _begin(doc, profile, due["activity"], due["end"], None, t, out, first=first)
        return
    key, room = _pick(doc, profile, t, tz)
    _begin(doc, profile, key, None, room, t, out, first=first)


def _apply(doc: dict[str, Any], profile: dict[str, Any], dt: timedelta, t: datetime, closeness: float) -> None:
    """``dt`` of what she is doing, on her body, her skills and her money."""
    hours = dt.total_seconds() / 3600
    act = profile["activities"].get(doc.get("activity") or "") or {}
    rates = act.get("needs") or {}
    woken = A._t(doc.get("woken"))
    if act.get("body") == "sleep" and woken is not None and t < woken:
        rates = {}  # (a message woke her: no sleep goes on while she is up)
    for need in NEEDS:
        rate = DRIFT[need] + (AFFECTION_CLOSE * closeness if need == "affection" else 0.0) + float(rates.get(need) or 0)
        rate += TOGETHER.get(need, 0.0) if doc.get("with_user") else 0.0
        if need == "sleep" and rate > 0:
            rate *= 1.1 - doc["stats"]["stamina"] / 100 * 0.35  # (the fitter she gets, the slower she tires)
        doc["needs"][need] = _clamp(doc["needs"][need] + rate * hours, need)
    calm = 1 - 0.5 * doc["needs"]["stress"]  # (she learns less when frazzled, and a skill comes slower the higher it is)
    for stat, gain in (act.get("stats") or {}).items():
        doc["stats"][stat] = min(100.0, doc["stats"][stat] + GROWTH * float(gain) * hours * calm * (1.25 - doc["stats"][stat] / 100))
    doc["money"] += int(round(float(act.get("pay") or 0) * hours * (0.75 + doc["stats"]["work"] / 100 * 0.6)))
    if act.get("cost") and doc.get("paid") != doc.get("since"):
        doc["paid"] = doc.get("since")
        if not doc.get("with_user"):  # (together, it is on them)
            doc["money"] = max(0, doc["money"] - int(act["cost"]))


def _day_summary(doc: dict[str, Any], day: str, t: datetime, tz: Any) -> dict[str, Any]:
    """The day that just ended, for her journal."""
    hours: dict[str, float] = {}
    for e in doc["timeline"]:
        a, b = A._t(e.get("from")), A._t(e.get("to"))
        if a is None or b is None:
            continue
        if _her_day(b, tz) == day or _her_day(a, tz) == day:
            hours[e["activity"]] = hours.get(e["activity"], 0.0) + (b - a).total_seconds() / 3600
    was = doc.get("day_stats") or {}
    grown = {s: round(doc["stats"][s] - float(was.get(s, doc["stats"][s])), 1) for s in STATS}
    money = doc["money"] - int(doc["day_money"]) if doc.get("day_money") is not None else 0
    return {"day": day, "hours": {k: round(v, 1) for k, v in sorted(hours.items(), key=lambda kv: -kv[1])[:6]}, "grown": {s: v for s, v in grown.items() if v >= 0.1},
            "money": money, "events": [e["id"] for e in doc["recent"] if e.get("day") == day]}


def _new_day(doc: dict[str, Any], profile: dict[str, Any], t: datetime, tz: Any) -> None:
    day = _her_day(t, tz)
    if doc.get("day") == day:
        return
    if doc.get("day"):
        doc["days"] = [*doc["days"], _day_summary(doc, doc["day"], t, tz)][-DAYS_KEPT:]
    doc["money"] = max(0, doc["money"] - int(profile.get("daily_cost") or 0))
    doc.update(day=day, day_stats=dict(doc["stats"]), day_money=doc["money"])


def _event_fits(doc: dict[str, Any], event: dict[str, Any], local: datetime, stage: str, t: datetime, tz: Any) -> bool:
    when = event.get("when") or {}
    if when.get("place") and when["place"] != doc.get("place"):
        return False
    if when.get("activity") and when["activity"] != doc.get("activity"):
        return False
    if not _day_matches(when.get("days"), local) or not _in_window(when.get("hours"), local.hour * 60 + local.minute):
        return False
    if when.get("weather") and when["weather"] != weather(doc, local):
        return False
    if when.get("stage") and stage not in when["stage"]:
        return False
    for key, values in (("stats", doc["stats"]), ("needs", doc["needs"]), ("money", {"money": doc["money"]})):
        for name, (low, high) in (when.get(key) or {}).items():
            if not low <= values.get(name, 0.0) <= high:
                return False
    if not set(when.get("flags") or []) <= set(doc["flags"]) or set(when.get("not_flags") or []) & set(doc["flags"]):
        return False
    born = A._t(doc.get("born"))
    if when.get("after_days") and born is not None and t - born < timedelta(days=int(when["after_days"])):
        return False
    return True


def _fire(doc: dict[str, Any], event: dict[str, Any], t: datetime, tz: Any, out: list[dict[str, Any]]) -> None:
    effects = event.get("effects") or {}
    for need, delta in (effects.get("needs") or {}).items():
        doc["needs"][need] = _clamp(doc["needs"][need] + float(delta), need)
    for stat, gain in (effects.get("stats") or {}).items():
        doc["stats"][stat] = min(100.0, doc["stats"][stat] + float(gain))
    doc["money"] = max(0, doc["money"] + int(effects.get("money") or 0))
    doc["flags"] = list(dict.fromkeys([*doc["flags"], *(effects.get("flags") or [])]))
    doc["fired"][event["id"]] = A._iso(t)
    doc["last_event"] = A._iso(t)
    doc["recent"] = [*doc["recent"], {"id": event["id"], "at": A._iso(t), "day": _her_day(t, tz)}][-RECENT_KEPT:]
    note(doc, event["says"], t)
    out.append({"type": "event", "id": event["id"], "title": dict(event.get("titles") or {}), "share": bool(event.get("share")),
                "says": event["says"], "feel": dict(effects.get("feel") or {})})


def _events(doc: dict[str, Any], profile: dict[str, Any], t: datetime, tz: Any, stage: str, out: list[dict[str, Any]]) -> None:
    """At most one thing happens to her at a time: each has its chance per hour, while it can happen."""
    last = A._t(doc.get("last_event"))
    if last is not None and t - last < EVENT_GAP:
        return
    local = t.astimezone(tz)
    for event in profile.get("events") or []:
        fired = A._t(doc["fired"].get(event["id"]))
        if fired is not None and (event.get("once") or t - fired < timedelta(days=int(event.get("repeat_days") or 7))):
            continue
        if not _event_fits(doc, event, local, stage, t, tz):
            continue
        if _rng(doc, "event", event["id"], local.strftime("%Y-%m-%d-%H-%M")).random() < float(event.get("chance") or 0) * STEP.total_seconds() / 3600:
            _fire(doc, event, t, tz, out)
            return


def _switch(doc: dict[str, Any], profile: dict[str, Any], t: datetime, tz: Any, out: list[dict[str, Any]]) -> None:
    """Whether what she is doing goes on, this step."""
    until = A._t(doc.get("until"))
    if doc.get("activity") == "commute":
        if until is not None and t < until:
            return
        going = doc.get("going") or {}
        key = going.get("activity")
        _close(doc, t)
        if key not in profile["activities"]:
            doc["activity"], doc["going"] = None, None
            _next(doc, profile, t, tz, out)
            return
        doc["activity"] = None
        _settle(doc, profile, key, A._t(going.get("until")), A._t(going.get("room")), t, out)
        return
    plan = doc.get("plan")
    if plan:
        if t < (A._t(plan.get("until")) or t):
            return
        heard_at = A._t(doc.get("heard_at"))
        if doc.get("with_user") and heard_at is not None and t - heard_at < STILL_TALKING:
            plan["until"] = doc["until"] = A._iso(t + STAY_ON)  # (they are still talking: she doesn't get up and go)
            return
        doc["plan"], doc["with_user"] = None, None
        _next(doc, profile, t, tz, out)
        return
    due = _due(doc, profile, t, tz)
    if due and due["activity"] == doc.get("activity"):
        doc["until"] = A._iso(due["end"])  # (still at it, however it began)
        return
    if due or until is None or t >= until:
        _next(doc, profile, t, tz, out)
        return
    current = profile["activities"].get(doc.get("activity") or "") or {}
    since = A._t(doc.get("since")) or t
    if current.get("free") and current.get("body") != "sleep" and t - since >= URGENT_AFTER:
        if (doc["needs"]["hunger"] >= URGENT and not current.get("eat")) or doc["needs"]["sleep"] >= URGENT:
            _next(doc, profile, t, tz, out)


def advance(doc: dict[str, Any], profile: dict[str, Any], now: datetime, tz: Any, *, closeness: float = 0.33, stage: str = "new") -> list[dict[str, Any]]:
    """Plays the time since it last ran. -> what happened, oldest first: {type: moved | started | event, …}."""
    t = A._t(doc.get("at")) or now
    if now - t > MAX_GAP:
        t = now - MAX_GAP
    out: list[dict[str, Any]] = []
    while t < now:
        dt = min(STEP, now - t)
        _apply(doc, profile, dt, t, closeness)
        t += dt
        _new_day(doc, profile, t, tz)
        _switch(doc, profile, t, tz, out)
        _events(doc, profile, t, tz, stage, out)
    doc["at"] = A._iso(now)
    return out


# ---- what she decides herself ----

def decide(doc: dict[str, Any], profile: dict[str, Any], key: Any, now: datetime, tz: Any, *, with_user: bool = False, minutes: Any = None,
           why: str = "") -> dict[str, Any]:
    """She goes and does this, because she decided to (do_activity: the model proposes, this holds what isn't up to her: that it
    exists, that it is open, that she can pay). -> {code: ok | already | unknown | closed | money, …}."""
    acts = profile["activities"]
    act = acts.get(key) if isinstance(key, str) else None
    if act is None or key == "commute":
        return {"code": "unknown"}
    place = profile["places"][act["place"]]
    trip = travel_minutes(profile, doc["place"], act["place"])
    if with_user and trip >= WALK_MINUTES:
        trip = max(1, round(trip / TOGETHER_FASTER))
    arrive = now + timedelta(minutes=trip)
    if not place_open(place, arrive.astimezone(tz)):
        return {"code": "closed", "hours": place.get("open"), "place": act["place"]}
    if not with_user and doc["money"] < int(act.get("cost") or 0):
        return {"code": "money", "cost": int(act["cost"])}
    low, high = act.get("minutes") or [45, 75]
    try:
        length = max(PLAN_MINUTES[0], min(PLAN_MINUTES[1], int(minutes)))
    except (TypeError, ValueError):
        length = (int(low) + int(high)) // 2
    until = arrive + timedelta(minutes=length)
    doc["with_user"] = A._iso(now) if with_user else None
    doc["plan"] = {"activity": key, "until": A._iso(until), "why": " ".join(str(why or "").split())[:120], "at": A._iso(now)}
    if doc.get("activity") == key:
        doc["until"] = A._iso(until)
        return {"code": "already", "activity": key, "place": act["place"]}
    out: list[dict[str, Any]] = []
    _begin(doc, profile, key, until, None, now, out)
    return {"code": "ok", "activity": key, "place": act["place"], "minutes": trip, "happened": out}


# ---- what comes from outside ----

def heard(doc: dict[str, Any], profile: dict[str, Any], message: str, now: datetime, *, warm: bool = False, rude: bool = False) -> bool:
    """A message of theirs reached her, once however often it is looked at: being talked to is part of what she wanted, and it wakes
    her if she sleeps. -> whether it just woke her."""
    if doc.get("heard") == message:
        return False
    doc["heard"], doc["heard_at"] = message, A._iso(now)
    _earn(doc, now)
    if not rude:
        doc["needs"]["affection"] = _clamp(doc["needs"]["affection"] - (HEARD_WARM if warm else HEARD_AFFECTION), "affection")
        doc["needs"]["fun"] = _clamp(doc["needs"]["fun"] - HEARD_FUN, "fun")
    else:
        doc["needs"]["stress"] = _clamp(doc["needs"]["stress"] + HEARD_RUDE_STRESS, "stress")
    if (profile["activities"].get(doc.get("activity") or "") or {}).get("body") != "sleep":
        return False
    woken = A._t(doc.get("woken"))
    doc["woken"] = A._iso(now + WOKEN_FOR)
    return woken is None or now >= woken


def _earn(doc: dict[str, Any], now: datetime) -> None:
    """Talking to her is what these come from, a little a day."""
    day = now.strftime("%Y-%m-%d")
    if doc.get("coins_day") != day:
        doc["coins_day"], doc["coins_today"] = day, 0
        doc["coins"] = int(doc.get("coins") or 0) + COINS_FIRST_MESSAGE
    if int(doc.get("coins_today") or 0) < COINS_A_DAY:
        doc["coins_today"] = int(doc.get("coins_today") or 0) + COINS_MESSAGE
        doc["coins"] = int(doc.get("coins") or 0) + COINS_MESSAGE


def give(doc: dict[str, Any], profile: dict[str, Any], item_id: Any) -> dict[str, Any]:
    """They send her something. -> {code: ok | unknown | coins, item}. What it does happens now; how she takes it is hers."""
    item = next((x for x in profile.get("shop") or [] if x.get("id") == item_id), None)
    if item is None:
        return {"code": "unknown"}
    price = int(item.get("price") or 0)
    if int(doc.get("coins") or 0) < price:
        return {"code": "coins", "item": item}
    doc["coins"] = int(doc.get("coins") or 0) - price
    for need, delta in (item.get("needs") or {}).items():
        doc["needs"][need] = _clamp(doc["needs"][need] + float(delta), need)
    for stat, gain in (item.get("stats") or {}).items():
        doc["stats"][stat] = min(100.0, doc["stats"][stat] + float(gain))
    if item.get("keep"):
        doc["kept"] = [*doc["kept"], item["id"]][-KEPT_MAX:]
    return {"code": "ok", "item": item}


def note(doc: dict[str, Any], text: str, at: datetime) -> None:
    """Something for her to hear with their next message, however much later that is."""
    doc["notes"] = [*doc.get("notes", []), {"text": text, "at": A._iso(at)}][-NOTES_MAX:]


def take_notes(doc: dict[str, Any], now: datetime) -> list[str]:
    out = []
    for n in doc.get("notes") or []:
        at = A._t(n.get("at")) if isinstance(n, dict) else None
        text = n.get("text") if isinstance(n, dict) else str(n)
        hours = (now - at).total_seconds() / 3600 if at is not None else 0
        when = "" if hours < 8 else "(Yesterday or so) " if hours < 36 else f"(About {max(2, round(hours / 24))} days ago) "
        out.append(when + str(text))
    doc["notes"] = []
    return out


def catalog(profile: dict[str, Any]) -> str:
    """What she can decide to do, for her system prompt."""
    lines = []
    for key, act in profile["activities"].items():
        if not act.get("free"):
            continue
        place = profile["places"][act["place"]]
        hours = f", open {place['open'][0]}–{place['open'][1]}" if place.get("open") else ""
        lines.append(f"- {key}: {act.get('doing') or key} (at {place.get('about') or act['place']}{hours})")
    return "\n".join(lines)


# ---- what can be seen of it ----

def slot(local: datetime) -> str:
    return next((name for name, a, b in SLOTS if a <= local.hour < b), "night")


def word(v: float) -> str:
    return next((w for floor, w in WORDS if v >= floor), "")


def asleep(doc: dict[str, Any], profile: dict[str, Any], now: datetime) -> bool:
    if (profile["activities"].get(doc.get("activity") or "") or {}).get("body") != "sleep":
        return False
    woken = A._t(doc.get("woken"))
    return woken is None or now >= woken


def for_state(doc: dict[str, Any], profile: dict[str, Any], now: datetime) -> dict[str, Any]:
    """What state.py reads of it: her needs and what she is doing does to how she feels."""
    act = profile["activities"].get(doc.get("activity") or "") or {}
    return {"needs": dict(doc["needs"]), "feel": dict(act.get("feel") or {}), "doing": act.get("doing") or "", "asleep": asleep(doc, profile, now)}


def body(doc: dict[str, Any]) -> list[list[str]]:
    """The needs that stand out, strongest first: [[need, word], …]."""
    order = sorted(NEEDS, key=lambda n: -doc["needs"][n])
    return [[n, word(doc["needs"][n])] for n in order if word(doc["needs"][n])]


def signature(doc: dict[str, Any]) -> list[Any]:
    """Without the fine print: when this changes she is told again, and every window hears."""
    return [doc.get("place"), doc.get("activity"), body(doc), bool(doc.get("with_user"))]


def art(profile: dict[str, Any], place: str | None, when: str) -> str:
    """The picture of a place at this time of day."""
    return f"{profile['art']}/{place}-{when}.webp" if profile.get("art") and place else ""


def line(doc: dict[str, Any], profile: dict[str, Any], now: datetime, tz: Any, *, woke: bool = False) -> str:
    """Her day, as she is told it in her <context>."""
    act = profile["activities"].get(doc.get("activity") or "") or {}
    place = profile["places"].get(doc.get("place") or "") or {}
    going = (doc.get("going") or {}).get("activity")
    if doc.get("activity") == "commute" and going in profile["activities"]:
        target = profile["places"][profile["activities"][going]["place"]]
        where = f"on your way to {target.get('about') or going}"
    else:
        since = A._t(doc.get("since")) or now
        minutes = int((now - since).total_seconds() // 60)
        doing = "in bed, up for now because of their messages" if act.get("body") == "sleep" and not asleep(doc, profile, now) else act.get("doing") or "taking it easy"
        where = f"at {place.get('about') or doc.get('place')}, {doing}"
        if minutes >= 10:
            where += f" (for {f'about {round(minutes / 60)} hours' if minutes >= 90 else f'{minutes} minutes'} now)"
    parts = [f"Your day: you are {where}."]
    if doc.get("with_user"):
        parts.append("They are here with you in person: this is not by phone, you can see each other.")
    if woke:
        parts.append("Their message just woke you up: you are groggy, you were asleep a moment ago.")
    elif asleep(doc, profile, now):
        parts.append("You were asleep until their message.")
    elif act.get("reply") and not doc.get("with_user"):
        parts.append(act["reply"])
    local = now.astimezone(tz)
    sky = weather(doc, local)
    if sky != "clear":
        parts.append({"cloudy": "It is cloudy today.", "rain": "It is raining today.", "snow": "It is snowing today."}[sky])
    coming = _upcoming(doc, profile, now, tz, other_than=doc.get("activity"))
    if coming:
        if coming["start"] - local <= timedelta(hours=4):
            what = profile["activities"][coming["activity"]]
            parts.append(f"Coming up at {coming['start'].strftime('%H:%M')}: {what.get('doing') or coming['activity']}.")
    planned = doc["week"].get(plan_slot(local) or "")
    if planned and planned != doc.get("activity") and planned in profile["activities"]:
        parts.append(f"They suggested you spend this time {profile['activities'][planned].get('doing') or planned}: it is a suggestion, up to you.")
    feelings = [f"{w} {BODY_WORDS[n]}" for n, w in body(doc)]
    if feelings:
        parts.append("Your body: " + ", ".join(feelings) + ".")
    names = [(next((x for x in profile.get("shop") or [] if x.get("id") == i), None) or {}).get("note") for i in doc.get("kept") or []]
    if any(names):
        parts.append("You have, from them: " + ", ".join(dict.fromkeys(n for n in names if n)) + ".")
    return " ".join(parts)


def _names(profile: dict[str, Any], kind: str, key: str | None) -> dict[str, str]:
    return dict((profile[kind].get(key or "") or {}).get("names") or {})


def summary(doc: dict[str, Any], profile: dict[str, Any], now: datetime, tz: Any) -> dict[str, Any]:
    """What the mate document carries: enough for her stage and the status chips."""
    act = profile["activities"].get(doc.get("activity") or "") or {}
    local = now.astimezone(tz)
    return {"enabled": True, "art": art(profile, doc["place"], slot(local)), "weather": weather(doc, local),
            "outdoor": bool((profile["places"].get(doc["place"]) or {}).get("outdoor")), "place": doc["place"], "place_name": _names(profile, "places", doc["place"]), "activity": doc.get("activity"),
            "activity_name": _names(profile, "activities", doc.get("activity")), "body": act.get("body") or "", "since": doc.get("since"),
            "until": doc.get("until"), "slot": slot(local), "asleep": asleep(doc, profile, now), "with_user": bool(doc.get("with_user")),
            "needs": {n: round(doc["needs"][n], 3) for n in NEEDS}}


def view(doc: dict[str, Any], profile: dict[str, Any], now: datetime, tz: Any) -> dict[str, Any]:
    """The whole of it, for the Life panel."""
    local = now.astimezone(tz)
    start = _midnight(local)
    coming = _upcoming(doc, profile, now, tz, other_than=doc.get("activity"))
    events = {e["id"]: e for e in profile.get("events") or []}
    return {**summary(doc, profile, now, tz), "plan": {"slots": plan_slots(), "week": dict(doc["week"]), "now": plan_slot(local),
                                                      "choices": [{"id": k, "name": _names(profile, "activities", k)} for k, a in profile["activities"].items() if a.get("plannable")]},
            "journal": [{**d, "names": {k: _names(profile, "activities", k) for k in d.get("hours") or {}},
                         "titles": [dict(events.get(e, {}).get("titles") or {}) for e in d.get("events") or []]} for d in reversed(doc["days"][-30:])],
            "happened": [{"at": e["at"], "title": dict(events.get(e["id"], {}).get("titles") or {})} for e in reversed(doc["recent"])],
            "stats": {s: round(doc["stats"][s], 1) for s in STATS}, "money": doc["money"],
            "going": (doc.get("going") or {}).get("activity"),
            "next": {"activity": coming["activity"], "at": A._iso(coming["start"]), "name": _names(profile, "activities", coming["activity"])} if coming else None,
            "map": profile.get("map") or "", "coins": int(doc.get("coins") or 0),
            "shop": [{"id": x["id"], "name": dict(x.get("names") or {}), "about": dict(x.get("abouts") or {}), "price": int(x.get("price") or 0), "kind": x.get("kind") or "",
                      "keep": bool(x.get("keep")), "have": x["id"] in (doc.get("kept") or [])} for x in profile.get("shop") or []],
            "places": [{"key": k, "name": dict(p.get("names") or {}), "open": place_open(p, local), "hours": p.get("open"), "here": k == doc["place"],
                        "minutes": travel_minutes(profile, doc["place"], k), "art": art(profile, k, slot(local)), "x": p.get("x"), "y": p.get("y")}
                       for k, p in profile["places"].items()],
            "today": [{**e, "name": _names(profile, "activities", e.get("activity")), "place_name": _names(profile, "places", e.get("place"))}
                      for e in doc["timeline"] if (A._t(e.get("to")) or now).astimezone(tz) >= start]}
