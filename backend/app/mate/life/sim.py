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


# ---- the document ----

def new(profile: dict[str, Any], now: datetime, tz: Any, seed: str) -> dict[str, Any]:
    start = profile.get("start") or {}
    doc = {"seed": seed, "at": A._iso(now), "needs": dict(START_NEEDS), "stats": {s: float((start.get("stats") or {}).get(s) or 0) for s in STATS},
           "money": int(start.get("money") or 0), "place": start.get("place") or next(iter(profile["places"])), "activity": None,
           "since": A._iso(now), "until": None, "going": None, "paid": None, "timeline": [], "day": now.astimezone(tz).strftime("%Y-%m-%d"),
           "woken": None, "heard": None}
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
    if doc.get("place") not in profile["places"]:
        doc["place"] = (profile.get("start") or {}).get("place") or next(iter(profile["places"]))
    if doc.get("activity") not in profile["activities"]:
        doc["activity"], doc["until"], doc["going"] = None, None, None
    return doc


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


def _upcoming(doc: dict[str, Any], profile: dict[str, Any], t: datetime, tz: Any) -> dict[str, Any] | None:
    """The next obligation that hasn't started, today or tomorrow."""
    local = t.astimezone(tz)
    ahead = [b for b in _blocks(doc, profile, local) + _blocks(doc, profile, local + timedelta(days=1)) if b["start"] > local]
    return min(ahead, key=lambda b: b["start"]) if ahead else None


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
    noise = _rng(doc, "pick", local.strftime("%Y-%m-%d-%H"), key).uniform(-0.3, 0.3)
    again = min(1.2, _hours_today(doc, key, local, tz) * 0.3) + (1.0 if key == doc.get("activity") and act.get("cost") else 0.0)
    out = float((profile.get("outing") or {}).get("bonus") or 0) if act["place"] != (profile.get("start") or {}).get("place") and _feels_like_going_out(doc, profile, local, tz) else 0.0
    return float(act.get("likes") or 0) + relief + noise + out - trip * 0.7 - shy - dear - again


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
        doc["needs"][need] = _clamp(doc["needs"][need] + rate * hours, need)
    calm = 1 - 0.5 * doc["needs"]["stress"]  # (she learns less when frazzled, and a skill comes slower the higher it is)
    for stat, gain in (act.get("stats") or {}).items():
        doc["stats"][stat] = min(100.0, doc["stats"][stat] + float(gain) * hours * calm * (1.25 - doc["stats"][stat] / 100))
    doc["money"] += int(round(float(act.get("pay") or 0) * hours))
    if act.get("cost") and doc.get("paid") != doc.get("since"):
        doc["paid"] = doc.get("since")
        doc["money"] = max(0, doc["money"] - int(act["cost"]))


def _new_day(doc: dict[str, Any], profile: dict[str, Any], t: datetime, tz: Any) -> None:
    day = t.astimezone(tz).strftime("%Y-%m-%d")
    if doc.get("day") != day:
        doc["money"] = max(0, doc["money"] - int(profile.get("daily_cost") or 0))
        doc["day"] = day


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


def advance(doc: dict[str, Any], profile: dict[str, Any], now: datetime, tz: Any, *, closeness: float = 0.33) -> list[dict[str, Any]]:
    """Plays the time since it last ran. -> what happened, oldest first: {type: moved | started, …}."""
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
    doc["at"] = A._iso(now)
    return out


# ---- what comes from outside ----

def heard(doc: dict[str, Any], profile: dict[str, Any], message: str, now: datetime, *, warm: bool = False, rude: bool = False) -> bool:
    """A message of theirs reached her, once however often it is looked at: being talked to is part of what she wanted, and it wakes
    her if she sleeps. -> whether it just woke her."""
    if doc.get("heard") == message:
        return False
    doc["heard"] = message
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
    return [doc.get("place"), doc.get("activity"), body(doc)]


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
    if woke:
        parts.append("Their message just woke you up: you are groggy, you were asleep a moment ago.")
    elif asleep(doc, profile, now):
        parts.append("You were asleep until their message.")
    elif act.get("reply"):
        parts.append(act["reply"])
    coming = _upcoming(doc, profile, now, tz)
    if coming and coming["activity"] != doc.get("activity"):
        local = now.astimezone(tz)
        if coming["start"] - local <= timedelta(hours=4):
            what = profile["activities"][coming["activity"]]
            parts.append(f"Coming up at {coming['start'].strftime('%H:%M')}: {what.get('doing') or coming['activity']}.")
    feelings = [f"{w} {BODY_WORDS[n]}" for n, w in body(doc)]
    if feelings:
        parts.append("Your body: " + ", ".join(feelings) + ".")
    return " ".join(parts)


def _names(profile: dict[str, Any], kind: str, key: str | None) -> dict[str, str]:
    return dict((profile[kind].get(key or "") or {}).get("names") or {})


def summary(doc: dict[str, Any], profile: dict[str, Any], now: datetime, tz: Any) -> dict[str, Any]:
    """What the mate document carries: enough for her stage and the status chips."""
    act = profile["activities"].get(doc.get("activity") or "") or {}
    return {"enabled": True, "place": doc["place"], "place_name": _names(profile, "places", doc["place"]), "activity": doc.get("activity"),
            "activity_name": _names(profile, "activities", doc.get("activity")), "body": act.get("body") or "", "since": doc.get("since"),
            "until": doc.get("until"), "slot": slot(now.astimezone(tz)), "asleep": asleep(doc, profile, now),
            "needs": {n: round(doc["needs"][n], 3) for n in NEEDS}}


def view(doc: dict[str, Any], profile: dict[str, Any], now: datetime, tz: Any) -> dict[str, Any]:
    """The whole of it, for the Life panel."""
    local = now.astimezone(tz)
    start = _midnight(local)
    coming = _upcoming(doc, profile, now, tz)
    return {**summary(doc, profile, now, tz), "stats": {s: round(doc["stats"][s], 1) for s in STATS}, "money": doc["money"],
            "going": (doc.get("going") or {}).get("activity"),
            "next": {"activity": coming["activity"], "at": A._iso(coming["start"]), "name": _names(profile, "activities", coming["activity"])} if coming else None,
            "places": [{"key": k, "name": dict(p.get("names") or {}), "open": place_open(p, local), "hours": p.get("open"), "here": k == doc["place"],
                        "minutes": travel_minutes(profile, doc["place"], k)} for k, p in profile["places"].items()],
            "today": [{**e, "name": _names(profile, "activities", e.get("activity")), "place_name": _names(profile, "places", e.get("place"))}
                      for e in doc["timeline"] if (A._t(e.get("to")) or now).astimezone(tz) >= start]}
