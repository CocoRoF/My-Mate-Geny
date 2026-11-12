"""Mates, their memories and the global Mate (voice) settings.

A mate is one row of JSON documents (shapes in docs/mate.md §1–2); every
write goes through the ``normalize_*`` helpers so the API only ever hands out
complete, well-typed documents. API keys for voice services are write-only:
they live in the vault (scope ``mate``) and the API reports only ``*_key_set``.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.db import Database
from app.mate import affinity as A
from app.mate import memory as M
from app.mate import state as S
from app.mate.life import profile as life_profile
from app.mate.life import sim
from app.mate.knowledge import Knowledge, digest, safe_text
from app.providers.catalog import DEFAULT_MATE_MODEL, default_mate_model
from app.services._ids import new_id, now_iso
from app.vault import SecretVault
from app.harness.vendors import API_PROVIDERS

# The persona is the character only — who she is (docs/mate.md §1 "Prompt composition"). How she talks (speech level,
# how she calls the user, speech habits …) lives in the conversation style (``prefs``) and nowhere else.
PERSONA_FIELDS = ("description", "personality", "greeting", "language", "instructions", "gender")
#: ``persona.gender``: who she is, as the character's data — nothing in the app shows it or sets it (a bundle says it, the
#: Mate Create studio writes it, an older mate's is read from her text once: ``infer_gender``); "" = not known
GENDERS = ("female", "male")
# persona fields of older documents / clients / imports and where they live now (prefs): moved, never dropped
LEGACY_STYLE_FIELDS = {"speech": "speech_style", "address": "address"}
TTS_ENGINES = ("off", "browser", "google", "openai", "elevenlabs", "omnivoice", "http")
# elevenlabs = Scribe v2 Realtime: the page streams the mic straight to ElevenLabs with a single-use token the
# backend mints (app/mate/voice.py realtime_token); the key never leaves the server.
STT_ENGINES = ("off", "browser", "google", "openai", "whisper", "elevenlabs")
# voice.stt.silence: how long a pause ends an utterance (ElevenLabs VAD, seconds; its API takes 0.192 – 3.0)
STT_SILENCE = (0.3, 3.0, 1.2)
AVATAR_KINDS = ("none", "video", "photo", "live2d", "livliv")
CLIP_KINDS = ("idle", "talk", "listen", "think", "react", "away", "life")
# stills that make her blink / talk: mechanics, never shown for an emotion
MECHANIC_STILLS = ("blink", "mouth_half", "mouth_open", "mouth_o")
MAX_CLIPS = 200
MAX_VOLUME = 3.0          # voice.volume: 0.0 – 3.0 (300 %), 1.0 = as synthesized
EFFORTS = ("default", "low", "medium", "high", "xhigh", "max")
LLM_PROVIDERS = ("claude", "codex", *API_PROVIDERS)  # engines that can run sealed (own prompt, only the mate MCP bridge)

MAX_FIELD = 8000          # one persona field
MAX_AVATAR_JSON = 256 * 1024
#: the id of her default set in the wardrobe, and how many other sets it holds
DEFAULT_OUTFIT = "default"
MAX_OUTFITS = 24
MAX_MEMORY = 1000         # one memory, chars
MAX_MEMORIES = 500        # active prompt tier; archived history is retained until explicit forgetting

# Global settings: plain values (URLs) and vault-held keys.
SETTING_URLS = ("omnivoice_url", "whisper_url", "http_tts_url")
SETTING_KEYS = ("google_key", "openai_key", "elevenlabs_key", "http_tts_key")
# Which voice provider (app/mate/providers.py) each setting belongs to: a
# change drops that provider's cached verification.
SETTING_PROVIDERS = {"google_key": "google", "openai_key": "openai", "elevenlabs_key": "elevenlabs", "omnivoice_url": "omnivoice",
                     "whisper_url": "whisper", "http_tts_url": "http", "http_tts_key": "http"}
_VERIFY_PREFIX = "verify:"
_VAULT_SCOPE = "mate"

_MODEL_RE = re.compile(r"^[A-Za-z0-9._:\-\[\]/]{0,120}$")

# The avatar-less "Geny" (only created when there is no mate at all). The
# persona is English whatever the reply language; the greeting is what the user
# sees first, so it comes in the reply language (swapped when that changes).
DEFAULT_GREETINGS = {
    "en": "Hi! I'm Geny. What can I help you with today?",
    "ko": "안녕하세요! 저는 지니예요. 오늘은 어떤 일을 도와드릴까요?",
}
DEFAULT_PERSONA = {
    "description": (
        "The user's personal secretary. You keep an eye on the user's work chats (coding agents), hand work "
        "to them, and keep the user posted on how it's going."
    ),
    "personality": ("Bright, warm and quick to pick up on things. Thorough without being chatty. "
                    "You honestly ask about what you don't know."),
    "greeting": DEFAULT_GREETINGS["ko"],
    "language": "ko",
    "instructions": "",
}
# … and how Geny talks: her conversation style (the speech level as structured data, not as a sentence)
DEFAULT_STYLE = {
    "speech_style": "Soft; short and natural, one or two sentences at a time. In English: warm and friendly, never stiff.",
    "defaults": {"formality": "haeyo"},
}


class MateError(ValueError):
    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


# ---- document normalization ----

def _s(v: Any, limit: int = MAX_FIELD) -> str:
    if v is None:
        return ""
    if not isinstance(v, (str, int, float)):
        raise MateError("expected a string")
    return str(v)[:limit]


def split_persona(persona: Any) -> tuple[Any, dict[str, Any]]:
    """A persona document/patch that may still carry the old speech fields → (the persona without them, the prefs
    patch they become: ``speech`` → ``speech_style``, ``address`` → ``address``). Anything that is not an object is
    returned as is (normalize_persona refuses it)."""
    if not isinstance(persona, dict) or not any(k in persona for k in LEGACY_STYLE_FIELDS):
        return persona, {}
    rest = {k: v for k, v in persona.items() if k not in LEGACY_STYLE_FIELDS}
    return rest, {new: persona[old] for old, new in LEGACY_STYLE_FIELDS.items() if old in persona}


def normalize_persona(patch: Any, base: dict[str, Any] | None = None) -> dict[str, Any]:
    out = {k: "" for k in PERSONA_FIELDS}
    out["language"] = "ko"
    out.update({k: v for k, v in (base or {}).items() if k in PERSONA_FIELDS})
    if patch is None:
        out["gender"] = out["gender"] if out["gender"] in GENDERS else ""
        return out
    if not isinstance(patch, dict):
        raise MateError("persona must be an object")
    for k in PERSONA_FIELDS:
        if k in patch:
            out[k] = _s(patch[k], 32).strip() if k in ("language", "gender") else _s(patch[k])
    out["language"] = out["language"] or "ko"
    out["gender"] = out["gender"].lower() if str(out["gender"]).lower() in GENDERS else ""
    return out


# what her persona text says she is (``infer_gender``): words for a woman or a man, Korean and English. A Korean one counts
# only where a word starts (체형 is no 형, 인형 no 형) and a compound like 남자친구 not at all (whose friend is it?).
_KO_WORD = r"(?<![가-힣])"
_FEMALE_CUES = re.compile(_KO_WORD + r"(?:그녀|여자(?!\s?친구)|여성|소녀|언니|누나|아가씨)"
                          r"|\b(?:she|her|hers|herself|girl|woman|women|lady|female)\b", re.I)
_MALE_CUES = re.compile(_KO_WORD + r"(?:그(?:는|가|의|를|에게)(?![가-힣])|남자(?!\s?친구)|남성|소년"
                        r"|(?:형|오빠)(?:님|이|은|을|의|도|에게|한테|처럼|이랑)?(?![가-힣]))"
                        r"|\b(?:he|him|his|himself|boy|man|men|guy|male)\b", re.I)


def infer_gender(persona: dict[str, Any] | None, speech: Any = "") -> str:
    """Who she is, as far as her own text tells (description, personality, how she talks): female | male when one side
    clearly outweighs the other, else "" — never a guess."""
    p = persona or {}
    text = "\n".join(str(x or "") for x in (p.get("description"), p.get("personality"), p.get("speech"), speech))
    f, m = len(_FEMALE_CUES.findall(text)), len(_MALE_CUES.findall(text))
    if f and f >= 2 * m:
        return "female"
    if m and m >= 2 * f:
        return "male"
    return ""


def normalize_llm(patch: Any, base: dict[str, Any] | None = None) -> dict[str, Any]:
    out = {"provider": "claude", "model": DEFAULT_MATE_MODEL, "effort": "low", **(base or {})}
    if patch is None:
        return out
    if not isinstance(patch, dict):
        raise MateError("llm must be an object")
    if "provider" in patch:
        prov = _s(patch["provider"], 32) or "claude"
        if prov not in LLM_PROVIDERS:
            raise MateError(f"unsupported mate provider: {prov} (a mate runs on {' or '.join(LLM_PROVIDERS)})")
        if prov != out["provider"] and "model" not in patch:
            out["model"] = default_mate_model(prov)  # (the other engine's model id means nothing here)
        out["provider"] = prov
    if "model" in patch:
        model = _s(patch["model"], 200).strip()
        if not _MODEL_RE.match(model):
            raise MateError(f"invalid model id: {model}")
        out["model"] = model
    if "effort" in patch:
        effort = _s(patch["effort"], 16) or "default"
        if effort not in EFFORTS:
            raise MateError(f"unknown effort: {effort}")
        out["effort"] = effort
    return out


def _num(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, f))


def _volume(v: Any) -> float:
    """voice.volume: 0.0 – 3.0 (1.0 = as synthesized; above it the page amplifies with a limiter)."""
    if isinstance(v, bool):
        return 1.0
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(f):  # NaN / inf
        return 1.0
    return round(max(0.0, min(MAX_VOLUME, f)), 3)


def normalize_voice(patch: Any, base: dict[str, Any] | None = None) -> dict[str, Any]:
    base = base or {}
    # instruct: OmniVoice voice design ("female, young adult, low pitch");
    # ref/ref_text: a reference clip (mate asset path) + its transcript.
    tts = {"engine": "browser", "voice": "", "model": "", "speed": 1.0, "profile": "", "language": "",
           "instruct": "", "ref": "", "ref_text": "",
           **(base.get("tts") or {})}
    # auto_send: a finished utterance goes out by itself (realtime engines; default off: it waits in the box);
    # barge_in: talking while she speaks stops her voice (default on, with echo protection — docs/mate.md §5)
    stt = {"engine": "browser", "model": "", "language": "", "auto_send": False, "barge_in": True,
           "silence": STT_SILENCE[2], "merge_fragments": True, "continuation_grace": 1.8,
           "ignore_short_fragments": False, **(base.get("stt") or {})}
    stt["continuation_grace"] = max(float(stt["silence"]), float(stt["continuation_grace"]))
    out = {"auto_read": bool(base.get("auto_read", True)), "volume": _volume(base.get("volume", 1.0)),
           "tts": tts, "stt": stt}
    if patch is None:
        return out
    if not isinstance(patch, dict):
        raise MateError("voice must be an object")
    if "auto_read" in patch:
        out["auto_read"] = bool(patch["auto_read"])
    if "volume" in patch:
        if isinstance(patch["volume"], bool) or not isinstance(patch["volume"], (int, float, str, type(None))):
            raise MateError("voice.volume must be a number (0.0 – 3.0)")
        out["volume"] = _volume(patch["volume"])
    pt = patch.get("tts")
    if pt is not None:
        if not isinstance(pt, dict):
            raise MateError("voice.tts must be an object")
        if "engine" in pt:
            eng = _s(pt["engine"], 32) or "browser"
            if eng not in TTS_ENGINES:
                raise MateError(f"unknown tts engine: {eng}")
            tts["engine"] = eng
        for k in ("voice", "model", "profile", "language", "ref"):
            if k in pt:
                tts[k] = _s(pt[k], 200).strip()
        for k in ("instruct", "ref_text"):
            if k in pt:
                tts[k] = _s(pt[k], 1000).strip()
        if "speed" in pt:
            tts["speed"] = _num(pt["speed"], 0.25, 4.0, 1.0)
    ps = patch.get("stt")
    if ps is not None:
        if not isinstance(ps, dict):
            raise MateError("voice.stt must be an object")
        if "engine" in ps:
            eng = _s(ps["engine"], 32) or "browser"
            if eng not in STT_ENGINES:
                raise MateError(f"unknown stt engine: {eng}")
            stt["engine"] = eng
        for k in ("model", "language"):
            if k in ps:
                stt[k] = _s(ps[k], 200).strip()
        for k in ("auto_send", "barge_in", "merge_fragments", "ignore_short_fragments"):
            if k in ps:
                if not isinstance(ps[k], (bool, int)) or ps[k] not in (True, False, 0, 1):
                    raise MateError(f"voice.stt.{k} must be true or false")
                stt[k] = bool(ps[k])
        if "continuation_grace" in ps:
            if isinstance(ps["continuation_grace"], bool):
                raise MateError("voice.stt.continuation_grace must be a number of seconds")
            stt["continuation_grace"] = round(_num(ps["continuation_grace"], .5, 5., 1.8), 2)
        if "silence" in ps:
            if isinstance(ps["silence"], bool):
                raise MateError("voice.stt.silence must be a number of seconds")
            stt["silence"] = round(_num(ps["silence"], *STT_SILENCE), 2)
    if ps is not None and "continuation_grace" in ps and stt["continuation_grace"] < stt["silence"]:
        raise MateError("voice.stt.continuation_grace must be at least voice.stt.silence")
    stt["continuation_grace"] = max(stt["continuation_grace"], stt["silence"])
    return out


# The conversation style (대화 방식; docs/mate.md "Prompt composition", docs/mate-memory-affinity.md §3): the single
# source of how the mate talks — each field changes a line of the prompt's "How you talk" section (prompt.py) and/or
# what the client does (emotion level). The user edits it in Mate settings, the mate with its own
# update_conversation_style tool (when ``self_edit`` allows it), the studio agent while a mate is being made.
FORMALITIES = ("auto", "haeyo", "hapsyo", "banmal")   # auto = the character's own level (``defaults.formality``)
LENGTHS = ("short", "normal", "long")
TONE_KEYS = ("warmth", "humor", "initiative")
TONE_LEVELS = ("auto", "low", "high")
RECALL_LEVELS = ("off", "light", "normal", "rich")
SELF_EDIT = ("auto", "ask", "off")   # may the mate change her own style: yes | as a proposal the user applies | no
LIFE = ("auto", "on", "off")          # her own day (app/mate/life): auto = on for a mate who comes with a world of her own
SELF_OUTFIT = ("auto", "off")        # may the mate change her clothes when the user asks (app/mate/wardrobe.py)
MAX_AVOID = 500
MAX_ADDRESS = 80
MAX_SELF_REF = 40
MAX_SPEECH_STYLE = 8000
# what the mate's own tool may change (+ ``language``: stored as persona.language — it also picks the localized
# name and greeting, the speech-to-text language and the built-in sync, so it stays there)
STYLE_FIELDS = ("user_name", "address", "self_ref", "formality", "speech_style", "length", "emotion", "tone", "avoid")


def default_style_defaults() -> dict[str, str]:
    """The character's own way of talking (bundled characters / imports — data, not a setting): what ``formality``
    "auto", an empty ``address`` and an empty ``self_ref`` mean. ``address`` may contain ``{name}`` (the user's)."""
    return {"formality": "", "address": "", "self_ref": ""}


def default_prefs() -> dict[str, Any]:
    return {"user_name": "", "address": "", "self_ref": "", "formality": "auto", "speech_style": "",
            "length": "normal", "emotion": 2, "tone": {k: "auto" for k in TONE_KEYS}, "avoid": "",
            "memory": {"recall": "normal", "self_save": True}, "self_edit": "auto", "self_outfit": "auto", "life": "auto",
            "defaults": default_style_defaults(), "proactive": {"enabled": False, "interval": 180, "guidance": "", "scope": "all", "preset": None}}


def _enum(v: Any, allowed: tuple[str, ...], what: str) -> str:
    v = _s(v, 32).strip() or allowed[0]
    if v not in allowed:
        raise MateError(f"unknown {what}: {v} (one of {', '.join(allowed)})")
    return v


def _one_line(v: Any, limit: int) -> str:
    return " ".join(_s(v, limit).split())


def normalize_style_defaults(v: Any, base: dict[str, Any] | None = None) -> dict[str, str]:
    out = default_style_defaults()
    if isinstance(base, dict):
        out.update({k: x for k, x in base.items() if k in out and isinstance(x, str)})
        if out["formality"] not in FORMALITIES[1:]:
            out["formality"] = ""
    if v is None:
        return out
    if not isinstance(v, dict):
        raise MateError("prefs.defaults must be an object")
    if "formality" in v:
        f = _s(v["formality"], 32).strip()
        if f and f not in FORMALITIES[1:]:
            raise MateError(f"unknown default speech level: {f} (one of {', '.join(FORMALITIES[1:])})")
        out["formality"] = f
    if "address" in v:
        out["address"] = _one_line(v["address"], MAX_ADDRESS)
    if "self_ref" in v:
        out["self_ref"] = _one_line(v["self_ref"], MAX_SELF_REF)
    return out


def normalize_prefs(patch: Any, base: dict[str, Any] | None = None) -> dict[str, Any]:
    """``mate.prefs``: merged field by field (``tone`` / ``memory`` / ``defaults`` too); unknown keys dropped."""
    out = default_prefs()
    b = base if isinstance(base, dict) else {}
    for k in ("user_name", "address", "self_ref", "formality", "speech_style", "length", "emotion", "avoid",
              "self_edit", "self_outfit", "life"):
        if k in b:
            out[k] = b[k]
    if isinstance(b.get("tone"), dict):
        out["tone"].update({k: v for k, v in b["tone"].items() if k in TONE_KEYS and v in TONE_LEVELS})
    if isinstance(b.get("memory"), dict):
        out["memory"].update({k: v for k, v in b["memory"].items() if k in ("recall", "self_save")})
    out["defaults"] = normalize_style_defaults(None, b.get("defaults") if isinstance(b.get("defaults"), dict) else None)
    proactive = {"enabled": False, "interval": 180, "guidance": ""}
    for source in (b.get("proactive"), patch.get("proactive") if isinstance(patch, dict) else None):
        if source is None: continue
        if not isinstance(source, dict): raise MateError("prefs.proactive must be an object")
        if "enabled" in source:
            if not isinstance(source["enabled"], bool): raise MateError("proactive.enabled must be boolean")
            proactive["enabled"] = source["enabled"]
        if "interval" in source:
            if isinstance(source["interval"], bool) or source["interval"] not in (60,180,300,600):
                raise MateError("proactive.interval must be 60, 180, 300 or 600")
            proactive["interval"] = source["interval"]
        if "guidance" in source: proactive["guidance"] = _s(source["guidance"], 1000).strip()
        if "scope" in source: proactive["scope"] = _enum(source["scope"], ("all","screen"), "proactive scope")
        if "preset" in source:
            from .trigger.schemas import TriggerPresetManifest
            try: proactive["preset"] = TriggerPresetManifest.model_validate(source["preset"]).model_dump() if source["preset"] else None
            except ValueError as exc: raise MateError("Invalid Geny trigger preset: " + str(exc)) from exc
    proactive.setdefault("scope","all")
    proactive.setdefault("preset",None)
    out["proactive"] = proactive
    if patch is not None:
        if not isinstance(patch, dict):
            raise MateError("prefs must be an object")
        if "user_name" in patch:
            out["user_name"] = _one_line(patch["user_name"], 80)
        if "address" in patch:
            out["address"] = _one_line(patch["address"], MAX_ADDRESS)
        if "self_ref" in patch:
            out["self_ref"] = _one_line(patch["self_ref"], MAX_SELF_REF)
        if "formality" in patch:
            out["formality"] = _enum(patch["formality"], FORMALITIES, "speech level")
        if "speech_style" in patch:
            out["speech_style"] = _s(patch["speech_style"], MAX_SPEECH_STYLE).strip()
        if "length" in patch:
            out["length"] = _enum(patch["length"], LENGTHS, "reply length")
        if "emotion" in patch:
            if isinstance(patch["emotion"], bool):
                raise MateError("prefs.emotion must be 0 – 3")
            try:
                out["emotion"] = int(patch["emotion"])
            except (TypeError, ValueError) as exc:
                raise MateError("prefs.emotion must be 0 – 3") from exc
        if "avoid" in patch:
            out["avoid"] = _s(patch["avoid"], MAX_AVOID).strip()
        if "self_edit" in patch:
            out["self_edit"] = _enum(patch["self_edit"], SELF_EDIT, "self-edit setting")
        if "self_outfit" in patch:
            out["self_outfit"] = _enum(patch["self_outfit"], SELF_OUTFIT, "self-outfit setting")
        if "life" in patch:
            out["life"] = _enum(patch["life"], LIFE, "life setting")
        tone = patch.get("tone")
        if tone is not None:
            if not isinstance(tone, dict):
                raise MateError("prefs.tone must be an object")
            for k in TONE_KEYS:
                if k in tone:
                    out["tone"][k] = _enum(tone[k], TONE_LEVELS, f"tone.{k}")
        mem = patch.get("memory")
        if mem is not None:
            if not isinstance(mem, dict):
                raise MateError("prefs.memory must be an object")
            if "recall" in mem:
                out["memory"]["recall"] = _enum(mem["recall"], RECALL_LEVELS, "recall level")
            if "self_save" in mem:
                out["memory"]["self_save"] = bool(mem["self_save"])
        if patch.get("defaults") is not None:
            out["defaults"] = normalize_style_defaults(patch["defaults"], out["defaults"])
    # (a stored document from an older/newer version: keep it well-typed)
    try:
        out["emotion"] = max(0, min(3, int(out["emotion"])))
    except (TypeError, ValueError):
        out["emotion"] = 2
    for k, allowed in (("formality", FORMALITIES), ("length", LENGTHS), ("self_edit", SELF_EDIT),
                       ("self_outfit", SELF_OUTFIT), ("life", LIFE)):
        if out[k] not in allowed:
            out[k] = "normal" if k == "length" else allowed[0]
    if out["memory"].get("recall") not in RECALL_LEVELS:
        out["memory"]["recall"] = "normal"
    out["memory"]["self_save"] = bool(out["memory"].get("self_save", True))
    for k in ("user_name", "address", "self_ref", "avoid", "speech_style"):
        out[k] = str(out[k] or "")
    return out


def effective_style(prefs: dict[str, Any] | None) -> dict[str, Any]:
    """What the conversation style comes to: the user's (or the mate's own) choice, else the character's default
    (``defaults``) → {formality ("" = no level set anywhere), formality_default (it is the character's), address,
    address_default, self_ref}."""
    s = normalize_prefs(None, prefs)
    d = s["defaults"]
    chosen = s["formality"] if s["formality"] != "auto" else ""
    return {"formality": chosen or d["formality"], "formality_default": not chosen and bool(d["formality"]),
            "address": s["address"] or d["address"], "address_default": not s["address"] and bool(d["address"]),
            "self_ref": s["self_ref"] or d["self_ref"]}


SCREEN_APPROVALS = ("ask", "allow")   # ask every time (default) | allow without asking
SCREEN_EDGES = (1280, 1920, 2560, 0)  # the long side at most (0 = as captured)


def default_screen() -> dict[str, Any]:
    return {"enabled": False, "approval": "ask", "hide_avatar": True, "max_edge": 1920}


def normalize_screen(patch: Any, base: dict[str, Any] | None = None) -> dict[str, Any]:
    """``mate.screen`` (docs/mate.md §4 "Seeing the screen"): may the mate look at the user's screen
    (``see_screen``, off by default), ask first or not, hide the avatar windows while capturing, the size of
    the picture (always a PNG). What to capture (a screen / a window) is chosen on each computer in the desktop app.
    Merged field by field; unknown keys dropped; wrong types / values → 400."""
    out = default_screen()
    b = base if isinstance(base, dict) else {}
    for k in out:
        if k in b:
            out[k] = b[k]
    if patch is not None:
        if not isinstance(patch, dict):
            raise MateError("screen must be an object")
        for k in ("enabled", "hide_avatar"):
            if k in patch:
                if not isinstance(patch[k], bool):
                    raise MateError(f"screen.{k} must be true or false")
                out[k] = patch[k]
        if "approval" in patch:
            out["approval"] = _enum(patch["approval"], SCREEN_APPROVALS, "screen.approval")
        if "max_edge" in patch:
            v = patch["max_edge"]
            if isinstance(v, bool) or not isinstance(v, int) or v not in SCREEN_EDGES:
                raise MateError(f"screen.max_edge must be one of {', '.join(map(str, SCREEN_EDGES))}")
            out["max_edge"] = v
    # (a stored document from an older/newer version: keep it well-typed)
    out["enabled"] = out["enabled"] is True
    out["hide_avatar"] = out["hide_avatar"] is not False
    if out["approval"] not in SCREEN_APPROVALS:
        out["approval"] = "ask"
    if out["max_edge"] not in SCREEN_EDGES:
        out["max_edge"] = 1920
    return out


def _name(v: Any, what: str, limit: int = 64) -> str:
    if not isinstance(v, str) or not v.strip():
        raise MateError(f"{what} must be a non-empty string")
    return v.strip()[:limit]


def normalize_clip(c: Any) -> dict[str, Any]:
    """One rig clip: ``{id, kind, src, small?, emotion?, loop?, disabled?}`` (unknown keys are kept)."""
    if not isinstance(c, dict):
        raise MateError("every rig clip must be an object")
    out = dict(c)
    out["id"] = _name(c.get("id"), "clip id")
    if c.get("kind") not in CLIP_KINDS:
        raise MateError(f"clip {out['id']}: unknown kind {c.get('kind')!r} (one of {', '.join(CLIP_KINDS)})")
    out["src"] = _s(c.get("src"), 2000)
    for k in ("small", "emotion", "thumb"):
        if c.get(k) in (None, ""):
            out.pop(k, None)
        else:
            out[k] = _s(c[k], 64 if k == "emotion" else 2000).strip()
    for k in ("loop", "disabled"):  # flags: present only when on
        if c.get(k):
            out[k] = True
        else:
            out.pop(k, None)
    return out


def normalize_rig(rig: dict[str, Any], *, photo: bool = False) -> dict[str, Any]:
    """A video/photo rig (docs/mate.md §2): clips validated (unique ids, known kinds, ``disabled``),
    ``emotions`` (emotion -> clip ids; ids that aren't clips are dropped, an empty list means "no
    clip for this emotion") and ``emotion_stills`` (emotion -> still name, "" = none; not a mechanic
    still). Other keys are kept as they are."""
    rig = dict(rig)
    rig.setdefault("aspect", [1, 1])
    rig.setdefault("home", "")
    rig.setdefault("stills", {})
    rig.setdefault("clips", [])
    if not isinstance(rig["stills"], dict) or not isinstance(rig["clips"], list):
        raise MateError("rig.stills must be an object and rig.clips a list")
    rig["stills"] = {str(k)[:64]: v for k, v in rig["stills"].items() if isinstance(v, str)}
    if photo:
        rig["clips"] = []
    if len(rig["clips"]) > MAX_CLIPS:
        raise MateError(f"a rig has at most {MAX_CLIPS} clips")
    clips = [normalize_clip(c) for c in rig["clips"]]
    ids = [c["id"] for c in clips]
    dup = next((i for i in ids if ids.count(i) > 1), None)
    if dup is not None:
        raise MateError(f"two clips are called {dup!r}: clip ids must be unique")
    rig["clips"] = clips
    emotions = rig.get("emotions")
    if emotions is None or photo:
        rig.pop("emotions", None)
    else:
        if not isinstance(emotions, dict):
            raise MateError("rig.emotions must be an object (emotion -> clip ids)")
        known = set(ids)
        out: dict[str, list[str]] = {}
        for emo, lst in emotions.items():
            key = str(emo).strip().lower()[:64]
            if not key:
                continue
            if isinstance(lst, str):
                lst = [lst]
            if not isinstance(lst, list):
                raise MateError(f"rig.emotions.{key} must be a list of clip ids")
            keep: list[str] = []
            for x in lst:
                if isinstance(x, str) and x in known and x not in keep:
                    keep.append(x)
            # every id gone (clips removed) -> the key goes too; an empty list the user set stays ("nothing")
            if keep or not lst:
                out[key] = keep
        rig["emotions"] = out
    es = rig.get("emotion_stills")
    if es is None:
        rig.pop("emotion_stills", None)
    else:
        if not isinstance(es, dict):
            raise MateError("rig.emotion_stills must be an object (emotion -> still name)")
        out_s: dict[str, str] = {}
        for emo, name in es.items():
            key = str(emo).strip().lower()[:64]
            if not key or not isinstance(name, str):
                continue
            if name == "" or (name in rig["stills"] and name not in MECHANIC_STILLS):
                out_s[key] = name
        rig["emotion_stills"] = out_s
    return rig


def normalize_avatar(v: Any) -> dict[str, Any]:
    if v is None:
        return {"kind": "none"}
    if not isinstance(v, dict):
        raise MateError("avatar must be an object")
    kind = v.get("kind") or "none"
    if kind not in AVATAR_KINDS:
        raise MateError(f"unknown avatar kind: {kind}")
    if len(json.dumps(v)) > MAX_AVATAR_JSON:
        raise MateError("avatar document is too large")
    if kind == "none":
        return {"kind": "none"}
    if kind in ("video", "photo"):
        rig = v.get("rig")
        if not isinstance(rig, dict):
            raise MateError(f"a {kind} avatar needs a rig")
        return {"kind": kind, "rig": normalize_rig(rig, photo=kind == "photo")}
    if kind == "livliv":
        return {"kind": "livliv", "livliv": _clean_livliv(v.get("livliv"))}
    l2d = v.get("live2d")
    if not isinstance(l2d, dict) or not isinstance(l2d.get("model"), str) or not l2d["model"]:
        raise MateError("a live2d avatar needs live2d.model (URL of the *.model3.json)")
    return {"kind": "live2d", "live2d": dict(l2d)}


def _clean_livliv(lv: Any) -> dict[str, Any]:
    """A LivLiv body: its model (the ``model.json`` or ``.livliv`` URL), what the package says about itself, and the user's
    own choices: which expression (or none) plays for an emotion of hers (``emotions``; unset, the standard ids that share her
    emotion's name do), and whether her eyes follow the pointer over her (``follow``)."""
    if not isinstance(lv, dict) or not isinstance(lv.get("model"), str) or not lv["model"].strip():
        raise MateError("a livliv avatar needs livliv.model (URL of the model.json or .livliv)")
    out: dict[str, Any] = {"model": lv["model"].strip()[:2000]}
    for key in ("name", "cover", "avatar", "author", "watermark"):
        if isinstance(lv.get(key), str):
            out[key] = lv[key][:2000]
    canvas = lv.get("canvas")
    if isinstance(canvas, list) and len(canvas) == 2 and all(isinstance(x, int) and x > 0 for x in canvas):
        out["canvas"] = list(canvas)
    if isinstance(lv.get("expressions"), list):
        out["expressions"] = [str(x)[:32] for x in lv["expressions"] if isinstance(x, str)][:64]
    if isinstance(lv.get("license"), dict):
        out["license"] = {k: str(lv["license"][k])[:300] for k in ("id", "url") if isinstance(lv["license"].get(k), str)}
    if isinstance(lv.get("emotions"), dict):
        out["emotions"] = {str(k)[:32]: (str(x)[:32] if isinstance(x, str) else "") for k, x in list(lv["emotions"].items())[:64]}
    if lv.get("follow") in ("canvas", "off"):
        out["follow"] = lv["follow"]
    return out


def _loads(raw: Any, empty: Any) -> Any:
    try:
        v = json.loads(raw or "null")
    except (TypeError, ValueError):
        return empty
    return v if isinstance(v, type(empty)) else empty


def with_new_clips(avatar: dict[str, Any], old: dict[str, Any] | None, new: dict[str, Any]) -> dict[str, Any]:
    """A body the user edited keeps the edits, and what the bundle brings for the first time joins it: a clip the old bundle
    never had (one the user took out of the old set stays out), and stills or emotions it never had."""
    rig = avatar.get("rig")
    before, after = ((old or {}).get("rig") or {}), (new.get("rig") or {})
    if not isinstance(rig, dict) or not after:
        return avatar
    had = {c.get("id") for c in before.get("clips") or []} | {c.get("id") for c in rig.get("clips") or []}
    fresh = [c for c in after.get("clips") or [] if c.get("id") not in had]
    extra = {f: {k: v for k, v in (after.get(f) or {}).items() if k not in (before.get(f) or {}) and k not in (rig.get(f) or {})}
             for f in ("stills", "emotions")}
    # (a clip of theirs that is still the bundle's, on the same file, gets what the bundle adds to it: its still for the library)
    bundled = {c.get("id"): c for c in after.get("clips") or []}
    clips = [{**c, "thumb": bundled[c.get("id")]["thumb"]} if not c.get("thumb") and bundled.get(c.get("id"), {}).get("thumb")
             and bundled[c.get("id")].get("src") == c.get("src") else c for c in rig.get("clips") or []]
    if not fresh and not any(extra.values()) and clips == (rig.get("clips") or []):
        return avatar
    rig = {**rig, "clips": [*clips, *fresh]}
    for f, more in extra.items():
        if more:
            rig[f] = {**(rig.get(f) or {}), **more}
    return {**avatar, "rig": rig}


def _on_new_files(avatar: dict[str, Any], old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """A set the user edited, when the bundle's files moved to another folder: the edits stay (a clip switched off, her
    triggers), on the new files, and what the new files bring for the first time joins them. The old folder is gone
    with that bundle."""
    def folder(doc: dict[str, Any]) -> str:
        return str((doc.get("rig") or {}).get("home") or "").rpartition("/")[0]

    was, now = folder(old), folder(new)
    if not was or not now or was == now:
        return with_new_clips(avatar, old, new)  # (the same folder: what is new in it still joins)
    moved = json.loads(json.dumps(avatar, ensure_ascii=False).replace(f"{was}/", f"{now}/"))
    rig, before, after = moved.get("rig"), old.get("rig") or {}, new.get("rig") or {}
    if not isinstance(rig, dict):
        return moved
    if after.get("aspect"):
        rig["aspect"] = after["aspect"]  # (the new files' crop)
    # (only what the bundle never had: something the user took out of the old set stays out)
    had = {c.get("id") for c in before.get("clips") or []}
    rig["clips"] = [*(rig.get("clips") or []), *(c for c in after.get("clips") or [] if c.get("id") not in had)]
    for field in ("stills", "emotions"):
        fresh = {k: v for k, v in (after.get(field) or {}).items() if k not in (before.get(field) or {})}
        if fresh:
            rig[field] = {**(rig.get(field) or {}), **fresh}
    return moved


def takes_frame(avatar: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """A set the user edited keeps the edits, and takes the bundle's measurement of the same picture."""
    rig, bundled = avatar.get("rig"), new.get("rig")
    if not isinstance(rig, dict) or not isinstance(bundled, dict) or not bundled.get("frame"):
        return avatar
    if rig.get("home") != bundled.get("home") or rig.get("frame") == bundled["frame"]:
        return avatar
    return {**avatar, "rig": {**rig, "frame": bundled["frame"]}}


def outfit_lock(item: dict[str, Any], affinity: int) -> int | None:
    """The affinity an outfit still waits for, None when it is open. Once reached it stays open (``unlock.at``), however
    the affinity moves later."""
    unlock = item.get("unlock") or {}
    need = unlock.get("affinity")
    return need if need and not unlock.get("at") and affinity < need else None


def _outfit_card(oid: str, name: str, avatar: dict[str, Any], *, note: str = "", lock: int | None = None,
                 feel: Any = None) -> dict[str, Any]:
    if lock:  # (only that it is there and what opens it: nothing of the set itself)
        return {"id": oid, "name": name, "kind": "none", "home": "", "aspect": [3, 4], "clips": 0, "stills": 0, "note": "",
                "locked": {"affinity": lock}}
    rig = avatar.get("rig") if isinstance(avatar.get("rig"), dict) else {}
    lv = avatar.get("livliv") if isinstance(avatar.get("livliv"), dict) else {}  # (a LivLiv set: its cover, its canvas)
    return {"id": oid, "name": name, "kind": avatar.get("kind") or "none",
            "home": rig.get("home") or (rig.get("stills") or {}).get("neutral") or lv.get("cover") or "",
            "aspect": rig.get("aspect") or lv.get("canvas") or [3, 4], "frame": rig.get("frame"), "clips": len(rig.get("clips") or []),
            "stills": len(rig.get("stills") or {}), "note": note, "feel": S.clean_feel(feel)}


def outfits_view(raw: dict[str, Any], on: dict[str, Any], affinity: int = 0) -> dict[str, Any]:
    """The wardrobe as clients see it (no avatar documents): which set she has on and a card per set, her default
    set first. ``on`` is the avatar column: the set she has on."""
    worn = raw.get("worn") or DEFAULT_OUTFIT
    base = on if worn == DEFAULT_OUTFIT else (raw.get("base") or {"kind": "none"})
    return {"worn": worn, "items": [
        _outfit_card(DEFAULT_OUTFIT, "", base),
        *(_outfit_card(it["id"], it["name"], on if it["id"] == worn else it["avatar"], note=it.get("note") or "",
                       lock=None if it["id"] == worn else outfit_lock(it, affinity), feel=it.get("feel"))
          for it in raw.get("items") or []),
    ]}


class MateStore:
    def __init__(self, db: Database, vault: SecretVault | None = None) -> None:
        self._db = db
        self._vault = vault
        # One reentrant connection lock avoids inversion between a source
        # transaction and a store mutation (UI, background worker, imports).
        self._lock = db._lock
        self.knowledge = Knowledge(db)
        self.last_changed: set[str] = set()  # the settings the last update_settings() changed
        # the same vendor's key from the language-model providers (Settings → Language model providers), for a
        # voice service whose own key is not set: one OpenAI / Google key is entered once (app/main.py)
        self.shared_key: Any = None
        # told (reason, mate_id) after every write a client can see: MateService
        # wires it to the /ws/sessions feed so every window refetches its mates
        self.on_change: Callable[[str, str | None], None] | None = None
        # told (mate_id) when a memory was added (not merged): the relationship counts it
        self.on_memory_added: Callable[[str], None] | None = None
        self.on_memory_forgotten: Callable[[str, bool], None] | None = None

    def _changed(self, reason: str, mate_id: str | None = None) -> None:
        if self.on_change is not None:
            try:
                self.on_change(reason, mate_id)
            except Exception:  # noqa: BLE001 - a notification never fails a write
                pass

    # ---- mates ----

    def _out(self, row: Any) -> dict[str, Any]:
        avatar = _loads(row["avatar"], {}) or {"kind": "none"}
        relation = self.relation_summary(row["id"])
        raw_outfits = _loads(row["outfits"], {}) if "outfits" in row.keys() else {}
        builtin = row["builtin"] if "builtin" in row.keys() else None
        prefs = _loads(row["prefs"], {}) if "prefs" in row.keys() else {}
        now = datetime.now(timezone.utc)
        life = self.life_now(row["id"], builtin, prefs)
        persona = normalize_persona(_loads(row["persona"], {}))
        who = self._who(builtin, raw_outfits, self.relation_doc(row["id"]) or A.new(), sim.for_state(life[0], life[1], now) if life else None,
                        row["name"] or "", gender=persona["gender"], created_at=row["created_at"], seed=row["id"])
        return {
            "id": row["id"],
            "name": row["name"],
            "is_default": bool(row["is_default"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "persona": persona,
            "avatar": avatar,
            "outfits": outfits_view(raw_outfits, avatar, relation["affinity"]),
            "llm": normalize_llm(None, _loads(row["llm"], {})),
            "voice": normalize_voice(None, _loads(row["voice"], {})),
            # (the user's name is one for all mates: Settings → Account; docs/settings.md)
            "prefs": {**normalize_prefs(None, prefs), "user_name": self.user_name()},
            "screen": normalize_screen(None, _loads(row["screen"], {}) if "screen" in row.keys() else {}),
            "session_id": row["session_id"],
            "memory_rev": row["memory_rev"],
            "builtin": builtin,
            "customized": bool(row["customized"]) if "customized" in row.keys() else False,
            "draft": bool(row["draft"]) if "draft" in row.keys() else False,
            "relation": relation,
            "state": S.summary(self.state_doc(row["id"]), who, now, self.tz()),
            "life": sim.summary(life[0], life[1], now, self.tz()) if life else {"enabled": False},
        }

    def list(self) -> list[dict[str, Any]]:
        """The mates (default first) — not the drafts being made in the Mate Create studio."""
        rows = self._db.query("SELECT * FROM mates WHERE draft = 0 ORDER BY is_default DESC, created_at")
        return [self._out(r) for r in rows]

    def drafts(self) -> list[dict[str, Any]]:
        """Mates still being made in the Mate Create studio (docs/avatar-create.md §11), newest first."""
        rows = self._db.query("SELECT * FROM mates WHERE draft = 1 ORDER BY updated_at DESC")
        return [self._out(r) for r in rows]

    def finish_draft(self, mate_id: str) -> dict[str, Any]:
        """A draft becomes a mate (it shows in the picker); the first real mate becomes the default."""
        cur = self.get(mate_id)
        if not cur["draft"]:
            return cur
        if not cur["name"].strip():
            raise MateError("a mate needs a name")
        # (the studio says who she is; one it didn't: her own text, once)
        persona = {**cur["persona"], "gender": cur["persona"]["gender"]
                   or infer_gender(cur["persona"], (cur.get("prefs") or {}).get("speech_style"))}
        with self._lock:
            first = self._db.query_one("SELECT COUNT(*) AS c FROM mates WHERE draft = 0")["c"] == 0
            if first:
                self._db.execute("UPDATE mates SET is_default = 0")
            self._db.execute("UPDATE mates SET draft = 0, is_default = ?, persona = ?, created_at = ?, updated_at = ? WHERE id = ?",
                             (1 if first else 0, json.dumps(persona, ensure_ascii=False), now_iso(), now_iso(), mate_id))
        self._changed("created", mate_id)
        return self.get(mate_id)

    def get(self, mate_id: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT * FROM mates WHERE id = ?", (mate_id,))
        if row is None:
            raise KeyError(f"mate not found: {mate_id}")
        return self._out(row)

    def create(
        self,
        *,
        name: str,
        persona: Any = None,
        avatar: Any = None,
        llm: Any = None,
        voice: Any = None,
        prefs: Any = None,
        is_default: bool = False,
        draft: bool = False,
    ) -> dict[str, Any]:
        name = _s(name, 80).strip()
        if not name and not draft:  # (a draft gets its name in the studio)
            raise MateError("a mate needs a name")
        persona, moved = split_persona(persona)  # (an import / older client: its speech fields are style now)
        if moved:
            prefs = {**moved, **(prefs if isinstance(prefs, dict) else {})}
        doc = (normalize_persona(persona), normalize_avatar(avatar), normalize_llm(llm), normalize_voice(voice),
               normalize_prefs(prefs))
        if not (isinstance(persona, dict) and "gender" in persona):  # (an import, an older client: her own text tells)
            doc[0]["gender"] = infer_gender(doc[0], doc[4].get("speech_style"))
        if doc[4].get("user_name"):  # (the user's name, one for all mates)
            self.set_user_name(doc[4]["user_name"])
        mid = new_id("mate_")
        now = now_iso()
        with self._lock:
            # (a draft is never the default: it isn't a mate yet)
            first = not draft and self._db.query_one("SELECT COUNT(*) AS c FROM mates WHERE draft = 0")["c"] == 0
            default = not draft and (is_default or first)
            if default:
                self._db.execute("UPDATE mates SET is_default = 0")
            self._db.execute(
                "INSERT INTO mates (id, name, is_default, persona, avatar, llm, voice, prefs, draft, created_at, "
                "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (mid, name, 1 if default else 0, *(json.dumps(d, ensure_ascii=False) for d in doc),
                 1 if draft else 0, now, now),
            )
        self._changed("draft" if draft else "created", mid)
        return self.get(mid)

    def ensure_default(self) -> bool:
        """No mates yet: create "Geny" (no avatar, browser voice). True if created."""
        with self._lock:
            if self._db.query_one("SELECT COUNT(*) AS c FROM mates WHERE draft = 0")["c"]:
                return False
            now = now_iso()
            self._db.execute(
                "INSERT INTO mates (id, name, is_default, persona, avatar, llm, voice, prefs, created_at, updated_at) "
                "VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
                (new_id("mate_"), "Geny", json.dumps(normalize_persona(DEFAULT_PERSONA), ensure_ascii=False),
                 json.dumps({"kind": "none"}), json.dumps(normalize_llm(None)), json.dumps(normalize_voice(None)),
                 json.dumps(normalize_prefs(DEFAULT_STYLE), ensure_ascii=False), now, now),
            )
            return True

    def update(self, mate_id: str, patch: dict[str, Any]) -> tuple[dict[str, Any], set[str]]:
        """Partial update: persona/llm/voice/prefs are merged field by field, the
        avatar is replaced. Returns (mate, names of the parts that changed)."""
        cur = self.get(mate_id)
        sets: list[str] = []
        params: list[Any] = []
        changed: set[str] = set()
        if isinstance(patch.get("persona"), dict):  # (an older client / import: its speech fields are style now)
            persona, moved = split_persona(patch["persona"])
            if moved:
                # (a page still open from before the move sends the old values back with every save: what the
                # migration already moved is not a change)
                legacy = self.persona_legacy(mate_id) or {}
                old = {new: k for k, new in LEGACY_STYLE_FIELDS.items()}
                moved = {k: v for k, v in moved.items() if old[k] not in legacy or v != legacy[old[k]]}
                patch = {**patch, "persona": persona,
                         "prefs": {**moved, **(patch["prefs"] if isinstance(patch.get("prefs"), dict) else {})}}
        if "name" in patch and patch["name"] is not None:
            name = _s(patch["name"], 80).strip()
            if not name and not cur.get("draft"):
                raise MateError("a mate needs a name")
            if name != cur["name"]:
                sets.append("name = ?")
                params.append(name)
                changed.add("name")
        if isinstance(patch.get("prefs"), dict) and "user_name" in patch["prefs"]:
            # the user's name is one for all mates (Settings → Account): whoever writes it here — the style tab of an
            # older page, her own style change and its undo, the studio — writes that one
            if self.set_user_name(patch["prefs"]["user_name"]):
                changed.add("prefs")
            patch = {**patch, "prefs": {k: v for k, v in patch["prefs"].items() if k != "user_name"}}
        for key, fn in (("persona", normalize_persona), ("llm", normalize_llm), ("voice", normalize_voice),
                        ("prefs", normalize_prefs), ("screen", normalize_screen)):
            if key in patch and patch[key] is not None:
                new = fn(patch[key], cur[key])
                if new != cur[key]:
                    sets.append(f"{key} = ?")
                    params.append(json.dumps(new, ensure_ascii=False))
                    changed.add(key)
        in_outfit = cur["outfits"]["worn"] != DEFAULT_OUTFIT
        if "avatar" in patch and patch["avatar"] is not None:
            new = normalize_avatar(patch["avatar"])
            if patch.get("_sync") and in_outfit:  # (a bundle update is her default set, not what she has on)
                wardrobe = self._wardrobe(mate_id)
                if new != wardrobe["base"]:
                    sets.append("outfits = ?")
                    params.append(json.dumps({**wardrobe, "base": new}, ensure_ascii=False))
                    changed.add("avatar")
            elif new != cur["avatar"]:
                sets.append("avatar = ?")
                params.append(json.dumps(new, ensure_ascii=False))
                changed.add("avatar")
        # (editing an outfit set leaves the bundled default set as it is)
        if cur.get("builtin") and not patch.get("_sync") and ("persona" in changed or ("avatar" in changed
                                                                                        and not in_outfit)):
            sets.append("customized = 1")  # the user's own version now: content updates leave it alone
        with self._lock:
            if patch.get("is_default") and not cur["is_default"] and not cur.get("draft"):
                self._db.execute("UPDATE mates SET is_default = 0")
                sets.append("is_default = 1")
                changed.add("is_default")
            if sets:
                sets.append("updated_at = ?")
                params += [now_iso(), mate_id]
                self._db.execute(f"UPDATE mates SET {', '.join(sets)} WHERE id = ?", params)
        if sets:
            self._changed("draft" if cur.get("draft") else "updated", mate_id)
        return self.get(mate_id), changed

    # ---- the wardrobe (docs/mate.md "Outfits") ----
    # The avatar column is always the set she has on, so everything that reads a mate just works. ``outfits`` holds the
    # rest: {worn, worn_at (since when), base (her default set while another one is on), items: [{id, name, note, feel,
    # avatar}]}. An outfit starts
    # empty (kind "none") and is filled like any avatar. What comes off keeps the state it was in (a worn item's own
    # ``avatar`` is only refreshed then).

    def _wardrobe(self, mate_id: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT outfits FROM mates WHERE id = ?", (mate_id,))
        if row is None:
            raise KeyError(f"mate not found: {mate_id}")
        w = _loads(row["outfits"], {})
        return {"worn": w.get("worn") or DEFAULT_OUTFIT, "worn_at": w.get("worn_at"), "base": w.get("base"),
                "items": w.get("items") or []}

    def _save_wardrobe(self, mate_id: str, wardrobe: dict[str, Any], avatar: dict[str, Any] | None = None) -> None:
        sets, params = ["outfits = ?", "updated_at = ?"], [json.dumps(wardrobe, ensure_ascii=False), now_iso()]
        if avatar is not None:
            sets.append("avatar = ?")
            params.append(json.dumps(avatar, ensure_ascii=False))
        self._db.execute(f"UPDATE mates SET {', '.join(sets)} WHERE id = ?", (*params, mate_id))
        self._changed("updated", mate_id)

    @staticmethod
    def _outfit_item(wardrobe: dict[str, Any], oid: str) -> dict[str, Any]:
        for it in wardrobe["items"]:
            if it["id"] == oid:
                return it
        raise KeyError(f"outfit not found: {oid}")

    def _open_outfit_item(self, mate_id: str, wardrobe: dict[str, Any], oid: str) -> dict[str, Any]:
        """One outfit to use or change: not while it waits for her affinity."""
        item = self._outfit_item(wardrobe, oid)
        need = None if oid == wardrobe["worn"] else outfit_lock(item, self.relation_summary(mate_id)["affinity"])
        if need:
            raise MateError(f"this outfit opens at affinity {need}", status=403)
        return item

    def _open_reached_outfits(self, mate_id: str, affinity: int) -> None:
        """What her affinity reached stays open from now on."""
        with self._lock:
            try:
                w = self._wardrobe(mate_id)
            except KeyError:
                return
            reached = [it for it in w["items"] if (it.get("unlock") or {}).get("affinity") and not outfit_lock(it, affinity)
                       and not it["unlock"].get("at")]
            for it in reached:
                it["unlock"] = {**it["unlock"], "at": now_iso()}
            if reached:
                self._save_wardrobe(mate_id, w)

    def close_outfits(self, mate_id: str) -> None:
        """A fresh start with her: what her affinity opened waits again, and she goes back to what is open."""
        with self._lock:
            w = self._wardrobe(mate_id)
            opened = [it["id"] for it in w["items"] if (it.get("unlock") or {}).get("at")]
            if not opened:
                return
            if w["worn"] in opened:
                self.wear_outfit(mate_id, DEFAULT_OUTFIT)
                w = self._wardrobe(mate_id)
            for it in w["items"]:
                if it["id"] in opened:
                    it["unlock"] = {"affinity": it["unlock"]["affinity"]}
            self._save_wardrobe(mate_id, w)

    def base_avatar(self, mate_id: str) -> dict[str, Any]:
        """Her default set, whatever she has on."""
        w = self._wardrobe(mate_id)
        return self.get(mate_id)["avatar"] if w["worn"] == DEFAULT_OUTFIT else (w["base"] or {"kind": "none"})

    def all_avatars(self, mate_id: str) -> list[dict[str, Any]]:
        """Every avatar document of this mate: what she has on and all the rest of the wardrobe."""
        w = self._wardrobe(mate_id)
        return [self.get(mate_id)["avatar"], *([w["base"]] if w["base"] else []), *(it["avatar"] for it in w["items"])]

    def worn_outfit(self, mate_id: str) -> dict[str, Any] | None:
        """The outfit she has on, without its avatar; None in her default set."""
        w = self._wardrobe(mate_id)
        if w["worn"] == DEFAULT_OUTFIT:
            return None
        return {k: v for k, v in self._outfit_item(w, w["worn"]).items() if k != "avatar"}

    def wear_outfit(self, mate_id: str, oid: str) -> dict[str, Any]:
        with self._lock:
            cur = self.get(mate_id)
            w = self._wardrobe(mate_id)
            if oid == w["worn"]:
                return cur
            on = w["base"] if oid == DEFAULT_OUTFIT else self._open_outfit_item(mate_id, w, oid)["avatar"]
            if oid != DEFAULT_OUTFIT and on.get("kind") == "none":
                raise MateError("this outfit is still empty")
            if w["worn"] == DEFAULT_OUTFIT:
                w["base"] = cur["avatar"]
            else:
                self._outfit_item(w, w["worn"])["avatar"] = cur["avatar"]
            if oid == DEFAULT_OUTFIT:
                w["base"] = None
            w["worn"], w["worn_at"] = oid, now_iso()
            self._save_wardrobe(mate_id, w, on or {"kind": "none"})
        return self.get(mate_id)

    def seed_builtin_outfits(self, mate_id: str, items: list[dict[str, Any]], previous: list[dict[str, Any]]) -> None:
        """Offer new bundled outfits once. Preserve edits, deletions, and whatever she has on. One she already has follows
        the bundle where it is still as bundled (its name and note, its set), and always in what opens it and what it does
        to how she feels."""
        with self._lock:
            w = self._wardrobe(mate_id)
            before = json.dumps(w, sort_keys=True)
            on = None
            was = {it["id"]: it for it in previous}
            for it in items:
                cur = next((x for x in w["items"] if x["id"] == it["id"]), None)
                if cur is None:
                    continue
                old, worn = was.get(it["id"]), cur["id"] == w["worn"]
                if old:
                    if cur["name"] == old["name"]:
                        cur["name"] = it["name"]
                    if (cur.get("note") or "") == (old.get("note") or ""):
                        cur["note"] = it.get("note") or ""
                    new = normalize_avatar(it["avatar"])
                    live = self.get(mate_id)["avatar"] if worn else cur["avatar"]
                    follows = new if live == old["avatar"] else takes_frame(_on_new_files(live, old["avatar"], new), new)
                    if follows != live:
                        cur["avatar"] = follows
                        on = follows if worn else on
                cur["feel"] = S.clean_feel(it.get("feel"))  # (what it does to her comes with the outfit)
                if worn and not w.get("worn_at"):
                    w["worn_at"] = now_iso()  # (on since before anyone noted the time: it counts from here)
                need = (it.get("unlock") or {}).get("affinity")
                # (an update never takes off what she has on: that one stays open)
                at = (cur.get("unlock") or {}).get("at") or (now_iso() if worn and need else None)
                if need:
                    cur["unlock"] = {"affinity": need, **({"at": at} if at else {})}
                else:
                    cur.pop("unlock", None)
            seen = {it["id"] for it in [*previous, *w["items"]]}
            added = [it for it in items if it["id"] not in seen]
            if len(w["items"]) + len(added) > MAX_OUTFITS:
                raise MateError("wardrobe is full: delete an outfit before adding bundled outfits")
            w["items"].extend({**it, "avatar": normalize_avatar(it["avatar"]), "created_at": now_iso()} for it in added)
            if json.dumps(w, sort_keys=True) != before:
                self._save_wardrobe(mate_id, w, on)
            self._open_reached_outfits(mate_id, self.relation_summary(mate_id)["affinity"])

    def add_outfit(self, mate_id: str, name: str) -> str:
        """A new, empty place in her wardrobe."""
        name = _s(name, 40).strip()
        if not name:
            raise MateError("an outfit needs a name")
        with self._lock:
            w = self._wardrobe(mate_id)
            if len(w["items"]) >= MAX_OUTFITS:
                raise MateError(f"a wardrobe holds at most {MAX_OUTFITS} outfits: delete one first")
            oid = new_id("out_")
            w["items"].append({"id": oid, "name": name, "note": "", "created_at": now_iso(), "avatar": {"kind": "none"}})
            self._save_wardrobe(mate_id, w)
        return oid

    def outfit_avatar(self, mate_id: str, oid: str) -> dict[str, Any]:
        """The avatar document of one set, whether she has it on or not."""
        w = self._wardrobe(mate_id)
        if oid == w["worn"]:
            return self.get(mate_id)["avatar"]
        if oid == DEFAULT_OUTFIT:
            return w["base"] or {"kind": "none"}
        return self._open_outfit_item(mate_id, w, oid)["avatar"]

    def set_outfit_avatar(self, mate_id: str, oid: str, avatar: Any, *, note: str | None = None) -> None:
        """What one set is made of, whether she has it on or not."""
        doc = normalize_avatar(avatar)
        with self._lock:
            w = self._wardrobe(mate_id)
            if oid == DEFAULT_OUTFIT:
                if w["worn"] == DEFAULT_OUTFIT:
                    raise MateError("her default set is on: change it like any avatar")
                w["base"] = doc
                self._save_wardrobe(mate_id, w)
                if self.get(mate_id).get("builtin"):
                    self.set_customized(mate_id, True)  # (the user's own version now, as with any avatar edit)
                return
            item = self._open_outfit_item(mate_id, w, oid)
            item["avatar"] = doc
            if note is not None:
                item["note"] = _s(note, 300)
            self._save_wardrobe(mate_id, w, doc if w["worn"] == oid else None)

    def fill_frames(self, mate_id: str, framed: Callable[[Any, str], Any]) -> None:
        """Sets from before they carried a ``frame``: measured once, without anything else changing."""
        with self._lock:
            w = self._wardrobe(mate_id)
            before = json.dumps(w, sort_keys=True)
            if w["base"]:
                w["base"] = framed(w["base"], mate_id)
            for it in w["items"]:
                it["avatar"] = framed(it["avatar"], mate_id)
            cur = self.get(mate_id)["avatar"]
            on = framed(cur, mate_id)
            if json.dumps(w, sort_keys=True) != before or on != cur:
                self._save_wardrobe(mate_id, w, on if on != cur else None)

    def rename_outfit(self, mate_id: str, oid: str, name: str) -> dict[str, Any]:
        name = _s(name, 40).strip()
        if not name:
            raise MateError("an outfit needs a name")
        with self._lock:
            w = self._wardrobe(mate_id)
            self._open_outfit_item(mate_id, w, oid)["name"] = name
            self._save_wardrobe(mate_id, w)
        return self.get(mate_id)

    def delete_outfit(self, mate_id: str, oid: str) -> dict[str, Any]:
        """Out of the wardrobe (her default set back on when she had it on). The default set can't go."""
        with self._lock:
            if oid == DEFAULT_OUTFIT:
                raise MateError("her default set stays in the wardrobe")
            self._open_outfit_item(mate_id, self._wardrobe(mate_id), oid)
            if self._wardrobe(mate_id)["worn"] == oid:
                self.wear_outfit(mate_id, DEFAULT_OUTFIT)
            w = self._wardrobe(mate_id)
            w["items"] = [it for it in w["items"] if it["id"] != oid]
            self._save_wardrobe(mate_id, w)
        return self.get(mate_id)

    # ---- built-in mates ----

    def by_builtin(self, key: str) -> dict[str, Any] | None:
        row = self._db.query_one("SELECT * FROM mates WHERE builtin = ?", (key,))
        if row is None:
            return None
        snap = _loads(row["builtin_snapshot"], {}) if "builtin_snapshot" in row.keys() else {}
        return {**self._out(row), "builtin_hash": row["builtin_hash"], "builtin_snapshot": snap or None}

    def release_builtin(self, mate_id: str) -> None:
        """A bundled mate whose bundle is gone stays on as the user's own: all that is hers stays, and a body that was
        made of the bundle's files goes, since they are gone with it."""
        with self._lock:
            mate = self.get(mate_id)
            bundle = f"/api/mates/builtin/{mate['builtin']}/"
            gone = lambda avatar: bundle in json.dumps(avatar or {}, ensure_ascii=False)  # noqa: E731
            w = self._wardrobe(mate_id)
            if gone(w["base"]):
                w["base"] = {"kind": "none"}
            for it in w["items"]:
                if gone(it["avatar"]):
                    it["avatar"] = {"kind": "none"}
            self._save_wardrobe(mate_id, w, {"kind": "none"} if gone(mate["avatar"]) else None)
            self._db.execute("UPDATE mates SET builtin = NULL, builtin_hash = NULL, builtin_snapshot = NULL, customized = 0 WHERE id = ?",
                             (mate_id,))
        self._changed("updated", mate_id)

    def builtin_removed(self) -> set[str]:
        return {r["key"] for r in self._db.query("SELECT key FROM mate_builtin_removed")}

    def restore_builtins(self) -> None:
        self._db.execute("DELETE FROM mate_builtin_removed")
        self._changed("restored")

    def set_customized(self, mate_id: str, on: bool) -> None:
        self._db.execute("UPDATE mates SET customized = ? WHERE id = ?", (1 if on else 0, mate_id))
        self._changed("updated", mate_id)

    def mark_builtin(self, mate_id: str, key: str, version: str, snapshot: dict[str, Any] | None = None) -> None:
        """Record the bundle version a built-in was synced from (and, given, that
        bundle's snapshot: what the next update compares the mate's fields with)."""
        if snapshot is None:
            self._db.execute("UPDATE mates SET builtin = ?, builtin_hash = ? WHERE id = ?", (key, version, mate_id))
        else:
            self._db.execute("UPDATE mates SET builtin = ?, builtin_hash = ?, builtin_snapshot = ? WHERE id = ?",
                             (key, version, json.dumps(snapshot, ensure_ascii=False), mate_id))

    def set_session(self, mate_id: str, sid: str | None) -> None:
        self._db.execute("UPDATE mates SET session_id = ? WHERE id = ?", (sid, mate_id))
        self._changed("session", mate_id)

    def delete(self, mate_id: str) -> None:
        with self._lock:
            row = self._db.query_one("SELECT is_default, builtin FROM mates WHERE id = ?", (mate_id,))
            if row is None:
                raise KeyError(f"mate not found: {mate_id}")
            if row["builtin"]:  # a deleted built-in stays deleted (until restored)
                self._db.execute("INSERT OR REPLACE INTO mate_builtin_removed (key, removed_at) VALUES (?, ?)",
                                 (row["builtin"], now_iso()))
            self._db.execute("DELETE FROM mate_memories WHERE mate_id = ?", (mate_id,))
            self._db.execute("DELETE FROM mate_relation WHERE mate_id = ?", (mate_id,))
            self._db.execute("DELETE FROM mate_state WHERE mate_id = ?", (mate_id,))
            self._db.execute("DELETE FROM mate_life WHERE mate_id = ?", (mate_id,))
            self._db.execute("DELETE FROM mate_style_changes WHERE mate_id = ?", (mate_id,))
            self._db.execute("DELETE FROM mate_settings WHERE key = ?", (f"styleok:{mate_id}",))
            self._db.execute("DELETE FROM mate_settings WHERE key = ?", (f"memchg:{mate_id}",))
            self._db.execute("DELETE FROM mates WHERE id = ?", (mate_id,))
            if row["is_default"]:  # someone else becomes the default
                nxt = self._db.query_one("SELECT id FROM mates WHERE draft = 0 ORDER BY created_at LIMIT 1")
                if nxt is not None:
                    self._db.execute("UPDATE mates SET is_default = 1 WHERE id = ?", (nxt["id"],))
        self._changed("deleted", mate_id)

    # ---- the conversation style: the one-time move out of the persona, and the mate's own changes ----

    def migrate_style(self) -> list[dict[str, Any]]:
        """Once per mate, idempotent: how she talks moves out of the persona into the conversation style —
        ``persona.address`` → ``prefs.address`` and ``persona.speech`` → ``prefs.speech_style``, each only where the
        style has no such field yet (so a value already there, or an address the user cleared, stays exactly as it
        is). The whole old persona document is kept in ``persona_legacy``. Drafts too. → what moved, per mate."""
        report: list[dict[str, Any]] = []
        for r in self._db.query("SELECT id, name, persona, prefs, persona_legacy FROM mates"):
            raw = _loads(r["persona"], {})
            if not any(k in raw for k in LEGACY_STYLE_FIELDS):
                continue
            prefs = _loads(r["prefs"], {})
            moved: dict[str, Any] = {}
            for old, new in LEGACY_STYLE_FIELDS.items():
                if old in raw and new not in prefs:
                    prefs[new] = str(raw.get(old) or "")
                    moved[new] = prefs[new]
            persona = {k: v for k, v in raw.items() if k not in LEGACY_STYLE_FIELDS}
            legacy = r["persona_legacy"] or json.dumps(raw, ensure_ascii=False)  # (the first backup is the one kept)
            self._db.execute("UPDATE mates SET persona = ?, prefs = ?, persona_legacy = ? WHERE id = ?",
                             (json.dumps(normalize_persona(persona), ensure_ascii=False),
                              json.dumps(normalize_prefs(None, prefs), ensure_ascii=False), legacy, r["id"]))
            report.append({"id": r["id"], "name": r["name"], "moved": moved,
                           "kept": [new for old, new in LEGACY_STYLE_FIELDS.items() if old in raw and new not in moved]})
        return report

    def migrate_gender(self) -> list[dict[str, str]]:
        """Once per mate, idempotent: a mate from before ``persona.gender`` gets it from her own text (``infer_gender``;
        not known stays "" — never female by default). Drafts too; not a bundled mate: her bundle says, at the sync
        (files.merge_builtin). → [{id, name, gender}] of those it was read for."""
        out = []
        for r in self._db.query("SELECT id, name, persona, prefs, builtin FROM mates"):
            raw = _loads(r["persona"], {})
            if not isinstance(raw, dict) or "gender" in raw or r["builtin"]:
                continue
            gender = infer_gender(raw, (_loads(r["prefs"], {}) or {}).get("speech_style"))
            self._db.execute("UPDATE mates SET persona = ? WHERE id = ?",
                             (json.dumps({**raw, "gender": gender}, ensure_ascii=False), r["id"]))
            out.append({"id": r["id"], "name": r["name"] or "", "gender": gender})
        return out

    def persona_legacy(self, mate_id: str) -> dict[str, Any] | None:
        row = self._db.query_one("SELECT persona_legacy FROM mates WHERE id = ?", (mate_id,))
        return _loads(row["persona_legacy"], {}) or None if row is not None else None

    @staticmethod
    def _style_change(row: Any) -> dict[str, Any]:
        return {"id": row["id"], "mate_id": row["mate_id"], "created_at": row["created_at"], "actor": row["actor"],
                "status": row["status"], "reason": row["reason"], "changes": _loads(row["changes"], {}),
                "session_id": row["session_id"], "resolved_at": row["resolved_at"]}

    def add_style_change(self, mate_id: str, changes: dict[str, Any], *, actor: str, status: str, reason: str = "",
                         session_id: str | None = None) -> dict[str, Any]:
        """Record a change of the conversation style (``changes``: {path: {"from", "to"}}) — the mate's own (applied
        or proposed) — for the conversation's chip, the Conversation style tab's history and undo."""
        cid = new_id("stc_")
        self._db.execute(
            "INSERT INTO mate_style_changes (id, mate_id, created_at, actor, status, reason, changes, session_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (cid, mate_id, now_iso(), actor, status, _s(reason, 300).strip(), json.dumps(changes, ensure_ascii=False),
             session_id))
        # keep the last 200 per mate
        self._db.execute("DELETE FROM mate_style_changes WHERE mate_id = ? AND id NOT IN (SELECT id FROM "
                         "mate_style_changes WHERE mate_id = ? ORDER BY created_at DESC LIMIT 200)", (mate_id, mate_id))
        self._changed("style", mate_id)
        return self.style_change(mate_id, cid)

    def style_changes(self, mate_id: str, limit: int = 50) -> list[dict[str, Any]]:
        rows = self._db.query("SELECT * FROM mate_style_changes WHERE mate_id = ? ORDER BY created_at DESC, id DESC "
                              "LIMIT ?", (mate_id, max(1, min(200, int(limit)))))
        return [self._style_change(r) for r in rows]

    def style_change(self, mate_id: str, cid: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT * FROM mate_style_changes WHERE id = ? AND mate_id = ?", (cid, mate_id))
        if row is None:
            raise KeyError(f"no such style change: {cid}")
        return self._style_change(row)

    def set_style_change(self, mate_id: str, cid: str, status: str) -> dict[str, Any]:
        self._db.execute("UPDATE mate_style_changes SET status = ?, resolved_at = ? WHERE id = ? AND mate_id = ?",
                         (status, now_iso(), cid, mate_id))
        self._changed("style", mate_id)
        return self.style_change(mate_id, cid)

    def style_ok_memories(self, mate_id: str) -> set[str]:
        """Memories the user said are fine where they are (the Memory tab's "conversation style?" flag dismissed)."""
        return set(_loads(self._setting(f"styleok:{mate_id}"), []))

    def dismiss_style_flag(self, mate_id: str, mem_id: str) -> None:
        ids = sorted(self.style_ok_memories(mate_id) | {mem_id})[-500:]
        self._put_setting(f"styleok:{mate_id}", json.dumps(ids))
        self._changed("memory", mate_id)

    # ---- memories (docs/mate-memory-affinity.md §4; ranking and the core: app/mate/memory.py) ----

    @staticmethod
    def _mem(row: Any) -> dict[str, Any]:
        d = dict(row)
        d["pinned"] = bool(d.get("pinned"))
        d["updated_at"] = d.get("updated_at") or d["created_at"]
        d["kind"] = d.get("kind") or "fact"
        d["status"] = d.get("status") or "active"
        return d

    def migrate_memories(self) -> int:
        """Memories saved before kinds existed (no ``updated_at``): a kind from a few cue words (profile ones
        pinned, so the mate keeps knowing who the user is), ``updated_at = created_at``. Text, ids and dates
        stay as they were. Idempotent: a migrated row has ``updated_at``."""
        rows = self._db.query("SELECT id, text, created_at FROM mate_memories WHERE updated_at IS NULL")
        for r in rows:
            kind = M.guess_kind(r["text"])
            self._db.execute("UPDATE mate_memories SET kind = ?, pinned = ?, updated_at = ? WHERE id = ?",
                             (kind, 1 if kind == "profile" else 0, r["created_at"], r["id"]))
        return len(rows)

    def memories(self, mate_id: str, *, status: str = "active", kind: str | None = None, q: str | None = None,
                 sort: str = "created") -> list[dict[str, Any]]:
        """``status``: active | done | archived | all; ``q``: words in the text; ``sort``: created (oldest
        first, the prompt's order) | recent | importance | due."""
        sql = "SELECT * FROM mate_memories WHERE mate_id = ?"
        args: list[Any] = [mate_id]
        if status != "all":
            sql += " AND COALESCE(status, 'active') = ?"
            args.append(status)
        if kind:
            sql += " AND COALESCE(kind, 'fact') = ?"
            args.append(kind)
        rows = [self._mem(r) for r in self._db.query(sql + " ORDER BY created_at, id", tuple(args))]
        if q and q.strip():
            nq = M.normalized(q)
            words = {t for t in M.tokens(q) if t.startswith("w:")}
            rows = [m for m in rows if (nq and nq in M.normalized(m["text"]))
                    or (words and words & set(M.tokens(m["text"])))]
        if sort == "recent":
            rows.sort(key=lambda m: m["updated_at"], reverse=True)
        elif sort == "importance":
            rows.sort(key=lambda m: (-int(m.get("importance") or 3), m["updated_at"]), reverse=False)
        elif sort == "due":
            rows.sort(key=lambda m: (m.get("due_at") is None, m.get("due_at") or "", m["updated_at"]))
        return rows

    def memory(self, mate_id: str, mem_id: str) -> dict[str, Any] | None:
        row = self._db.query_one("SELECT * FROM mate_memories WHERE id = ? AND mate_id = ?", (mem_id, mate_id))
        return self._mem(row) if row is not None else None

    def memory_counts(self, mate_id: str) -> dict[str, int]:
        out = {s: 0 for s in M.STATUSES}
        for r in self._db.query("SELECT COALESCE(status, 'active') AS s, COUNT(*) AS c FROM mate_memories "
                                "WHERE mate_id = ? GROUP BY s", (mate_id,)):
            out[r["s"]] = r["c"]
        out["core"] = len(M.core(self.memories(mate_id)))
        return out

    def _core_sig(self, mate_id: str) -> str:
        return "\n".join(M.line(m) for m in M.core(self.memories(mate_id)))

    def _user_edit(self, mate_id: str, before: str, change: dict[str, Any]) -> None:
        """After the user changed a memory: a change to what the system prompt always carries (the core)
        reloads the engine at the next turn; anything else is told in the next message's context block —
        no restart (app/mate/service.py)."""
        if self._core_sig(mate_id) != before:
            self._bump_memory(mate_id)
            return
        key = f"memchg:{mate_id}"
        pending = _loads(self._setting(key), [])
        pending = [c for c in pending if c.get("id") != change.get("id")] + [change]
        self._put_setting(key, json.dumps(pending[-20:], ensure_ascii=False))

    def take_memory_changes(self, mate_id: str) -> list[dict[str, Any]]:
        """Peek until a provider acknowledges this turn's context."""
        return _loads(self._setting(f"memchg:{mate_id}"), [])

    def ack_memory_changes(self, mate_id: str, changes: list[dict[str, Any]]) -> None:
        key = f"memchg:{mate_id}"
        with self._db.transaction():
            pending = _loads(self._setting(key), [])
            remaining = [c for c in pending if c not in changes]
            self._put_setting(key, json.dumps(remaining, ensure_ascii=False))

    def _clean(self, text: Any) -> str:
        text = " ".join(_s(text, MAX_MEMORY * 2).split())
        if len(text) > MAX_MEMORY:
            raise MateError(f"Memory exceeds {MAX_MEMORY} characters; save a shorter supported assertion")
        if not text:
            raise MateError("empty memory")
        return text

    @staticmethod
    def _kind(v: Any) -> str:
        k = _s(v, 24).strip().lower() or "fact"
        if k not in M.KINDS:
            raise MateError(f"unknown memory kind: {k} (one of {', '.join(M.KINDS)})")
        return k

    @staticmethod
    def _importance(v: Any) -> int:
        if v in (None, ""):
            return 3
        if isinstance(v, bool):
            raise MateError("importance must be 1 – 5")
        try:
            return max(1, min(5, int(float(v))))
        except (TypeError, ValueError) as exc:
            raise MateError("importance must be 1 – 5") from exc

    @staticmethod
    def _due(v: Any) -> str | None:
        try:
            return M.parse_due(v)
        except ValueError as exc:
            raise MateError(str(exc)) from exc

    def _make_room(self, mate_id: str) -> None:
        active = self._db.query_one("SELECT COUNT(*) AS c FROM mate_memories WHERE mate_id = ? AND "
                                    "COALESCE(status, 'active') = 'active'", (mate_id,))["c"]
        if active >= M.MAX_ACTIVE:
            # the least important, least used one goes to the archive (never a pinned or profile memory)
            row = self._db.query_one(
                "SELECT id FROM mate_memories WHERE mate_id = ? AND COALESCE(status, 'active') = 'active' AND "
                "pinned = 0 AND COALESCE(kind, 'fact') != 'profile' "
                "ORDER BY importance, COALESCE(last_used_at, updated_at, created_at) LIMIT 1", (mate_id,))
            if row is None:
                raise MateError(f"memory is full ({M.MAX_ACTIVE} items): forget something first")
            cur = self.memory(mate_id, row["id"])
            self.knowledge.snapshot(cur, "policy", "before_archive")
            self._db.execute("UPDATE mate_memories SET status = 'archived', updated_at = ?, revision=revision+1 WHERE id = ?",
                             (now_iso(), row["id"]))
            self.knowledge.snapshot(self.memory(mate_id, row["id"]), "policy", "archived")
        # MAX_ROWS used to destroy archived history. Archive is a retrieval
        # tier, never a retention deadline; only explicit forgetting deletes.

    def add_memory(self, mate_id: str, text: str, *, kind: Any = None, importance: Any = None, pinned: bool = False,
                   due_at: Any = None, by_user: bool = False, source: str | None = None) -> dict[str, Any]:
        """Only exact same assertions deduplicate. Similarity suggests review,
        never that a negation, another date or a shorter correction is equivalent."""
        self.get(mate_id)
        text = self._clean(text)
        if not safe_text(text):
            raise MateError("Credentials belong in provider settings, not personal memory")
        if not by_user and self.knowledge.excluded(mate_id, "text:" + digest(M.normalized(text))):
            raise MateError("This memory was explicitly forgotten; ask before saving it again")
        kind = self._kind(kind)
        imp = self._importance(importance)
        due = self._due(due_at)
        now = now_iso()
        with self._lock, self._db.transaction():
            before = self._core_sig(mate_id) if by_user else ""
            rows = self.memories(mate_id)
            close = M.similar(text, kind, rows)
            exact = next((m for m in rows if m["kind"] == kind and M.normalized(m["text"]) == M.normalized(text)
                          and (due is None or due == m.get("due_at"))), None)
            if exact:
                old = exact
                self.knowledge.snapshot(old, "user" if by_user else "mate", "before_edit")
                new_text = text
                self._db.execute(
                    "UPDATE mate_memories SET text = ?, importance = ?, due_at = ?, pinned = ?, updated_at = ?, revision=revision+1 "
                    "WHERE id = ?",
                    (new_text, max(imp, int(old.get("importance") or 3)), due or old.get("due_at"),
                     1 if (old["pinned"] or (pinned and by_user)) else 0, now, old["id"]))
                mem = {**self.memory(mate_id, old["id"]), "merged": True, "similar": []}
                self.knowledge.snapshot(self.memory(mate_id, old["id"]), "user" if by_user else "mate", "deduplicated")
                if by_user:
                    self._user_edit(mate_id, before, {"id": old["id"], "op": "edited", "text": mem["text"]})
                self._changed("memory", mate_id)
                return mem
            self._make_room(mate_id)
            mid = new_id("mem_")[:12]
            expires = (datetime.now(timezone.utc) + timedelta(days=M.CONTEXT_DAYS)).isoformat() \
                if kind == "context" else None
            self._db.execute(
                "INSERT INTO mate_memories (id, mate_id, text, created_at, kind, importance, pinned, due_at, "
                "expires_at, status, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
                (mid, mate_id, text, now, kind, imp, 1 if (pinned and by_user) else 0, due, expires,
                 source or ("user" if by_user else "mate"), now))
            self._db.execute("UPDATE mate_memories SET evidence_type=? WHERE id=?", ("asserted" if by_user else "reported", mid))
            self.knowledge.snapshot(self.memory(mate_id, mid), "user" if by_user else "mate", "created")
            mem = {**self.memory(mate_id, mid), "merged": False, "similar": [m for _s2, m in close[:3]]}
            if by_user:
                self._user_edit(mate_id, before, {"id": mid, "op": "added", "text": text, "kind": kind})
        self._changed("memory", mate_id)
        if self.on_memory_added is not None:
            try:
                self.on_memory_added(mate_id)
            except Exception:  # noqa: BLE001 - counting never fails a write
                pass
        return mem

    def update_memory(self, mate_id: str, mem_id: str, patch: dict[str, Any], *, by_user: bool = False) -> dict[str, Any]:
        """Edit a memory in place (same id): text, kind, importance, due_at, status; ``pinned`` is the user's."""
        cur = self.memory(mate_id, mem_id)
        if cur is None:
            raise KeyError(f"no memory with id {mem_id!r}")
        if not isinstance(patch, dict):
            raise MateError("a memory patch must be an object")
        if patch.get("expected_revision") is not None and patch["expected_revision"] != cur["revision"]:
            raise MateError("Memory changed in another window; reload before editing", status=409)
        sets: dict[str, Any] = {}
        if "text" in patch and patch["text"] is not None:
            sets["text"] = self._clean(patch["text"])
        if patch.get("kind") is not None:
            sets["kind"] = self._kind(patch["kind"])
            if sets["kind"] == "context" and not cur.get("expires_at"):
                sets["expires_at"] = (datetime.now(timezone.utc) + timedelta(days=M.CONTEXT_DAYS)).isoformat()
        if patch.get("importance") is not None:
            sets["importance"] = self._importance(patch["importance"])
        if "due_at" in patch or "due" in patch:
            sets["due_at"] = self._due(patch.get("due_at", patch.get("due")))
        if patch.get("status") is not None:
            st = _s(patch["status"], 16).strip()
            if st not in M.STATUSES:
                raise MateError(f"unknown memory status: {st} (one of {', '.join(M.STATUSES)})")
            sets["status"] = st
        if "pinned" in patch and by_user:
            sets["pinned"] = 1 if patch["pinned"] else 0
        sets = {k: v for k, v in sets.items() if cur.get(k) != v}
        if not sets:
            return cur
        with self._lock, self._db.transaction():
            cur = self.memory(mate_id, mem_id)
            if cur is None:
                raise KeyError(mem_id)
            if patch.get("expected_revision") is not None and patch["expected_revision"] != cur["revision"]:
                raise MateError("Memory changed in another window; reload before editing", status=409)
            if "text" in sets and not safe_text(sets["text"]):
                raise MateError("Credentials belong in provider settings, not personal memory")
            self.knowledge.snapshot(cur, "user" if by_user else "mate", "before_edit")
            before = self._core_sig(mate_id) if by_user else ""
            if "text" in sets and sets["text"] != cur["text"]:
                sets["evidence_type"] = "asserted" if by_user else "reported"
            sets["revision"] = cur["revision"] + 1
            sets["updated_at"] = now_iso()
            self._db.execute(f"UPDATE mate_memories SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",
                             (*sets.values(), mem_id))
            mem = self.memory(mate_id, mem_id)
            if mem["text"] == cur["text"]:
                self._db.execute("INSERT OR IGNORE INTO memory_evidence(memory_id,memory_revision,source_id,source_revision,quote,start,end,relation) SELECT memory_id,?,source_id,source_revision,quote,start,end,relation FROM memory_evidence WHERE memory_id=? AND memory_revision=?", (mem["revision"], mem_id, cur["revision"]))
            self.knowledge.snapshot(mem, "user" if by_user else "mate", "updated")
            if by_user:
                op = "done" if sets.get("status") == "done" else "archived" if sets.get("status") == "archived" \
                    else "edited"
                self._user_edit(mate_id, before, {"id": mem_id, "op": op, "text": mem["text"]})
        self._changed("memory", mate_id)
        return mem

    def delete_memory(self, mate_id: str, mem_id: str, *, by_user: bool = False) -> bool:
        row = self._db.query_one("SELECT 1 FROM mate_memories WHERE id = ? AND mate_id = ?", (mem_id, mate_id))
        if row is None:
            return False
        with self._lock, self._db.transaction():
            before = self._core_sig(mate_id) if by_user else ""
            self.knowledge.forget(mate_id, self.memory(mate_id, mem_id))
            if by_user:
                self._user_edit(mate_id, before, {"id": mem_id, "op": "deleted"})
        if self.on_memory_forgotten:
            self.on_memory_forgotten(mate_id, by_user)
        self._changed("memory", mate_id)
        return True

    def bulk_memories(self, mate_id: str, ids: list[str], action: str) -> int:
        if action not in ("delete", "archive", "restore", "pin", "unpin"):
            raise MateError(f"unknown bulk action: {action}")
        count = 0
        with self._lock, self._db.transaction():
            for mid in dict.fromkeys(str(i) for i in ids or []):
                if self.memory(mate_id, mid) is None:
                    continue
                if action == "delete":
                    self.delete_memory(mate_id, mid, by_user=True)
                else:
                    k, v = {"archive": ("status", "archived"), "restore": ("status", "active"),
                            "pin": ("pinned", True), "unpin": ("pinned", False)}[action]
                    self.update_memory(mate_id, mid, {k: v}, by_user=True)
                count += 1
        return count

    def mark_used(self, mate_id: str, ids: list[str]) -> None:
        """Recalled into a conversation: counted, and a short-term context memory lives a week longer."""
        if not ids:
            return
        now = datetime.now(timezone.utc)
        ext = (now + timedelta(days=M.USED_EXTENDS_DAYS)).isoformat()
        for mid in ids:
            self._db.execute(
                "UPDATE mate_memories SET use_count = use_count + 1, last_used_at = ?, "
                "expires_at = CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN ? ELSE expires_at END "
                "WHERE id = ? AND mate_id = ?", (now.isoformat(), ext, ext, mid, mate_id))

    def housekeep(self, mate_id: str, now_utc: datetime, now_local: datetime) -> int:
        """Expired temporary context is archived. An overdue plan stays unconfirmed."""
        n = 0
        for m in self.memories(mate_id):
            st = M.expired(m, now_utc, now_local)
            if st:
                self.update_memory(mate_id, m["id"], {"status": st}, by_user=True)
                n += 1
        return n

    def _bump_memory(self, mate_id: str) -> None:
        # The user edited what the system prompt always carries: the engine
        # reloads its prompt at the next turn.
        self._db.execute("UPDATE mates SET memory_rev = memory_rev + 1 WHERE id = ?", (mate_id,))

    # ---- the relationship (app/mate/affinity.py; the rules run in app/mate/service.py) ----

    def relation_doc(self, mate_id: str) -> dict[str, Any] | None:
        row = self._db.query_one("SELECT doc FROM mate_relation WHERE mate_id = ?", (mate_id,))
        return A.normalized(_loads(row["doc"], {})) if row is not None else None

    def save_relation(self, mate_id: str, doc: dict[str, Any]) -> None:
        self._db.execute(
            "INSERT INTO mate_relation (mate_id, doc, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(mate_id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
            (mate_id, json.dumps(doc, ensure_ascii=False), now_iso()))
        self._open_reached_outfits(mate_id, round(float(doc.get("affinity") or 0)))

    def wipe_memory(self, mate_id: str) -> None:
        """What she knows and what she got from talking, in this database: memories, the record of how she changed her own
        style (it quotes what was asked; the style itself stays), how she feels (its reasons quote what was said), and the day she
        has been living (it begins again)."""
        self.knowledge.wipe(mate_id)
        self._db.execute("DELETE FROM mate_style_changes WHERE mate_id = ?", (mate_id,))
        self._db.execute("DELETE FROM mate_settings WHERE key = ?", (f"memchg:{mate_id}",))
        self.save_state(mate_id, S.new())
        self._db.execute("DELETE FROM mate_life WHERE mate_id = ?", (mate_id,))

    # ---- her own day (app/mate/life) ----

    @staticmethod
    def life_profile(builtin: str | None, prefs: Any) -> dict[str, Any] | None:
        """Her world, if she lives in one: on by default for a mate who comes with her own (``life``: auto), else on request."""
        wanted = prefs.get("life") if isinstance(prefs, dict) else None
        if wanted == "off" or (wanted != "on" and not life_profile.own(builtin)):
            return None
        return life_profile.load(builtin)

    def life_doc(self, mate_id: str, profile: dict[str, Any]) -> dict[str, Any] | None:
        row = self._db.query_one("SELECT doc FROM mate_life WHERE mate_id = ?", (mate_id,))
        return sim.normalized(_loads(row["doc"], {}), profile) if row is not None else None

    def save_life(self, mate_id: str, doc: dict[str, Any]) -> None:
        self._db.execute(
            "INSERT INTO mate_life (mate_id, doc, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(mate_id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
            (mate_id, json.dumps(doc, ensure_ascii=False), now_iso()))

    def life_now(self, mate_id: str, builtin: str | None, prefs: Any) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """Her day as last played (the runtime keeps it going; reading never writes): (doc, profile), or None without one."""
        profile = self.life_profile(builtin, prefs)
        doc = self.life_doc(mate_id, profile) if profile else None
        return (doc, profile) if doc else None

    # ---- how she feels (app/mate/state.py) ----

    def state_doc(self, mate_id: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT doc FROM mate_state WHERE mate_id = ?", (mate_id,))
        return S.normalized(_loads(row["doc"], {}) if row is not None else None)

    def save_state(self, mate_id: str, doc: dict[str, Any]) -> None:
        self._db.execute(
            "INSERT INTO mate_state (mate_id, doc, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(mate_id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
            (mate_id, json.dumps(doc, ensure_ascii=False), now_iso()))

    @staticmethod
    def _who(builtin: str | None, wardrobe: dict[str, Any], relation: dict[str, Any], life: dict[str, Any] | None = None,
             name: str = "", *, gender: str = "", created_at: str | None = None, seed: str = "") -> dict[str, Any]:
        """``created_at``: the mate's (when they first met, until the relationship knows it); ``seed``: her id (her own days)."""
        worn = wardrobe.get("worn") or DEFAULT_OUTFIT
        item = next((it for it in wardrobe.get("items") or [] if it["id"] == worn), None)
        outfit = {"id": worn, "name": item["name"], "feel": S.clean_feel(item.get("feel")), "since": wardrobe.get("worn_at")} if item else None
        on = relation["enabled"]
        return S.who(closeness=float(relation["affinity"]) / 100 if on else 0.33, sensitivity=relation["sensitivity"] if on else 1.0,
                     builtin=builtin, away=on and relation["paused"], outfit=outfit, life=life, name=name, gender=gender,
                     met=relation.get("started_at") or created_at, seed=seed)

    def state_who(self, mate_id: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT builtin, outfits, prefs, name, persona, created_at FROM mates WHERE id = ?", (mate_id,))
        if row is None:
            raise KeyError(f"mate not found: {mate_id}")
        life = self.life_now(mate_id, row["builtin"], _loads(row["prefs"], {}))
        return self._who(row["builtin"], _loads(row["outfits"], {}), self.relation_doc(mate_id) or A.new(),
                         sim.for_state(life[0], life[1], datetime.now(timezone.utc)) if life else None, row["name"] or "",
                         gender=normalize_persona(_loads(row["persona"], {}))["gender"], created_at=row["created_at"], seed=mate_id)

    def relation_summary(self, mate_id: str) -> dict[str, Any]:
        doc = self.relation_doc(mate_id) or A.new()
        return A.summary(doc, datetime.now(timezone.utc), self.tz())

    # ---- global settings ----

    def _setting(self, key: str) -> str:
        row = self._db.query_one("SELECT value FROM mate_settings WHERE key = ?", (key,))
        return row["value"] if row else ""

    def _put_setting(self, key: str, value: str) -> None:
        self._db.execute(
            "INSERT INTO mate_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))

    def location(self) -> dict[str, Any] | None:
        """Where the user is (Settings → Language: found from their connection, or a city they picked): her weather and
        the public holidays of their country (life/world.py). {lat, lon, city, country, source, at} or None."""
        doc = _loads(self._setting("location"), None) if self._setting("location") else None
        return doc if isinstance(doc, dict) and isinstance(doc.get("lat"), (int, float)) else None

    @staticmethod
    def _clean_location(v: Any) -> dict[str, Any]:
        if not isinstance(v, dict):
            raise MateError("location must be an object")
        try:
            lat, lon = float(v.get("lat")), float(v.get("lon"))
        except (TypeError, ValueError) as exc:
            raise MateError("location needs lat and lon") from exc
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise MateError("location: lat / lon out of range")
        country = _s(v.get("country") or "", 2).upper()
        return {"lat": round(lat, 3), "lon": round(lon, 3), "city": _one_line(_s(v.get("city") or "", 80), 80).strip(),
                "country": country if re.fullmatch(r"[A-Z]{2}", country) else "",
                "source": "manual" if v.get("source") == "manual" else "ip", "at": datetime.now(timezone.utc).isoformat()}

    def tz(self) -> Any:
        """The user's timezone (Global settings → Defaults; the console fills it from the browser), else the
        server's local zone."""
        return self.tz_and_key()[0]

    def tz_and_key(self) -> tuple[Any, str]:
        """The zone and a name for it: the user's IANA name, or ``local:<abbr><±hhmm>`` for the server's own zone
        (a stand-in until a browser reports the user's — a container usually runs in UTC). The relationship
        remembers the name it was computed in and is computed again from the history when it changes
        (app/mate/service.py ``relation_doc``): days counted in the wrong zone don't stay."""
        name = self._setting("timezone")
        if name:
            try:
                return ZoneInfo(name), name
            except (ZoneInfoNotFoundError, ValueError):
                pass
        local = datetime.now().astimezone()
        return local.tzinfo, f"local:{local.tzname()}{local.strftime('%z')}"

    def secret(self, name: str) -> str:
        """A voice-service key (server side only): its own, else the same vendor's language-model key; "" when
        neither is set."""
        own = self._own_secret(name)
        if own or self.shared_key is None:
            return own
        try:
            return self.shared_key(name) or ""
        except Exception:  # noqa: BLE001 - the pool unavailable: as unset
            return ""

    def _own_secret(self, name: str) -> str:
        if self._vault is None:
            return ""
        ref = SecretVault.make_id(_VAULT_SCOPE, name)
        if not self._vault.exists(ref):
            return ""
        try:
            return self._vault.read(ref)
        except Exception:  # noqa: BLE001 - key mismatch: treat as unset
            return ""

    def user_name(self) -> str:
        """The user's name, one for all mates (Settings → Account). Until it is set once, what the mates had each:
        the default mate's, else the one most of them had (read once from before the name was one)."""
        row = self._db.query_one("SELECT value FROM mate_settings WHERE key = 'user_name'")
        if row is not None:
            return row["value"] or ""
        names: dict[str, int] = {}
        first = ""
        for r in self._db.query("SELECT prefs, is_default FROM mates ORDER BY is_default DESC, updated_at DESC"):
            n = _one_line(str((_loads(r["prefs"], {}) or {}).get("user_name") or ""), 80).strip()
            if n:
                names[n] = names.get(n, 0) + 1
                if r["is_default"] and not first:
                    first = n
        name = first or (max(names, key=names.get) if names else "")
        self._put_setting("user_name", name)
        return name

    def set_user_name(self, value: Any) -> bool:
        """→ whether it changed."""
        name = _one_line(str(value or ""), 80).strip()
        if name == self.user_name():
            return False
        self._put_setting("user_name", name)
        return True

    def settings(self) -> dict[str, Any]:
        out: dict[str, Any] = {k: self._setting(k) for k in SETTING_URLS}
        out["timezone"] = self._setting("timezone")
        out["user_name"] = self.user_name()
        out["location"] = self.location()
        for k in SETTING_KEYS:
            own = bool(self._vault is not None and self._vault.exists(SecretVault.make_id(_VAULT_SCOPE, k)))
            out[f"{k}_set"] = own
            # (not its own: the language-model providers' key of that vendor stands in — said, not hidden)
            out[f"{k}_shared"] = not own and bool(self.secret(k))
        return out

    def update_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        """URLs: set ("" clears). Keys: a non-empty string sets, "" or null
        removes, absent keeps. A changed setting drops its provider's cached
        verification; :attr:`last_changed` names what changed."""
        urls: dict[str, str] = {}
        for k in SETTING_URLS:  # validate everything before writing anything
            if k in patch and patch[k] is not None:
                url = _s(patch[k], 500).strip().rstrip("/")
                if url and not re.match(r"^https?://[^\s/]+", url):
                    raise MateError(f"{k} must be an http(s) URL")
                urls[k] = url
        tzname = None
        if patch.get("timezone") is not None:
            tzname = _s(patch["timezone"], 64).strip()
            if tzname:
                try:
                    ZoneInfo(tzname)
                except (ZoneInfoNotFoundError, ValueError) as exc:
                    raise MateError(f"unknown timezone: {tzname}") from exc
        location = self._clean_location(patch["location"]) if patch.get("location") is not None else None
        changed: set[str] = set()
        if patch.get("user_name") is not None and self.set_user_name(patch["user_name"]):
            changed.add("user_name")
        if location is not None:
            self._put_setting("location", json.dumps(location, ensure_ascii=False))
            changed.add("location")
        if tzname is not None and tzname != self._setting("timezone"):
            self._put_setting("timezone", tzname)
            changed.add("timezone")
        for k, url in urls.items():
            if url != self._setting(k):
                changed.add(k)
            self._db.execute(
                "INSERT INTO mate_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, url))
        for k in SETTING_KEYS:
            if k not in patch:
                continue
            if self._vault is None:
                raise MateError("no vault configured", status=500)
            val = patch[k]
            ref = SecretVault.make_id(_VAULT_SCOPE, k)
            if val:
                self._vault.put(_VAULT_SCOPE, k, _s(val, 4000).strip())
                changed.add(k)
            elif self._vault.exists(ref):
                self._vault.delete(ref)
                changed.add(k)
        for provider in {SETTING_PROVIDERS[k] for k in changed if k in SETTING_PROVIDERS}:
            self.set_verification(provider, None)
        self.last_changed = changed
        if changed:
            self._changed("settings")
        return self.settings()

    # ---- voice provider verification results (kept across restarts) ----

    def verification(self, provider: str) -> dict[str, Any] | None:
        raw = self._setting(_VERIFY_PREFIX + provider)
        return (_loads(raw, {}) or None) if raw else None

    def set_verification(self, provider: str, doc: dict[str, Any] | None) -> None:
        key = _VERIFY_PREFIX + provider
        if doc is None:
            self._db.execute("DELETE FROM mate_settings WHERE key = ?", (key,))
            return
        self._db.execute(
            "INSERT INTO mate_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, json.dumps(doc, ensure_ascii=False)))
