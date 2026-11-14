"""Voices a local model can speak with (docs/local-voice.md "Voices").

A voice (Voice Studio: a "profile") is reference clips by feeling — neutral, joy, sadness, anger, surprise, fear,
disgust, smile; one clip each — with its exact transcript; a cloning engine (Qwen3-TTS, CosyVoice3, OmniVoice) speaks
a line like the clip of the feeling it is said in (a mate's emotion tag picks it, through a short chain: worried →
fear, else sadness), else like the neutral one.

- Built in: the voices that come with the app (app/mate/builtin/voices/<key>/voice.json — 한채린, 메스가키), read-only.
- The user's own: made in Settings → 이미지 및 음성 공급자 → 로컬 음성 모델 (a name, clips uploaded as files; a clip
  without a transcript is transcribed by the local Whisper when it is installed).
- A mate's own clip (her Voice tab's reference, ``voice.tts.ref``) works too, as a voice of one neutral clip.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from .settings import VoiceSettings
from .store import VoiceStore

FEELINGS = ("neutral", "joy", "sadness", "anger", "surprise", "fear", "disgust", "smile")
# a mate's emotion tag (or a feeling) → the clips to try, in order; the neutral clip is always the last resort
_CHAIN = {"joy": ("joy",), "laugh": ("joy",), "smile": ("smile", "joy"), "greet": ("smile", "joy"),
          "shy": ("smile",), "surprised": ("surprise",), "surprise": ("surprise",), "sad": ("sadness",),
          "sadness": ("sadness",), "worried": ("fear", "sadness"), "fear": ("fear", "sadness"),
          "scared": ("fear", "sadness"), "angry": ("anger",), "anger": ("anger",), "disgust": ("disgust", "anger")}
BUILTIN_DIR = Path(__file__).resolve().parents[1] / "mate" / "builtin" / "voices"
BUILTIN = "builtin:"


def chain_of(emotion: str | None) -> tuple[str, ...]:
    return _CHAIN.get((emotion or "").strip().lower(), ())


def feeling_of(emotion: str | None) -> str:
    """the feeling a tag asks for first (neutral when it asks for none)"""
    c = chain_of(emotion)
    return c[0] if c else "neutral"


def _builtin(key: str) -> dict[str, Any] | None:
    d = BUILTIN_DIR / key
    try:
        spec = json.loads((d / "voice.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None
    refs = []
    emotions = spec.get("emotions") if isinstance(spec.get("emotions"), dict) else {}
    if not emotions and spec.get("ref"):
        emotions = {"neutral": {"ref": spec["ref"], "text": spec.get("text", "")}}
    for label, e in emotions.items():
        f = d / str(e.get("ref") or "")
        if label in FEELINGS and f.is_file():
            refs.append({"id": f"{BUILTIN}{key}:{label}", "voice_id": f"{BUILTIN}{key}", "label": label,
                         "file": str(f), "transcript": str(e.get("text") or ""), "language": spec.get("language", "ko"),
                         "duration": float(e.get("seconds") or 0), "stats": {}})
    if not refs:
        return None
    return {"id": f"{BUILTIN}{key}", "name": spec.get("name") or key, "language": spec.get("language", "ko"),
            "instruct": spec.get("instruct", ""), "builtin": True, "source": spec.get("source", ""),
            "rights": spec.get("rights", ""), "description": spec.get("description", ""), "default_model": "",
            "default_params": {}, "tags": [], "starred": False, "references": refs}


def builtins() -> list[dict[str, Any]]:
    if not BUILTIN_DIR.is_dir():
        return []
    out = []
    for d in sorted(BUILTIN_DIR.iterdir()):
        v = _builtin(d.name) if d.is_dir() else None
        if v:
            out.append(v)
    return out


class VoiceLibrary:
    def __init__(self, settings: VoiceSettings, store: VoiceStore) -> None:
        self.s = settings
        self.store = store

    def _file(self, ref: dict[str, Any]) -> Path:
        p = Path(ref["file"])
        return p if p.is_absolute() else self.s.refs_dir / p

    def list(self) -> list[dict[str, Any]]:
        own = []
        for v in self.store.voices():
            v["builtin"] = False
            own.append(v)
        return builtins() + own

    def get(self, vid: str) -> dict[str, Any] | None:
        if vid.startswith(BUILTIN):
            return _builtin(vid[len(BUILTIN):])
        v = self.store.voice(vid)
        if v is not None:
            v["builtin"] = False
        return v

    def reference_file(self, vid: str, rid: str) -> Path | None:
        v = self.get(vid)
        ref = next((r for r in (v or {}).get("references", []) if r["id"] == rid), None)
        if ref is None:
            return None
        f = self._file(ref)
        return f if f.is_file() else None

    def resolve(self, vid: str, emotion: str | None = None) -> dict[str, Any] | None:
        """The clip a line is cloned from: the voice's clip of the feeling (through its chain), else its neutral one,
        else its first. → the worker's reference ({path, text, language, label: the clip's feeling, ref_id}) or None
        (no such voice / no clip)."""
        v = self.get(vid)
        refs = (v or {}).get("references") or []
        if not refs:
            return None
        by = {}
        for r in refs:
            by.setdefault(r["label"], r)
        ref = next((by[f] for f in (*chain_of(emotion), "neutral") if f in by), None) or refs[0]
        f = self._file(ref)
        if not f.is_file():
            return None
        lang = ref.get("language") or (v or {}).get("language") or "auto"
        return {"path": str(f), "text": ref.get("transcript") or "", "language": lang, "label": ref["label"],
                "ref_id": ref["id"]}

    # -- the user's voices ------------------------------------------------------------------------------------------
    def create(self, name: str, language: str = "auto", instruct: str = "", **more: Any) -> dict[str, Any]:
        name = " ".join(str(name or "").split())[:80]
        if not name:
            raise ValueError("A voice needs a name")
        v = self.store.create_voice(name, language or "auto", str(instruct or "")[:500])
        if more:
            v = self.store.update_voice(v["id"], **more) or v
        v["builtin"] = False
        return v

    def duplicate(self, vid: str, name: str = "") -> dict[str, Any]:
        """A copy of a voice (a built-in one too: the way to change it) with copies of its clips."""
        from app.services._ids import new_id

        src = self.get(vid)
        if src is None:
            raise KeyError("no such voice")
        v = self.create(name or f"{src['name']} (copy)", src.get("language") or "auto", src.get("instruct") or "",
                        description=src.get("description") or "", default_model=src.get("default_model") or "",
                        default_params=src.get("default_params") or {}, tags=src.get("tags") or [])
        for ref in src.get("references") or []:
            f = self._file(ref)
            if not f.is_file():
                continue
            rid = new_id("ref")
            rel = f"{v['id']}/{rid}.wav"
            (self.s.refs_dir / v["id"]).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, self.s.refs_dir / rel)
            self.store.add_reference(v["id"], label=ref["label"], file=rel, transcript=ref.get("transcript") or "",
                                     language=ref.get("language") or v["language"], duration=float(ref.get("duration") or 0),
                                     stats=ref.get("stats") or {}, rid=rid)
        return self.get(v["id"]) or v

    def delete(self, vid: str) -> bool:
        if vid.startswith(BUILTIN):
            raise ValueError("A built-in voice can't be deleted")
        if self.store.voice(vid) is None:
            return False
        self.store.delete_voice(vid)
        shutil.rmtree(self.s.refs_dir / vid, ignore_errors=True)
        return True

    def add_reference(self, vid: str, data: bytes, *, label: str = "neutral", transcript: str = "",
                      language: str = "", start: float | None = None, end: float | None = None,
                      replace: bool = True) -> dict[str, Any]:
        """A clip for one of the user's voices: read (any common format), made mono 24 kHz, cut to [start, end] when
        given (else its silence trimmed), at most max_reference_seconds long, saved as a WAV — in place of the clip
        the feeling had (``replace``). → the reference (``stats.warnings``: what may hurt cloning)."""
        from app.services._ids import new_id

        from . import audio  # (numpy / soundfile: only where they are needed — the server starts without them)

        v = self.store.voice(vid)
        if v is None:
            raise KeyError("no such voice")
        if len(data) > self.s.max_upload_mb * 1024 * 1024:
            raise ValueError(f"The clip is larger than {self.s.max_upload_mb} MB")
        if label not in FEELINGS:
            label = "neutral"
        x, sr = audio.decode(data, audio.REF_SR)
        if start is not None or end is not None:
            x = audio.cut(x, sr, start, end)
        else:
            x = audio.trim_silence(x, sr)
        x = x[: int(self.s.max_reference_seconds * sr)]
        if len(x) < sr * 0.5:
            raise ValueError("The clip is shorter than half a second (after its silence is trimmed)")
        st = audio.stats(x, sr)
        rid = new_id("ref")
        rel = f"{vid}/{rid}.wav"
        audio.write_wav(self.s.refs_dir / rel, audio.normalize(x), sr)
        if replace:
            for old in v.get("references") or []:
                if old["label"] == label:
                    self.delete_reference(old["id"])
        return self.store.add_reference(vid, label=label, file=rel, transcript=" ".join(str(transcript or "").split()),
                                        language=language or v.get("language") or "auto", duration=st.duration,
                                        stats=st.to_dict(), rid=rid)

    def trim_reference(self, rid: str, start: float | None, end: float | None) -> dict[str, Any]:
        """Cut a stored clip to [start, end] seconds (the trimmer). The transcript is the user's to fix."""
        from . import audio

        ref = self.store.reference(rid)
        if ref is None:
            raise KeyError("no such clip")
        f = self._file(ref)
        x, sr = audio.decode(f.read_bytes(), audio.REF_SR)
        x = audio.cut(x, sr, start, end)
        if len(x) < sr * 0.5:
            raise ValueError("Keep at least half a second")
        st = audio.stats(x, sr)
        audio.write_wav(f, audio.normalize(x), sr)
        return self.store.update_reference(rid, duration=st.duration, stats=st.to_dict()) or ref

    def delete_reference(self, rid: str) -> bool:
        f = self.store.delete_reference(rid)
        if f is None:
            return False
        (self.s.refs_dir / f).unlink(missing_ok=True)
        return True
