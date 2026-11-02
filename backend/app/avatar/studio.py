"""The Mate Create studio's fields (docs/avatar-create.md §11): what the creation agent may write on the mate being
made (``update_mate_draft``), what the user changed on the right that the agent has not seen yet (a compact
``<studio_update>`` before its next message — never stored, never a restart), and when a draft is complete enough
to become a mate.

Pure helpers; the service (app/avatar/service.py) owns the documents. The agent can write the profile (the character:
who she is), the conversation style (how she talks: speech level, address, speech habits …) and the concept — never the voice, the language model, the avatar, the default flag or any key.
"""

from __future__ import annotations

from typing import Any

from app.mate.store import FORMALITIES, LENGTHS, TONE_KEYS, TONE_LEVELS, MateError, normalize_persona, \
    normalize_prefs

# persona fields the agent may write — the character only — with their length limits (a mate's own limit is 8000 per
# field); how she talks goes into prefs (the conversation style): the speech level, the address, the speech habits
PERSONA = {"description": 4000, "personality": 1500, "greeting": 600, "instructions": 2000, "language": 8}
PREFS_TEXT = {"user_name": 40, "address": 40, "self_ref": 40, "speech_style": 2000, "avoid": 500}
# where the fields the persona had before live now
_MOVED = {"speech": "prefs.speech_style", "address": "prefs.address"}
# the concept: the studio's notes the settings don't hold (shown on the right; the avatar and the persona are made
# from them)
CONCEPT = ("pitch", "role", "interests", "backstory", "voice", "style", "look", "outfit", "palette", "mood")
CONCEPT_MAX = 600
NAME_MAX = 40
LANGS = ("ko", "en", "ja", "zh", "es", "fr", "de", "it", "pt", "vi")


class StudioError(ValueError):
    pass


def _text(v: Any, limit: int, what: str) -> str:
    if v is None:
        return ""
    if not isinstance(v, (str, int, float)) or isinstance(v, bool):
        raise StudioError(f"{what} must be text")
    s = str(v).strip()
    if len(s) > limit:
        raise StudioError(f"{what} is too long ({len(s)} characters, at most {limit})")
    return s


def agent_patch(args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    """``update_mate_draft``'s arguments → (a mate patch, a concept patch). Checked strictly: an unknown field, a
    wrong enum or an over-long text is an error the model sees (and fixes), nothing is half-applied."""
    if not isinstance(args, dict):
        raise StudioError("expected an object")
    f = args.get("fields") if isinstance(args.get("fields"), dict) else args
    allowed = {"name", "persona", "prefs", "concept"}
    unknown = sorted(set(f) - allowed)
    if unknown:
        raise StudioError(f"unknown field(s): {', '.join(unknown)} — you may write name, persona {{{', '.join(PERSONA)}}}, "
                          f"prefs {{{', '.join(PREFS_TEXT)}, formality, length, emotion, tone}}, concept "
                          f"{{{', '.join(CONCEPT)}}}. The voice, the language model and the avatar are the user's.")
    patch: dict[str, Any] = {}
    if "name" in f:
        name = _text(f["name"], NAME_MAX, "name")
        if not name:
            raise StudioError("name can't be empty")
        patch["name"] = name
    if "persona" in f:
        p = f["persona"]
        if not isinstance(p, dict):
            raise StudioError("persona must be an object")
        moved = [f"persona.{k} is now {_MOVED[k]}" for k in p if k in _MOVED]
        if moved:
            raise StudioError("how she talks is her conversation style, not her persona: " + "; ".join(moved)
                              + " — write it there (nothing was written)")
        bad = sorted(set(p) - set(PERSONA))
        if bad:
            raise StudioError(f"unknown persona field(s): {', '.join(bad)} (one of {', '.join(PERSONA)})")
        out = {k: _text(v, PERSONA[k], f"persona.{k}") for k, v in p.items()}
        if "language" in out and out["language"] not in LANGS:
            raise StudioError(f"persona.language: one of {', '.join(LANGS)}")
        try:
            normalize_persona(out)
        except MateError as exc:
            raise StudioError(str(exc)) from None
        if out:
            patch["persona"] = out
    if "prefs" in f:
        p = f["prefs"]
        if not isinstance(p, dict):
            raise StudioError("prefs must be an object")
        ok = set(PREFS_TEXT) | {"formality", "length", "emotion", "tone"}
        bad = sorted(set(p) - ok)
        if bad:
            raise StudioError(f"unknown prefs field(s): {', '.join(bad)} (one of {', '.join(sorted(ok))})")
        out: dict[str, Any] = {}
        for k, lim in PREFS_TEXT.items():
            if k in p:
                out[k] = _text(p[k], lim, f"prefs.{k}")
        if "formality" in p:
            if p["formality"] not in FORMALITIES:
                raise StudioError(f"prefs.formality: one of {', '.join(FORMALITIES)}")
            out["formality"] = p["formality"]
        if "length" in p:
            if p["length"] not in LENGTHS:
                raise StudioError(f"prefs.length: one of {', '.join(LENGTHS)}")
            out["length"] = p["length"]
        if "emotion" in p:
            if isinstance(p["emotion"], bool) or not isinstance(p["emotion"], int) or not 0 <= p["emotion"] <= 3:
                raise StudioError("prefs.emotion: 0 (off), 1 (subtle), 2 (normal) or 3 (expressive)")
            out["emotion"] = p["emotion"]
        if "tone" in p:
            t = p["tone"]
            if not isinstance(t, dict) or set(t) - set(TONE_KEYS):
                raise StudioError(f"prefs.tone: an object with {', '.join(TONE_KEYS)}")
            for k, v in t.items():
                if v not in TONE_LEVELS:
                    raise StudioError(f"prefs.tone.{k}: one of {', '.join(TONE_LEVELS)}")
            out["tone"] = dict(t)
        try:
            normalize_prefs(out)
        except MateError as exc:
            raise StudioError(str(exc)) from None
        if out:
            patch["prefs"] = out
    concept: dict[str, str] = {}
    if "concept" in f:
        c = f["concept"]
        if not isinstance(c, dict):
            raise StudioError("concept must be an object")
        bad = sorted(set(c) - set(CONCEPT))
        if bad:
            raise StudioError(f"unknown concept field(s): {', '.join(bad)} (one of {', '.join(CONCEPT)})")
        concept = {k: _text(v, CONCEPT_MAX, f"concept.{k}") for k, v in c.items()}
    if not patch and not concept:
        raise StudioError("nothing to write: give at least one field")
    return patch, concept


def user_concept(c: Any) -> dict[str, str]:
    """The user's own concept edits (same fields, cut to length rather than refused)."""
    if not isinstance(c, dict):
        raise StudioError("concept must be an object")
    return {k: str(v or "")[:CONCEPT_MAX] for k, v in c.items() if k in CONCEPT and isinstance(v, (str, int, float))}


def snapshot(mate: dict[str, Any], concept: dict[str, Any] | None) -> dict[str, Any]:
    """The draft's fields as flat paths (what the agent compares with what it last saw)."""
    p = mate.get("persona") or {}
    pr = mate.get("prefs") or {}
    tts = ((mate.get("voice") or {}).get("tts") or {})
    llm = mate.get("llm") or {}
    out: dict[str, Any] = {"name": mate.get("name") or ""}
    for k in PERSONA:
        out[f"persona.{k}"] = p.get(k) or ""
    for k in ("user_name", "address", "self_ref", "formality", "speech_style", "length", "emotion", "avoid"):
        out[f"prefs.{k}"] = pr.get(k, "")
    for k in TONE_KEYS:
        out[f"prefs.tone.{k}"] = (pr.get("tone") or {}).get(k, "auto")
    for k in CONCEPT:
        out[f"concept.{k}"] = (concept or {}).get(k) or ""
    out["voice"] = " · ".join(x for x in (tts.get("engine") or "", tts.get("voice") or "") if x)
    out["llm"] = " · ".join(x for x in (llm.get("provider") or "", llm.get("model") or "") if x)
    return out


def paths_of(patch: dict[str, Any], concept: dict[str, Any]) -> list[str]:
    out = []
    if "name" in patch:
        out.append("name")
    for k in (patch.get("persona") or {}):
        out.append(f"persona.{k}")
    for k, v in (patch.get("prefs") or {}).items():
        if k == "tone" and isinstance(v, dict):
            out += [f"prefs.tone.{t}" for t in v]
        elif k != "memory":
            out.append(f"prefs.{k}")
    out += [f"concept.{k}" for k in concept]
    if "voice" in patch:
        out.append("voice")
    if "llm" in patch:
        out.append("llm")
    return out


def patch_for(path: str, value: Any) -> tuple[dict[str, Any], dict[str, str]]:
    """One flat path back to (a mate patch, a concept patch) — the per-field undo."""
    if path == "name":
        return {"name": value}, {}
    head, _, rest = path.partition(".")
    if head == "persona" and rest in PERSONA:
        return {"persona": {rest: value}}, {}
    if head == "prefs":
        if rest.startswith("tone."):
            return {"prefs": {"tone": {rest[5:]: value}}}, {}
        return {"prefs": {rest: value}}, {}
    if head == "concept" and rest in CONCEPT:
        return {}, {rest: str(value or "")}
    raise StudioError(f"not a field that can be undone: {path}")


def _short(v: Any, n: int = 220) -> str:
    s = " ".join(str(v if v is not None else "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def update_note(seen: dict[str, Any] | None, now: dict[str, Any]) -> str:
    """What changed on the right since the agent last saw the fields (the user typed, picked, undid)."""
    if not isinstance(seen, dict):
        return ""
    lines = []
    for k, v in now.items():
        if k in seen and seen[k] != v:
            lines.append(f"- {k}: {_short(seen[k]) or '(empty)'} → {_short(v) or '(empty)'}")
    if not lines:
        return ""
    return ("<studio_update>\nThe user changed these settings of the mate on the right since your last turn "
            "(their values win; build on them, don't write them back):\n" + "\n".join(lines[:24])
            + "\n</studio_update>")


def missing(mate: dict[str, Any]) -> list[str]:
    """What a draft still needs before Create mate: a name and who she is."""
    out = []
    if not (mate.get("name") or "").strip():
        out.append("name")
    p = mate.get("persona") or {}
    if not (p.get("description") or "").strip() and not (p.get("personality") or "").strip():
        out.append("persona.description or persona.personality")
    return out


def compact(mate: dict[str, Any], concept: dict[str, Any] | None) -> dict[str, Any]:
    """The draft for get_project: only the fields that are set (short)."""
    return {k: _short(v, 400) for k, v in snapshot(mate, concept).items() if v not in ("", None, "auto")}
