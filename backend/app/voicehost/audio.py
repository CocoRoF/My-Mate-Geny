"""Audio in and out for the server process (numpy + soundfile + soxr, ffmpeg for formats libsndfile lacks)."""

from __future__ import annotations

import io
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

REF_SR = 24000  # references are stored as 24 kHz mono float WAV: every engine here reads that natively


class AudioError(ValueError):
    pass


def _ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def decode(data: bytes, target_sr: int | None = None) -> tuple[np.ndarray, int]:
    """Any common audio file (wav, flac, ogg, mp3, webm/opus from a browser recorder, m4a) -> mono float32."""
    wav, sr = None, 0
    try:
        wav, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception:  # noqa: BLE001 - libsndfile does not read webm/m4a; ffmpeg does
        ff = _ffmpeg()
        if not ff:
            raise AudioError("This audio format can't be read here (use wav, flac, ogg or mp3)") from None
        sr = target_sr or 48000
        p = subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(sr),
                            "-f", "f32le", "pipe:1"], input=data, capture_output=True, timeout=120)
        if p.returncode != 0 or not p.stdout:
            raise AudioError("Could not read the audio: " + p.stderr.decode(errors="replace")[-300:]) from None
        wav = np.frombuffer(p.stdout, dtype=np.float32).reshape(-1, 1)
    mono = wav.mean(axis=1).astype(np.float32)
    if target_sr and sr != target_sr:
        mono = resample(mono, sr, target_sr)
        sr = target_sr
    return mono, sr


def resample(x: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return x
    import soxr

    return soxr.resample(x, sr, target, quality="HQ").astype(np.float32)


@dataclass
class Stats:
    duration: float
    rms_db: float
    peak: float
    clipped: float  # share of samples at full scale
    silence: float  # share of 20 ms frames below -45 dBFS
    warnings: list[str]  # codes: empty | short | long | clipped | quiet | silent (the UI words them)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def stats(x: np.ndarray, sr: int) -> Stats:
    dur = len(x) / sr if sr else 0.0
    if len(x) == 0:
        return Stats(0.0, -120.0, 0.0, 0.0, 1.0, ["empty"])
    peak = float(np.abs(x).max())
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))
    rms_db = 20 * np.log10(max(rms, 1e-6))
    clipped = float(np.mean(np.abs(x) >= 0.999))
    hop = max(1, int(sr * 0.02))
    frames = x[: len(x) // hop * hop].reshape(-1, hop) if len(x) >= hop else x.reshape(1, -1)
    fr_db = 20 * np.log10(np.maximum(np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1)), 1e-6))
    silence = float(np.mean(fr_db < -45))
    w = []
    if dur < 3:
        w.append("short")  # (5–15 s clones best)
    elif dur > 20:
        w.append("long")
    if clipped > 0.001:
        w.append("clipped")
    if rms_db < -35:
        w.append("quiet")
    if silence > 0.5:
        w.append("silent")
    return Stats(round(dur, 3), round(rms_db, 1), round(peak, 3), round(clipped, 5), round(silence, 3), w)


def trim_silence(x: np.ndarray, sr: int, threshold_db: float = -45.0, pad: float = 0.15) -> np.ndarray:
    """Cut leading and trailing silence, keeping a short pad so words are not clipped."""
    hop = max(1, int(sr * 0.01))
    if len(x) < hop * 3:
        return x
    n = len(x) // hop
    fr = x[: n * hop].reshape(n, hop)
    db = 20 * np.log10(np.maximum(np.sqrt(np.mean(fr.astype(np.float64) ** 2, axis=1)), 1e-6))
    voiced = np.nonzero(db > threshold_db)[0]
    if len(voiced) == 0:
        return x
    p = int(pad * sr)
    start = max(0, voiced[0] * hop - p)
    end = min(len(x), (voiced[-1] + 1) * hop + p)
    return x[start:end]


def normalize(x: np.ndarray, target_db: float = -20.0, peak_limit: float = 0.95) -> np.ndarray:
    """Bring speech to a steady loudness (RMS) without letting peaks clip."""
    if len(x) == 0:
        return x
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))
    if rms < 1e-5:
        return x
    gain = 10 ** (target_db / 20) / rms
    peak = float(np.abs(x).max()) * gain
    if peak > peak_limit:
        gain *= peak_limit / peak
    return (x * gain).astype(np.float32)


def concat(chunks: list[np.ndarray], sr: int, gap: float = 0.25) -> np.ndarray:
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    silence = np.zeros(int(sr * gap), dtype=np.float32)
    out: list[np.ndarray] = []
    fade = int(sr * 0.005)
    for i, c in enumerate(chunks):
        c = c.astype(np.float32, copy=True)
        if fade and len(c) > 2 * fade:  # 5 ms fades: no clicks at the joins
            ramp = np.linspace(0, 1, fade, dtype=np.float32)
            c[:fade] *= ramp
            c[-fade:] *= ramp[::-1]
        if i:
            out.append(silence)
        out.append(c)
    return np.concatenate(out)


def write_wav(path: Path, x: np.ndarray, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), x, sr, subtype="PCM_16")


FORMATS = {"wav": "audio/wav", "mp3": "audio/mpeg", "ogg": "audio/ogg", "flac": "audio/flac"}


def encode(path: Path, fmt: str) -> bytes:
    """A stored WAV in another container. mp3 needs ffmpeg; flac/ogg go through libsndfile."""
    if fmt == "wav":
        return path.read_bytes()
    if fmt in ("flac", "ogg"):
        x, sr = sf.read(str(path), dtype="float32")
        buf = io.BytesIO()
        sf.write(buf, x, sr, format=fmt.upper(), subtype="VORBIS" if fmt == "ogg" else "PCM_16")
        return buf.getvalue()
    if fmt == "mp3":
        ff = _ffmpeg()
        if not ff:
            raise AudioError("mp3 needs ffmpeg on this server")
        p = subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-i", str(path), "-codec:a", "libmp3lame",
                            "-q:a", "2", "-f", "mp3", "pipe:1"], capture_output=True, timeout=120)
        if p.returncode != 0:
            raise AudioError("mp3 encoding failed")
        return p.stdout
    raise AudioError(f"unsupported format: {fmt}")
