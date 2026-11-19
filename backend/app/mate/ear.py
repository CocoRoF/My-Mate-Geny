"""A call's own ear (docs/mate-calls.md "Taking turns"): from the microphone's sound itself, whether they are talking now
and — the moment they stop — whether their voice sounds done. Our own models on this server, whichever recognizer
writes their words down:

- **Silero VAD** v6 (MIT): speech or not, every 32 ms — their voice, not the room's noise or a level that crossed a line;
- **Smart Turn** v3.2 (BSD-2, Pipecat; 23 languages, Korean among them): P(their turn is over) from the last ≤ 8 s of
  their voice — the fall of a finished sentence vs. the hang of one going on ("…만났는데", "근데 그냥 자꾸…").

The page (mate/call/session.ts) sends what its microphone hears on the call's line — binary frames: the page's clock (ms,
float64 little-endian) at the frame's last sample, then 16 kHz mono int16 PCM — and gets back ``{"type": "ear", "on":
bool, "at": <page ms>, "p"?: P}``: their voice began / ended (``p``: Smart Turn's judgement of the turn so far). The
turn-taking (mate/call/turns.ts) decides with these and the words.

Both models are small ONNX files (2.3 MB, 8.7 MB), fetched on first use into ``<data home>/models/ear`` and checked
against their SHA-256; they run on the CPU (onnxruntime: VAD ≈ 0.1 ms a frame, Smart Turn ≈ 50 ms a turn end). Without
onnxruntime or the files the ear is off and the page goes by the microphone's level as before.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import struct
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger("mate.ear")

SR = 16000
FRAME = 512                      # Silero's frame at 16 kHz (32 ms)
ON_P, OFF_P = 0.5, 0.35          # speech above ON_P, silence below OFF_P (Silero's own hysteresis)
ON_FRAMES = 2                    # 64 ms of speech starts their voice
OFF_FRAMES = 3                   # 96 ms of quiet ends it
TAIL_S = 0.2                     # Smart Turn hears their turn with this much quiet after it (as it was trained)
TURN_S = 8.0                     # …and at most this much of it
PRE_S = 0.3                      # a turn's audio starts this much before its first speech (its first syllable)
FORGET_S = 3.0                   # quiet this long: the next voice is a new turn for Smart Turn

MODELS: dict[str, dict[str, str]] = {
    "vad": {"file": "silero_vad.onnx", "sha256": "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
            "url": "https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.3/src/silero_vad/data/silero_vad.onnx"},
    "turn": {"file": "smart-turn-v3.2-cpu.onnx", "sha256": "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
             "url": "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/"
                    "smart-turn-v3.2-cpu.onnx"},
}


def _session(path: Path, threads: int = 1) -> Any:
    import onnxruntime as ort

    if hasattr(ort, "disable_telemetry_events"):
        ort.disable_telemetry_events()  # (nothing about this machine goes anywhere)
    so = ort.SessionOptions()
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.inter_op_num_threads = 1
    so.intra_op_num_threads = threads
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.log_severity_level = 3
    return ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])


class Vad:
    """Silero VAD: P(speech) for each 512-sample frame, its state carried from frame to frame."""

    CONTEXT = 64

    def __init__(self, session: Any) -> None:
        self.s = session
        self.state = np.zeros((2, 1, 128), np.float32)
        self.context = np.zeros((1, self.CONTEXT), np.float32)

    def __call__(self, frame: np.ndarray) -> float:
        x = np.concatenate([self.context, frame.reshape(1, -1).astype(np.float32)], axis=1)
        out, self.state = self.s.run(None, {"input": x, "state": self.state, "sr": np.array(SR, np.int64)})
        self.context = x[:, -self.CONTEXT:]
        return float(np.asarray(out).reshape(-1)[0])


def _hz_to_mel(f: np.ndarray) -> np.ndarray:  # (Slaney's scale: linear below 1 kHz, log above)
    f = np.asarray(f, np.float64)
    return np.where(f >= 1000.0, 15.0 + np.log(np.maximum(f, 1e-10) / 1000.0) / (np.log(6.4) / 27.0), 3.0 * f / 200.0)


def _mel_to_hz(m: np.ndarray) -> np.ndarray:
    m = np.asarray(m, np.float64)
    return np.where(m >= 15.0, 1000.0 * np.exp((np.log(6.4) / 27.0) * (m - 15.0)), 200.0 * m / 3.0)


def mel_filters(n_mels: int = 80, n_fft: int = 400, fmax: float = 8000.0) -> np.ndarray:
    """(n_fft/2+1, n_mels) triangular filters, Slaney-normalized — Whisper's."""
    freqs = np.linspace(0, SR // 2, n_fft // 2 + 1)
    pts = _mel_to_hz(np.linspace(_hz_to_mel(0.0), _hz_to_mel(fmax), n_mels + 2))
    diff = np.diff(pts)
    slopes = pts[None, :] - freqs[:, None]
    fb = np.maximum(0, np.minimum(-slopes[:, :-2] / diff[:-1], slopes[:, 2:] / diff[1:]))
    return fb * (2.0 / (pts[2:n_mels + 2] - pts[:n_mels]))[None, :]


class SmartTurn:
    """P(the turn is complete) from the last 8 s of it — Whisper's log-mel features (numpy, the same to 1e-6 as
    transformers' WhisperFeatureExtractor), zeros padded at the start."""

    N = int(TURN_S * SR)

    def __init__(self, session: Any) -> None:
        self.s = session
        self.mel = mel_filters()
        self.window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(400) / 400)

    def features(self, audio: np.ndarray) -> np.ndarray:
        x = audio.astype(np.float64)
        x = x[-self.N:] if len(x) > self.N else np.pad(x, (self.N - len(x), 0))
        x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)
        xp = np.pad(x, (200, 200), mode="reflect")
        n = 1 + (len(xp) - 400) // 160
        frames = xp[np.arange(400)[None, :] + 160 * np.arange(n)[:, None]] * self.window
        log = np.log10(np.maximum((np.abs(np.fft.rfft(frames, n=400, axis=1)) ** 2) @ self.mel, 1e-10)).T[:, :-1]
        log = np.maximum(log, log.max() - 8.0)
        return ((log + 4.0) / 4.0).astype(np.float32)[None]

    def __call__(self, audio: np.ndarray) -> float:
        return float(np.asarray(self.s.run(None, {"input_features": self.features(audio)})[0]).reshape(-1)[0])


class Models:
    """The ear's two models, fetched once (checked) and loaded once per process; ``ready`` once both are."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.vad: Any = None
        self.turn: SmartTurn | None = None
        self.error = ""
        self._lock = threading.Lock()
        self._task: asyncio.Task | None = None

    @property
    def ready(self) -> bool:
        return self.vad is not None and self.turn is not None

    def start(self) -> None:
        """Fetch and load in the background (a call before it is done goes by the microphone's level)."""
        if self.ready or (self._task is not None and not self._task.done()):
            return
        try:
            self._task = asyncio.get_running_loop().create_task(asyncio.to_thread(self.load))
        except RuntimeError:
            pass

    def load(self) -> bool:
        with self._lock:
            if self.ready:
                return True
            try:
                import onnxruntime  # noqa: F401
            except ImportError:
                self.error = "onnxruntime is not installed"
                return False
            try:
                paths = {k: self._fetch(m) for k, m in MODELS.items()}
                self.vad = _session(paths["vad"])
                self.turn = SmartTurn(_session(paths["turn"]))
                self.error = ""
                log.info("ear ready (Silero VAD, Smart Turn v3.2)")
                return True
            except Exception as exc:  # noqa: BLE001 - the ear is off; the page goes by the level
                self.error = str(exc)[:300]
                log.warning("ear unavailable: %s", self.error)
                return False

    def _fetch(self, m: dict[str, str]) -> Path:
        path = self.folder / m["file"]
        if path.exists() and _sha256(path) == m["sha256"]:
            return path
        import httpx

        self.folder.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(".part")
        with httpx.stream("GET", m["url"], follow_redirects=True, timeout=60) as r:
            r.raise_for_status()
            with part.open("wb") as f:
                for chunk in r.iter_bytes():
                    f.write(chunk)
        if _sha256(part) != m["sha256"]:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"{m['file']}: not the file expected (SHA-256)")
        part.replace(path)
        return path


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# one thread runs every call's models (in order; never the event loop's)
_POOL = ThreadPoolExecutor(1, thread_name_prefix="ear")


class Ear:
    """One call's ear: frames in, "their voice began / ended (and sounds done: p)" out — at the page's clock."""

    def __init__(self, models: Models, *, vad: Any = None, turn: Any = None) -> None:
        self.vad = vad or Vad(models.vad)
        self.turn = turn or models.turn
        self.buf = np.zeros(0, np.float32)        # samples not yet a whole frame
        self.ring = np.zeros(0, np.float32)       # the last TURN_S + PRE_S of sound
        self.speaking = False
        self.on_run = 0
        self.off_run = 0
        self.turn_from: int | None = None         # sample index (since the start) where this turn began
        self.speech_end = 0                       # sample index where their voice last ended
        self.n = 0                                # samples heard so far
        self.base_at = 0.0                        # page ms of sample 0 (from the frames' clocks)
        self.closed = False

    def reset_turn(self) -> None:
        """their turn went to her: Smart Turn hears the next one on its own"""
        self.turn_from = None

    def feed(self, data: bytes) -> list[dict[str, Any]]:
        if len(data) < 10:
            return []
        at = struct.unpack("<d", data[:8])[0]
        pcm = np.frombuffer(data[8: 8 + (len(data) - 8) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
        end = self.n + len(self.buf) + len(pcm)
        self.base_at = at - end * 1000.0 / SR     # (the page's clock at sample 0, by this frame)
        self.buf = np.concatenate([self.buf, pcm])
        keep = int((TURN_S + PRE_S + 1.0) * SR)
        self.ring = np.concatenate([self.ring, pcm])[-keep:]
        out: list[dict[str, Any]] = []
        while len(self.buf) >= FRAME:
            frame, self.buf = self.buf[:FRAME], self.buf[FRAME:]
            p = self.vad(frame)
            start = self.n
            self.n += FRAME
            ev = self._step(p, start)
            if ev is not None:
                out.append(ev)
        return out

    def _ms(self, sample: int) -> float:
        return round(self.base_at + sample * 1000.0 / SR, 1)

    def _step(self, p: float, start: int) -> dict[str, Any] | None:
        if not self.speaking:
            self.on_run = self.on_run + 1 if p >= ON_P else 0
            if self.on_run >= ON_FRAMES:
                self.speaking, self.off_run = True, 0
                began = start - (ON_FRAMES - 1) * FRAME
                if self.turn_from is None or (began - self.speech_end) > FORGET_S * SR:
                    self.turn_from = max(0, began - int(PRE_S * SR))
                return {"type": "ear", "on": True, "at": self._ms(began)}
            return None
        self.off_run = self.off_run + 1 if p < OFF_P else 0
        if self.off_run < OFF_FRAMES:
            return None
        self.speaking, self.on_run = False, 0
        ended = start + FRAME - OFF_FRAMES * FRAME
        self.speech_end = ended
        ev: dict[str, Any] = {"type": "ear", "on": False, "at": self._ms(ended)}
        if self.turn is not None:
            ev["p"] = round(self._judge(ended), 3)
        return ev

    def _judge(self, ended: int) -> float:
        """Smart Turn on this turn up to its end, then TAIL_S of quiet (what was heard after it, zeros for the rest)"""
        frm = self.turn_from if self.turn_from is not None else max(0, ended - int(TURN_S * SR))
        frm = max(frm, ended - int(TURN_S * SR))
        ring_start = self.n + len(self.buf) - len(self.ring)  # sample index of ring[0]
        a = self.ring[max(0, frm - ring_start): max(0, ended - ring_start)]
        heard_after = self.ring[max(0, ended - ring_start): max(0, ended - ring_start) + int(TAIL_S * SR)]
        tail = np.concatenate([heard_after, np.zeros(int(TAIL_S * SR) - len(heard_after), np.float32)])
        return self.turn(np.concatenate([a, tail]))


async def hear(ear: Ear, data: bytes) -> list[dict[str, Any]]:
    """(the call's line) a frame through the ear, off the event loop"""
    return await asyncio.get_running_loop().run_in_executor(_POOL, ear.feed, data)
