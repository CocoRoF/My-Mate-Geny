"""The conversation style as flat fields: what the mate's own changes record (``{path: {from, to}}``), how they are
applied, undone and told back to the model, and the Memory tab's read-only check for memories that hold style rules.

Pure helpers; MateService owns the writes (docs/mate.md "Prompt composition").
"""

from __future__ import annotations

import unicodedata
from typing import Any

from app.mate.store import FORMALITIES, TONE_KEYS, effective_style, normalize_prefs

# the flat paths of the style (prefs) + the reply language (persona.language)
PATHS = ("formality", "address", "user_name", "self_ref", "language", "length", "emotion", "tone.warmth",
         "tone.humor", "tone.initiative", "speech_style", "avoid")


def values(mate: dict[str, Any]) -> dict[str, Any]:
    s = normalize_prefs(None, mate.get("prefs"))
    out: dict[str, Any] = {k: s[k] for k in ("formality", "address", "user_name", "self_ref", "length", "emotion",
                                             "speech_style", "avoid")}
    out["language"] = (mate.get("persona") or {}).get("language") or "ko"
    for k in TONE_KEYS:
        out[f"tone.{k}"] = s["tone"][k]
    return out


def patch_of(flat: dict[str, Any]) -> dict[str, Any]:
    """Flat paths → a mate patch (prefs + persona.language)."""
    prefs: dict[str, Any] = {}
    out: dict[str, Any] = {}
    for path, v in flat.items():
        if path == "language":
            out["persona"] = {"language": v}
        elif path.startswith("tone."):
            prefs.setdefault("tone", {})[path[5:]] = v
        elif path in PATHS:
            prefs[path] = v
    if prefs:
        out["prefs"] = prefs
    return out


def flat_args(args: dict[str, Any]) -> dict[str, Any]:
    """The tool's arguments → flat paths (only the fields it gave)."""
    out: dict[str, Any] = {}
    for k in ("formality", "address", "user_name", "self_ref", "language", "length", "emotion", "speech_style",
              "avoid"):
        if k in args and args[k] is not None:
            out[k] = args[k]
    tone = args.get("tone")
    if isinstance(tone, dict):
        for k in TONE_KEYS:
            if k in tone and tone[k] is not None:
                out[f"tone.{k}"] = tone[k]
    return out


def diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {p: {"from": before.get(p), "to": after.get(p)} for p in PATHS if before.get(p) != after.get(p)}


_LABELS = {"formality": "speech level", "address": "what you call the user", "user_name": "the user's name",
           "self_ref": "how you refer to yourself", "language": "reply language", "length": "reply length",
           "emotion": "emotion tags", "tone.warmth": "warmth", "tone.humor": "humor", "tone.initiative": "initiative",
           "speech_style": "speech habits", "avoid": "topics to avoid"}


def _short(v: Any, n: int = 60) -> str:
    s = " ".join(str("" if v is None else v).split())
    return f"“{s if len(s) <= n else s[: n - 1] + '…'}”" if s else "(empty)"


def describe(changes: dict[str, dict[str, Any]]) -> str:
    """For the model: “speech level: haeyo → banmal; what you call the user: (empty) → “하렴””."""
    parts = []
    for p, c in changes.items():
        if p == "speech_style":
            parts.append(f"{_LABELS[p]}: rewritten")
        elif p in ("formality", "length", "emotion") or p.startswith("tone."):
            parts.append(f"{_LABELS[p]}: {c['from']} → {c['to']}")
        else:
            parts.append(f"{_LABELS.get(p, p)}: {_short(c['from'])} → {_short(c['to'])}")
    return "; ".join(parts)


def summary(mate: dict[str, Any]) -> str:
    """The style as it is now, in one line for the model."""
    v = values(mate)
    eff = effective_style(mate.get("prefs"))
    bits = [f"speech level {eff['formality'] or 'not fixed'}" + (" (your character's own)" if eff["formality_default"]
                                                                  else "")]
    bits.append(f"you call the user {_short(eff['address'])}" if eff["address"] else "no fixed address")
    if v["user_name"]:
        bits.append(f"the user's name {_short(v['user_name'])}")
    if eff["self_ref"]:
        bits.append(f"you refer to yourself as {_short(eff['self_ref'])}")
    bits.append(f"reply language {v['language']}, length {v['length']}, emotion tags {v['emotion']}")
    tone = [f"{k[5:]} {v[k]}" for k in ("tone.warmth", "tone.humor", "tone.initiative") if v[k] != "auto"]
    if tone:
        bits.append("tone: " + ", ".join(tone))
    if v["avoid"]:
        bits.append(f"topics to avoid {_short(v['avoid'])}")
    return "; ".join(bits)


# ---- the Memory tab's check: memories that are really style rules (read-only; the user decides) ----
#
# Not a classifier of what the user says (the model decides that with update_conversation_style): only a hint on
# memories stored before the conversation style existed, or saved by mistake. Signals, all from the style itself:
# the words that name a speech level or a form of address (data, both languages — the same names the settings use),
# and memories of the preference / profile kind that talk about a way of speaking. A flag never deletes or moves anything; the user moves it ("Move to conversation style") or
# dismisses it.

LEVEL_TERMS = {
    "banmal": ("반말", "편하게 말", "말 놓", "casual speech", "speak casually", "talk casually", "informal"),
    "haeyo": ("존댓말", "해요체", "존대", "polite speech", "speak politely", "talk politely"),
    "hapsyo": ("합쇼체", "하십시오체", "격식체", "formal speech", "speak formally", "talk formally"),
}
ADDRESS_TERMS = ("호칭", "라고 불러", "라고 부르", "call me", "call them", "call the user", "address me",
                 "address them", "nickname")
SPEECH_TERMS = ("말투", "말버릇", "어투", "말할 때", "speaking style", "tone of voice", "way of talking", "refer to yourself")


def _norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "").lower()


def memory_flags(memories: list[dict[str, Any]], mate: dict[str, Any], dismissed: set[str] | None = None
                 ) -> dict[str, dict[str, Any]]:
    """{memory id: {"reason": formality|address|speech, "conflict": bool, "level"?: …}} for active memories that look
    like a rule about how the mate talks — duplicating (or contradicting) the conversation style."""
    eff = effective_style(mate.get("prefs"))
    out: dict[str, dict[str, Any]] = {}
    for m in memories:
        if m.get("status", "active") != "active" or m["id"] in (dismissed or set()):
            continue
        t = _norm(m.get("text") or "")
        levels = [lv for lv, terms in LEVEL_TERMS.items() if any(_norm(x) in t for x in terms)]
        if levels:
            want = levels[0] if len(levels) == 1 else None
            out[m["id"]] = {"reason": "formality", "level": want,
                            "conflict": bool(want and eff["formality"] and want != eff["formality"])}
            continue
        address = any(_norm(x) in t for x in ADDRESS_TERMS)
        speech = any(_norm(x) in t for x in SPEECH_TERMS)
        if address or (speech and m.get("kind") in ("preference", "profile")):
            out[m["id"]] = {"reason": "address" if address else "speech", "conflict": False}
    return out

