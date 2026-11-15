"""A voice's own laughs (docs/local-voice.md "Laughs, sighs and yawns").

No engine here laughs reliably when a line says 헤헤 (OmniVoice's tag laughs in 38% of lines, the others hardly ever),
but a laugh made on its own, the best of a dozen takes, is a laugh every time. So a voice keeps a few clips of its
own laugh, and a line that laughs gets one put in where it laughs (nonverbal.parts → :func:`splice`).

Where a voice's clips come from, the first found:

* its profile's own sound clips (Voice Studio → 프로필: label 웃음 / 하품 — recorded, uploaded, or made here),
* a built-in voice's (app/mate/builtin/voices/<key>/sounds/, listed in its voice.json),
* the ones made for the clip a line is cloned from, the first time a line of it laughs: ``<home>/sounds/<its key>/``
  (VoiceHost.make_sounds: the installed engine that laughs best, the takes an AudioSet classifier hears laughing).
"""

from __future__ import annotations

import hashlib
import json
import shutil
import time
from pathlib import Path
from typing import Any

SOUND_LABELS = ("laugh", "yawn")   # a profile's sound clips (its feelings are the clips it is cloned from)
MADE = ("laugh", "giggle")         # what is made for a voice (a giggle: the strongest short part of a laugh)
GIGGLE_MAX_S = 1.0


def ref_key(ref: dict[str, Any]) -> str:
    """the clip a line is cloned from, as a folder name (another clip, or this one changed: other laughs)"""
    p = Path(str(ref.get("path") or ""))
    try:
        st = p.stat()
        stamp = f"{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        stamp = ""
    return hashlib.sha1(f"{p}|{stamp}|{ref.get('text') or ''}".encode()).hexdigest()[:20]


class SoundBank:
    def __init__(self, home: Path) -> None:
        self.root = Path(home) / "sounds"

    def dir_for(self, ref: dict[str, Any]) -> Path:
        return self.root / ref_key(ref)

    def made(self, ref: dict[str, Any]) -> dict[str, Any] | None:
        """what was made for this clip: {kinds: {kind: [file]}, made_at, model_id, checked} (None: nothing yet)"""
        d = self.dir_for(ref)
        try:
            meta = json.loads((d / "meta.json").read_text("utf-8"))
        except (OSError, ValueError):
            return None
        kinds = {k: [str(d / f) for f in fs if (d / f).is_file()] for k, fs in (meta.get("kinds") or {}).items()}
        return {**meta, "kinds": {k: v for k, v in kinds.items() if v}, "dir": str(d)}

    def clips(self, ref: dict[str, Any] | None, own: dict[str, list[str]] | None = None) -> dict[str, list[str]]:
        """kind → clip files for a line in this voice: ``own`` (its profile's or built-in voice's:
        VoiceLibrary.sound_clips) first, then the ones made for the clip it is cloned from"""
        out = {k: [f for f in fs if Path(f).is_file()] for k, fs in (own or {}).items()}
        out = {k: fs for k, fs in out.items() if fs}
        made = self.made(ref) if ref else None
        for k, files in ((made or {}).get("kinds") or {}).items():
            out.setdefault(k, files)
        return out

    def save(self, ref: dict[str, Any], takes: list[dict[str, Any]], *, model_id: str, checked: bool) -> dict[str, Any]:
        """the kept takes (worker files: {path, kind, score, seconds}) as this clip's sounds"""
        d = self.dir_for(ref)
        stage = d.with_name(d.name + ".partial")
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir(parents=True)
        kinds: dict[str, list[str]] = {}
        scores: dict[str, float | None] = {}
        for t in takes:
            n = len(kinds.setdefault(t["kind"], [])) + 1
            name = f"{t['kind']}-{n}.wav"
            shutil.copyfile(t["path"], stage / name)
            kinds[t["kind"]].append(name)
            scores[name] = t.get("score")
        (stage / "meta.json").write_text(json.dumps({
            "kinds": kinds, "scores": scores, "model_id": model_id, "checked": checked, "made_at": time.time(),
            "source": str(ref.get("path") or "")}, ensure_ascii=False, indent=1), "utf-8")
        shutil.rmtree(d, ignore_errors=True)
        stage.rename(d)
        return self.made(ref) or {}

    def forget(self, ref: dict[str, Any]) -> bool:
        d = self.dir_for(ref)
        if not d.exists():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True


def pick(files: list[str], n: int) -> str:
    """the n-th sound of a line in turn (the same line, the same seed: the same clips)"""
    return files[n % len(files)]


def splice(pieces: list[Any], sr: int, *, gap_before: float = 0.06, gap_after: float = 0.12,
           gap_words: float = 0.22) -> Any:
    """Speech (arrays at ``sr``) and sound clips ((kind, file)) into one take: each clip read at ``sr``, levelled to the
    speech around it, faded in and out, with a short breath of silence on each side."""
    import numpy as np
    import soundfile as sf

    from . import audio

    def rms(x: Any) -> float:
        a = np.abs(x)
        loud = x[a > max(1e-4, a.max() * 0.05)] if len(x) else x
        return float(np.sqrt(np.mean(loud.astype(np.float64) ** 2))) if len(loud) else 0.0

    speech = [p for p in pieces if not isinstance(p, tuple)]
    level = float(np.median([rms(s) for s in speech if len(s)])) if speech else 0.08
    out: list[Any] = []
    prev = ""
    for p in pieces:
        if isinstance(p, tuple):
            kind, f = p
            x, csr = sf.read(f, dtype="float32", always_2d=False)
            if x.ndim > 1:
                x = x.mean(axis=1)
            if csr != sr:
                x = audio.resample(x, csr, sr)
            x = audio.trim_silence(x, sr, pad=0.03)
            if kind == "giggle" and len(x) > GIGGLE_MAX_S * sr:
                x = x[: int(GIGGLE_MAX_S * sr)]
            r = rms(x)
            if r > 0:
                x = x * min(4.0, level * 0.9 / r)
            fade = min(len(x) // 4, int(sr * 0.012))
            if fade:
                ramp = np.linspace(0, 1, fade, dtype=np.float32)
                x[:fade] *= ramp
                x[-fade:] *= ramp[::-1]
            tail = min(len(x) // 3, int(sr * 0.12))
            if kind == "giggle" and len(x) >= GIGGLE_MAX_S * sr and tail:  # (cut short here: faded out, not stopped)
                x[-tail:] *= np.linspace(1, 0, tail, dtype=np.float32)
            if out:
                out.append(np.zeros(int(sr * gap_before), dtype=np.float32))
            out.append(x.astype(np.float32))
            prev = "sound"
        else:
            x = audio.trim_silence(np.asarray(p, dtype=np.float32), sr, pad=0.05)
            if out:
                out.append(np.zeros(int(sr * (gap_after if prev == "sound" else gap_words)), dtype=np.float32))
            out.append(x)
            prev = "say"
    if not out:
        return np.zeros(0, dtype=np.float32)
    y = np.concatenate(out)
    peak = float(np.abs(y).max()) if len(y) else 0.0
    return y * (0.98 / peak) if peak > 0.98 else y
