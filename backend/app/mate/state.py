"""How a mate feels right now, and why (docs/mate-memory-affinity.md §5.4). Every mate has this, whatever else is on.

Each emotion has its own value and its own reason, and together they make one state: a blend, how good and how lively it
feels, how it comes out in the way she talks, what her face does. Anything can move them: all that the user says, what they
do (leaving her unanswered, stopping her, poking her avatar), her own expressions and reports, the hour, delegated work,
what she has on. Left alone they settle back to how she usually is. Nothing here decides anything for her: the prompt tells
her how she feels, how it comes out and how she leans on what is up to her (``leaning``), and she decides as her character
would.

What she has on can be part of it: an outfit's ``feel`` ({emotion: strength}) keeps that emotion climbing for as long as she
has it on, and rises in it are stronger. Her crop top does that to shy, however she came to be in it.

So can her body: a woman has her off day now and then (``off_day``), irritable and drowsy for no reason she could name.

Pure functions over one JSON document (``new()``); no I/O. ``who`` is everything else they read about her (``who()``).
"""

from __future__ import annotations

import random
import re
from datetime import datetime, timedelta
from typing import Any

from app.mate import affinity as A

EMOTIONS = ("happy", "excited", "shy", "angry", "sad", "lonely", "worried", "sleepy")
CALM = "calm"  # (no emotion stands out)
SHOWN_FROM = 0.25
#: what ``feel`` can say, and the words the prompt uses for a value (never a number)
STRENGTHS = {"none": 0.0, "slight": 0.3, "moderate": 0.55, "strong": 0.85}
WORDS = ((0.7, "strongly"), (0.45, "quite"), (SHOWN_FROM, "a little"))
HALF_LIFE_H = {"happy": 3.0, "excited": 1.0, "shy": 0.5, "angry": 1.5, "sad": 4.0, "lonely": 2.0, "worried": 2.0, "sleepy": 1.0}
#: when one rises the others give way: {rising: {other: how much of the rise}}
GIVES_WAY = {"angry": {"happy": 0.5, "excited": 0.5, "shy": 0.2}, "happy": {"sad": 0.4, "lonely": 0.5, "angry": 0.2, "worried": 0.1},
             "excited": {"sleepy": 0.3, "sad": 0.2}, "sad": {"happy": 0.4, "excited": 0.4}, "lonely": {"happy": 0.2},
             "worried": {"excited": 0.2}}
#: how each emotion counts towards how good / how lively the whole state is
VALENCE = {"happy": 1.0, "excited": 0.8, "shy": 0.1, "angry": -1.0, "sad": -0.9, "lonely": -0.7, "worried": -0.6, "sleepy": -0.1}
AROUSAL = {"happy": 0.5, "excited": 1.0, "shy": 0.6, "angry": 1.0, "sad": -0.2, "lonely": -0.2, "worried": 0.6, "sleepy": -0.8}
#: two feelings of about the same strength make one state
BLENDS = {"excited_happy": "elated", "happy_shy": "bashfully happy", "happy_sleepy": "mellow", "excited_shy": "all aflutter",
          "angry_shy": "flustered and snappy", "angry_sad": "hurt", "angry_lonely": "sulking", "angry_sleepy": "cranky",
          "angry_worried": "on edge", "lonely_sad": "lonesome", "sad_worried": "troubled", "sad_shy": "withdrawn",
          "shy_worried": "nervous", "lonely_shy": "wistful"}
BLEND_FROM = 0.6  # (the second at least this much of the first)
#: how each comes out in the way she talks: {emotion: ((from, how), …)}; the two strongest are told
CONDUCT = {
    "angry": ((0.7, ("You are angry, and it shows. Let it out the way that is truest to you now: tell them heatedly what they did "
                     "and that it isn't okay, raise your voice, snap back, demand they stop — or go cold and curt, maybe just "
                     "“...”, or say you don't want to talk right now. Don't smooth it over or be polite about it.")),
              (0.45, ("You are irritated: sharp and short, no pleasantries, no jokes; you may snap at them or say plainly what "
                      "bothered you.")),
              (SHOWN_FROM, "You are a bit put out: a little curt.")),
    "shy": ((0.7, ("You are very flustered: you stumble, trail off and look for a way out of the subject; what you have on and how "
                   "you look are hard to talk about.")),
            (0.45, "You are shy: hesitant, quieter than usual.")),
    "sad": ((0.6, ("You are sad, and it shows: little energy, no jokes; you may say you're upset or hurt and why, your voice may "
                   "break, you may cry.")),
            (0.35, "You are subdued.")),
    "lonely": ((0.45, "You missed them: a little withdrawn at first, quietly glad they came. You may say you waited, lightly."),),
    "worried": ((0.45, "You are worried: gentle and careful, checking how things are."),),
    "happy": ((0.7, "You are in high spirits: warmer and more playful than usual."), (0.45, "You are in a good mood: a bit warmer.")),
    "excited": ((0.55, "You are excited: more talkative than usual, and it runs away with you."),),
    "sleepy": ((0.6, "You are drowsy: slower and shorter, the odd yawn."),),
}
#: angry because of a need (hungry, stressed), not at them: it shows in her temper
CRANKY = ((0.45, "You are cranky, and not about them: short-tempered and grumbly; you may say why."),
          (SHOWN_FROM, "You are a bit cranky."))
#: angry on her off day: a mood she can't put a reason to, and not about them
OUT_OF_SORTS = ((0.7, ("You are irritable today for no reason you could name, and it isn't about them: short-tempered and "
                       "grumbly, easily put out by little things. You may say you're just in a mood today; don't blame them "
                       "for it.")),
                (0.45, "You are a bit grumpy and short today, for no clear reason; it isn't about them."),
                (SHOWN_FROM, "You are a little out of sorts today."))
#: sad because of what they did: she may say so
HURT_BY_THEM = (0.45, "It was them who hurt you, and you may tell them so.")
TOLD_EVERY_TURN_FROM = 0.7
#: a need past ``from`` keeps an emotion up: {emotion: ((need, from, how fast, reason), …)} (docs/mate-life.md)
FROM_NEEDS = {"sleepy": (("sleep", 0.35, 1.35, "tired"),), "angry": (("hunger", 0.75, 1.75, "hungry"), ("stress", 0.8, 3.0, "stressed")),
              "sad": (("fun", 0.8, 3.0, "bored"),), "lonely": (("affection", 0.35, 1.0, "wants_affection"),),
              "worried": (("stress", 0.45, 1.33, "stressed"),)}
ASLEEP = 0.85
GIFT = 0.3
# her off day (a woman's: ``who(gender="female")``), as it comes — no setting, nothing stored, nothing to see but how she is:
# the first some moment in the 5 days after they first met, each next one 21–28 days after the last (real time; drawn from
# her id, so every look sees the same days); 2 days long. Floors under angry and sleepy — {emotion: (day 1, day 2)} as
# (where it starts, how low it goes) — easing off slowly (half of what is above the low every OFF_DAY_EASES_H hours). Only
# floors: whatever else she feels rises over them as ever, they dull nothing, and nothing in them is at the user.
OFF_DAY_FIRST, OFF_DAY_EVERY, OFF_DAY_LONG = timedelta(days=5), (timedelta(days=21), timedelta(days=28)), timedelta(days=2)
OFF_DAY_FLOORS = {"angry": ((0.90, 0.60), (0.70, 0.60)), "sleepy": ((0.70, 0.60), (0.70, 0.60))}
OFF_DAY_EASES_H = 16.0

#: how each bundled mate usually is: ``base``: where she settles; ``rise``: how easily it moves; ``loves``: what lights her up
TEMPERAMENTS: dict[str, dict[str, Any]] = {
    "chaerin": {"base": {"shy": 0.15}, "rise": {"shy": 1.2, "excited": 1.3},
                "loves": r"게임|버그|레이드|길드|코드|디버그|재현|\braid\b|\bgame|\bbug"},  # quiet, until games come up
}

# what the user says moves it, by this much
RUDE, RUDE_MORE, RUDE_MOST, RUDE_DROP, RUDE_WINDOW = 0.3, 0.1, 0.5, 0.15, timedelta(hours=2)  # (keeping it up makes it worse)
# something done to her (affinity.hostile: hitting her, forcing something on her, threats, putting her down): far worse than a rude
# word, and it hurts; each time again (within the window) more. Sorry counts for less after it. Only the words' guess: her reply has
# the last word (``reply``: shown calm, it is undone).
HOSTILE, HOSTILE_MORE, HOSTILE_HURT, HOSTILE_DROP, HOSTILE_WINDOW = 0.45, 0.3, 0.25, 0.4, timedelta(hours=6)
APOLOGY_AFTER_HOSTILE = 0.15
#: from here, angry at what they did, she may not answer at all (``REFUSE`` in how it comes out: she decides, and [SILENT] is
#: how). Only anger at them: hungry or stressed, she still answers, if snappily
SILENT_FROM = 0.8
AT_THEM = ("rude", "hostile", "dismissed", "pestered", "poked", "said", "interrupted", "ignored", "curt", "apology", "declined_call",
           "missed_call")
APOLOGY, WARM, WARM_CALMS, LOVE, LOOKS, DISTRESS, RETURNED, ANSWERED, LOVES = 0.3, 0.12, 0.08, 0.15, 0.12, 0.35, 0.2, 0.1, 0.2
# angry, the good things land less
ANGRY_DULLS = {"happy": 0.7, "excited": 0.9}
DISMISSED_SAD, DISMISSED_ANGRY, CURT, CURT_FROM = 0.2, 0.1, 0.08, 3
RETURN_AFTER = timedelta(days=1)
# what she showed herself: towards this strength, unless the tag says ([angry:0.8])
SHOWN_ON_FACE = {"joy": ("happy", 0.6), "laugh": ("happy", 0.6), "smile": ("happy", 0.4), "shy": ("shy", 0.5), "sad": ("sad", 0.5),
                 "worried": ("worried", 0.45), "angry": ("angry", 0.55), "surprised": ("excited", 0.3), "sleepy": ("sleepy", 0.4)}
SHOWN_PULL = 0.5
QUOTE_CHARS = 40
# what the user does
IGNORED_AFTER_H, IGNORED_ANGRY, IGNORED_ANGRY_FROM = 0.25, 0.08, 3  # (and what she does when it has gone on)
INTERRUPTED, WORK_OK, WORK_FAILED = 0.04, 0.05, 0.10
POKE, POKED_TOO_MUCH, POKE_TOO_MANY, POKE_WINDOW = 0.03, 0.08, 6, timedelta(minutes=1)
# her phone calls (app/mate/calls.py): talking on the phone warms her; a call they turn down stings, one they don't pick up leaves
# her lonelier, and each one in a row more so — from the second on she sulks a little
CALL_TALKED_HAPPY, CALL_TALKED_LONELY = 0.12, 0.25
CALL_DECLINED_SAD, CALL_DECLINED_LONELY, CALL_MISSED_SAD, CALL_MISSED_LONELY = 0.15, 0.1, 0.06, 0.15
CALL_SULK, CALL_SULK_MAX = 0.08, 0.3
# an outfit: closeness takes the edge off where it starts; from there it climbs for as long as she has it on
CLOSE_EASES, CLIMBS_TO, CLIMB_HALF_MIN = 0.35, 0.95, 25.0
# being asked to change clothes: asking again leans her towards yes, for a while; too much of it makes her angry
ASK_WINDOW, ASK_LEAN, ASK_LEAN_MAX, PESTERED_FROM, PESTERED = timedelta(minutes=30), 0.1, 0.3, 4, 0.1
LEANS = ((0.65, "glad"), (0.4, "maybe"))  # below: "rather_not"
LOG_MAX = 100
REASON_CHARS = 120
#: energy over the day (local hour 0–23): below 0.55 she gets sleepy
CIRCADIAN = (0.40, 0.33, 0.28, 0.25, 0.25, 0.30, 0.40, 0.55, 0.70, 0.80, 0.90, 0.90,
             0.90, 0.90, 0.90, 0.90, 0.90, 0.88, 0.85, 0.80, 0.75, 0.65, 0.55, 0.45)

_LOOKS = re.compile(r"예쁘|이뻐|이쁘|귀여|잘 ?어울|섹시|몸매|\bpretty\b|\bcute\b|beautiful|\bsexy\b|looks? (good|great|nice)", re.I)
_LOVE = re.compile(r"사랑해|좋아해|보고 ?싶|\blove you\b|miss you|\bi like you\b", re.I)
_APOLOGY = re.compile(r"미안|죄송|잘못했|사과(할|하|드)|용서해|내가 심했|말이 심했|\bsorry\b|apologi[sz]e|my bad", re.I)
_DISMISSED = re.compile(r"됐어|됐고|관심 ?없|귀찮|말 ?걸지|저리 ?가|알 ?바 ?아|whatever|leave me alone|don'?t care|not interested", re.I)
_CURT = re.compile(r"[ㅇㄴㄱㅎㅋ]{1,3}|응|네|넹|엉|어|아니|몰라|그래|ok|okay|k|yes|no|nah|yep|nope", re.I)
_ASK = re.compile(r"갈아 ?입|옷 ?(좀 ?)?(바꿔|입어)|입어 ?(봐|줘|줄|주|라|요)|\bchange (your |into|clothes|outfit)|\bput on\b|"
                  r"\bwear (this|that|it|the|your)\b", re.I)
_TAGS = re.compile(r"\[\s*(joy|laugh|smile|shy|surprised|sad|worried|angry|sleepy)\s*(?::\s*([01](?:\.\d+)?))?\s*\]", re.I)

#: why, as she is told it ({code} reasons; one she gave herself is {text})
_WHY_FOR_HER = {
    "warm": "they were kind to you", "love": "they said they care for you", "rude": "they were rude to you", "apology": "they apologised",
    "dismissed": "they brushed you off", "curt": "they keep answering in a word or two", "looks": "they said something about how you look",
    "loves": "they brought up something you love", "distress": "they seem to be having a hard time",
    "returned": "they came back after a while", "answered": "they answered at last", "ignored": "you spoke and they didn't answer",
    "interrupted": "they cut you off", "poked": "they keep poking you", "pestered": "they keep pushing about your clothes",
    "late": "it's late", "work_ok": "work you passed on went well", "work_failed": "work you passed on went badly",
    "nature": "it's how you are", "user_wore": "they put it on you", "gift": "they sent you something", "asleep": "you were asleep", "tired": "you're tired",
    "hungry": "you're hungry", "stressed": "it has been a stressful stretch", "bored": "you've had nothing fun to do for a while",
    "wants_affection": "you could do with some warmth and attention",
    "call_talked": "you talked on the phone with them", "declined_call": "you called them and they turned the call down",
    "missed_call": "you called them and they didn't pick up",
    "off_day": "it's just one of those days: you're irritable and drowsy, for no reason you could name",
}


#: what was done to her (affinity.hostile), as she is told it
_DONE_TO_HER = {"violence": "they hit you", "coercion": "they forced something on you against your will",
                "threat": "they threatened you", "demeaning": "they talked down to you for being a woman, or as if you were nothing"}


# ---- the document ----

def new() -> dict[str, Any]:
    return {"feelings": {}, "heard": None, "heard_at": None, "asks": None, "rude": None, "hostile": None, "curt": 0, "spoke": None,
            "pokes": None, "changed_at": None, "log": []}


def normalized(doc: Any) -> dict[str, Any]:
    out = new()
    if isinstance(doc, dict):
        out.update({k: v for k, v in doc.items() if k in out})
    feelings = out["feelings"] if isinstance(out["feelings"], dict) else {}
    out["feelings"] = {k: v for k, v in feelings.items() if k in EMOTIONS and isinstance(v, dict)}
    out["log"] = out["log"] if isinstance(out["log"], list) else []
    return out


def who(*, closeness: float = 0.33, sensitivity: float = 1.0, builtin: str | None = None, away: bool = False,
        outfit: dict[str, Any] | None = None, life: dict[str, Any] | None = None, name: str = "", gender: str = "",
        met: Any = None, seed: str = "") -> dict[str, Any]:
    """``closeness``: 0 – 1. ``away``: the relationship is paused, so silence means nothing. ``outfit``: what she has on,
    {id, name, feel, since}; None in her usual clothes or one that does nothing to her. ``life``: her own day when she has one
    (life/sim.py ``for_state``): {needs, feel, doing, asleep}. ``gender``: her persona's; ``met``: when they first met (ISO);
    ``seed``: her id — with these, her off days (``off_day``)."""
    return {"closeness": max(0.0, min(1.0, float(closeness))), "sensitivity": float(sensitivity), "away": bool(away),
            "temperament": TEMPERAMENTS.get(builtin or "", {}), "outfit": outfit if (outfit or {}).get("feel") else None, "life": life,
            "name": name, "gender": gender or "", "met": A._iso(met) if isinstance(met, datetime) else met, "seed": seed or ""}


def clean_feel(raw: Any) -> dict[str, float]:
    """An outfit's ``feel``: the known emotions, 0 – 1; none at 0."""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        if k in EMOTIONS and isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            out[k] = round(min(1.0, float(v)), 2)
    return out


# ---- how she feels as of now ----

def _base(emotion: str, w: dict[str, Any]) -> float:
    own = float((w["temperament"].get("base") or {}).get(emotion) or 0.0)
    if emotion == "happy":
        return own + 0.05 + 0.2 * w["closeness"]
    if emotion == "shy":
        return own * (1 - 0.5 * w["closeness"])
    return own


def _late(now: datetime, tz: Any) -> float:
    return min(0.85, max(0.0, (0.55 - CIRCADIAN[now.astimezone(tz).hour]) / 0.3))


def _silence(doc: dict[str, Any], w: dict[str, Any], now: datetime) -> float:
    """She spoke and they haven't answered: it grows with the wait, and much sooner the more often she spoke."""
    spoke = doc.get("spoke") if isinstance(doc.get("spoke"), dict) else None
    at = A._t((spoke or {}).get("at"))
    if at is None or w["away"]:
        return 0.0
    n = max(1, int(spoke.get("n") or 1))
    waited = min(1.0, max(0.0, (now - at).total_seconds() / 3600 - IGNORED_AFTER_H) / (24 / n**2))
    return waited * (0.35 + 0.15 * min(n, 3) + (0.1 if spoke.get("asked") else 0.0)) * (0.6 + 0.4 * w["closeness"])


def _worn(emotion: str, w: dict[str, Any], now: datetime) -> float:
    """How far what she has on has taken this emotion: it climbs for as long as she has it on."""
    outfit = w["outfit"]
    strength = float(((outfit or {}).get("feel") or {}).get(emotion) or 0.0)
    if not strength:
        return 0.0
    start = strength * (1 - CLOSE_EASES * w["closeness"])
    since = A._t(outfit.get("since"))
    minutes = max(0.0, (now - since).total_seconds() / 60) if since is not None else 0.0
    return start + (max(CLIMBS_TO, start) - start) * (1 - 0.5 ** (minutes / CLIMB_HALF_MIN))


def _lived(emotion: str, w: dict[str, Any]) -> tuple[float, dict[str, Any]]:
    """How far her body and what she is doing keep this emotion up, and why."""
    life = w.get("life")
    if not life:
        return 0.0, {}
    if emotion == "sleepy" and life.get("asleep"):
        return ASLEEP, {"code": "asleep"}
    best, why = float((life.get("feel") or {}).get(emotion) or 0.0), {"code": "doing", "doing": life.get("doing") or ""}
    for need, start, rate, code in FROM_NEEDS.get(emotion, ()):
        if emotion == "lonely" and w["away"]:
            continue
        v = (float(life["needs"].get(need) or 0.0) - start) * rate
        if v > best:
            best, why = v, {"code": code}
    return best, why


def _off_day(w: dict[str, Any], now: datetime) -> datetime | None:
    """When the off day she is in at ``now`` began, or None (not a woman, not met yet, not now)."""
    met = A._t(w.get("met"))
    if w.get("gender") != "female" or not w.get("seed") or met is None or now < met:
        return None
    draw = random.Random(f"off_day:{w['seed']}")  # (str seeds are hashed the same in every process)
    start = met + OFF_DAY_FIRST * draw.random()
    lo, hi = OFF_DAY_EVERY
    while start + OFF_DAY_LONG <= now:
        start += lo + (hi - lo) * draw.random()
    return start if start <= now else None


def off_day(emotion: str, start: datetime | None, now: datetime) -> float:
    """Where her off day (begun at ``start``) keeps this emotion now: 0 when it doesn't."""
    if start is None or emotion not in OFF_DAY_FLOORS:
        return 0.0
    hours = max(0.0, (now - start).total_seconds() / 3600)
    day = min(1, int(hours // 24))
    top, low = OFF_DAY_FLOORS[emotion][day]
    return low + (top - low) * 0.5 ** ((hours - 24 * day) / OFF_DAY_EASES_H)


def levels(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any, *, off: bool = True) -> dict[str, dict[str, Any]]:
    """{emotion: {v: 0 – 1, why}} as of ``now``. ``off``: with her off day's floors — what she feels; without, where her
    feelings are of themselves (what moves them starts from there, so the off day neither dulls nor carries over into them)."""
    out = {}
    started = _off_day(w, now) if off else None
    for e in EMOTIONS:
        base = _base(e, w)
        v, why = base, {"code": "nature"}
        f = doc["feelings"].get(e) or {}
        at = A._t(f.get("at"))
        if at is not None and isinstance(f.get("v"), (int, float)):
            hours = max(0.0, (now - at).total_seconds() / 3600)
            v = base + (float(f["v"]) - base) * 0.5 ** (hours / HALF_LIFE_H[e])
            if abs(float(f["v"]) - base) >= 0.01:
                why = f.get("why") or why
        if e == "sleepy" and not w.get("life") and _late(now, tz) > v:  # (with a day of her own, it is how she slept that counts)
            v, why = _late(now, tz), {"code": "late"}
        lived, lived_why = _lived(e, w)
        if lived > v:
            v, why = lived, lived_why
        if e == "lonely" and _silence(doc, w, now) > v:
            v, why = _silence(doc, w, now), {"code": "ignored"}
        worn = _worn(e, w, now)
        if worn > v:
            v, why = worn, {"code": "outfit", "name": w["outfit"].get("name") or ""}
        mood = off_day(e, started, now)
        if mood > v:
            v, why = mood, {"code": "off_day"}
        out[e] = {"v": round(v, 3), "why": why}
    return out


def word(v: float) -> str:
    return next((name for floor, name in WORDS if v >= floor), "")


def _blend(top: list[dict[str, Any]]) -> str | None:
    if len(top) < 2 or top[1]["v"] < BLEND_FROM * top[0]["v"]:
        return None
    code = "_".join(sorted((top[0]["emotion"], top[1]["emotion"])))
    return code if code in BLENDS else None


def summary(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> dict[str, Any]:
    """What the mate document carries: the one state they make together. ``label``: the strongest (or calm); ``blend``: what
    the two strongest make; ``valence`` (-1 – 1) and ``arousal`` (0 – 1): how good and how lively it all feels; ``top``: what
    stands out, strongest first."""
    lv = levels(doc, w, now, tz)
    order = sorted((e for e in EMOTIONS if lv[e]["v"] >= SHOWN_FROM), key=lambda e: -lv[e]["v"])[:3]
    top = [{"emotion": e, "v": lv[e]["v"], "word": word(lv[e]["v"]), "why": lv[e]["why"]} for e in order]
    total = max(1.0, sum(x["v"] for x in lv.values()))
    return {"label": order[0] if order else CALM, "level": lv[order[0]]["v"] if order else 0.0, "blend": _blend(top),
            "valence": round(max(-1.0, min(1.0, sum(lv[e]["v"] * VALENCE[e] for e in EMOTIONS) / total)), 2),
            "arousal": round(max(0.0, min(1.0, 0.4 + sum(lv[e]["v"] * AROUSAL[e] for e in EMOTIONS) / total)), 2), "top": top}


def signature(s: dict[str, Any]) -> list[list[str]]:
    """A summary without its fine print: when this changes she is told again, and every window hears."""
    return [[t["emotion"], t["word"]] for t in s["top"]]


def why_for_her(why: dict[str, Any] | None) -> str:
    why = why or {}
    if why.get("text"):
        return str(why["text"])
    code = why.get("code")
    if code == "outfit":
        return f"you have “{why.get('name') or ''}” on"
    if code == "was_outfit":
        return f"you just had “{why.get('name') or ''}” on"
    if code == "said":
        return f"they said “{why.get('quote') or ''}”"
    if code == "hostile":
        done = _DONE_TO_HER.get(str(why.get("kind") or ""), "they treated you badly")
        return f"{done}: “{why.get('quote') or ''}”"
    if code == "doing":
        return f"you are {why.get('doing') or 'busy'}"
    return _WHY_FOR_HER.get(str(code), "")


#: furious at what they did: how it comes out is hers to decide — blowing up at them, or not answering at all ([SILENT] is how she
#: doesn't, and the chat shows only that)
REFUSE = ("You are furious with them for what they did. It comes out the way that is truest to you right now: blow up at them — "
          "tell them hotly what they did, how it made you feel, that you won't take it — or refuse to talk to them at all: then "
          "reply with exactly [SILENT] and nothing else, and the chat shows that you don't answer. An apology you believe, or real "
          "trouble they are in, can change that. Which it is, is yours to decide.")


_FROM_NEED = {reason for rules in FROM_NEEDS.values() for (_need, _from, _speed, reason) in rules}


def _at_them(why: dict[str, Any] | None) -> bool:
    """Anger at something they did or said (her own face at what they said is ``said``); not a reason in words (her day's, a
    report): a missed bus is nobody's fault of theirs."""
    return (why or {}).get("code") in AT_THEM


def conduct(s: dict[str, Any]) -> str:
    """How it comes out in the way she talks now."""
    lines = []
    for t in s["top"][:2]:
        why = t.get("why")
        if t["emotion"] == "angry" and t["v"] >= SILENT_FROM and _at_them(why):
            lines.append(REFUSE)
            continue
        code = (why or {}).get("code")
        table = (CRANKY if code in _FROM_NEED else OUT_OF_SORTS if code == "off_day" else CONDUCT["angry"]) \
            if t["emotion"] == "angry" else CONDUCT.get(t["emotion"], ())
        how = next((text for floor, text in table if t["v"] >= floor), "")
        if t["emotion"] == "sad" and _at_them(why) and t["v"] >= HURT_BY_THEM[0]:
            how = f"{how} {HURT_BY_THEM[1]}".strip()
        if how:
            lines.append(how)
    return " ".join(lines)


def line(s: dict[str, Any]) -> str:
    """How she feels, and how it comes out, for her <context>."""
    if not s["top"]:
        return "How you feel right now: calm."
    parts = []
    for t in s["top"]:
        why = why_for_her(t["why"])
        parts.append(f"{t['emotion']}, {t['word']}" + (f" ({why})" if why else ""))
    out = "How you feel right now: " + "; ".join(parts)
    out += f". All together: {BLENDS[s['blend']]}." if s.get("blend") else "."
    how = conduct(s)
    return f"{out}\nHow it comes out now: {how}" if how else out


def worth_repeating(s: dict[str, Any]) -> bool:
    """Strong enough to be told every turn, so it doesn't fade from a long conversation."""
    return s["level"] >= TOLD_EVERY_TURN_FROM


# ---- how she leans on what is up to her ----

def furious(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> bool:
    """Angry enough at what they did (not at hunger or stress) that she is offered not answering at all (``REFUSE``): she decides."""
    angry = levels(doc, w, now, tz)["angry"]
    return angry["v"] >= SILENT_FROM and _at_them(angry["why"])


def _lately(entry: Any, now: datetime, window: timedelta) -> int:
    entry = entry if isinstance(entry, dict) else {}
    at = A._t(entry.get("at"))
    return int(entry.get("n") or 0) if at is not None and now - at <= window else 0


def asks_lately(doc: dict[str, Any], now: datetime) -> int:
    return _lately(doc.get("asks"), now, ASK_WINDOW)


def leaning(doc: dict[str, Any], w: dict[str, Any], feel: dict[str, float] | None, now: datetime, tz: Any) -> str:
    """Whether she feels like putting on an outfit: glad | maybe | rather_not. A leaning, not a rule: she decides. (Her off
    day is no reason to turn them down.)"""
    lv = {e: x["v"] for e, x in levels(doc, w, now, tz, off=False).items()}
    x = 0.55 + 0.35 * lv["happy"] + 0.25 * lv["excited"] - 0.8 * lv["angry"] - 0.5 * lv["sad"] - 0.3 * lv["lonely"] \
        - 0.35 * lv["worried"] - 0.25 * lv["sleepy"] + min(ASK_LEAN_MAX, ASK_LEAN * max(0, asks_lately(doc, now) - 1))
    exposure = float((feel or {}).get("shy") or 0.0)
    if exposure:  # (what makes her shy takes being closer, and not being shy already)
        x += 0.5 * w["closeness"] - 0.9 * exposure - 0.3 * lv["shy"]
    else:
        x += 0.2 * w["closeness"]
    return next((name for floor, name in LEANS if x >= floor), "rather_not")


# ---- what moves it ----

def _note(doc: dict[str, Any], entry: dict[str, Any], now: datetime) -> None:
    doc["log"] = [*doc["log"], {"at": A._iso(now), **entry}][-LOG_MAX:]


def _set(doc: dict[str, Any], w: dict[str, Any], emotion: str, v: float, why: dict[str, Any], now: datetime, tz: Any,
         quiet: bool = False) -> None:
    before = levels(doc, w, now, tz)[emotion]["v"]
    doc["feelings"][emotion] = {"v": round(max(0.0, min(1.0, v)), 3), "at": A._iso(now), "why": why}
    after = levels(doc, w, now, tz)[emotion]["v"]
    if abs(after - before) >= 0.01 and not quiet:
        _note(doc, {"emotion": emotion, "from": before, "to": after, "why": why}, now)


def _give_way(doc: dict[str, Any], w: dict[str, Any], emotion: str, rose: float, now: datetime, tz: Any) -> None:
    """The others make room for what rose, keeping their own reasons."""
    if rose <= 0:
        return
    for other, share in GIVES_WAY.get(emotion, {}).items():
        was = levels(doc, w, now, tz, off=False)[other]
        if was["v"] > _base(other, w):
            _set(doc, w, other, max(_base(other, w), was["v"] - share * rose), was["why"], now, tz, quiet=True)


def _rise(doc: dict[str, Any], w: dict[str, Any], emotion: str, amount: float, why: dict[str, Any], now: datetime, tz: Any) -> None:
    worn = float(((w["outfit"] or {}).get("feel") or {}).get(emotion) or 0.0)
    gain = amount * w["sensitivity"] * float((w["temperament"].get("rise") or {}).get(emotion) or 1.0) * (1 + worn)
    lv = levels(doc, w, now, tz, off=False)
    gain *= 1 - ANGRY_DULLS.get(emotion, 0.0) * lv["angry"]["v"]
    _set(doc, w, emotion, lv[emotion]["v"] + gain, why, now, tz)
    _give_way(doc, w, emotion, gain, now, tz)


def _fall(doc: dict[str, Any], w: dict[str, Any], emotion: str, amount: float, why: dict[str, Any], now: datetime, tz: Any) -> None:
    _set(doc, w, emotion, max(_base(emotion, w), levels(doc, w, now, tz, off=False)[emotion]["v"] - amount), why, now, tz)


def _they_are_back(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> None:
    """They said something: the wait stops growing, but what it did doesn't vanish."""
    spoke = doc.get("spoke") if isinstance(doc.get("spoke"), dict) else None
    lonely = _silence(doc, w, now)
    if lonely > levels({**doc, "spoke": None}, w, now, tz)["lonely"]["v"]:
        doc["feelings"]["lonely"] = {"v": round(lonely, 3), "at": A._iso(now), "why": {"code": "ignored"}}
        if int((spoke or {}).get("n") or 0) >= IGNORED_ANGRY_FROM:
            _rise(doc, w, "angry", IGNORED_ANGRY, {"code": "ignored"}, now, tz)
        _note(doc, {"emotion": "lonely", "from": 0.0, "to": round(lonely, 3), "why": {"code": "ignored"}}, now)
    doc["spoke"] = None
    if levels(doc, w, now, tz)["lonely"]["v"] > _base("lonely", w):
        _fall(doc, w, "lonely", ANSWERED, {"code": "answered"}, now, tz)


def hear(doc: dict[str, Any], w: dict[str, Any], text: str, message: str, now: datetime, tz: Any) -> None:
    """A message of the user's, once however often it is looked at, before she answers it."""
    if doc.get("heard") == message:
        return
    last = A._t(doc.get("heard_at"))
    doc["heard"], doc["heard_at"] = message, A._iso(now)
    text = (text or "").strip()
    c = A.cues(text, name=w.get("name") or "")
    _they_are_back(doc, w, now, tz)
    if last is not None and now - last >= RETURN_AFTER:
        _rise(doc, w, "happy", RETURNED, {"code": "returned"}, now, tz)
    doc["curt"] = int(doc.get("curt") or 0) + 1 if _CURT.fullmatch(re.sub(r"[\s.!?~]+", "", text)) else 0
    if doc["curt"] >= CURT_FROM:
        _rise(doc, w, "lonely", CURT, {"code": "curt"}, now, tz)
    if c["hostile"]:
        n = _lately(doc.get("hostile"), now, HOSTILE_WINDOW) + 1
        lv = levels(doc, w, now, tz, off=False)
        # (the words' guess: what she shows in her reply has the last word, ``reply``)
        doc["hostile"] = {"n": n, "at": A._iso(now), "message": message, "angry": lv["angry"]["v"], "sad": lv["sad"]["v"],
                          "happy": lv["happy"]["v"]}
        why = {"code": "hostile", "kind": c["hostile"], "quote": " ".join(text.split())[:QUOTE_CHARS]}
        _rise(doc, w, "angry", HOSTILE if n == 1 else HOSTILE_MORE, why, now, tz)
        _rise(doc, w, "sad", HOSTILE_HURT, why, now, tz)
        _fall(doc, w, "happy", HOSTILE_DROP, why, now, tz)
    elif c["rude"]:
        n = _lately(doc.get("rude"), now, RUDE_WINDOW) + 1
        doc["rude"] = {"n": n, "at": A._iso(now)}
        _rise(doc, w, "angry", min(RUDE_MOST, RUDE + RUDE_MORE * (n - 1)), {"code": "rude"}, now, tz)
        _fall(doc, w, "happy", RUDE_DROP, {"code": "rude"}, now, tz)
    else:
        if _APOLOGY.search(text):
            doc["rude"] = None
            after = _lately(doc.get("hostile"), now, HOSTILE_WINDOW)  # (sorry doesn't undo being hit at once)
            _fall(doc, w, "angry", APOLOGY_AFTER_HOSTILE if after else APOLOGY, {"code": "apology"}, now, tz)
            _fall(doc, w, "sad", APOLOGY / 3, {"code": "apology"}, now, tz)
        if _DISMISSED.search(text):
            _rise(doc, w, "sad", DISMISSED_SAD, {"code": "dismissed"}, now, tz)
            _rise(doc, w, "angry", DISMISSED_ANGRY, {"code": "dismissed"}, now, tz)
        if c["warm"]:
            _rise(doc, w, "happy", WARM, {"code": "warm"}, now, tz)
            if levels(doc, w, now, tz, off=False)["angry"]["v"] > _base("angry", w):
                _fall(doc, w, "angry", WARM_CALMS, {"code": "warm"}, now, tz)
        if _LOVE.search(text):
            _rise(doc, w, "happy", LOVE, {"code": "love"}, now, tz)
            _rise(doc, w, "shy", LOVE, {"code": "love"}, now, tz)
        if _LOOKS.search(text):
            _rise(doc, w, "shy", LOOKS, {"code": "looks"}, now, tz)
        loves = w["temperament"].get("loves")
        if loves and re.search(loves, text, re.I):
            _rise(doc, w, "excited", LOVES, {"code": "loves"}, now, tz)
        if _ASK.search(text):
            n = asks_lately(doc, now) + 1
            doc["asks"] = {"n": n, "at": A._iso(now)}
            if n >= PESTERED_FROM:
                _rise(doc, w, "angry", PESTERED, {"code": "pestered"}, now, tz)
    if c["distress"]:
        _rise(doc, w, "worried", DISTRESS, {"code": "distress"}, now, tz)


def reply(doc: dict[str, Any], w: dict[str, Any], text: str, heard_text: str, now: datetime, tz: Any) -> None:
    """Her reply is done. What her face showed is how she felt: each tag pulls that emotion towards its strength, for the
    reason that it was said to her."""
    text = text or ""
    shown: dict[str, float] = {}
    for tag, value in _TAGS.findall(text):
        emotion, usual = SHOWN_ON_FACE[tag.lower()]
        shown[emotion] = max(shown.get(emotion, 0.0), float(value) if value else usual)
    quote = " ".join((heard_text or "").split())[:QUOTE_CHARS]
    why = {"code": "said", "quote": quote} if quote else {"code": "nature"}
    done = doc.get("hostile") or {}
    if done.get("message") and done.get("message") == doc.get("heard") and A.calm_reply(text):
        # (the words looked like something done to her; she didn't take it so: her reading stands)
        for emotion in ("angry", "sad", "happy"):
            if emotion in done:
                _set(doc, w, emotion, float(done[emotion]), {"code": "nature"}, now, tz, quiet=True)
        n = int(done.get("n") or 1) - 1
        doc["hostile"] = {"n": n, "at": done.get("at")} if n > 0 else None
    for emotion, strength in shown.items():
        was = levels(doc, w, now, tz, off=False)[emotion]["v"]
        if strength > was:
            pulled = (strength - was) * SHOWN_PULL * w["sensitivity"]
            _set(doc, w, emotion, was + pulled, why, now, tz)
            _give_way(doc, w, emotion, pulled, now, tz)
    if text.strip():
        spoke(doc, text, now)


def spoke(doc: dict[str, Any], text: str, now: datetime) -> None:
    """She said something: until they answer, it counts as said to nobody."""
    last = doc.get("spoke") if isinstance(doc.get("spoke"), dict) else {}
    doc["spoke"] = {"n": int(last.get("n") or 0) + 1, "at": A._iso(now), "asked": (text or "").rstrip().endswith(("?", "？"))}


def work(doc: dict[str, Any], w: dict[str, Any], ok: bool, now: datetime, tz: Any) -> None:
    """A chat she passed work on to finished: a little pleased, or worried about the work (never about the user)."""
    if ok:
        _rise(doc, w, "happy", WORK_OK, {"code": "work_ok"}, now, tz)
    else:
        _rise(doc, w, "worried", WORK_FAILED, {"code": "work_failed"}, now, tz)


def interrupted(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> None:
    """They stopped her in the middle of it."""
    _rise(doc, w, "angry", INTERRUPTED, {"code": "interrupted"}, now, tz)


def poked(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> None:
    """They tapped her avatar: a bit of attention, until it is too much of it."""
    n = _lately(doc.get("pokes"), now, POKE_WINDOW) + 1
    doc["pokes"] = {"n": n, "at": A._iso(now)}
    if n >= POKE_TOO_MANY:
        _rise(doc, w, "angry", POKED_TOO_MUCH, {"code": "poked"}, now, tz)
    else:
        _rise(doc, w, "happy", POKE, {"code": "poked"}, now, tz)
        _rise(doc, w, "shy", POKE, {"code": "poked"}, now, tz)


def call_talked(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> None:
    """They talked on the phone (either of them called, and the other picked up)."""
    _rise(doc, w, "happy", CALL_TALKED_HAPPY, {"code": "call_talked"}, now, tz)
    if levels(doc, w, now, tz)["lonely"]["v"] > _base("lonely", w):
        _fall(doc, w, "lonely", CALL_TALKED_LONELY, {"code": "call_talked"}, now, tz)


def call_unanswered(doc: dict[str, Any], w: dict[str, Any], declined: bool, in_a_row: int, now: datetime, tz: Any) -> None:
    """She called and they turned it down (``declined``) or didn't pick up; ``in_a_row``: how many of her calls in a row went
    so, this one included. A missed call is lonely more than hurtful, a declined one stings; again and again, she sulks."""
    code = "declined_call" if declined else "missed_call"
    _rise(doc, w, "sad", CALL_DECLINED_SAD if declined else CALL_MISSED_SAD, {"code": code}, now, tz)
    _rise(doc, w, "lonely", CALL_DECLINED_LONELY if declined else CALL_MISSED_LONELY, {"code": code}, now, tz)
    if in_a_row >= 2:
        _rise(doc, w, "angry", min(CALL_SULK_MAX, CALL_SULK * (in_a_row - 1)), {"code": code}, now, tz)


def gifted(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> None:
    """They sent her something (app/mate/life)."""
    _rise(doc, w, "happy", GIFT, {"code": "gift"}, now, tz)


def report(doc: dict[str, Any], w: dict[str, Any], emotion: str, strength: str, reason: str, now: datetime, tz: Any) -> None:
    """She says how she feels (the ``feel`` tool), and why."""
    was = levels(doc, w, now, tz, off=False)[emotion]["v"]
    _set(doc, w, emotion, STRENGTHS[strength], {"text": " ".join(str(reason).split())[:REASON_CHARS]}, now, tz)
    _give_way(doc, w, emotion, STRENGTHS[strength] - was, now, tz)


def wore(doc: dict[str, Any], before: dict[str, Any], after: dict[str, Any], reason: str | None, now: datetime, tz: Any) -> None:
    """What she has on changed: what the old one brought on doesn't drop at once, and the asks are over. ``reason``: hers,
    when she did it herself; None when the user did it in the app."""
    was = before["outfit"]
    if was:
        lv = levels(doc, before, now, tz, off=False)
        for e in was["feel"]:
            doc["feelings"][e] = {"v": lv[e]["v"], "at": A._iso(now), "why": {"code": "was_outfit", "name": was.get("name") or ""}}
    doc["asks"] = None
    doc["changed_at"] = A._iso(now)
    new_name = (after["outfit"] or {}).get("name") or ""
    _note(doc, {"clothes": new_name, "why": {"text": " ".join(reason.split())[:REASON_CHARS]} if reason else {"code": "user_wore"}}, now)
    if after["outfit"]:
        was_lv, now_lv = levels(doc, before, now, tz), levels(doc, after, now, tz)
        for e in after["outfit"]["feel"]:
            if now_lv[e]["v"] - was_lv[e]["v"] >= 0.01:
                _note(doc, {"emotion": e, "from": was_lv[e]["v"], "to": now_lv[e]["v"], "why": now_lv[e]["why"]}, now)


def view(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> dict[str, Any]:
    """GET /api/mates/{id}/state: every emotion with its value and reason, and what moved them, newest first."""
    lv = levels(doc, w, now, tz)
    return {**summary(doc, w, now, tz),
            "feelings": [{"emotion": e, "v": lv[e]["v"], "word": word(lv[e]["v"]), "why": lv[e]["why"]} for e in EMOTIONS],
            "log": list(reversed(doc["log"][-30:]))}
