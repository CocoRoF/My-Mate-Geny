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
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.db import Database
from app.mate import affinity as A
from app.mate import memory as M
from app.providers.catalog import DEFAULT_MATE_MODEL, default_mate_model
from app.services._ids import new_id, now_iso
from app.vault import SecretVault

PERSONA_FIELDS = ("description", "personality", "speech", "greeting", "address", "language", "instructions")
TTS_ENGINES = ("off", "browser", "openai", "elevenlabs", "omnivoice", "http")
STT_ENGINES = ("off", "browser", "openai", "whisper")
AVATAR_KINDS = ("none", "video", "photo", "live2d")
CLIP_KINDS = ("idle", "talk", "listen", "think", "react", "away")
# stills that make her blink / talk: mechanics, never shown for an emotion
MECHANIC_STILLS = ("blink", "mouth_half", "mouth_open", "mouth_o")
MAX_CLIPS = 200
MAX_VOLUME = 3.0          # voice.volume: 0.0 – 3.0 (300 %), 1.0 = as synthesized
EFFORTS = ("default", "low", "medium", "high", "xhigh", "max")
LLM_PROVIDERS = ("claude", "codex")  # engines that can run sealed (own prompt, only the mate MCP bridge)

MAX_FIELD = 8000          # one persona field
MAX_AVATAR_JSON = 256 * 1024
MAX_MEMORY = 1000         # one memory, chars
MAX_MEMORIES = 500        # active ones per mate (app/mate/memory.py MAX_ACTIVE; archived ones too up to MAX_ROWS)

# Global settings: plain values (URLs) and vault-held keys.
SETTING_URLS = ("omnivoice_url", "whisper_url", "http_tts_url")
SETTING_KEYS = ("openai_key", "elevenlabs_key", "http_tts_key")
# Which voice provider (app/mate/providers.py) each setting belongs to: a
# change drops that provider's cached verification.
SETTING_PROVIDERS = {"openai_key": "openai", "elevenlabs_key": "elevenlabs", "omnivoice_url": "omnivoice",
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
    "speech": ("Soft and polite; short and natural, one or two sentences at a time. In Korean: gentle 존댓말 "
               "(해요체), never 반말. In English: warm and friendly, never stiff."),
    "greeting": DEFAULT_GREETINGS["ko"],
    "address": "",
    "language": "ko",
    "instructions": "",
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


def normalize_persona(patch: Any, base: dict[str, Any] | None = None) -> dict[str, Any]:
    out = {k: "" for k in PERSONA_FIELDS}
    out["language"] = "ko"
    out.update({k: v for k, v in (base or {}).items() if k in PERSONA_FIELDS})
    if patch is None:
        return out
    if not isinstance(patch, dict):
        raise MateError("persona must be an object")
    for k in PERSONA_FIELDS:
        if k in patch:
            out[k] = _s(patch[k], 32).strip() if k == "language" else _s(patch[k])
    out["language"] = out["language"] or "ko"
    return out


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
    stt = {"engine": "browser", "model": "", "language": "", **(base.get("stt") or {})}
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
    return out


# Conversation settings (docs/mate-memory-affinity.md §3): each one changes a
# prompt line (prompt.py) and/or what the client does (emotion level).
FORMALITIES = ("auto", "haeyo", "hapsyo", "banmal")
LENGTHS = ("short", "normal", "long")
TONE_KEYS = ("warmth", "humor", "initiative")
TONE_LEVELS = ("auto", "low", "high")
RECALL_LEVELS = ("off", "light", "normal", "rich")
MAX_AVOID = 500


def default_prefs() -> dict[str, Any]:
    return {"user_name": "", "self_ref": "", "formality": "auto", "length": "normal", "emotion": 2,
            "tone": {k: "auto" for k in TONE_KEYS}, "avoid": "",
            "memory": {"recall": "normal", "self_save": True}}


def _enum(v: Any, allowed: tuple[str, ...], what: str) -> str:
    v = _s(v, 32).strip() or allowed[0]
    if v not in allowed:
        raise MateError(f"unknown {what}: {v} (one of {', '.join(allowed)})")
    return v


def normalize_prefs(patch: Any, base: dict[str, Any] | None = None) -> dict[str, Any]:
    """``mate.prefs``: merged field by field (``tone`` / ``memory`` too); unknown keys dropped."""
    out = default_prefs()
    b = base if isinstance(base, dict) else {}
    for k in ("user_name", "self_ref", "formality", "length", "emotion", "avoid"):
        if k in b:
            out[k] = b[k]
    if isinstance(b.get("tone"), dict):
        out["tone"].update({k: v for k, v in b["tone"].items() if k in TONE_KEYS and v in TONE_LEVELS})
    if isinstance(b.get("memory"), dict):
        out["memory"].update({k: v for k, v in b["memory"].items() if k in ("recall", "self_save")})
    if patch is not None:
        if not isinstance(patch, dict):
            raise MateError("prefs must be an object")
        if "user_name" in patch:
            out["user_name"] = " ".join(_s(patch["user_name"], 80).split())
        if "self_ref" in patch:
            out["self_ref"] = " ".join(_s(patch["self_ref"], 40).split())
        if "formality" in patch:
            out["formality"] = _enum(patch["formality"], FORMALITIES, "speech level")
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
    # (a stored document from an older/newer version: keep it well-typed)
    try:
        out["emotion"] = max(0, min(3, int(out["emotion"])))
    except (TypeError, ValueError):
        out["emotion"] = 2
    for k, allowed in (("formality", FORMALITIES), ("length", LENGTHS)):
        if out[k] not in allowed:
            out[k] = allowed[0] if k == "formality" else "normal"
    if out["memory"].get("recall") not in RECALL_LEVELS:
        out["memory"]["recall"] = "normal"
    out["memory"]["self_save"] = bool(out["memory"].get("self_save", True))
    for k in ("user_name", "self_ref", "avoid"):
        out[k] = str(out[k] or "")
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
    for k in ("small", "emotion"):
        if c.get(k) in (None, ""):
            out.pop(k, None)
        else:
            out[k] = _s(c[k], 2000 if k == "small" else 64).strip()
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
    l2d = v.get("live2d")
    if not isinstance(l2d, dict) or not isinstance(l2d.get("model"), str) or not l2d["model"]:
        raise MateError("a live2d avatar needs live2d.model (URL of the *.model3.json)")
    return {"kind": "live2d", "live2d": dict(l2d)}


def _loads(raw: Any, empty: Any) -> Any:
    try:
        v = json.loads(raw or "null")
    except (TypeError, ValueError):
        return empty
    return v if isinstance(v, type(empty)) else empty


class MateStore:
    def __init__(self, db: Database, vault: SecretVault | None = None) -> None:
        self._db = db
        self._vault = vault
        self._lock = threading.Lock()
        self.last_changed: set[str] = set()  # the settings the last update_settings() changed
        # told (reason, mate_id) after every write a client can see: MateService
        # wires it to the /ws/sessions feed so every window refetches its mates
        self.on_change: Callable[[str, str | None], None] | None = None
        # told (mate_id) when a memory was added (not merged): the relationship counts it
        self.on_memory_added: Callable[[str], None] | None = None

    def _changed(self, reason: str, mate_id: str | None = None) -> None:
        if self.on_change is not None:
            try:
                self.on_change(reason, mate_id)
            except Exception:  # noqa: BLE001 - a notification never fails a write
                pass

    # ---- mates ----

    def _out(self, row: Any) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "is_default": bool(row["is_default"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "persona": normalize_persona(_loads(row["persona"], {})),
            "avatar": _loads(row["avatar"], {}) or {"kind": "none"},
            "llm": normalize_llm(None, _loads(row["llm"], {})),
            "voice": normalize_voice(None, _loads(row["voice"], {})),
            "prefs": normalize_prefs(None, _loads(row["prefs"], {}) if "prefs" in row.keys() else {}),
            "session_id": row["session_id"],
            "memory_rev": row["memory_rev"],
            "builtin": row["builtin"] if "builtin" in row.keys() else None,
            "customized": bool(row["customized"]) if "customized" in row.keys() else False,
            "relation": self.relation_summary(row["id"]),
        }

    def list(self) -> list[dict[str, Any]]:
        rows = self._db.query("SELECT * FROM mates ORDER BY is_default DESC, created_at")
        return [self._out(r) for r in rows]

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
    ) -> dict[str, Any]:
        name = _s(name, 80).strip()
        if not name:
            raise MateError("a mate needs a name")
        doc = (normalize_persona(persona), normalize_avatar(avatar), normalize_llm(llm), normalize_voice(voice),
               normalize_prefs(prefs))
        mid = new_id("mate_")
        now = now_iso()
        with self._lock:
            first = self._db.query_one("SELECT COUNT(*) AS c FROM mates")["c"] == 0
            if is_default or first:
                self._db.execute("UPDATE mates SET is_default = 0")
            self._db.execute(
                "INSERT INTO mates (id, name, is_default, persona, avatar, llm, voice, prefs, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (mid, name, 1 if (is_default or first) else 0, *(json.dumps(d, ensure_ascii=False) for d in doc),
                 now, now),
            )
        self._changed("created", mid)
        return self.get(mid)

    def ensure_default(self) -> bool:
        """No mates yet: create "Geny" (no avatar, browser voice). True if created."""
        with self._lock:
            if self._db.query_one("SELECT COUNT(*) AS c FROM mates")["c"]:
                return False
            now = now_iso()
            self._db.execute(
                "INSERT INTO mates (id, name, is_default, persona, avatar, llm, voice, created_at, updated_at) "
                "VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)",
                (new_id("mate_"), "Geny", json.dumps(normalize_persona(DEFAULT_PERSONA), ensure_ascii=False),
                 json.dumps({"kind": "none"}), json.dumps(normalize_llm(None)), json.dumps(normalize_voice(None)),
                 now, now),
            )
            return True

    def update(self, mate_id: str, patch: dict[str, Any]) -> tuple[dict[str, Any], set[str]]:
        """Partial update: persona/llm/voice/prefs are merged field by field, the
        avatar is replaced. Returns (mate, names of the parts that changed)."""
        cur = self.get(mate_id)
        sets: list[str] = []
        params: list[Any] = []
        changed: set[str] = set()
        if "name" in patch and patch["name"] is not None:
            name = _s(patch["name"], 80).strip()
            if not name:
                raise MateError("a mate needs a name")
            if name != cur["name"]:
                sets.append("name = ?")
                params.append(name)
                changed.add("name")
        for key, fn in (("persona", normalize_persona), ("llm", normalize_llm), ("voice", normalize_voice),
                        ("prefs", normalize_prefs)):
            if key in patch and patch[key] is not None:
                new = fn(patch[key], cur[key])
                if new != cur[key]:
                    sets.append(f"{key} = ?")
                    params.append(json.dumps(new, ensure_ascii=False))
                    changed.add(key)
        if "avatar" in patch and patch["avatar"] is not None:
            new = normalize_avatar(patch["avatar"])
            if new != cur["avatar"]:
                sets.append("avatar = ?")
                params.append(json.dumps(new, ensure_ascii=False))
                changed.add("avatar")
        if cur.get("builtin") and changed & {"persona", "avatar"} and not patch.get("_sync"):
            sets.append("customized = 1")  # the user's own version now: content updates leave it alone
        with self._lock:
            if patch.get("is_default") and not cur["is_default"]:
                self._db.execute("UPDATE mates SET is_default = 0")
                sets.append("is_default = 1")
                changed.add("is_default")
            if sets:
                sets.append("updated_at = ?")
                params += [now_iso(), mate_id]
                self._db.execute(f"UPDATE mates SET {', '.join(sets)} WHERE id = ?", params)
        if sets:
            self._changed("updated", mate_id)
        return self.get(mate_id), changed

    # ---- built-in mates ----

    def by_builtin(self, key: str) -> dict[str, Any] | None:
        row = self._db.query_one("SELECT * FROM mates WHERE builtin = ?", (key,))
        if row is None:
            return None
        snap = _loads(row["builtin_snapshot"], {}) if "builtin_snapshot" in row.keys() else {}
        return {**self._out(row), "builtin_hash": row["builtin_hash"], "builtin_snapshot": snap or None}

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
            self._db.execute("DELETE FROM mate_settings WHERE key = ?", (f"memchg:{mate_id}",))
            self._db.execute("DELETE FROM mates WHERE id = ?", (mate_id,))
            if row["is_default"]:  # someone else becomes the default
                nxt = self._db.query_one("SELECT id FROM mates ORDER BY created_at LIMIT 1")
                if nxt is not None:
                    self._db.execute("UPDATE mates SET is_default = 1 WHERE id = ?", (nxt["id"],))
        self._changed("deleted", mate_id)

    # ---- memories (docs/mate-memory-affinity.md §4; ranking and the core: app/mate/memory.py) ----

    @staticmethod
    def _mem(row: Any) -> dict[str, Any]:
        d = dict(row)
        d.pop("mate_id", None)
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
        """The user's memory edits the mate hasn't been told about yet (cleared)."""
        key = f"memchg:{mate_id}"
        pending = _loads(self._setting(key), [])
        if pending:
            self._db.execute("DELETE FROM mate_settings WHERE key = ?", (key,))
        return pending

    def _clean(self, text: Any) -> str:
        text = " ".join(_s(text, MAX_MEMORY * 2).split())[:MAX_MEMORY]
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
            self._db.execute("UPDATE mate_memories SET status = 'archived', updated_at = ? WHERE id = ?",
                             (now_iso(), row["id"]))
        total = self._db.query_one("SELECT COUNT(*) AS c FROM mate_memories WHERE mate_id = ?", (mate_id,))["c"]
        if total >= M.MAX_ROWS:
            row = self._db.query_one(
                "SELECT id FROM mate_memories WHERE mate_id = ? AND COALESCE(status, 'active') != 'active' "
                "ORDER BY updated_at LIMIT 1", (mate_id,))
            if row is None:
                raise MateError(f"memory is full ({M.MAX_ROWS} items): forget something first")
            self._db.execute("DELETE FROM mate_memories WHERE id = ?", (row["id"],))

    def add_memory(self, mate_id: str, text: str, *, kind: Any = None, importance: Any = None, pinned: bool = False,
                   due_at: Any = None, by_user: bool = False, source: str | None = None) -> dict[str, Any]:
        """A new memory — or, when an active one of the same kind says the same (≥ 0.85 similar, or one
        contains the other), that one updated (``merged``). ``similar``: other close ones (0.55 – 0.85)."""
        self.get(mate_id)
        text = self._clean(text)
        kind = self._kind(kind)
        imp = self._importance(importance)
        due = self._due(due_at)
        now = now_iso()
        with self._lock:
            before = self._core_sig(mate_id) if by_user else ""
            rows = self.memories(mate_id)
            close = M.similar(text, kind, rows)
            if close and close[0][0] >= M.MERGE_AT:
                old = close[0][1]
                new_text = text if len(text) >= len(old["text"]) else old["text"]
                self._db.execute(
                    "UPDATE mate_memories SET text = ?, importance = ?, due_at = ?, pinned = ?, updated_at = ? "
                    "WHERE id = ?",
                    (new_text, max(imp, int(old.get("importance") or 3)), due or old.get("due_at"),
                     1 if (old["pinned"] or (pinned and by_user)) else 0, now, old["id"]))
                mem = {**self.memory(mate_id, old["id"]), "merged": True, "similar": []}
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
        if not sets:
            return cur
        with self._lock:
            before = self._core_sig(mate_id) if by_user else ""
            sets["updated_at"] = now_iso()
            self._db.execute(f"UPDATE mate_memories SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",
                             (*sets.values(), mem_id))
            mem = self.memory(mate_id, mem_id)
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
        with self._lock:
            before = self._core_sig(mate_id) if by_user else ""
            self._db.execute("DELETE FROM mate_memories WHERE id = ? AND mate_id = ?", (mem_id, mate_id))
            if by_user:
                self._user_edit(mate_id, before, {"id": mem_id, "op": "deleted"})
        self._changed("memory", mate_id)
        return True

    def bulk_memories(self, mate_id: str, ids: list[str], action: str) -> int:
        """The Memory tab's selection: delete | archive | restore | pin | unpin (the user's)."""
        if action not in ("delete", "archive", "restore", "pin", "unpin"):
            raise MateError(f"unknown bulk action: {action}")
        done: list[dict[str, Any]] = []
        with self._lock:
            before = self._core_sig(mate_id)
            for mid in dict.fromkeys(str(i) for i in ids or []):
                cur = self.memory(mate_id, mid)
                if cur is None:
                    continue
                if action == "delete":
                    self._db.execute("DELETE FROM mate_memories WHERE id = ? AND mate_id = ?", (mid, mate_id))
                else:
                    col, val = {"archive": ("status", "archived"), "restore": ("status", "active"),
                                "pin": ("pinned", 1), "unpin": ("pinned", 0)}[action]
                    self._db.execute(f"UPDATE mate_memories SET {col} = ?, updated_at = ? WHERE id = ?",
                                     (val, now_iso(), mid))
                done.append({"id": mid, "op": {"delete": "deleted", "archive": "archived"}.get(action, "edited"),
                             **({} if action == "delete" else {"text": cur["text"]})})
            if done:
                if self._core_sig(mate_id) != before:
                    self._bump_memory(mate_id)
                else:
                    for change in done:
                        self._user_edit(mate_id, before, change)
        n = len(done)
        if n:
            self._changed("memory", mate_id)
        return n

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
        """Short-term context past its expiry → archived; plans a week past due → done. (No restart: what
        the system prompt carried stays until the engine reloads for another reason.)"""
        n = 0
        for m in self.memories(mate_id):
            st = M.expired(m, now_utc, now_local)
            if st:
                self._db.execute("UPDATE mate_memories SET status = ?, updated_at = ? WHERE id = ?",
                                 (st, now_iso(), m["id"]))
                n += 1
        if n:
            self._changed("memory", mate_id)
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
        """A voice-service key (server side only); "" when not set."""
        if self._vault is None:
            return ""
        ref = SecretVault.make_id(_VAULT_SCOPE, name)
        if not self._vault.exists(ref):
            return ""
        try:
            return self._vault.read(ref)
        except Exception:  # noqa: BLE001 - key mismatch: treat as unset
            return ""

    def settings(self) -> dict[str, Any]:
        out: dict[str, Any] = {k: self._setting(k) for k in SETTING_URLS}
        out["timezone"] = self._setting("timezone")
        for k in SETTING_KEYS:
            out[f"{k}_set"] = bool(self._vault is not None
                                   and self._vault.exists(SecretVault.make_id(_VAULT_SCOPE, k)))
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
        changed: set[str] = set()
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
