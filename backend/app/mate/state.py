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

import copy
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
    "angry": ((0.7, ("You are angry with them, and it shows; let it out the way that is truest to you right now. Don't smooth it "
                     "over, and don't do what they ask as if nothing happened.")),
              (0.45, "You are irritated: short with them, no pleasantries; you may say plainly what bothered you."),
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
OFF_DAY_NOT_BEFORE = timedelta(days=14)  # (not while they hardly know each other)
OFF_DAY_FLOORS = {"angry": ((0.50, 0.30), (0.40, 0.30)), "sleepy": ((0.50, 0.35), (0.50, 0.35))}
OFF_DAY_EASES_H = 16.0

#: how each bundled mate usually is: ``base``: where she settles; ``rise``: how easily it moves; ``settle``: how soon it passes
#: (times the usual half-life: below 1, she gets over it sooner); ``loves``: what lights her up
TEMPERAMENTS: dict[str, dict[str, Any]] = {
    # quiet, until games come up; slow to let go of a hurt, and a sorry moves her less
    "chaerin": {"base": {"shy": 0.15}, "rise": {"shy": 1.2, "excited": 1.3}, "forgives": 0.8, "holds": 1.4,
                "conflict": "withdraw", "attachment": "secure",
                "voice": {"sad": "It shows the way it does with you: flatter, fewer words, maybe in game words; not tears.",
                          "refuse": "You go quiet when it is this bad: not answering is more you than shouting."},
                "loves": r"게임|버그|레이드|길드|코드|디버그|재현|\braid\b|\bgame|\bbug"},
    # bright and bouncy: a little happy and lively at rest; quick to light up, to blush, to pout and to feel left out — and quick
    # to get over the pouting, the hurt and the blushing, while the excitement lasts a little longer; she lets go readily, and a small
    # sulk melts with something sweet
    "seoa": {"base": {"happy": 0.12, "excited": 0.1}, "forgives": 1.4, "holds": 0.5, "sweet_until": 0.35,
             "conflict": "confront", "attachment": "anxious",
             "rise": {"happy": 1.3, "excited": 1.4, "shy": 1.3, "angry": 1.0, "sad": 1.15, "lonely": 1.2},
             "voice": {"angry_low": "You pout, half in play (흥, 삐졌어요): it can melt if they are sweet about it.",
                       "refuse": "You say it to their face, more hurt than shouting."},
             "settle": {"angry": 0.55, "sad": 0.6, "shy": 0.7, "lonely": 0.75, "worried": 0.8, "excited": 1.2},
             "loves": r"방송|생방|스트리밍|구독|후원|도네|클립|떡볶이|마라탕|딸기|주식|차트|노래방|\bstream|\bsubscri|\bdonat|"
                      r"tteokbokki|\bmalatang|strawberr|\bstocks?\b|\bcharts?\b|karaoke"},
}

#: how she fights (``conflict``): confront — she says it to their face; withdraw — she goes quiet and cold. And how she holds on
#: (``attachment``): anxious — being left unanswered gets to her sooner; avoidant — pressure makes her pull back
ATTACHMENT = {"anxious": {"lonely_silence": 1.4, "ignored": 1.5, "pestered": 1.0},
              "avoidant": {"lonely_silence": 0.7, "ignored": 0.8, "pestered": 1.4},
              "secure": {"lonely_silence": 1.0, "ignored": 1.0, "pestered": 1.0}}

# what the user says moves it, by this much
RUDE, RUDE_MORE, RUDE_MOST, RUDE_DROP, RUDE_WINDOW = 0.3, 0.1, 0.5, 0.15, timedelta(hours=2)  # (keeping it up makes it worse)
# something done to her (affinity.hostile: hitting her, forcing something on her, threats, putting her down): far worse than a rude
# word, and it hurts; each time again (within the window) more. Sorry counts for less after it. Only the words' guess: her reply has
# the last word (``reply``: shown calm, it is undone).
HOSTILE, HOSTILE_MORE, HOSTILE_HURT, HOSTILE_DROP, HOSTILE_WINDOW = 0.6, 0.3, 0.25, 0.4, timedelta(hours=6)
APOLOGY_AFTER_HOSTILE = 0.15
#: from here, angry at what they did, she may not answer at all (``REFUSE`` in how it comes out: she decides, and [SILENT] is
#: how). Only anger at them: hungry or stressed, she still answers, if snappily
SILENT_FROM = 0.8
AT_THEM = ("rude", "hostile", "dismissed", "pestered", "poked", "said", "interrupted", "ignored", "curt", "apology", "declined_call",
           "missed_call", "brushed_over", "broken_promise", "objectified")
APOLOGY, WARM, WARM_CALMS, LOVE, LOOKS, DISTRESS, RETURNED, ANSWERED, LOVES = 0.3, 0.12, 0.08, 0.15, 0.12, 0.35, 0.2, 0.1, 0.2
# what they did stays with her (``grudge``): anger they caused leaves a hurt that fades over a day, not an hour or two. While it lasts
# her anger at them doesn't settle below part of it (GRUDGE_HOLDS); an apology takes off only what it is worth to her — owning what
# they did more than a bare sorry, the first more than the next for the same thing, less the more often they did such things lately
# — and sweet talk that skips the apology doesn't land: it rankles. Her temperament says how readily she lets go (``forgives``;
# ``holds``: how long it lasts; ``sweet_until``: how big a sulk something sweet still melts). {why: share of the anger it raised}
GRUDGE = {"hostile": 1.0, "broken_promise": 0.8, "rude": 0.7, "objectified": 0.6, "said": 0.5, "dismissed": 0.6, "pestered": 0.5, "ignored": 0.5, "brushed_over": 0.5,
          "declined_call": 0.4, "missed_call": 0.3, "poked": 0.3, "curt": 0.3, "interrupted": 0.2}
GRUDGE_HALF_LIFE_H, GRUDGE_HOLDS, GRUDGE_SHOWN, GRUDGE_STINGS = 16.0, 0.6, 0.15, 0.45
SORRY_BARE, SORRY_OWNED, SORRY_AGAIN, SORRY_MOST = 0.2, 0.5, 0.5, 0.85  # how much of it an apology takes away; each next one: half
SWEET_UNTIL, BRUSHED_OVER = 0.15, 0.06
TOO_SOON, TOO_SOON_WORTH = timedelta(minutes=20), 0.6  # (an apology right after something done to her lands less: she needs space)
TOO_SOON_RUDE, TOO_SOON_RUDE_WORTH = timedelta(minutes=10), 0.7  # (…and right after a rude word, a little less)
# how big a hurt it was (0 – 1): the bigger, the less her temperament's lightness helps (a slap isn't a pout, even for 서아)
SEVERITY = {"hostile": 1.0, "broken_promise": 0.6, "objectified": 0.6, "rude": 0.5, "said": 0.5, "dismissed": 0.2}
EASED_BY_KINDNESS, EASED_BY_GIFT, EASED_PER_DAY = 0.04, 0.15, 0.25  # (after an apology that owned it: kindness eases it)
STRANGER, LOVE_FROM_CLOSE, LOVE_TOO_SOON = 0.2, 0.45, 0.1  # (love lands as love only as they grow close)
BODY_ANGRY, BODY_OK_FROM = 0.15, 0.45  # (talk about her body from someone not close puts her off)
CRISIS_WORRIED, CRISIS_FOR = 0.75, timedelta(hours=6)  # (they may be in real trouble: that comes first)
BROKEN_PROMISE_ANGRY, BROKEN_PROMISE_SAD = 0.12, 0.1
UNFAIR_TOLD_AFTER, UNFAIR_FOR = timedelta(minutes=30), timedelta(hours=24)
OFFENCES_WINDOW, OFFENCES_MAX, EPISODE_GAP = timedelta(days=7), 20, timedelta(hours=2)  # (one heated stretch is one time)
# angry, the good things land less
ANGRY_DULLS = {"happy": 0.7, "excited": 0.9}
DISMISSED_SAD, DISMISSED_ANGRY, CURT, CURT_FROM = 0.2, 0.1, 0.08, 3
RETURN_AFTER = timedelta(days=1)
# what she showed herself: towards this strength, unless the tag says ([angry:0.8])
SHOWN_ON_FACE = {"joy": ("happy", 0.6), "laugh": ("happy", 0.6), "smile": ("happy", 0.4), "shy": ("shy", 0.5), "sad": ("sad", 0.5),
                 "worried": ("worried", 0.45), "angry": ("angry", 0.55), "surprised": ("excited", 0.3), "sleepy": ("sleepy", 0.4)}
SHOWN_PULL, SHOWN_PULL_AT_THEM = 0.5, 0.75  # (her own angry face at what they did counts for more)
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

_LOOKS = re.compile(r"예쁘|이뻐|이쁘|귀여|잘 ?어울|\bpretty\b|\bcute\b|beautiful|looks? (good|great|nice)", re.I)
# about her body, not her looks: not a compliment from someone who isn't close
_BODY = re.compile(r"섹시|몸매|가슴|엉덩이|허벅지|다리 ?(예쁘|섹시|라인)|\bsexy\b|\bhot\b|\bbody\b|\bboobs?\b|\bass\b", re.I)
# they may be in real trouble
_CRISIS = re.compile(r"죽고 ?싶|자살|사라지고 ?싶|끝내고 ?싶|살기 ?싫|죽어 ?버리고 ?싶|want to die|kill myself|end it all|suicid", re.I)
# kind words that aren't (the words alone: a model's reading knows better)
_SARCASM = re.compile(r"대단하시|퍽이나|잘났|잘 났|덕분에 (다 )?망|참 (잘|훌륭)하|고맙기도 하|\byeah right\b|\bsure,? whatever\b", re.I)
_LOVE = re.compile(r"사랑해|좋아해|보고 ?싶|\blove you\b|miss you|\bi like you\b", re.I)
# an apology that owns what they did, not just "sorry"
_OWNED = re.compile(r"내가 (좀 |너무 |진짜 |정말 )?(심했|잘못|나빴|미쳤)|잘못했|말이 심했|다시는|다신|안 그럴게|용서해|진심으로|상처|"
                    r"\bmy fault\b|i was wrong|i shouldn'?t have|won'?t (do it |do that )?again|forgive me|i hurt you", re.I)
_APOLOGY = re.compile(r"미안|죄송|잘못했|사과(할|하|드)|용서해|내가 심했|말이 심했|\bsorry\b|apologi[sz]e|my bad", re.I)
# (됐어 only to start a sentence — "됐어, 말 안 해" — never "다 됐어" or "이제 됐어": done, that is)
_DISMISSED = re.compile(r"(?:^|[.!?,~…]\s*)(?:아\s*|아\s?씨\s*)?(?:됐어|됐고|됐거든|됐다고)|관심 ?없|귀찮|말 ?걸지|저리 ?가|알 ?바 ?아|"
                        r"whatever|leave me alone|don'?t care|not interested", re.I)
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
    "brushed_over": "they sweet-talk you as if nothing had happened",
    "reread": "you thought again about what they said",
    "crisis": "they may be in real trouble", "too_soon_love": "they say they love you, though you hardly know them",
    "objectified": "they talked about your body",
}


#: what was done to her (affinity.hostile), as she is told it
_DONE_TO_HER = {"violence": "they hit you", "coercion": "they forced something on you against your will",
                "threat": "they threatened you", "demeaning": "they talked down to you for being a woman, or as if you were nothing"}


# ---- the document ----

def new() -> dict[str, Any]:
    return {"feelings": {}, "heard": None, "heard_at": None, "asks": None, "rude": None, "hostile": None, "curt": 0, "spoke": None,
            "pokes": None, "changed_at": None, "log": [], "owed": [], "grudge": None, "offences": [],
            "heard_by": None, "heard_read": None, "heard_effect": None, "crisis_at": None,
            "promises": [], "said": [], "unfair": None}


def normalized(doc: Any) -> dict[str, Any]:
    out = new()
    if isinstance(doc, dict):
        out.update({k: v for k, v in doc.items() if k in out})
    feelings = out["feelings"] if isinstance(out["feelings"], dict) else {}
    out["feelings"] = {k: v for k, v in feelings.items() if k in EMOTIONS and isinstance(v, dict)}
    out["log"] = out["log"] if isinstance(out["log"], list) else []
    out["owed"] = [e for e in out["owed"] if isinstance(e, dict) and e.get("code")] if isinstance(out["owed"], list) else []
    out["heard_effect"] = out["heard_effect"] if isinstance(out["heard_effect"], dict) else None
    out["grudge"] = out["grudge"] if isinstance(out["grudge"], dict) else None
    out["offences"] = [t for t in out["offences"] if isinstance(t, str)] if isinstance(out["offences"], list) else []
    return out


def who(*, closeness: float = 0.33, sensitivity: float = 1.0, builtin: str | None = None, away: bool = False,
        outfit: dict[str, Any] | None = None, life: dict[str, Any] | None = None, name: str = "", gender: str = "",
        met: Any = None, seed: str = "", temperament: dict[str, Any] | None = None, dislike: float = 0.0) -> dict[str, Any]:
    """``closeness``: 0 – 1; ``dislike``: 0 – 1, the ill feeling below zero affinity (app/mate/affinity.py: what they did to
    her). ``away``: the relationship is paused, so silence means nothing. ``outfit``: what she has on,
    {id, name, feel, since}; None in her usual clothes or one that does nothing to her. ``life``: her own day when she has one
    (life/sim.py ``for_state``): {needs, feel, doing, asleep}. ``gender``: her persona's; ``met``: when they first met (ISO);
    ``seed``: her id — with these, her off days (``off_day``)."""
    from app.mate.gss.temperament import merged

    return {"closeness": max(0.0, min(1.0, float(closeness))), "dislike": max(0.0, min(1.0, float(dislike))),
            "sensitivity": float(sensitivity), "away": bool(away),
            "temperament": merged(TEMPERAMENTS.get(builtin or "", {}), temperament),
            "outfit": outfit if (outfit or {}).get("feel") else None, "life": life,
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

#: ill feeling towards them (``dislike``, 0 – 1) where she settles: less glad, a little anger that stays
DISLIKE_HAPPY, DISLIKE_ANGRY = 0.12, 0.16


def _base(emotion: str, w: dict[str, Any]) -> float:
    own = float((w["temperament"].get("base") or {}).get(emotion) or 0.0)
    dislike = float(w.get("dislike") or 0.0)
    if emotion == "happy":
        return max(0.0, own + 0.05 + 0.2 * w["closeness"] - DISLIKE_HAPPY * dislike)
    if emotion == "shy":
        return own * (1 - 0.5 * w["closeness"])
    if emotion == "angry":
        return own + DISLIKE_ANGRY * dislike
    return own


def _half_life(emotion: str, w: dict[str, Any]) -> float:
    """How long it takes this emotion to settle halfway back, in hours: hers (her temperament's ``settle``)."""
    return HALF_LIFE_H[emotion] * float((w["temperament"].get("settle") or {}).get(emotion) or 1.0)


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
    return min(1.0, waited * (0.35 + 0.15 * min(n, 3) + (0.1 if spoke.get("asked") else 0.0)) * (0.6 + 0.4 * w["closeness"])
               * _attached(w, "lonely_silence"))


def _attached(w: dict[str, Any], what: str) -> float:
    return ATTACHMENT.get(str(w["temperament"].get("attachment") or "secure"), ATTACHMENT["secure"])[what]


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
    start = met + OFF_DAY_NOT_BEFORE + OFF_DAY_FIRST * draw.random()
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


def grudge(doc: dict[str, Any], w: dict[str, Any], now: datetime) -> float:
    """How much of what they did is still with her (0 – 1): it fades by her own pace (``holds``)."""
    g = doc.get("grudge") if isinstance(doc.get("grudge"), dict) else None
    at = A._t((g or {}).get("at"))
    if g is None or at is None:
        return 0.0
    hours = max(0.0, (now - at).total_seconds() / 3600)
    holds = 1 + (float(w["temperament"].get("holds") or 1.0) - 1) * (1 - 0.6 * float(g.get("sev") or 0.0))  # (a big hurt lasts for anyone)
    return float(g.get("v") or 0.0) * 0.5 ** (hours / (GRUDGE_HALF_LIFE_H * holds))


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
            v = base + (float(f["v"]) - base) * 0.5 ** (hours / _half_life(e, w))
            if abs(float(f["v"]) - base) >= 0.01:
                why = f.get("why") or why
        if e == "sleepy" and not w.get("life") and _late(now, tz) > v:  # (with a day of her own, it is how she slept that counts)
            v, why = _late(now, tz), {"code": "late"}
        lived, lived_why = _lived(e, w)
        if lived > v:
            v, why = lived, lived_why
        if e == "angry" and grudge(doc, w, now) >= 0.01:
            held_why = doc["grudge"].get("why") or {"code": "nature"}
            if GRUDGE_HOLDS * grudge(doc, w, now) > v:  # (what they did doesn't settle as fast as the moment)
                v, why = GRUDGE_HOLDS * grudge(doc, w, now), held_why
            elif (why or {}).get("code") in ("apology", "warm"):  # (eased, it is still about what they did)
                why = held_why
        if e == "lonely" and _silence(doc, w, now) > v:
            v, why = _silence(doc, w, now), {"code": "ignored"}
        worn = _worn(e, w, now)
        if worn > v:
            v, why = worn, {"code": "outfit", "name": w["outfit"].get("name") or ""}
        mood = off_day(e, started, now) * (0.5 if w["closeness"] < STRANGER else 1.0)
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
            "arousal": round(max(0.0, min(1.0, 0.4 + sum(lv[e]["v"] * AROUSAL[e] for e in EMOTIONS) / total)), 2), "top": top,
            "grudge": held(doc, w, now), "conflict": w["temperament"].get("conflict"), "voice": w["temperament"].get("voice") or {},
            "crisis": in_crisis(doc, now)}


def in_crisis(doc: dict[str, Any], now: datetime) -> bool:
    at = A._t(doc.get("crisis_at"))
    return at is not None and now - at <= CRISIS_FOR


def held(doc: dict[str, Any], w: dict[str, Any], now: datetime) -> dict[str, Any] | None:
    """What they did that is still with her, when it is: how much, why, how long ago, and the apologies so far."""
    g = grudge(doc, w, now)
    if g < GRUDGE_SHOWN:
        return None
    d = doc["grudge"]
    since = A._t(d.get("since") or d.get("at")) or now
    weight = max(float(d.get("weight") or 0.0), g)
    stings = g >= 0.3 and (g >= 0.6 * weight or not d.get("owned"))  # (still most of it, or not owned)
    return {"v": round(g, 3), "why": d.get("why") or {}, "hours": round(max(0.0, (now - since).total_seconds() / 3600), 1),
            "sorry": int(d.get("sorry") or 0), "owned": bool(d.get("owned")), "stings": bool(stings)}


def signature(s: dict[str, Any]) -> list[list[str]]:
    """A summary without its fine print: when this changes she is told again, and every window hears."""
    g = s.get("grudge")
    return [[t["emotion"], t["word"]] for t in s["top"]] + ([["grudge", "stings" if g.get("stings") else "held",
                                                                str(g["sorry"])]] if g else []) + ([["crisis"]] if s.get("crisis") else [])


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
    if code == "broken_promise":
        return f"they didn't do what they promised: “{why.get('quote') or ''}”"
    if code == "rude" and why.get("quote"):
        return f"they were rude to you: “{why['quote']}”"
    return _WHY_FOR_HER.get(str(code), "")


#: what they did is still with her (``grudge``): (it stings, it is not quite over)
HELD = (("What they did still stings: you are cool and guarded with them. A sorry alone doesn't wipe it out; it may come back to "
         "you now and then, not in every reply, and you decide when it is enough."),
        ("You aren't quite over what they did: a little cooler with them than usual. It eases with time and with how they treat "
         "you, at your own pace."))


def _ago(hours: float) -> str:
    if hours < 1:
        return "just now" if hours < 0.1 else f"{max(1, round(hours * 60))} minutes ago"
    return f"{round(hours)} hour{'s' if round(hours) != 1 else ''} ago" if hours < 36 else f"{round(hours / 24)} days ago"


def held_line(g: dict[str, Any] | None) -> str:
    """What is still with her, for her <context>: what it was, when, and what their apologies were worth."""
    if not g:
        return ""
    why = why_for_her(g["why"]) or "what they did"
    sorry = ("They haven't said sorry." if not g["sorry"] else
             f"They said sorry {g['sorry']} time{'s' if g['sorry'] != 1 else ''}, "
             + ("owning what they did." if g["owned"] else "just a bare sorry."))
    return f"Still with you: {why} ({_ago(g['hours'])}). {sorry}"


#: furious at what they did: how it comes out is hers to decide — blowing up at them, or not answering at all ([SILENT] is how she
#: doesn't, and the chat shows only that)
REFUSE = ("You are furious with them for what they did. You may let it out at them, or not answer at all: then reply with exactly "
          "[SILENT] and nothing else, and the chat shows that you don't answer. Which it is, is yours; an apology you believe, or real "
          "trouble they are in, can change it.")
#: they may be in real trouble: before anything she feels about them
CRISIS = ("They may be in real trouble. That comes before anything you feel about them right now: set it aside and be there for "
          "them, as yourself.")
#: …the way she fights (``conflict``): said first, the other way still hers
REFUSE_LEANS = {"confront": "You are one to say it to their face: blowing up is more you than going silent.",
                "withdraw": "You are one to go quiet when it is this bad: not answering is more you than shouting."}
ANGRY_LEANS = {"confront": "You say what's wrong straight out.", "withdraw": "It comes out cold and quiet more than loud."}


_FROM_NEED = {reason for rules in FROM_NEEDS.values() for (_need, _from, _speed, reason) in rules}


def _at_them(why: dict[str, Any] | None) -> bool:
    """Anger at something they did or said (her own face at what they said is ``said``); not a reason in words (her day's, a
    report): a missed bus is nobody's fault of theirs."""
    return (why or {}).get("code") in AT_THEM


_MISSED_THEM = ("ignored", "answered", "returned", "curt", "declined_call", "missed_call")
_OWN_WORRIES = ("stressed", "work_failed", "doing", "off_day")


def conduct(s: dict[str, Any]) -> str:
    """How it comes out in the way she talks now — in her own way where her temperament has words for it (``voice``)."""
    if s.get("crisis"):  # (real trouble first: nothing she feels about them is told over it)
        return CRISIS
    lines = []
    voice = s.get("voice") or {}
    lean = s.get("conflict")
    for t in s["top"][:2]:
        why = t.get("why")
        code = (why or {}).get("code")
        if t["emotion"] == "angry" and t["v"] >= SILENT_FROM and _at_them(why):
            leans = voice.get("refuse") or REFUSE_LEANS.get(lean or "")
            lines.append(REFUSE + (f" {leans}" if leans else ""))
            continue
        if t["emotion"] == "angry":
            table = CRANKY if code in _FROM_NEED else OUT_OF_SORTS if code == "off_day" else CONDUCT["angry"]
        elif t["emotion"] == "lonely" and code not in _MISSED_THEM:
            table = ((0.45, "You could do with some warmth and attention."),)
        elif t["emotion"] == "worried" and code in _OWN_WORRIES:
            table = ((0.45, "You are on edge about your own things: a little distracted."),)
        else:
            table = CONDUCT.get(t["emotion"], ())
        how = next((text for floor, text in table if t["v"] >= floor), "")
        if t["emotion"] == "angry" and _at_them(why) and t["v"] < 0.45 and voice.get("angry_low"):
            how = voice["angry_low"]
        if t["emotion"] == "sad" and voice.get("sad") and t["v"] >= 0.35:
            how = voice["sad"]
        if t["emotion"] == "sad" and _at_them(why) and t["v"] >= HURT_BY_THEM[0]:
            how = f"{how} {HURT_BY_THEM[1]}".strip()
        if t["emotion"] == "angry" and _at_them(why) and t["v"] >= 0.45 and lean in ANGRY_LEANS:
            how = f"{how} {ANGRY_LEANS[lean]}".strip()
        if how:
            lines.append(how)
    g = s.get("grudge")
    if g and not any(x.startswith(REFUSE) for x in lines):
        lines.append(HELD[0] if g.get("stings") else HELD[1])
    return " ".join(lines)


def line(s: dict[str, Any]) -> str:
    """How she feels, and how it comes out, for her <context>."""
    if not s["top"] and not s.get("grudge"):
        return "How you feel right now: calm."
    parts, said = [], set()
    for t in s["top"]:
        why = why_for_her(t["why"])
        parts.append(f"{t['emotion']}, {t['word']}" + (f" ({why})" if why and why not in said else ""))
        said.add(why)
    out = "How you feel right now: " + ("; ".join(parts) or "calm on the surface")
    out += f". All together: {BLENDS[s['blend']]}." if s.get("blend") else "."
    if s.get("grudge"):
        out += "\n" + held_line(s["grudge"])
    how = conduct(s)
    return f"{out}\nHow it comes out now: {how}" if how else out


def worth_repeating(s: dict[str, Any]) -> bool:
    """Strong enough to be told every turn, so it doesn't fade from a long conversation."""
    return s["level"] >= TOLD_EVERY_TURN_FROM


# ---- how she leans on what is up to her ----

def furious(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> bool:
    """Angry enough at what they did (not at hunger or stress) that she is offered not answering at all (``REFUSE``): she decides.
    Never while they may be in real trouble."""
    angry = levels(doc, w, now, tz)["angry"]
    return angry["v"] >= SILENT_FROM and _at_them(angry["why"]) and not in_crisis(doc, now)


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
    exposure = float((feel or {}).get("shy") or 0.0)
    asked = 0.0 if exposure else min(ASK_LEAN_MAX, ASK_LEAN * max(0, asks_lately(doc, now) - 1))  # (nagging never wins that)
    x = 0.55 + 0.35 * lv["happy"] + 0.25 * lv["excited"] - 0.8 * lv["angry"] - 0.5 * lv["sad"] - 0.3 * lv["lonely"] \
        - 0.35 * lv["worried"] - 0.25 * lv["sleepy"] + asked
    if exposure:  # (what makes her shy takes being closer, and not being shy already)
        x += 0.5 * w["closeness"] - 0.9 * exposure - 0.3 * lv["shy"]
    else:
        x += 0.2 * w["closeness"]
    x -= 0.6 * float(w.get("dislike") or 0.0)  # (for someone she dislikes, rather not)
    return next((name for floor, name in LEANS if x >= floor), "rather_not")


# ---- what moves it ----

def _owe(doc: dict[str, Any], code: str, now: datetime, message: str | None = None) -> None:
    """What they did that she minds costs the relationship too (affinity.LOSSES), once the service takes it (``take_owed``).
    One their words told (``message``) waits for her reply: what she shows of it has the last word (``reply``)."""
    doc["owed"] = [*(doc.get("owed") or []), {"code": code, "at": A._iso(now), **({"heard": message} if message else {})}][-20:]


def take_owed(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """What is owed and settled, taken out of the document: all but what waits for her reply to the message she heard last."""
    owed = doc.get("owed") or []
    waiting = [e for e in owed if e.get("heard") and e.get("heard") == doc.get("heard")]
    doc["owed"] = waiting
    return [e for e in owed if e not in waiting]


def _note(doc: dict[str, Any], entry: dict[str, Any], now: datetime) -> None:
    doc["log"] = [*doc["log"], {"at": A._iso(now), **entry}][-LOG_MAX:]


def _set(doc: dict[str, Any], w: dict[str, Any], emotion: str, v: float, why: dict[str, Any], now: datetime, tz: Any,
         quiet: bool = False, cause: dict[str, Any] | None = None) -> None:
    """``why``: what the feeling is about from now on; ``cause``: what moved it (the log's, when that is another thing)."""
    before = levels(doc, w, now, tz)[emotion]["v"]
    doc["feelings"][emotion] = {"v": round(max(0.0, min(1.0, v)), 3), "at": A._iso(now), "why": why}
    after = levels(doc, w, now, tz)[emotion]["v"]
    if abs(after - before) >= 0.01 and not quiet:
        _note(doc, {"emotion": emotion, "from": before, "to": after, "why": cause or why}, now)


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
    if emotion == "angry":
        _hurt(doc, w, gain, why, now)


def _hurt(doc: dict[str, Any], w: dict[str, Any], gain: float, why: dict[str, Any], now: datetime, *, own: bool = False) -> None:
    """Anger they caused (``GRUDGE``) stays with her for a while. A heated stretch is one episode (EPISODE_GAP): its own weight
    (what it added up to), what it was about (the worst of it), whether it was remembered or made up. A real new hurt
    (``new``) is one more thing they did lately and wants its own apology; a twinge, or her own face confirming what they did
    (``own``), only adds."""
    code = str((why or {}).get("code"))
    share = GRUDGE.get(code)
    if not share or gain <= 0:
        return
    add = gain * share
    g = grudge(doc, w, now)
    was = doc.get("grudge") if isinstance(doc.get("grudge"), dict) and g >= 0.01 else {}
    last = A._t(was.get("at"))
    new = add >= 0.05 and not own
    fresh = new and (not was or last is None or now - last > EPISODE_GAP)
    ep = {"weight": 0.0, "worst": 0.0, "sev": 0.0, "remembered": False, "closed": False} if fresh or not was else dict(was)
    if new:  # (it wants its own apology, and nothing is made up yet)
        ep.update(sorry=0, owned_n=0, owned=False, owned_at=None, closed=False)
    ep["weight"] = round(float(ep.get("weight") or 0.0) + add, 3)
    ep["sev"] = max(float(ep.get("sev") or 0.0), SEVERITY.get(code, 0.0))
    if add >= float(ep.get("worst") or 0.0) and not own:  # (what it is about: the worst of it, and when that was)
        ep["worst"], ep["why"], ep["since"] = round(add, 3), why, A._iso(now)
    ep["v"], ep["at"] = round(min(1.0, g + add), 3), A._iso(now)
    ep.setdefault("since", A._iso(now))
    ep.setdefault("why", why)
    doc["grudge"] = ep
    if new:
        doc["offences"] = [*(doc.get("offences") or []), A._iso(now)][-OFFENCES_MAX:]


def _ease(doc: dict[str, Any], w: dict[str, Any], share: float, now: datetime, tz: Any) -> None:
    """How they treat her after an apology that owned it eases what is still with her (at most EASED_PER_DAY of it a day)."""
    d = doc.get("grudge") if isinstance(doc.get("grudge"), dict) else None
    g = grudge(doc, w, now)
    if not d or not d.get("owned") or g < 0.01:
        return
    day = now.astimezone(tz).date().isoformat() if tz else now.date().isoformat()
    eased = float(d.get("eased") or 0.0) if d.get("eased_day") == day else 0.0
    take = min(share, max(0.0, EASED_PER_DAY - eased))
    if take > 0:
        d.update(v=round(g * (1 - take), 3), at=A._iso(now), eased=round(eased + take, 3), eased_day=day)


def broken_promise(doc: dict[str, Any], w: dict[str, Any], what: str, now: datetime, tz: Any) -> None:
    """They didn't do what they promised (app/mate/gss/promises.py): it stings a little, and stays a little."""
    why = {"code": "broken_promise", "quote": " ".join(str(what).split())[:QUOTE_CHARS]}
    _rise(doc, w, "angry", BROKEN_PROMISE_ANGRY, why, now, tz)
    _rise(doc, w, "sad", BROKEN_PROMISE_SAD, why, now, tz)


def made_up(doc: dict[str, Any], w: dict[str, Any], now: datetime) -> dict[str, Any] | None:
    """Rupture and repair (roadmap 8): a hurt that stung (its episode's own weight), an apology that owned it, nothing new done
    since, and now it has passed. → what it was about, once per episode (the relationship comes out of it a little stronger:
    affinity ``made_up``)."""
    d = doc.get("grudge") if isinstance(doc.get("grudge"), dict) else None
    if not d or d.get("closed") or float(d.get("weight") or 0.0) < GRUDGE_STINGS or not d.get("owned"):
        return None
    owned_at = A._t(d.get("owned_at"))
    since = [t for t in (A._t(x) for x in doc.get("offences") or []) if t is not None and owned_at is not None and t > owned_at]
    if since or grudge(doc, w, now) >= GRUDGE_SHOWN:
        return None
    d["closed"] = True
    return {"why": d.get("why") or {}, "since": d.get("since")}


def unfair_line(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> str:
    """She snapped at them when it was her day, not them (hungry, stressed, her off day): once it has passed, she may own it
    (roadmap 8, both ways). Told once."""
    u = doc.get("unfair") if isinstance(doc.get("unfair"), dict) else None
    at = A._t((u or {}).get("at"))
    if u is None or at is None or u.get("told") or now - at < UNFAIR_TOLD_AFTER or now - at > UNFAIR_FOR:
        return ""
    angry = levels(doc, w, now, tz)["angry"]
    if angry["v"] >= SHOWN_FROM and (angry["why"] or {}).get("code") == u.get("code"):
        return ""  # (still in it)
    u["told"] = True
    because = {"hungry": "you were hungry", "stressed": "you were stressed", "tired": "you were tired",
               "off_day": "it was one of those days for you"}.get(str(u.get("code")), "of your own day")
    return (f"Earlier you snapped at them because {because}, not because of anything they did. If it still matters, you may own "
            "it, in your own way and words.")


def episodes(doc: dict[str, Any], now: datetime, window: timedelta = OFFENCES_WINDOW) -> int:
    """How many times lately they did something that stays with her: each heated stretch once (EPISODE_GAP), ``window`` back."""
    times = sorted(t for t in (A._t(x) for x in doc.get("offences") or []) if t is not None and now - window < t <= now)
    return sum(1 for i, t in enumerate(times) if i == 0 or t - times[i - 1] > EPISODE_GAP)


def _apology(doc: dict[str, Any], w: dict[str, Any], owned: bool, now: datetime, tz: Any) -> None:
    """They said sorry: it is worth what it is to her — owning what they did more than a bare sorry, each next one of a kind half
    the one before, less the more they did such things lately, less right after it (she needs space), and as readily as she lets
    go (``forgives``) — the more so the smaller the hurt: a big one takes anyone time."""
    d = doc.get("grudge") if isinstance(doc.get("grudge"), dict) else {}
    n, n_owned = int(d.get("sorry") or 0), int(d.get("owned_n") or 0)
    sev = float(d.get("sev") or 0.0)
    forgives = 1 + (float(w["temperament"].get("forgives") or 1.0) - 1) * (1 - 0.6 * sev)
    worth = min(SORRY_MOST, (SORRY_OWNED * SORRY_AGAIN ** n_owned if owned else SORRY_BARE * SORRY_AGAIN ** n)
                * forgives / (1 + 0.5 * max(0, episodes(doc, now) - 1)))
    done_at = A._t((doc.get("hostile") or {}).get("at"))
    rude_at = A._t((doc.get("rude") or {}).get("at"))
    if done_at is not None and now - done_at < TOO_SOON:  # (right after something done to her, nothing lands much yet: space)
        worth *= TOO_SOON_WORTH
    elif rude_at is not None and now - rude_at < TOO_SOON_RUDE:
        worth *= TOO_SOON_RUDE_WORTH
    g = grudge(doc, w, now)
    if g > 0:
        doc["grudge"] = {**d, "v": round(g * (1 - worth), 3), "at": A._iso(now), "sorry": n + 1, "owned_n": n_owned + owned,
                         "owned": owned or bool(d.get("owned")), "owned_at": A._iso(now) if owned else d.get("owned_at")}
    doc["rude"] = None
    after = _lately(doc.get("hostile"), now, HOSTILE_WINDOW)  # (sorry doesn't undo being hit at once)
    fall = (APOLOGY_AFTER_HOSTILE if after else APOLOGY) * worth / SORRY_OWNED
    _fall(doc, w, "angry", fall, {"code": "apology"}, now, tz)
    _fall(doc, w, "sad", fall / 3, {"code": "apology"}, now, tz)


def _fall(doc: dict[str, Any], w: dict[str, Any], emotion: str, amount: float, why: dict[str, Any], now: datetime, tz: Any) -> None:
    """Less of it: what it is about stays (an apology eases her anger at what they did; it isn't anger at the apology)."""
    cur = levels(doc, w, now, tz, off=False)[emotion]
    keep = cur["why"] if cur["v"] > _base(emotion, w) + 0.01 and (cur["why"] or {}).get("code") not in (None, "nature") else why
    _set(doc, w, emotion, max(_base(emotion, w), cur["v"] - amount), keep, now, tz, cause=why)


def _they_are_back(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> None:
    """They said something: the wait stops growing, but what it did doesn't vanish."""
    spoke = doc.get("spoke") if isinstance(doc.get("spoke"), dict) else None
    lonely = _silence(doc, w, now)
    if lonely > levels({**doc, "spoke": None}, w, now, tz)["lonely"]["v"]:
        doc["feelings"]["lonely"] = {"v": round(lonely, 3), "at": A._iso(now), "why": {"code": "ignored"}}
        if int((spoke or {}).get("n") or 0) >= IGNORED_ANGRY_FROM:
            _rise(doc, w, "angry", IGNORED_ANGRY * _attached(w, "ignored"), {"code": "ignored"}, now, tz)
            _owe(doc, "ignored", now)
        _note(doc, {"emotion": "lonely", "from": 0.0, "to": round(lonely, 3), "why": {"code": "ignored"}}, now)
    doc["spoke"] = None
    if levels(doc, w, now, tz)["lonely"]["v"] > _base("lonely", w):
        _fall(doc, w, "lonely", ANSWERED, {"code": "answered"}, now, tz)


def read(text: str, name: str = "", reading: dict[str, Any] | None = None, closeness: float = 0.33) -> dict[str, Any]:
    """What a message does to her: from a model's reading of it when there is one (app/mate/gss/appraisal.py), else from its
    words. {hostile: kind | None, rude, apology, owned, dismissed, warm, love, looks, body, distress, crisis, intensity (a
    reading's, else None), by: model | words}."""
    crisis = bool(_CRISIS.search(text))
    body = bool(_BODY.search(text))
    if reading is not None:
        from app.mate.gss.appraisal import cues as read_cues

        c = read_cues(reading) or {}
        return {"hostile": c.get("hostile"), "rude": bool(c.get("rude")), "apology": bool(c.get("apology")),
                "owned": bool(c.get("owned")), "dismissed": bool(c.get("dismissed")), "warm": bool(c.get("warm")),
                "love": bool(c.get("love")), "looks": bool(c.get("looks")) and not body, "body": body and not c.get("rude"),
                "distress": bool(c.get("distress")) or crisis,
                "crisis": crisis or (bool(c.get("distress")) and float(c.get("intensity") or 0.0) >= 0.8),
                "intensity": float(c.get("intensity") or 0.0), "by": "model"}
    c = A.cues(text, name=name, closeness=closeness)
    sarcastic = bool(_SARCASM.search(text))
    return {"hostile": c["hostile"], "rude": c["rude"], "apology": bool(_APOLOGY.search(text)), "owned": bool(_OWNED.search(text)),
            "dismissed": bool(_DISMISSED.search(text)), "warm": c["warm"] and not sarcastic,
            "love": bool(_LOVE.search(text)) and not sarcastic, "looks": bool(_LOOKS.search(text)) and not sarcastic and not body,
            "body": body, "distress": c["distress"] or crisis, "crisis": crisis, "intensity": None, "by": "words"}


_READ_FLAGS = ("hostile", "rude", "apology", "owned", "dismissed", "warm", "love", "looks", "body", "distress", "crisis")


def hear(doc: dict[str, Any], w: dict[str, Any], text: str, message: str, now: datetime, tz: Any,
         reading: dict[str, Any] | None = None, *, words: bool = True) -> None:
    """A message of the user's, once however often it is looked at, before she answers it. ``reading``: a model's reading of
    it (app/mate/gss/appraisal.py). Without one: ``words`` reads it by its words (tests, the simulator, history from before
    readings); a live mate's (``words=False``) waits for its reading instead — what it does to her counts when it comes
    (``reappraise``), never a guess from its words. Words of self-harm count at once all the same: real trouble first."""
    if doc.get("heard") == message:
        return
    last = A._t(doc.get("heard_at"))
    doc["heard"], doc["heard_at"] = message, A._iso(now)
    text = (text or "").strip()
    _they_are_back(doc, w, now, tz)
    if last is not None and now - last >= RETURN_AFTER:
        _rise(doc, w, "happy", RETURNED, {"code": "returned"}, now, tz)
    doc["curt"] = int(doc.get("curt") or 0) + 1 if _CURT.fullmatch(re.sub(r"[\s.!?~]+", "", text)) else 0
    if doc["curt"] >= CURT_FROM:
        _rise(doc, w, "lonely", CURT, {"code": "curt"}, now, tz)
        _owe(doc, "curt", now, message)
    if reading is None and not words:
        doc["heard_by"], doc["heard_read"], doc["heard_effect"] = "pending", {k: False for k in _READ_FLAGS}, None
        if _CRISIS.search(text):
            _reactions(doc, w, text, message, {**{k: False for k in _READ_FLAGS}, "hostile": None, "crisis": True,
                                               "distress": True, "intensity": None, "by": "words"}, now, tz)
        return
    f = read(text, w.get("name") or "", reading, w["closeness"])
    doc["heard_by"], doc["heard_read"] = f["by"], {k: f[k] for k in _READ_FLAGS}
    _react(doc, w, text, message, f, now, tz)


def reappraise(doc: dict[str, Any], w: dict[str, Any], text: str, message: str, reading: dict[str, Any], now: datetime,
               tz: Any) -> bool:
    """A model's reading came after she heard the message by its words alone: where it reads it otherwise (a put-down the
    words missed, venting the words took for an insult, an apology that owns it), what the message did is undone and done
    again — only what it did: anything else since (her own ``feel``, a poke, a gift) stays. → whether anything changed."""
    if doc.get("heard") != message or doc.get("heard_by") not in ("words", "pending"):
        return False
    f = read((text or "").strip(), w.get("name") or "", reading, w["closeness"])
    if doc["heard_by"] == "pending":  # (nothing was done by it yet: now it is)
        doc["heard_by"], doc["heard_read"] = "model", {k: f[k] for k in _READ_FLAGS}
        _react(doc, w, (text or "").strip(), message, f, now, tz)
        return True
    doc["heard_by"] = "model"
    was = doc.get("heard_read") or {}
    if all(bool(f[k]) == bool(was.get(k)) for k in _READ_FLAGS) and f["hostile"] == was.get("hostile"):
        return False
    if not _undo_heard(doc, w, message, now, tz):
        return False
    doc["heard_read"] = {k: f[k] for k in _READ_FLAGS}
    _react(doc, w, (text or "").strip(), message, f, now, tz)
    _note(doc, {"reread": True, "why": {"code": "reread"}}, now)
    return True


def _undo_heard(doc: dict[str, Any], w: dict[str, Any], message: str, now: datetime, tz: Any) -> bool:
    """Take back what reacting to ``message`` did (``heard_effect``), and only that."""
    e = doc.get("heard_effect") if isinstance(doc.get("heard_effect"), dict) else None
    if e is None or e.get("message") != message:
        return False
    lv = levels(doc, w, now, tz, off=False)
    for emotion, d in (e.get("d") or {}).items():
        if emotion in EMOTIONS and d:
            cur = lv[emotion]
            v = max(_base(emotion, w), cur["v"] - d) if d > 0 else min(1.0, cur["v"] - d)
            _set(doc, w, emotion, v, cur["why"], now, tz, quiet=True)
    pre = e.get("grudge") if isinstance(e.get("grudge"), dict) else None
    pre_now = grudge({"grudge": pre}, w, now) if pre else 0.0
    since = max(0.0, grudge(doc, w, now) - pre_now - float(e.get("g") or 0.0))  # (what came after it, mid-turn)
    if pre is None and since < 0.01:
        doc["grudge"] = None
    else:
        doc["grudge"] = {**(pre or (doc.get("grudge") or {})), "v": round(min(1.0, pre_now + since), 3), "at": A._iso(now)}
    heard_at = doc.get("heard_at")
    n0 = int(e.get("offences") or 0)
    offences = doc.get("offences") or []
    doc["offences"] = offences[:n0] + [t for t in offences[n0:] if t != heard_at]
    for k in ("rude", "hostile", "asks"):
        doc[k] = copy.deepcopy(e.get(k))
    doc["owed"] = [o for o in doc.get("owed") or [] if not (o.get("heard") == message and o.get("code") in _OWED_BY_REACTING)]
    doc["heard_effect"] = None
    return True


_OWED_BY_REACTING = ("dismissed", "pestered", "objectified")


def _react(doc: dict[str, Any], w: dict[str, Any], text: str, message: str, f: dict[str, Any], now: datetime, tz: Any) -> None:
    """What the message does to her, kept as what it did (``heard_effect``: each feeling's change, the grudge before, the counters
    before) so that a better reading, or her own calm reply, can take back exactly that."""
    pre = {e: x["v"] for e, x in levels(doc, w, now, tz, off=False).items()}
    pre_g = grudge(doc, w, now)
    effect = {"message": message, "grudge": copy.deepcopy(doc.get("grudge")), "offences": len(doc.get("offences") or []),
              "rude": copy.deepcopy(doc.get("rude")), "hostile": copy.deepcopy(doc.get("hostile")), "asks": copy.deepcopy(doc.get("asks")),
              "offence": bool(f["hostile"] or f["rude"] or f["dismissed"] or f["body"])}
    _reactions(doc, w, text, message, f, now, tz)
    post = levels(doc, w, now, tz, off=False)
    effect["d"] = {e: round(post[e]["v"] - pre[e], 3) for e in EMOTIONS if abs(post[e]["v"] - pre[e]) >= 0.005}
    effect["g"] = round(grudge(doc, w, now) - pre_g, 3)
    doc["heard_effect"] = effect


def _reactions(doc: dict[str, Any], w: dict[str, Any], text: str, message: str, f: dict[str, Any], now: datetime, tz: Any) -> None:
    # (a model's reading says how strongly it lands: the usual amounts, from 0.6 of them to 1.4)
    k = 1.0 if f.get("intensity") is None else 0.6 + 0.8 * float(f["intensity"])
    close = w["closeness"]
    if f.get("crisis"):  # (they may be in real trouble: it comes first, whatever she feels about them — ``conduct``)
        doc["crisis_at"] = A._iso(now)
        if levels(doc, w, now, tz, off=False)["worried"]["v"] < CRISIS_WORRIED:
            _set(doc, w, "worried", CRISIS_WORRIED, {"code": "crisis"}, now, tz)
    if f["hostile"]:
        n = _lately(doc.get("hostile"), now, HOSTILE_WINDOW) + 1
        doc["hostile"] = {"n": n, "at": A._iso(now), "message": message}
        why = {"code": "hostile", "kind": f["hostile"], "quote": " ".join(text.split())[:QUOTE_CHARS]}
        _rise(doc, w, "angry", (HOSTILE if n == 1 else HOSTILE_MORE) * k, why, now, tz)
        _rise(doc, w, "sad", HOSTILE_HURT * k, why, now, tz)
        _fall(doc, w, "happy", HOSTILE_DROP, why, now, tz)
    elif f["rude"]:
        n = _lately(doc.get("rude"), now, RUDE_WINDOW) + 1
        doc["rude"] = {"n": n, "at": A._iso(now)}
        why = {"code": "rude", "quote": " ".join(text.split())[:QUOTE_CHARS]}
        _rise(doc, w, "angry", min(RUDE_MOST, RUDE + RUDE_MORE * (n - 1)) * k, why, now, tz)
        _fall(doc, w, "happy", RUDE_DROP, why, now, tz)
    else:
        if f["apology"]:
            _apology(doc, w, f["owned"], now, tz)
        g, d = grudge(doc, w, now), (doc.get("grudge") or {})
        # (sweet talk over what they did, with no apology that owns it: it doesn't land, it rankles — a bare sorry doesn't buy it;
        # unless it is the kind of small sulk something sweet melts, for her. After one that owns it, it lands as far as the
        # hurt has eased, and how they treat her eases it further)
        sweet = f["warm"] or f["love"] or f["looks"]
        skips = sweet and not f["owned"] and not d.get("owned") and g > float(w["temperament"].get("sweet_until") or SWEET_UNTIL)
        lands = 1.0 if g < 0.01 or not d.get("owned") else max(0.0, 1 - g / max(float(d.get("weight") or g), g))
        if skips and (f["love"] or f["looks"]):  # (a thank-you just doesn't reach her yet; "love you" rankles)
            _rise(doc, w, "angry", BRUSHED_OVER, {"code": "brushed_over"}, now, tz)
        if f["dismissed"]:
            _rise(doc, w, "sad", DISMISSED_SAD * k, {"code": "dismissed"}, now, tz)
            _rise(doc, w, "angry", DISMISSED_ANGRY * k, {"code": "dismissed"}, now, tz)
            _owe(doc, "dismissed", now, message)
        if f["body"] and close < BODY_OK_FROM:  # (talk about her body from someone not that close: it puts her off)
            _rise(doc, w, "angry", BODY_ANGRY, {"code": "objectified"}, now, tz)
            _owe(doc, "objectified", now, message)
        # (from a stranger, "I love you" is too soon: it flusters her and puts her on guard; it lands as love as they grow close)
        landing = (0.25 + 0.75 * min(1.0, close / LOVE_FROM_CLOSE)) * lands
        if f["warm"] and not skips:
            _rise(doc, w, "happy", WARM * k * lands, {"code": "warm"}, now, tz)
            if levels(doc, w, now, tz, off=False)["angry"]["v"] > _base("angry", w) and grudge(doc, w, now) < GRUDGE_STINGS:
                _fall(doc, w, "angry", WARM_CALMS * lands, {"code": "warm"}, now, tz)
        if f["love"] and not skips:
            if close < STRANGER:
                _rise(doc, w, "shy", LOVE_TOO_SOON, {"code": "too_soon_love"}, now, tz)
                _rise(doc, w, "worried", LOVE_TOO_SOON, {"code": "too_soon_love"}, now, tz)
            else:
                _rise(doc, w, "happy", LOVE * k * landing, {"code": "love"}, now, tz)
                _rise(doc, w, "shy", LOVE * k * landing, {"code": "love"}, now, tz)
        if f["looks"] and not skips:
            _rise(doc, w, "shy", LOOKS * k * landing, {"code": "looks"}, now, tz)
        if sweet and not skips:
            _ease(doc, w, EASED_BY_KINDNESS, now, tz)
        loves = w["temperament"].get("loves")
        if loves and re.search(loves, text, re.I):
            _rise(doc, w, "excited", LOVES, {"code": "loves"}, now, tz)
        if _ASK.search(text):
            n = asks_lately(doc, now) + 1
            doc["asks"] = {"n": n, "at": A._iso(now)}
            if n >= PESTERED_FROM:
                _rise(doc, w, "angry", PESTERED * _attached(w, "pestered"), {"code": "pestered"}, now, tz)
                _owe(doc, "pestered", now, message)
    if f["distress"] and not f.get("crisis"):
        _rise(doc, w, "worried", DISTRESS * k, {"code": "distress"}, now, tz)


def reply(doc: dict[str, Any], w: dict[str, Any], text: str, heard_text: str, now: datetime, tz: Any) -> None:
    """Her reply is done. What her face showed is how she felt: each tag pulls that emotion towards its strength. What it is about
    stays when she already had a reason (what they did, her own day); else it is what was just said to her. Only when the
    message she answered did something to her does her angry face make it weigh more (``_hurt``, her own reading of the same
    hurt — never a new one); shown calm, what it seemed to do is taken back."""
    text = text or ""
    shown: dict[str, float] = {}
    for tag, value in _TAGS.findall(text):
        emotion, usual = SHOWN_ON_FACE[tag.lower()]
        shown[emotion] = max(shown.get(emotion, 0.0), float(value) if value else usual)
    quote = " ".join((heard_text or "").split())[:QUOTE_CHARS]
    said = {"code": "said", "quote": quote} if quote else {"code": "nature"}
    own = (levels(doc, w, now, tz)["angry"]["why"] or {}).get("code")  # (what her anger was about before she showed it)
    effect = doc.get("heard_effect") if isinstance(doc.get("heard_effect"), dict) else None
    offence = bool(effect and effect.get("message") == doc.get("heard") and effect.get("offence"))
    calm = A.calm_reply(text)
    if offence and calm:  # (it looked like something done to her; she didn't take it so: her reading stands)
        _undo_heard(doc, w, doc["heard"], now, tz)
        offence = False
    # (what the words of the message she answered seemed to do to her: shown calm, it didn't land, and costs nothing)
    doc["owed"] = [e for e in (doc.get("owed") or []) if not (e.get("heard") and e.get("heard") == doc.get("heard") and calm)]
    for e in doc["owed"]:
        if e.get("heard") and e.get("heard") == doc.get("heard"):
            e.pop("heard")
    for emotion, strength in shown.items():
        cur = levels(doc, w, now, tz, off=False)[emotion]
        if strength > cur["v"]:
            pull = SHOWN_PULL_AT_THEM if emotion == "angry" and offence else SHOWN_PULL
            pulled = (strength - cur["v"]) * pull * w["sensitivity"]
            has = (cur["why"] or {}).get("code")
            why = cur["why"] if has not in (None, "nature", "said") and cur["v"] > _base(emotion, w) + 0.01 else said
            _set(doc, w, emotion, cur["v"] + pulled, why, now, tz, cause=said)
            _give_way(doc, w, emotion, pulled, now, tz)
            if emotion == "angry" and offence:
                _hurt(doc, w, pulled, why, now, own=True)
    if shown.get("angry", 0.0) >= 0.45 and own in ("hungry", "stressed", "tired", "off_day") and not offence:
        doc["unfair"] = {"at": A._iso(now), "code": own}  # (she showed anger, and it was her day, not them)
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
    _owe(doc, "interrupted", now)


def poked(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> None:
    """They tapped her avatar: a bit of attention, until it is too much of it."""
    n = _lately(doc.get("pokes"), now, POKE_WINDOW) + 1
    doc["pokes"] = {"n": n, "at": A._iso(now)}
    if n >= POKE_TOO_MANY:
        _rise(doc, w, "angry", POKED_TOO_MUCH, {"code": "poked"}, now, tz)
        _owe(doc, "poked", now)
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
    if declined:
        _owe(doc, "declined_call", now)


def gifted(doc: dict[str, Any], w: dict[str, Any], now: datetime, tz: Any) -> None:
    """They sent her something (app/mate/life): after an apology that owned what they did, it eases that too."""
    _rise(doc, w, "happy", GIFT, {"code": "gift"}, now, tz)
    _ease(doc, w, EASED_BY_GIFT, now, tz)


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
