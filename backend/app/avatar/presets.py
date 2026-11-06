"""What an avatar is made of: the stills and motion clips on offer, the presets, and the fixed prompt templates.

The templates are the ones the official mates were made with (ailism-mate ``original_content/tools/mate.py``):

* a still = the picked candidate as the reference + "change only her face" (only the face region is then laid over
  the base picture, so the hair never shimmers);
* a clip = Kling O3 first/last frame with start = end = the base picture on a flat gray, "… ends in exactly the same
  pose as she starts", so every clip loops and any clip follows any other.

Standard = 한채린's manifest (15 clips after the owner retired ``pout`` on 2026-10-28, 11 stills). The texts are written
for any character: ``{S}`` / ``{s}`` subject, ``{pos}`` possessive, ``{obj}`` object, filled per the brief's pronoun.
"""

from __future__ import annotations

import re
from typing import Any

#: the background every clip is generated on (Kling kept it to the end in the tests)
GRAY = (213, 212, 217)

CLIP_KINDS = ("idle", "talk", "listen", "think", "react", "away")
#: the emotion tags the mate writes ([joy] [smile] …, app/mate/prompt.py) — what react clips are keyed by
EMOTIONS = ("joy", "smile", "laugh", "shy", "surprised", "sad", "angry", "thinking", "agree", "greet", "sleepy")
#: stills the player uses for its mechanics (blink, mouth while speaking) — never an emotion's still
MECHANICS = ("blink", "mouth_half", "mouth_open", "mouth_o")

PRONOUNS = {
    "she": {"S": "She", "s": "she", "pos": "her", "Pos": "Her", "obj": "her"},
    "he": {"S": "He", "s": "he", "pos": "his", "Pos": "His", "obj": "him"},
    "they": {"S": "The character", "s": "it", "pos": "their", "Pos": "Their", "obj": "them"},
}

#: still name -> the face, as the "change only her face" prompt says it
STILLS: dict[str, str] = {
    "smile": "a warm, gentle smile",
    "laugh": "laughing happily with {pos} eyes closed and mouth open",
    "shy": "shy and blushing, eyes looking a little away",
    "surprised": "surprised, eyes wide, mouth slightly open",
    "sad": "sad and sympathetic, eyes lowered",
    "thinking": "thinking, eyes looking up",
    "sleepy": "sleepy, eyes half closed",
    "angry": "annoyed, brows drawn together, mouth in a small frown",
    "blink": "eyes gently closed as in a slow blink; mouth exactly as before",
    "mouth_half": "mouth slightly open as if saying 'eh'; eyes exactly as before",
    "mouth_open": "mouth open as if saying 'ah'; eyes exactly as before",
    "mouth_o": "mouth rounded as if saying 'oh'; eyes exactly as before",
}

#: clip id -> (kind, action, emotion, loop)
CLIPS: dict[str, tuple[str, str, str | None, bool]] = {
    "idle_a": ("idle", "{S} breathes quietly and blinks, relaxed", None, False),
    "idle_b": ("idle", "{S} glances down at something off-screen, then back at the viewer with a slow blink", None,
               False),
    "idle_c": ("idle", "{S} tilts {pos} head a little and shifts {pos} weight, then settles back", None, False),
    "idle_d": ("idle", "{S} looks around softly as if listening to the room, then back at the viewer", None, False),
    "talk_a": ("talk", "{S} talks quietly and briefly, lips moving a little, glancing away now and then", None, False),
    "talk_b": ("talk", "{S} talks fast and excited, eyes sparkling, small hand gestures, then calms down", None, False),
    "talk_c": ("talk", "{S} explains something calmly, nodding a little while talking", None, False),
    "listen": ("listen", "{S} listens and gives two small nods", None, False),
    "listen_b": ("listen", "{S} listens attentively with a slight head tilt and a soft smile", None, False),
    "think": ("think", "{S} tilts {pos} head and looks up, thinking, then looks back", None, False),
    "think_b": ("think", "{S} touches {pos} chin, thinking hard, then looks back at the viewer", None, False),
    "laugh": ("react", "{S} lets out a small laugh and quickly hides the smile, then looks back", "joy", False),
    "smile": ("react", "A small, warm smile appears on {pos} face", "smile", False),
    "shy": ("react", "{S} blushes and looks away shyly, then peeks back", "shy", False),
    "surprised": ("react", "{Pos} eyes go wide and {s} freezes for a moment, then relaxes", "surprised", False),
    "sad": ("react", "{S} looks down sadly, then looks back with a small reassuring nod", "sad", False),
    "nod": ("react", "{S} nods twice firmly, determined", "agree", False),
    "wave": ("react", "{S} lifts a hand and gives a small friendly wave, then lowers it", "greet", False),
    "angry": ("react", "{S} frowns, annoyed for a moment, then lets it go with a small sigh", "angry", False),
    "yawn": ("react", "{S} covers a small yawn with a hand, then blinks awake", "sleepy", False),
    "doze": ("away", "{S} gets sleepy, eyes slowly closing and head dipping forward, then blinks awake", None, True),
}

PRESETS: dict[str, dict[str, list[str]]] = {
    "minimal": {
        "clips": ["idle_a", "idle_b", "talk_a", "talk_b", "listen", "think"],
        "stills": ["smile", "surprised", "sad", "thinking", "blink", "mouth_open"],
    },
    # 한채린 (original_content/mate/chaerin/manifest.json) without the retired pout
    "standard": {
        "clips": ["idle_a", "idle_b", "idle_c", "talk_a", "talk_b", "listen", "think", "laugh", "smile", "shy",
                  "surprised", "sad", "nod", "wave", "doze"],
        "stills": ["smile", "laugh", "shy", "surprised", "sad", "thinking", "sleepy", "blink", "mouth_half",
                   "mouth_open", "mouth_o"],
    },
    "rich": {
        "clips": ["idle_a", "idle_b", "idle_c", "idle_d", "talk_a", "talk_b", "talk_c", "listen", "listen_b", "think",
                  "think_b", "laugh", "smile", "shy", "surprised", "sad", "nod", "wave", "angry", "yawn", "doze"],
        "stills": ["smile", "laugh", "shy", "surprised", "sad", "thinking", "sleepy", "angry", "blink", "mouth_half",
                   "mouth_open", "mouth_o"],
    },
}

#: limits a brief must stay within (a custom plan too)
MAX_CLIPS = 32
MAX_STILLS = 16
MAX_CANDIDATES = 4
#: Kling O3 FLF clip length (the official mates: all 5 s, short loops)
CLIP_SECONDS = 5
ASPECTS = ("1:1", "9:16")
#: quality tier -> Kling mode and the two encoded heights (the stacked video is twice as tall)
TIERS = {
    "studio": {"mode": "pro", "sizes": {"lg": 1080, "sm": 540}},
    "light": {"mode": "std", "sizes": {"lg": 720, "sm": 360}},
}

FACE = ("Exactly the same picture as the reference: same pose, framing, hair, clothes and lighting. Change only {pos} "
        "face: {face}. Nothing else changes. Clean face, no wrinkles.")
CLIP = "{action}. Static camera. The plain gray background stays exactly the same. {end}"
#: the base picture every candidate must be (ailism MATE.md §3.5: waist-up, front, relaxed, flat gray)
FRAMING = ("Waist-up portrait of one character, facing the viewer, relaxed friendly pose, arms and hands natural "
           "(no floating or extra hands), centred, the whole head and hair inside the frame with space above, plain "
           "flat light gray background, soft even lighting, no text, no props in front of the body.")
REDRAW = "The same character as the reference: exactly the same face, eyes, hair, outfit, colours and art style."
#: an outfit set (docs/avatar-create.md §12): the mate's own picture redrawn in new clothes, she stays exactly herself
OUTFIT = ("The same character as the reference: exactly the same face, eyes, hairstyle, hair colour, skin tone, body "
          "proportions, art style and line work. Only the clothes change: nothing of the reference's clothes stays; "
          "accessories like a headset or glasses do, unless the description below says otherwise.")
OUTFIT_CLOTHES_REFS = "The first reference picture is the character; the others only show the clothes to wear."
OUTFIT_CROP = "Cropped at the waist: nothing below the waist is in the picture."


def words(pronoun: str | None) -> dict[str, str]:
    return PRONOUNS.get(pronoun or "she", PRONOUNS["she"])


def fill(text: str, pronoun: str | None) -> str:
    w = words(pronoun)
    out = text
    for k in ("Pos", "pos", "obj", "S", "s"):
        out = out.replace("{" + k + "}", w[k])
    return out


def end_line(pronoun: str | None) -> str:
    w = words(pronoun)
    if (pronoun or "she") == "they":
        return "The character ends in exactly the same pose as at the start."
    return f"{w['S']} ends in exactly the same pose as {w['s']} starts."


def clip_prompt(action: str, pronoun: str | None) -> str:
    action = fill(action.strip().rstrip("."), pronoun)
    return CLIP.format(action=action, end=end_line(pronoun))


def face_prompt(face: str, pronoun: str | None) -> str:
    return FACE.format(pos=words(pronoun)["pos"], face=fill(face.strip().rstrip("."), pronoun))


def design_prompt(prompt: str, *, redraw: bool, outfit: bool = False, clothes_refs: bool = False) -> str:
    """A candidate's prompt: the agent's English description + the fixed framing (+ the reference rule: an outfit set
    keeps her and changes the clothes, ``clothes_refs``: pictures of the clothes came with her own)."""
    desc = " ".join((prompt or "").split())
    outfit = outfit and redraw
    parts = ([OUTFIT, *([OUTFIT_CLOTHES_REFS] if clothes_refs else [])] if outfit else [REDRAW] if redraw else [])
    if desc:
        parts.append(desc.rstrip(".") + ".")
    parts.append(FRAMING)
    if outfit:
        parts.append(OUTFIT_CROP)
    return " ".join(parts)


def design_edit_prompt(change: str) -> str:
    """A candidate the user likes, with one thing changed: the picture is the reference."""
    return ("Keep this picture exactly as it is: the same character, face, eyes, hair, clothes, pose, framing, colours, "
            f"art style and plain flat light gray background. Change only this: {' '.join(change.split()).rstrip('.')}.")


def preset_clips(name: str) -> list[dict[str, Any]]:
    out = []
    for cid in PRESETS[name]["clips"]:
        kind, action, emotion, loop = CLIPS[cid]
        c: dict[str, Any] = {"id": cid, "kind": kind, "action": action}
        if emotion:
            c["emotion"] = emotion
        if loop:
            c["loop"] = True
        out.append(c)
    return out


def preset_stills(name: str) -> list[dict[str, str]]:
    return [{"name": n, "face": STILLS[n]} for n in PRESETS[name]["stills"]]


_ID = re.compile(r"^[a-z][a-z0-9_]{0,23}$")


class BriefError(ValueError):
    pass


def default_brief() -> dict[str, Any]:
    return {
        "reference": {"mode": "none", "files": []},  # none | redraw | as_base
        "design": {"prompt": "", "notes": ""},       # prompt: English, written by the agent
        "pronoun": "she",
        "candidates": 4,
        "aspect": "1:1",
        "tier": "studio",
        "preset": "standard",
        "clips": preset_clips("standard"),
        "stills": preset_stills("standard"),
        "target": {"mode": "new", "mate_id": None, "name": ""},
    }


def _clean_clip(c: Any, seen: set[str]) -> dict[str, Any]:
    if not isinstance(c, dict):
        raise BriefError("every clip is an object {id, kind, action}")
    cid = str(c.get("id") or "").strip().lower()
    if not _ID.match(cid):
        raise BriefError(f"clip id {cid!r}: lowercase letters, digits and _ (max 24)")
    if cid in seen:
        raise BriefError(f"clip id {cid!r} is used twice")
    seen.add(cid)
    lib = CLIPS.get(cid)
    kind = c.get("kind") or (lib[0] if lib else None)
    if kind not in CLIP_KINDS:
        raise BriefError(f"clip {cid}: kind must be one of {', '.join(CLIP_KINDS)}")
    action = " ".join(str(c.get("action") or (lib[1] if lib else "")).split())
    if not 8 <= len(action) <= 400:
        raise BriefError(f"clip {cid}: the action is a short English sentence (8–400 characters)")
    out: dict[str, Any] = {"id": cid, "kind": kind, "action": action}
    emo = c.get("emotion") or (lib[2] if lib and "emotion" not in c else None)
    if emo:
        emo = str(emo).strip().lower()
        if emo not in EMOTIONS:
            raise BriefError(f"clip {cid}: emotion must be one of {', '.join(EMOTIONS)}")
        out["emotion"] = emo
    if kind == "react" and not out.get("emotion"):
        raise BriefError(f"clip {cid}: a react clip names the emotion it plays for")
    if c.get("loop") or kind == "away":
        out["loop"] = True
    return out


def _clean_still(s: Any, seen: set[str]) -> dict[str, str]:
    if isinstance(s, str):
        s = {"name": s}
    if not isinstance(s, dict):
        raise BriefError("every still is an object {name, face}")
    name = str(s.get("name") or "").strip().lower()
    if not _ID.match(name) or name == "neutral":
        raise BriefError(f"still {name!r}: lowercase letters, digits and _ (not 'neutral': that is the base picture)")
    if name in seen:
        raise BriefError(f"still {name!r} is listed twice")
    seen.add(name)
    face = " ".join(str(s.get("face") or STILLS.get(name, "")).split())
    if not 4 <= len(face) <= 300:
        raise BriefError(f"still {name}: describe the face in a short English phrase")
    return {"name": name, "face": face}


def merge_brief(cur: dict[str, Any] | None, patch: dict[str, Any]) -> dict[str, Any]:
    """The brief with ``patch`` applied and checked (BriefError with a readable reason)."""
    if not isinstance(patch, dict):
        raise BriefError("the patch is an object")
    b = {**default_brief(), **(cur or {})}
    for k in ("reference", "design", "target"):
        if k in patch:
            if not isinstance(patch[k], dict):
                raise BriefError(f"{k} is an object")
            b[k] = {**b[k], **patch[k]}
        else:
            b[k] = dict(b[k])
    for k in ("pronoun", "candidates", "aspect", "tier"):
        if k in patch:
            b[k] = patch[k]
    if "preset" in patch:
        p = patch["preset"]
        if p not in (*PRESETS, "custom"):
            raise BriefError(f"preset must be one of {', '.join([*PRESETS, 'custom'])}")
        b["preset"] = p
        if p in PRESETS and "clips" not in patch:
            b["clips"] = preset_clips(p)
        if p in PRESETS and "stills" not in patch:
            b["stills"] = preset_stills(p)
    if "clips" in patch:
        seen: set[str] = set()
        b["clips"] = [_clean_clip(c, seen) for c in (patch["clips"] or [])]
        if "preset" not in patch:
            b["preset"] = "custom"
    if "stills" in patch:
        seen = set()
        b["stills"] = [_clean_still(s, seen) for s in (patch["stills"] or [])]
        if "preset" not in patch:
            b["preset"] = "custom"
    # checks
    ref = b["reference"]
    if ref.get("mode") not in ("none", "redraw", "as_base"):
        raise BriefError("reference.mode must be none, redraw or as_base")
    ref["files"] = [str(f) for f in (ref.get("files") or []) if isinstance(f, str)][:4]
    if ref["mode"] != "none" and not ref["files"]:
        raise BriefError("reference.mode needs an uploaded reference picture first (ask the user to upload one)")
    if b["pronoun"] not in PRONOUNS:
        raise BriefError("pronoun must be she, he or they")
    try:
        b["candidates"] = int(b["candidates"])
    except (TypeError, ValueError):
        raise BriefError("candidates is a number (1–4)") from None
    if not 1 <= b["candidates"] <= MAX_CANDIDATES:
        raise BriefError(f"candidates: 1–{MAX_CANDIDATES}")
    if b["aspect"] not in ASPECTS:
        raise BriefError(f"aspect must be one of {', '.join(ASPECTS)}")
    if b["tier"] not in TIERS:
        raise BriefError(f"tier must be one of {', '.join(TIERS)}")
    d = b["design"]
    d["prompt"] = " ".join(str(d.get("prompt") or "").split())[:1200]
    d["notes"] = str(d.get("notes") or "")[:2000]
    if not b["clips"]:
        raise BriefError("at least one clip (an idle clip) is needed for a video avatar")
    if len(b["clips"]) > MAX_CLIPS:
        raise BriefError(f"at most {MAX_CLIPS} clips")
    if not any(c["kind"] == "idle" for c in b["clips"]):
        raise BriefError("at least one idle clip is needed (the avatar breathes while nothing happens)")
    if len(b["stills"]) > MAX_STILLS:
        raise BriefError(f"at most {MAX_STILLS} stills")
    t = b["target"]
    if t.get("mode") not in ("new", "existing"):
        raise BriefError("target.mode must be new or existing")
    t["name"] = str(t.get("name") or "")[:80]
    return b


def outfit_brief(base: dict[str, Any], refs: list[str], target: dict[str, Any]) -> dict[str, Any]:
    """The brief an outfit set starts from: her own picture as the reference, the shape of her default set and its
    motions, without the clips the user switched off there (they would be paid for and never play)."""
    rig = base.get("rig") if base.get("kind") == "video" else {}
    off = {c.get("id") for c in rig.get("clips") or [] if c.get("disabled")}
    clips = [c for c in preset_clips("standard") if c["id"] not in off]
    if not any(c["kind"] == "idle" for c in clips):
        clips = preset_clips("standard")
    size = rig.get("aspect") or []
    tall = len(size) == 2 and size[1] and size[0] / size[1] < 0.62
    return merge_brief(None, {
        "reference": {"mode": "redraw" if refs else "none", "files": refs},
        "candidates": 3, "aspect": "9:16" if tall else "1:1", "preset": "standard", "clips": clips,
        "stills": preset_stills("standard"), "target": target,
    })


def problems(b: dict[str, Any]) -> list[str]:
    """What still keeps this brief from being estimated (asked in the interview)."""
    out = []
    if b["reference"]["mode"] != "as_base" and not b["design"]["prompt"]:
        out.append("design.prompt: an English description of the character (or a reference used as the base)")
    t = b["target"]
    if t["mode"] == "existing" and not t.get("mate_id"):
        out.append("target.mate_id: which mate gets the avatar")
    if t["mode"] == "new" and not t.get("name"):
        out.append("target.name: the new mate's name")
    return out


def emotions_map(clips: list[dict[str, Any]]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for c in clips:
        if c.get("emotion"):
            out.setdefault(c["emotion"], []).append(c["id"])
    return out
