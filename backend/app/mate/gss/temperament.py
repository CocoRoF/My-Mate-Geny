"""A temperament for every mate (docs/geny-state-system.md, roadmap 7). 한채린 and 서아 carry hand-made numbers
(state.TEMPERAMENTS); any other mate gets hers read from her persona by a model, once (``derive``), kept in her prefs
(``prefs.temperament``) and editable in the Studio. It says how she is at rest, how easily each feeling rises and passes, what
lights her up, how readily she forgives and lets go, how she fights (``conflict``) and how she holds on (``attachment``)."""

from __future__ import annotations

import json
import re
from typing import Any

EMOTIONS = ("happy", "excited", "shy", "angry", "sad", "lonely", "worried", "sleepy")
CONFLICT = ("confront", "withdraw")
ATTACHMENT = ("secure", "anxious", "avoidant")
RANGES = {"base": (0.0, 0.3), "rise": (0.5, 1.8), "settle": (0.4, 2.0), "forgives": (0.5, 1.6), "holds": (0.4, 2.0),
          "sweet_until": (0.05, 0.45)}

PROMPT = """\
Read this character and say how her feelings work, as numbers for an emotion engine. Return one JSON object and nothing else:
{"base": {emotion: 0-0.3 where she rests, only the ones above 0},
 "rise": {emotion: 0.5-1.8 how easily it rises (1 = usual)},
 "settle": {emotion: 0.4-2.0 how long it lasts (below 1 she gets over it sooner)},
 "forgives": 0.5-1.6, "holds": 0.4-2.0 (how long a hurt stays with her, 1 = about a day),
 "sweet_until": 0.05-0.45 (how big a sulk something sweet still melts),
 "conflict": "confront" | "withdraw", "attachment": "secure" | "anxious" | "avoidant",
 "loves": ["a few words or topics that light her up, in the languages she speaks"]}
Emotions: happy, excited, shy, angry, sad, lonely, worried, sleepy. Leave out what is usual for her. Go by the character's \
text only; don't invent traits it doesn't suggest."""


def clean(raw: Any) -> dict[str, Any]:
    """A temperament as the engine takes it: known keys, clamped (anything else dropped)."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in ("base", "rise", "settle"):
        lo, hi = RANGES[key]
        d = raw.get(key)
        if isinstance(d, dict):
            vals = {e: round(max(lo, min(hi, float(v))), 2) for e, v in d.items()
                    if e in EMOTIONS and isinstance(v, (int, float)) and not isinstance(v, bool)}
            if vals:
                out[key] = vals
    for key in ("forgives", "holds", "sweet_until"):
        v = raw.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            lo, hi = RANGES[key]
            out[key] = round(max(lo, min(hi, float(v))), 2)
    if raw.get("conflict") in CONFLICT:
        out["conflict"] = raw["conflict"]
    if raw.get("attachment") in ATTACHMENT:
        out["attachment"] = raw["attachment"]
    loves = raw.get("loves")
    if isinstance(loves, list):
        words = [" ".join(str(x).split())[:30] for x in loves if isinstance(x, str) and str(x).strip()][:12]
        if words:
            out["loves"] = words
    return out


def loves_pattern(loves: Any) -> str | None:
    """A ``loves`` list of words → the pattern state.py matches (a bundled one is a pattern already)."""
    if isinstance(loves, str):
        return loves or None
    if isinstance(loves, list) and loves:
        return "|".join(re.escape(x) for x in loves if x)
    return None


def merged(bundled: dict[str, Any], custom: dict[str, Any] | None) -> dict[str, Any]:
    """The bundled temperament (a built-in's, else none) with her own over it, key by key."""
    out = dict(bundled or {})
    for k, v in clean(custom or {}).items():
        out[k] = {**(out.get(k) or {}), **v} if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    if "loves" in out:
        out["loves"] = loves_pattern(out["loves"])
    return out


def request(persona: dict[str, Any], name: str) -> tuple[str, str]:
    who = "\n\n".join(str(persona.get(k) or "").strip() for k in ("description", "personality") if persona.get(k))
    return PROMPT, f"Character: {name}\n\n{who[:6000]}"


def parse(raw: str) -> dict[str, Any]:
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        return {}
    try:
        return clean(json.loads(m.group(0)))
    except ValueError:
        return {}
