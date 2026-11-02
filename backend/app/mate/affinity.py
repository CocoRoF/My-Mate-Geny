"""How close the user and a mate are, and how the mate feels right now
(docs/mate-memory-affinity.md §5) — modelled on memora's relationship engine.

Two numbers, as in memora:

* **earned** — days talked, turns, memories: cumulative, never goes down;
* **affinity** (0–100) — the warmth *now*: rises when you talk, cools when
  you stay away (after a few free days, faster each day, never below a floor).

The stage is the lower of the two (new → familiar → trusted → companion), so
neglect shows but the way back is short. Gains are credited the moment they
happen; losses only for **finished** days, settled in time order — the same
functions for real time and for a recompute from history (memora plan/61:
two rule sets drift; a timer that settles a day before its talk was counted
only ever lowers it). Every change is logged with its reason.

The mood (valence, energy → a label) drifts toward a stage baseline, follows
the time of day and how exchanges go. Nothing here is ever said as a number
to the model: the prompt gets a stage and a mood word (app/mate/prompt.py).

Pure functions over one JSON document (``new()``); no I/O.
"""

from __future__ import annotations

import copy
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

STAGES = ("new", "familiar", "trusted", "companion")
# earned: (active days, user turns, memories) a stage needs
EARNED = {"familiar": (3, 15, 0), "trusted": (10, 60, 10), "companion": (30, 200, 25)}
# warmth bands: the floor of each stage (index = STAGES index)
BAND_FLOORS = (0.0, 20.0, 45.0, 70.0)
HYST_UP, HYST_DOWN = 2.0, 3.0      # a band is entered 2 above its floor, left 3 below it

TALK = 6.0                          # the day's first user turn
LIVELY_TURNS, LIVELY = 12, 3.0      # the day's 12th user turn, once a day
STREAK, STREAK_WEEK = 1.0, 2.0      # a talk day after a talk day; +2 more each 7th day in a row
WARM, WARM_CAP = 0.5, 2.0           # a warm exchange; per day
MEMORY, MEMORY_CAP = 1.0, 3.0       # a new memory; per day
RUDE, RUDE_CAP = 1.0, 3.0           # rudeness aimed at the mate (never sadness or venting); per day
GAIN_CAP = 12.0                     # all gains of one day
GRACE_DAYS = 3                      # quiet days that cost nothing
DECAY_BASE, DECAY_GROWTH, DECAY_CAP = 4.0, 1.4, 15.0
FLOOR = 10.0                        # quiet days never take it below this
CATCHUP_DAYS = 90
LOG_MAX = 200
SENSITIVITY = (0.5, 1.5)
ANNIVERSARIES = (7, 30, 100, 365)

MOODS = ("cheerful", "content", "calm", "focused", "sleepy", "concerned")
BASELINE = {"new": 0.10, "familiar": 0.15, "trusted": 0.20, "companion": 0.25}
MOOD_HALF_LIFE_H = 4.0
# energy over the day (local hour 0–23)
CIRCADIAN = (0.40, 0.33, 0.28, 0.25, 0.25, 0.30, 0.40, 0.55, 0.70, 0.80, 0.90, 0.90,
             0.90, 0.90, 0.90, 0.90, 0.90, 0.88, 0.85, 0.80, 0.75, 0.65, 0.55, 0.45)

_POS = re.compile(r"고마워|고맙|감사|최고|사랑해|귀여|잘했|덕분|좋아요|좋아!|좋다|멋져|ㅋㅋ|ㅎㅎ|\bthanks?\b|thank you|great|awesome|"
                  r"love (it|you|this)|\bnice\b|\bcool\b|perfect|haha|\blol\b|well done|amazing", re.I)
_RUDE = re.compile(r"닥쳐|꺼져|멍청|병신|시발|씨발|ㅅㅂ|쓸모없|바보 ?같|shut up|stupid|useless|idiot|\bdumb\b|hate you|"
                   r"you suck|moron", re.I)
_DISTRESS = re.compile(r"힘들|우울|슬퍼|슬프|외로|죽고 ?싶|지쳤|지친다|불안|무서워|\bstressed\b|depress|\bsad\b|lonely|"
                       r"anxious|exhausted|overwhelmed|can'?t cope", re.I)
_REPLY_POS = re.compile(r"\[\s*(joy|laugh|smile|shy)\b", re.I)


# ---- the document ----

def new() -> dict[str, Any]:
    return {
        "enabled": True, "paused": False, "sensitivity": 1.0, "show_indicator": True, "avatar_mood": False,
        "affinity": 0.0, "started_at": None, "turns": 0, "active_days": 0, "last_active_day": None,
        "streak_days": 0, "memories": 0, "settled_day": None, "today": {}, "talk_days": [], "warm": 0,
        "stage": "new", "stage_changed_at": None, "milestones": [], "log": [],
        "mood": {"valence": None, "at": None, "concern_until": None, "turns": []},
        "quiet_from": None,
        "tz": None,  # the zone its days were counted in (store.tz_and_key); another → computed again from history
        "marks": [],  # what the user did by hand ({at, kind: set | reset, v}): a recompute in another zone keeps them
    }


def normalized(doc: Any) -> dict[str, Any]:
    out = new()
    if isinstance(doc, dict):
        out.update({k: v for k, v in doc.items() if k in out})
        if isinstance(doc.get("mood"), dict):
            out["mood"] = {**new()["mood"], **doc["mood"]}
    out["sensitivity"] = max(SENSITIVITY[0], min(SENSITIVITY[1], float(out.get("sensitivity") or 1.0)))
    out["affinity"] = max(0.0, min(100.0, float(out.get("affinity") or 0.0)))
    return out


def _d(v: Any) -> date | None:
    return date.fromisoformat(v) if isinstance(v, str) and v else None


def _t(v: Any) -> datetime | None:
    if not isinstance(v, str) or not v:
        return None
    t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat(timespec="seconds")


# ---- stages ----

def earned_stage(r: dict[str, Any]) -> str:
    stage = "new"
    for s in ("familiar", "trusted", "companion"):
        d, t, m = EARNED[s]
        if r["active_days"] >= d and r["turns"] >= t and r["memories"] >= m:
            stage = s
        else:
            break
    return stage


def _raw_band(a: float) -> int:
    return max(i for i, f in enumerate(BAND_FLOORS) if a >= f)


def warmth_index(a: float, prev: int) -> int:
    """The warmth band with hysteresis: up only 2 points past a floor, down only 3 below it."""
    up = max(i for i, f in enumerate(BAND_FLOORS) if i == 0 or a >= f + HYST_UP)
    if up > prev:
        return up
    down = prev
    while down > 0 and a < BAND_FLOORS[down] - HYST_DOWN:
        down -= 1
    return down


def days_together(r: dict[str, Any], today: date, tz: Any = timezone.utc) -> int:
    start = _t(r.get("started_at"))
    return 0 if start is None else max(1, (today - start.astimezone(tz).date()).days + 1)


def _milestone(r: dict[str, Any], key: str, at: datetime) -> None:
    if not any(m.get("key") == key for m in r["milestones"]):
        r["milestones"] = [*r["milestones"], {"key": key, "at": _iso(at)}][-60:]


def refresh(r: dict[str, Any], at: datetime, tz: Any) -> None:
    """Stage (min of earned and warmth, with hysteresis) and milestones."""
    r["warm"] = warmth_index(r["affinity"], int(r.get("warm") or 0))
    stage = STAGES[min(STAGES.index(earned_stage(r)), int(r["warm"]))]
    if stage != r["stage"]:
        if STAGES.index(stage) > STAGES.index(r["stage"]):
            _milestone(r, f"stage_{stage}", at)
        r["stage"], r["stage_changed_at"] = stage, _iso(at)
    today = at.astimezone(tz).date()
    for n in ANNIVERSARIES:
        if days_together(r, today, tz) >= n:
            start = _t(r["started_at"])
            _milestone(r, f"days_{n}", start + timedelta(days=n - 1) if start else at)
    if r["memories"] >= 1:
        _milestone(r, "first_memory", at)


# ---- changes ----

def _log(r: dict[str, Any], d: float, why: str, at: datetime) -> None:
    r["log"] = [*r["log"], {"at": _iso(at), "d": round(d, 2), "why": why, "v": round(r["affinity"], 2)}][-LOG_MAX:]


def _bump(r: dict[str, Any], delta: float, why: str, at: datetime, *, floor: float = 0.0) -> float:
    before = r["affinity"]
    after = max(0.0, min(100.0, before + delta))
    if delta < 0 and floor:
        after = max(min(before, floor), after)  # (never pushed below the floor; already below: stays)
    after = round(after, 2)
    r["affinity"] = after
    if after != before:
        _log(r, after - before, why, at)
    return after - before


def _today(r: dict[str, Any], day: date) -> dict[str, Any]:
    if r["today"].get("day") != day.isoformat():
        r["today"] = {"day": day.isoformat(), "turns": 0, "talked": False, "lively": False, "warm": 0.0,
                      "memory": 0.0, "rude": 0.0, "gained": 0.0}
    return r["today"]


def _gain(r: dict[str, Any], day: dict[str, Any], amount: float, why: str, at: datetime,
          cap_key: str | None = None, cap: float | None = None) -> None:
    pts = amount * r["sensitivity"]
    if cap_key:
        pts = min(pts, max(0.0, cap - float(day.get(cap_key) or 0.0)))
    pts = min(pts, max(0.0, GAIN_CAP - float(day.get("gained") or 0.0)))
    if pts <= 0:
        return
    got = _bump(r, pts, why, at)
    if cap_key:
        day[cap_key] = float(day.get(cap_key) or 0.0) + got
    day["gained"] = float(day.get("gained") or 0.0) + got


def decay_for(silence_days: int) -> float:
    """What a finished quiet day costs after ``silence_days`` days without talking (before sensitivity)."""
    if silence_days <= GRACE_DAYS:
        return 0.0
    return round(min(DECAY_CAP, DECAY_BASE * DECAY_GROWTH ** (silence_days - GRACE_DAYS - 1)), 2)


def _last_talk(r: dict[str, Any], d: date) -> date | None:
    """The last talk day up to ``d`` — or the day a pause ended / tracking came back on, if later (the quiet
    before it never counts)."""
    days = [x for x in (_d(v) for v in r["talk_days"]) if x and x <= d]
    last = max(days) if days else None
    if last is None:
        la = _d(r.get("last_active_day"))
        last = la if la and la <= d else None
    if last is None:
        start = _t(r.get("started_at"))
        last = start.date() if start else None
    q = _d(r.get("quiet_from"))
    if q and q <= d and (last is None or q > last):
        last = q
    return last


def _settle_day(r: dict[str, Any], d: date, tz: Any) -> None:
    if r["paused"] or not r["started_at"] or d.isoformat() in r["talk_days"]:
        return
    last = _last_talk(r, d)
    if last is None:
        return
    loss = decay_for((d - last).days) * r["sensitivity"]
    if loss > 0:
        end = datetime.combine(d + timedelta(days=1), time.min, tzinfo=tz)
        _bump(r, -loss, f"quiet_{(d - last).days}", end, floor=FLOOR)


def advance(r: dict[str, Any], now: datetime, tz: Any) -> None:
    """Settle every finished day since the last time, in order (≤ 90 days back)."""
    today = now.astimezone(tz).date()
    settled = _d(r.get("settled_day"))
    if settled is None:
        start = _t(r.get("started_at"))
        settled = (start.astimezone(tz).date() if start else today) - timedelta(days=1)
    d = max(settled + timedelta(days=1), today - timedelta(days=CATCHUP_DAYS))
    while d < today:
        if r["enabled"]:
            _settle_day(r, d, tz)
        d += timedelta(days=1)
    r["settled_day"] = max(settled, today - timedelta(days=1)).isoformat()
    refresh(r, now, tz)


def cues(user_text: str, reply_text: str = "") -> dict[str, bool]:
    u = user_text or ""
    rude = bool(_RUDE.search(u))
    return {"warm": not rude and (bool(_POS.search(u)) or bool(_REPLY_POS.search(reply_text or ""))),
            "rude": rude, "distress": bool(_DISTRESS.search(u)), "pos": bool(_POS.search(u))}


def credit_turn(r: dict[str, Any], at: datetime, tz: Any, user_text: str = "", reply_text: str = "") -> None:
    """One user turn ended (call ``advance`` first). Paused or off: nothing moves."""
    if not r["enabled"] or r["paused"]:
        return
    day = at.astimezone(tz).date()
    t = _today(r, day)
    if r["started_at"] is None:
        r["started_at"] = _iso(at)
    t["turns"] += 1
    r["turns"] += 1
    last = _d(r.get("last_active_day"))
    if last != day:
        r["streak_days"] = r["streak_days"] + 1 if last == day - timedelta(days=1) else 1
        r["active_days"] += 1
        r["last_active_day"] = day.isoformat()
    if not t["talked"]:
        t["talked"] = True
        r["talk_days"] = sorted({*r["talk_days"], day.isoformat()})[-30:]
        _gain(r, t, TALK, "talk", at)
        if r["streak_days"] >= 2:
            _gain(r, t, STREAK, "streak", at)
            if r["streak_days"] % 7 == 0:
                _gain(r, t, STREAK_WEEK, "streak_week", at)
    if t["turns"] >= LIVELY_TURNS and not t["lively"]:
        t["lively"] = True
        _gain(r, t, LIVELY, "lively", at)
    c = cues(user_text, reply_text)
    if c["warm"]:
        _gain(r, t, WARM, "warm", at, "warm", WARM_CAP)
    if c["rude"] and float(t.get("rude") or 0.0) < RUDE_CAP:
        loss = min(RUDE * r["sensitivity"], RUDE_CAP - float(t.get("rude") or 0.0))
        t["rude"] = float(t.get("rude") or 0.0) + loss
        _bump(r, -loss, "rude", at)
    mood_turn(r, at, c)
    refresh(r, at, tz)


def credit_memory(r: dict[str, Any], at: datetime, tz: Any) -> None:
    """A memory was added (not a merge)."""
    if not r["enabled"] or r["paused"]:
        return
    r["memories"] += 1
    if r["started_at"] is None:
        r["started_at"] = _iso(at)
    _gain(r, _today(r, at.astimezone(tz).date()), MEMORY, "memory", at, "memory", MEMORY_CAP)
    refresh(r, at, tz)


def set_switch(r: dict[str, Any], key: str, on: bool, at: datetime, tz: Any) -> None:
    """Pause / turn off (``paused`` / ``enabled``): settle up to now under the old setting first; coming back,
    the quiet days before don't count."""
    advance(r, at, tz)
    if bool(r[key]) == bool(on):
        return
    r[key] = bool(on)
    if (key == "paused" and not on) or (key == "enabled" and on):
        r["quiet_from"] = at.astimezone(tz).date().isoformat()
    _log(r, 0.0, f"{key}_{'on' if on else 'off'}", at)


def set_value(r: dict[str, Any], value: float, at: datetime, tz: Any, why: str = "manual") -> None:
    """The user sets it (Relationship tab): logged; the band follows at once (no hysteresis)."""
    before = r["affinity"]
    r["affinity"] = round(max(0.0, min(100.0, float(value))), 2)
    r["warm"] = _raw_band(r["affinity"])
    _log(r, r["affinity"] - before, why, at)
    if why == "manual":
        _mark(r, at, "set", r["affinity"])
    refresh(r, at, tz)


def _mark(r: dict[str, Any], at: datetime, kind: str, v: float | None = None) -> None:
    r["marks"] = [*(r.get("marks") or []), {"at": _iso(at), "kind": kind, **({} if v is None else {"v": v})}][-50:]


def reset(r: dict[str, Any], at: datetime, tz: Any) -> dict[str, Any]:
    """A fresh start: counters, affinity, mood, milestones gone; the user's settings kept."""
    out = new()
    for k in ("enabled", "paused", "sensitivity", "show_indicator", "avatar_mood", "tz", "marks"):
        out[k] = r[k]
    out["settled_day"] = (at.astimezone(tz).date() - timedelta(days=1)).isoformat()
    _log(out, 0.0, "reset", at)
    _mark(out, at, "reset")
    return out


def marks_of(r: dict[str, Any]) -> list[dict[str, Any]]:
    """The user's own changes, for a recompute: kept ones, else (a document from before marks) read from its log."""
    if r.get("marks"):
        return list(r["marks"])
    out = []
    for e in r.get("log") or []:
        if e.get("why") == "manual" and e.get("at"):
            out.append({"at": e["at"], "kind": "set", "v": e.get("v")})
        elif e.get("why") == "reset" and e.get("at"):
            out.append({"at": e["at"], "kind": "reset"})
    return out


# ---- mood ----

def _valence_now(r: dict[str, Any], now: datetime) -> float:
    base = BASELINE.get(r["stage"], 0.1)
    m = r["mood"]
    at = _t(m.get("at"))
    v = m.get("valence")
    if v is None or at is None:
        return base
    hours = max(0.0, (now - at).total_seconds() / 3600)
    return base + (float(v) - base) * 0.5 ** (hours / MOOD_HALF_LIFE_H)


def mood_turn(r: dict[str, Any], at: datetime, c: dict[str, bool]) -> None:
    m = r["mood"]
    v = _valence_now(r, at)
    v += max(-0.3, min(0.3, 0.15 * ((1 if c.get("warm") else 0) - (1 if c.get("rude") else 0))))
    m["valence"] = round(max(-1.0, min(1.0, v)), 3)
    m["at"] = _iso(at)
    if c.get("distress"):
        m["concern_until"] = _iso(at + timedelta(hours=2))
    cutoff = at - timedelta(hours=2)
    m["turns"] = [x for x in (m.get("turns") or []) if (_t(x) or at) >= cutoff][-30:] + [_iso(at)]


def mood_result(r: dict[str, Any], at: datetime, ok: bool) -> None:
    """A delegated chat finished: a little pleased, or concerned about the work (never about the user)."""
    if not r["enabled"] or r["paused"]:
        return
    m = r["mood"]
    m["valence"] = round(max(-1.0, min(1.0, _valence_now(r, at) + (0.05 if ok else -0.10))), 3)
    m["at"] = _iso(at)


def mood(r: dict[str, Any], now: datetime, tz: Any) -> dict[str, Any]:
    """The mood as of now: ``{label, valence, energy}``."""
    local = now.astimezone(tz)
    h = local.hour
    v = _valence_now(r, now)
    cutoff = now - timedelta(hours=2)
    recent = sum(1 for x in (r["mood"].get("turns") or []) if (_t(x) or cutoff) > cutoff)
    e = max(0.0, CIRCADIAN[h] - 0.02 * min(10, recent))
    concern = _t(r["mood"].get("concern_until"))
    if concern and concern > now:
        label = "concerned"
    elif (h >= 23 or h < 6) and e < 0.5:
        label = "sleepy"
    elif v <= -0.25:
        label = "concerned"
    elif v >= 0.4:
        label = "cheerful" if e >= 0.55 else "content"
    elif e >= 0.8:
        label = "focused"
    else:
        label = "calm"
    return {"label": label, "valence": round(v, 2), "energy": round(e, 2)}


# ---- views ----

def next_stage(r: dict[str, Any]) -> dict[str, Any] | None:
    i = STAGES.index(earned_stage(r))
    if i >= len(STAGES) - 1:
        return None
    nxt = STAGES[i + 1]
    d, t, m = EARNED[nxt]
    ratios = [min(1.0, r["active_days"] / d), min(1.0, r["turns"] / t), 1.0 if m == 0 else min(1.0, r["memories"] / m)]
    return {"stage": nxt, "ratio": round(min(ratios), 3),
            "needs": {"days": max(0, d - r["active_days"]), "turns": max(0, t - r["turns"]),
                      "memories": max(0, m - r["memories"])}}


def view(r: dict[str, Any], now: datetime, tz: Any) -> dict[str, Any]:
    today = now.astimezone(tz).date()
    last = _d(r.get("last_active_day"))
    return {
        "enabled": r["enabled"], "paused": r["paused"], "sensitivity": r["sensitivity"],
        "show_indicator": r["show_indicator"], "avatar_mood": r["avatar_mood"],
        "affinity": round(r["affinity"], 1), "stage": r["stage"], "earned_stage": earned_stage(r),
        "warmth_stage": STAGES[int(r.get("warm") or 0)], "next": next_stage(r),
        "stats": {"days_together": days_together(r, today, tz), "turns": r["turns"], "active_days": r["active_days"],
                  "streak_days": r["streak_days"], "memories": r["memories"],
                  "idle_days": (today - last).days if last else None, "grace_days": GRACE_DAYS},
        "mood": mood(r, now, tz), "milestones": list(reversed(r["milestones"])),
        "log": list(reversed(r["log"][-100:])), "started_at": r["started_at"],
    }


def summary(r: dict[str, Any], now: datetime, tz: Any) -> dict[str, Any]:
    """What the mate document carries (the indicator): changes rarely, so pushes stay rare."""
    return {"enabled": r["enabled"], "paused": r["paused"], "stage": r["stage"], "affinity": int(round(r["affinity"])),
            "mood": mood(r, now, tz)["label"] if r["enabled"] and not r["paused"] else None,
            "show_indicator": r["show_indicator"], "avatar_mood": r["avatar_mood"]}


# ---- recompute: the same engine over the real history ----

def replay(events: list[tuple[datetime, str, Any]], now: datetime, tz: Any,
           settings: dict[str, Any] | None = None, marks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """``events``: (time, "turn", (user_text, reply_text)) | (time, "memory", None) — rebuilt from scratch with the
    current settings (enabled / sensitivity …; pauses in the past aren't known, so none). ``marks``: the user's
    own changes (a value set by hand, a fresh start — ``marks_of``), applied when they happened."""
    r = new()
    for k, v in (settings or {}).items():
        if k in ("enabled", "sensitivity", "show_indicator", "avatar_mood"):
            r[k] = v
    r = normalized(r)
    enabled = r["enabled"]
    r["enabled"] = True
    timeline = list(events)
    for m in marks or []:
        at = _t(m.get("at"))
        if at is not None and m.get("kind") in ("set", "reset"):
            timeline.append((at, m["kind"], m.get("v")))
    order = {"turn": 0, "memory": 1, "set": 2, "reset": 2}
    for at, what, arg in sorted(timeline, key=lambda e: (e[0], order.get(e[1], 3))):
        advance(r, at, tz)
        if what == "turn":
            u, a = arg or ("", "")
            credit_turn(r, at, tz, u, a)
        elif what == "memory":
            credit_memory(r, at, tz)
        elif what == "set" and arg is not None:
            set_value(r, float(arg), at, tz)
        elif what == "reset":
            r = reset(r, at, tz)
    advance(r, now, tz)
    _log(r, 0.0, "recomputed", now)
    r["enabled"] = enabled
    r["marks"] = list(marks or [])[-50:]
    return r


def clone(r: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(r)
