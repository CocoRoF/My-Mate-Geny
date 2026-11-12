"""The Mate Create studio's fields (docs/avatar-create.md §11): what the creation agent may write on the mate being
made (``update_mate_draft``), what the user changed on the right that the agent has not seen yet (a compact
``<studio_update>`` before its next message — never stored, never a restart), and when a draft is complete enough
to become a mate.

Pure helpers; the service (app/avatar/service.py) owns the documents. The agent can write the profile (the character:
who she is), the conversation style (how she talks: speech level, address, speech habits …) and the concept — never the voice, the language model, the avatar, the default flag or any key.
Of an avatar the user brought (a Live2D model, a LivLiv package) it sees what the model has (``avatar_view``) and maps
those expressions and motions to her emotions (``emotion_map``).
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import unquote

from app.mate import files
from app.mate.prompt import EMOTION_TAGS
from app.mate.store import FORMALITIES, LENGTHS, TONE_KEYS, TONE_LEVELS, MateError, normalize_persona, \
    normalize_prefs

# persona fields the agent may write — the character only — with their length limits (a mate's own limit is 8000 per
# field); how she talks goes into prefs (the conversation style): the speech level, the address, the speech habits
PERSONA = {"description": 4000, "personality": 1500, "greeting": 600, "instructions": 2000, "language": 8}
# who she is (``gender``: female | male, "" = not said): character data the app uses and nothing shows — so it is written at
# the top of the fields, not as a persona text, and never shows as a filled field on the right
GENDERS = ("female", "male", "")
HIDDEN = ("gender",)
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
    allowed = {"name", "gender", "persona", "prefs", "concept"}
    unknown = sorted(set(f) - allowed)
    if unknown:
        raise StudioError(f"unknown field(s): {', '.join(unknown)} — you may write name, gender (female|male), persona "
                          f"{{{', '.join(PERSONA)}}}, prefs {{{', '.join(PREFS_TEXT)}, formality, length, emotion, tone}}, "
                          f"concept {{{', '.join(CONCEPT)}}}. The voice, the language model and the avatar are the user's.")
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
            raise StudioError(f"unknown persona field(s): {', '.join(bad)} (one of {', '.join(PERSONA)})"
                              + ("; gender is written at the top: fields.gender" if "gender" in bad else ""))
        out = {k: _text(v, PERSONA[k], f"persona.{k}") for k, v in p.items()}
        if "language" in out and out["language"] not in LANGS:
            raise StudioError(f"persona.language: one of {', '.join(LANGS)}")
        try:
            normalize_persona(out)
        except MateError as exc:
            raise StudioError(str(exc)) from None
        if out:
            patch["persona"] = out
    if "gender" in f:
        g = _text(f["gender"], 8, "gender").lower()
        if g not in GENDERS:
            raise StudioError("gender: female or male (or \"\" when the character has none)")
        patch["persona"] = {**(patch.get("persona") or {}), "gender": g}
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


def _model3(url: Any, mate_id: str) -> dict[str, Any]:
    """The ``*.model3.json`` behind a Live2D avatar's URL (her assets or a bundled character's), or {}."""
    path = unquote(str(url or "").split("?")[0])
    try:
        own, builtin = f"/api/mates/{mate_id}/assets/", "/api/mates/builtin/"
        if path.startswith(own):
            f = files.resolve_asset(mate_id, path[len(own):])
        elif path.startswith(builtin):
            key, _, rel = path[len(builtin):].partition("/")
            f = files.resolve_builtin(key, rel)
        else:
            return {}
        out = json.loads(f.read_text(encoding="utf-8-sig"))
    except (KeyError, OSError, ValueError, files.MateError):
        return {}
    return out if isinstance(out, dict) else {}


def avatar_view(mate: dict[str, Any]) -> dict[str, Any]:
    """Her avatar as the agent sees it: the kind, and for a Live2D model or a LivLiv package what it has — the
    expressions (and Live2D's motion groups) — and which of her emotions each answers to now."""
    a = mate.get("avatar") or {}
    kind = a.get("kind") or "none"
    out: dict[str, Any] = {"kind": kind}
    if kind == "live2d":
        l2 = a.get("live2d") or {}
        refs = _model3(l2.get("model"), mate.get("id") or "").get("FileReferences") or {}
        out["expressions"] = [str(e["Name"]) for e in refs.get("Expressions") or []
                              if isinstance(e, dict) and e.get("Name")]
        out["motion_groups"] = [str(g) for g in (refs.get("Motions") or {})]
        out["idle_group"] = l2.get("idle_group") or ""
        out["emotions"] = dict(l2.get("emotions") or {})
        out["emotion_motions"] = dict(l2.get("emotion_motions") or {})
    elif kind == "livliv":
        lv = a.get("livliv") or {}
        out["name"] = lv.get("name") or ""
        out["expressions"] = [str(x) for x in lv.get("expressions") or []]
        out["emotions"] = dict(lv.get("emotions") or {})
    return out


def avatar_line(view: dict[str, Any]) -> str:
    """One line of it (the change note: the user brought another avatar, or remapped one)."""
    parts = [view["kind"]]
    if view.get("expressions") is not None:
        parts.append(f"expressions: {', '.join(view['expressions'][:30]) or '(none)'}")
    if view.get("motion_groups"):
        parts.append(f"motions: {', '.join(view['motion_groups'][:20])}")
    mapped = {**{k: v for k, v in (view.get("emotions") or {}).items() if v not in ("", None)},
              **{f"{k} (motion)": v for k, v in (view.get("emotion_motions") or {}).items() if v}}
    if mapped:
        parts.append("mapped: " + ", ".join(f"{k}→{v}" for k, v in mapped.items()))
    return " · ".join(parts)


def emotion_map(view: dict[str, Any], avatar: dict[str, Any], expressions: Any, motions: Any) -> dict[str, Any]:
    """Her avatar with these emotions mapped (merged over what is mapped): ``expressions`` {emotion tag: one of the
    model's expressions, or "" to unmap}, ``motions`` {emotion tag: a motion group, or ""} (Live2D only). Only the
    model's own names and her emotion tags; nothing half-applied."""
    kind = view["kind"]
    if kind not in ("live2d", "livliv"):
        raise StudioError("her avatar is not a Live2D model or a LivLiv package: it has no expressions to map")
    if not isinstance(expressions, dict) or not isinstance(motions, dict) or not (expressions or motions):
        raise StudioError("give expressions {emotion: expression} and/or motions {emotion: motion group}")
    if motions and kind != "live2d":
        raise StudioError("motions are a Live2D model's; a LivLiv package maps expressions only")
    for k in (*expressions, *motions):
        if k not in EMOTION_TAGS:
            raise StudioError(f"not one of her emotions: {k!r} (they are: {', '.join(EMOTION_TAGS)})")
    for k, v in expressions.items():
        if v not in ("", None) and str(v) not in view["expressions"]:
            raise StudioError(f"{k}: the model has no expression {v!r} (it has: {', '.join(view['expressions']) or 'none'})")
    for k, v in motions.items():
        if v not in ("", None) and str(v) not in view["motion_groups"]:
            raise StudioError(f"{k}: the model has no motion group {v!r} (it has: {', '.join(view['motion_groups'])})")
    body = dict(avatar.get(kind) or {})
    emotions = dict(body.get("emotions") or {})
    for k, v in expressions.items():
        if v in ("", None) and kind == "live2d":
            emotions.pop(k, None)
        else:
            emotions[k] = "" if v is None else str(v)  # (LivLiv: "" = none for that emotion)
    body["emotions"] = emotions
    if motions:
        moves = dict(body.get("emotion_motions") or {})
        for k, v in motions.items():
            if v in ("", None):
                moves.pop(k, None)
            else:
                moves[k] = str(v)
        body["emotion_motions"] = moves
    return {**avatar, kind: body}


def snapshot(mate: dict[str, Any], concept: dict[str, Any] | None) -> dict[str, Any]:
    """The draft's fields as flat paths (what the agent compares with what it last saw)."""
    p = mate.get("persona") or {}
    pr = mate.get("prefs") or {}
    tts = ((mate.get("voice") or {}).get("tts") or {})
    llm = mate.get("llm") or {}
    out: dict[str, Any] = {"name": mate.get("name") or "", "gender": p.get("gender") or ""}
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
    out["avatar"] = avatar_line(avatar_view(mate))
    return out


def paths_of(patch: dict[str, Any], concept: dict[str, Any]) -> list[str]:
    out = []
    if "name" in patch:
        out.append("name")
    for k in (patch.get("persona") or {}):
        out.append("gender" if k == "gender" else f"persona.{k}")
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
    if path == "gender":
        return {"persona": {"gender": value or ""}}, {}
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
        if k in HIDDEN and k not in seen:  # (not on the right: nothing the user changed there)
            continue
        # (a field tracked since: set now, it shows once)
        if seen.get(k, "") != v and (k in seen or v not in ("", None, "none")):
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
