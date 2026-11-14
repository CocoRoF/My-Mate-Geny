"""Local voice models, served from this machine's GPU — one service for the app (docs/local-voice.md).

    VoiceHost
      ├─ gate          can this machine serve them at all (an NVIDIA GPU, a CUDA 12.8 driver, …): refused up front
      ├─ installer     모델 받기: the engine's environment (uv, locked) + the weights, after the license is accepted
      ├─ engines       which models are on the GPU (measured VRAM, park / stop, pins for calls)
      ├─ queue         one GPU job at a time; a mate's words go before a preview, a preview before a load
      └─ voices        reference clips by feeling: built in (한채린, 메스가키) and the user's own

The server process never imports torch: each loaded model is a worker process in its engine's own environment.
"""

from __future__ import annotations

import asyncio
import collections
import io
import itertools
import random
import logging
import shutil
import time
from typing import Any, Awaitable, Callable

from . import catalog, gate as G, system, textsplit
from .batch import BatchInputError, BatchRunner, BatchStore, parse as parse_batch
from .history import HistoryStore
from .host import EngineManager, NoRoom
from .installer import RUNTIMES, Installer
from .settings import VoiceSettings
from .store import VoiceStore
from .voices import VoiceLibrary
from .workerproc import WorkerError

log = logging.getLogger("app.voicehost")

# how each engine wants long text: Qwen3-TTS batches sentence segments in one call, CosyVoice3 takes them one by one,
# OmniVoice chunks internally and is fastest given the whole text (measured, docs/local-voice.md)
STRATEGY = {"qwen3_tts": ("batch", 4), "cosyvoice3": ("segments", 1), "omnivoice": ("whole", 1), "fake": ("segments", 1)}
# a mate on the local engine without a model of her own speaks with the first of these that is installed
DEFAULT_TTS = ("omnivoice", "qwen3-tts-1.7b-base", "qwen3-tts-0.6b-base", "cosyvoice3-0.5b")
DEFAULT_STT = ("whisper-large-v3-turbo",)

INTERACTIVE, PREVIEW, BACKGROUND = 0, 1, 2  # GPU job priorities
_GIB = 1 << 30

# what Voice Studio → 설정 may change while the server runs: (type, min, max); 0 = never for the two idle times
RUNTIME = {"vram_budget_fraction": (float, 0.3, 0.95), "idle_unload_seconds": (float, 0, 86400),
           "parked_ttl_seconds": (float, 0, 86400), "park_ram_gb": (float, 0, 64),
           "history_max_entries": (int, 50, 100000), "history_max_gb": (float, 0.5, 500)}
MODES = ("clone", "design", "auto")


class VoiceError(Exception):
    """a request local voice can't serve: ``code`` for the UI (no_gpu, not_installed, license, no_room, …)"""

    def __init__(self, message: str, code: str = "error", status: int = 400, data: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.data = data or {}


class GpuQueue:
    """One GPU job at a time (they would only compete for memory and slow each other down). Waiting jobs go by
    priority — a mate's words, then a preview, then a load — and in order of arrival within one.

    Every job leaves a record (Voice Studio's overview: what ran, on which model, for whom — ``source``: ``mate:<name>``,
    ``call:<name>``, ``studio``, ``compare``, ``seed``, ``batch``, ``settings`` — and how long it waited and took)."""

    def __init__(self, engines: EngineManager) -> None:
        self.engines = engines
        self._q: asyncio.PriorityQueue = asyncio.PriorityQueue()
        self._seq = itertools.count()
        self._task: asyncio.Task | None = None
        self.running: str = ""
        self.current: dict[str, Any] | None = None
        self.waiting_jobs: dict[int, dict[str, Any]] = {}
        self.recent: collections.deque = collections.deque(maxlen=120)

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def close(self) -> None:
        if self._task:
            self._task.cancel()

    def waiting(self) -> int:
        return self._q.qsize()

    def snapshot(self) -> dict[str, Any]:
        return {"running": dict(self.current) if self.current else None,
                "waiting": sorted((dict(r) for r in self.waiting_jobs.values()), key=lambda r: (r["priority"], r["id"])),
                "recent": [dict(r) for r in reversed(self.recent)]}

    async def run(self, priority: int, label: str, job: Callable[[], Awaitable[Any]],
                  record: dict[str, Any] | None = None) -> Any:
        """``record``: what the overview shows about this job (kind, model_id, source, …); the caller may add to it
        after the job (audio seconds, real-time factor) — the record kept is the same dict."""
        fut = asyncio.get_running_loop().create_future()
        seq = next(self._seq)
        rec = record if record is not None else {}
        rec.update(id=seq, label=label, priority=priority, queued_at=time.time(), started_at=None, ended_at=None,
                   ok=None)
        rec.setdefault("source", "")
        self.waiting_jobs[seq] = rec
        self._q.put_nowait((priority, seq, label, job, fut))
        return await fut

    async def _loop(self) -> None:
        while True:
            _prio, seq, label, job, fut = await self._q.get()
            rec = self.waiting_jobs.pop(seq, {"id": seq, "label": label})
            if fut.cancelled():
                continue
            self.running = label
            self.current = rec
            rec["started_at"] = time.time()
            try:
                result = await job()
                rec["ok"] = True
                if not fut.cancelled():
                    fut.set_result(result)
            except Exception as e:  # noqa: BLE001 - the caller gets it
                rec.update(ok=False, error=str(e)[:200])
                if not fut.cancelled():
                    fut.set_exception(e)
            finally:
                rec["ended_at"] = time.time()
                self.recent.append(rec)
                self.running = ""
                self.current = None
            if self._q.empty():
                try:
                    await self.engines.trim()
                except Exception:  # noqa: BLE001
                    pass


def _wav_bytes(x, sr: int) -> bytes:
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, x, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class VoiceHost:
    def __init__(self, db, settings: VoiceSettings | None = None) -> None:
        self.s = settings or VoiceSettings.from_app()
        self.store = VoiceStore(db)
        self.installer = Installer(self.s, self.store)
        self.engines = EngineManager(self.s, self.installer.python_for, self.installer.worker_env)
        self.queue = GpuQueue(self.engines)
        self.voices = VoiceLibrary(self.s, self.store)
        self.history = HistoryStore(db, self.s.home / "history")
        self.batches = BatchStore(db)
        self.batch_runner = BatchRunner(self, self.batches)
        self.on_change: Callable[[str], None] = lambda what: None  # (every open window refetches: app/main.py)
        self.installer.on_change = lambda model_id: self.on_change(f"model:{model_id}")
        self._gate: tuple[float, G.Gate] | None = None
        self._started = False
        # the GPU over the last half hour (Voice Studio's overview): a sample every 5 s while someone looks, else 30 s
        self.series: collections.deque = collections.deque(maxlen=360)
        self._sampler: asyncio.Task | None = None
        self._watch_until = 0.0
        self._apply_settings()

    # -- lifecycle --------------------------------------------------------------------------------------------------
    async def start(self) -> None:
        if self.s.engine_mode == "off":
            return
        try:
            self.s.ensure_dirs()
        except OSError as e:
            log.warning("local voice: its folders can't be made: %s", e)
            return
        self.engines.start()
        self.queue.start()
        self._started = True
        stopped = self.batches.interrupted()
        if stopped:
            log.info("local voice: %d batch(es) a restart stopped can be resumed", len(stopped))
        self._sampler = asyncio.create_task(self._sample_loop())
        await asyncio.to_thread(self._prune_history)

    async def stop(self) -> None:
        await self.installer.close()
        if not self._started:
            return
        await self.batch_runner.close()
        if self._sampler:
            self._sampler.cancel()
        await self.queue.close()
        await self.engines.close()

    # -- settings Voice Studio can change -------------------------------------------------------------------------------
    def _apply_settings(self) -> None:
        for key, (kind, lo, hi) in RUNTIME.items():
            v = self.store.setting(f"runtime:{key}")
            if v is not None:
                try:
                    setattr(self.s, key, kind(min(hi, max(lo, kind(v)))))
                except (TypeError, ValueError):
                    pass

    def settings_doc(self) -> dict[str, Any]:
        base = VoiceSettings(home=self.s.home)
        return {"values": {k: getattr(self.s, k) for k in RUNTIME},
                "defaults": {k: getattr(base, k) for k in RUNTIME},
                "bounds": {k: [lo, hi] for k, (_, lo, hi) in RUNTIME.items()},
                "default_tts": self.store.setting("default:tts") or "", "default_stt": self.store.setting("default:stt") or "",
                "default_voice": self.store.setting("default:voice") or "",
                "paths": {"home": str(self.s.home), "models": str(self.s.models_dir), "runtimes": str(self.s.runtimes_dir),
                          "references": str(self.s.refs_dir), "history": str(self.history.root)},
                "engine_mode": self.s.engine_mode, "device": self.s.device, "hf_endpoint": self.s.hf_endpoint}

    def put_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        for key, (kind, lo, hi) in RUNTIME.items():
            if key not in patch:
                continue
            v = patch[key]
            if v is None:  # (back to the server's own value)
                self.store.put_setting(f"runtime:{key}", None)
                setattr(self.s, key, getattr(VoiceSettings(home=self.s.home), key))
                continue
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise VoiceError(f"{key} must be a number", code="bad_input")
            v = kind(min(hi, max(lo, v)))
            self.store.put_setting(f"runtime:{key}", v)
            setattr(self.s, key, v)
        for kind in ("tts", "stt"):
            k = f"default_{kind}"
            if k in patch:
                mid = str(patch[k] or "")
                if mid and (mid not in catalog.BY_ID or catalog.BY_ID[mid].kind != kind):
                    raise VoiceError(f"{mid} isn't a {kind} model", code="bad_input")
                self.store.put_setting(f"default:{kind}", mid or None)
        if "default_voice" in patch:
            vid = str(patch["default_voice"] or "")
            if vid and self.voices.get(vid) is None:
                raise VoiceError("No such profile", code="gone", status=404)
            self.store.put_setting("default:voice", vid or None)
        if any(k.startswith("history_") for k in patch):
            self._prune_history()
        self.on_change("settings")
        return self.settings_doc()

    def model_defaults(self, model_id: str) -> dict[str, Any]:
        spec = self._spec(model_id)
        return catalog.clean_params(spec, self.store.setting(f"model_defaults:{spec.id}") or {})

    def put_model_defaults(self, model_id: str, params: dict[str, Any] | None) -> dict[str, Any]:
        spec = self._spec(model_id)
        clean = catalog.clean_params(spec, params or {})
        self.store.put_setting(f"model_defaults:{spec.id}", clean or None)
        self.on_change(f"model:{spec.id}")
        return clean

    # -- what this machine can do -----------------------------------------------------------------------------------
    def gate(self, fresh: bool = False) -> G.Gate:
        if not fresh and self._gate and time.monotonic() - self._gate[0] < 5:
            return self._gate[1]
        g = G.check(self.s.engine_mode, self.s.device)
        self._gate = (time.monotonic(), g)
        return g

    def ready(self) -> bool:
        return self._started and self.gate().ok

    def _need_gate(self) -> None:
        g = self.gate()
        if not g.ok:
            raise VoiceError(g.message, code=g.code, status=409, data=g.to_dict())
        if not self._started:
            raise VoiceError("Local voice isn't running on this server", code="off", status=409)

    def installed(self, kind: str | None = None) -> list[str]:
        return [m.id for m in catalog.CATALOG if (kind is None or m.kind == kind) and self.installer.installed(m)]

    def default_model(self, kind: str) -> str:
        have = set(self.installed(kind))
        chosen = self.store.setting(f"default:{kind}")  # (Voice Studio → 설정: the user's pick, while installed)
        if chosen in have:
            return chosen
        for mid in (DEFAULT_TTS if kind == "tts" else DEFAULT_STT):
            if mid in have:
                return mid
        return next(iter(sorted(have)), "")

    def model_for(self, kind: str, chosen: str = "") -> str:
        """the model a mate uses: the one she chose while it is installed (and of that kind), else the default"""
        spec = catalog.BY_ID.get(chosen or "")
        if spec is not None and spec.kind == kind and self.installer.installed(spec):
            return spec.id
        return self.default_model(kind)

    def usable(self, kind: str) -> bool:
        """this server can speak (tts) / hear (stt) with a local model now"""
        return self.ready() and bool(self.installed(kind))

    # -- status for the UI ------------------------------------------------------------------------------------------
    def status(self, lang: str = "en") -> dict[str, Any]:
        g = self.gate()
        residents = {r["model_id"]: r for r in self.engines.status()}
        models = []
        for spec in catalog.CATALOG:
            d = spec.to_dict(lang)
            d.update(self.installer.status(spec))
            d["resident"] = residents.get(spec.id)
            d["need_bytes"] = self.installer.need_bytes(spec)
            models.append(d)
        gs = system.gpus()
        return {
            "gate": g.to_dict(),
            "running": self._started,
            "system": {
                "platform": system.platform_key(),
                "container": system.in_container(),
                "gpus": [x.to_dict() for x in gs],
                "memory": system.host_memory(),
                "cpu": system.cpu(),
                "disk": {"models": system.disk(self.s.models_dir), "runtimes": system.disk(self.s.runtimes_dir)},
            },
            "models": models,
            "runtimes": [{"name": r.name, "ready": self.installer.runtime_ready(r), "engines": list(r.engines)}
                         for r in RUNTIMES],
            "events": self.engines.events[-20:],
            "queue": {"running": self.queue.running, "waiting": self.queue.waiting()},
            "defaults": {"tts": self.default_model("tts"), "stt": self.default_model("stt"),
                         "voice": self.store.setting("default:voice") or ""},
            "settings": {"models_dir": str(self.s.models_dir), "runtimes_dir": str(self.s.runtimes_dir),
                         "vram_budget": self.s.vram_budget_fraction, "idle_unload_seconds": self.s.idle_unload_seconds,
                         "device": self.s.device, "engine_mode": self.s.engine_mode},
        }

    # -- models -----------------------------------------------------------------------------------------------------
    def _spec(self, model_id: str) -> catalog.ModelSpec:
        try:
            return catalog.get(model_id)
        except KeyError:
            raise VoiceError(f"No such model: {model_id}", code="unknown_model", status=404) from None

    def install(self, model_id: str, accept_license: bool) -> dict[str, Any]:
        spec = self._spec(model_id)
        self._need_gate()
        if not accept_license and not self.store.license_record(spec.id):
            raise VoiceError(f"Read and accept the license of {spec.name} first ({spec.license.name})",
                             code="license", status=409, data={"license": spec.to_dict()["license"]})
        if accept_license:
            self.store.accept_license(spec.id, spec.license.name, spec.license.url)
        p = self.installer.start(spec)
        self.on_change(f"model:{spec.id}")
        return p.to_dict()

    def cancel_install(self, model_id: str) -> bool:
        return self.installer.cancel(self._spec(model_id).id)

    async def remove(self, model_id: str) -> dict[str, Any]:
        spec = self._spec(model_id)
        if self.installer.busy(spec.id):
            raise VoiceError("It is being installed; cancel the install first", code="busy", status=409)
        if self.engines.residents.get(spec.id):
            await self.engines.unload(spec.id)
        out = await asyncio.to_thread(self.installer.remove, spec)
        self.on_change(f"model:{spec.id}")
        return out

    async def load(self, model_id: str, source: str = "settings") -> dict[str, Any]:
        spec = self._spec(model_id)
        self._need_gate()
        if not self.installer.installed(spec):
            raise VoiceError(f"{spec.name} isn't installed", code="not_installed", status=409)
        try:
            r = await self.queue.run(BACKGROUND, f"load {spec.id}", lambda: self.engines.load(spec.id),
                                     {"kind": "load", "model_id": spec.id, "source": source})
        except NoRoom as e:
            raise VoiceError(str(e), code="no_room", status=409, data=e.data) from None
        except WorkerError as e:
            raise VoiceError(str(e), code=e.kind, status=409 if e.kind == "user" else 500) from None
        self.on_change(f"model:{spec.id}")
        return r.describe()

    async def unload(self, model_id: str, park: bool = False) -> bool:
        spec = self._spec(model_id)
        try:
            done = await self.engines.unload(spec.id, park=park)
        except WorkerError as e:
            raise VoiceError(str(e), code="busy", status=409) from None
        self.on_change(f"model:{spec.id}")
        return done

    # -- a call keeps its models warm ---------------------------------------------------------------------------------
    def pin(self, model_id: str) -> None:
        if model_id in catalog.BY_ID:
            self.engines.pin(model_id)

    def unpin(self, model_id: str) -> None:
        if model_id in catalog.BY_ID:
            self.engines.unpin(model_id)

    async def prewarm(self, model_id: str, source: str = "call") -> None:
        """on the GPU before it is needed (a call ringing): best effort, never an error"""
        try:
            spec = catalog.get(model_id)
            if self.ready() and self.installer.installed(spec):
                await self.queue.run(INTERACTIVE, f"warm {spec.id}", lambda: self.engines.load(spec.id),
                                     {"kind": "warm", "model_id": spec.id, "source": source})
        except Exception as e:  # noqa: BLE001
            log.info("prewarm %s: %s", model_id, e)

    # -- speaking ---------------------------------------------------------------------------------------------------
    async def synthesize(self, model_id: str, text: str, *, reference: dict[str, Any] | None = None,
                         language: str = "auto", instruct: str = "", params: dict[str, Any] | None = None,
                         seed: int | None = None, priority: int = INTERACTIVE,
                         source: str = "") -> tuple[bytes, dict[str, Any]]:
        """One line (or a long text) in a voice → (WAV bytes, what it took). ``reference``: {path, text, language}
        (voices.resolve), or None for a model that can make a voice of its own (OmniVoice: auto / design). The model's
        default parameters (Voice Studio → 모델) are under ``params``; ``source``: who asked (the GPU job record)."""
        from . import audio
        import soundfile as sf

        spec = self._spec(model_id)
        if spec.kind != "tts":
            raise VoiceError(f"{spec.name} doesn't speak (it is a {spec.kind} model)", code="wrong_kind")
        self._need_gate()
        if not self.installer.installed(spec):
            raise VoiceError(f"{spec.name} isn't installed", code="not_installed", status=409)
        text = " ".join(str(text or "").split()) if "\n" not in str(text or "") else str(text).strip()
        if not text:
            raise VoiceError("Nothing to say", code="empty")
        if len(text) > self.s.max_text_chars:
            raise VoiceError(f"Too long (at most {self.s.max_text_chars} characters)", code="too_long")
        params = catalog.clean_params(spec, {**(self.store.setting(f"model_defaults:{spec.id}") or {}), **(params or {})})
        if language not in spec.languages:
            language = "auto"
        instruct = (instruct or "").strip()
        if instruct and not ({"design", "instruct"} & set(spec.features)):
            instruct = ""
        if reference is None and not ({"design", "auto_voice"} & set(spec.features)):
            raise VoiceError(f"{spec.name} speaks in a voice it is given: pick a voice (reference clips)",
                             code="needs_voice")
        if reference is not None and not (reference.get("text") or "").strip() and spec.engine == "omnivoice":
            raise VoiceError("OmniVoice clones from a clip with its transcript: this clip has none", code="needs_text")
        if reference is not None:  # (the worker takes the clip itself; which feeling it was is ours to know)
            reference = {k: reference[k] for k in ("path", "text", "language") if k in reference}
        engine = spec.engine if self.s.engine_mode != "fake" else "fake"
        strategy, batch = STRATEGY.get(engine, ("segments", 1))
        segments = [text] if strategy == "whole" else (textsplit.split(text) or [text])
        from app.services._ids import new_id

        tmp = self.s.tmp_dir / new_id("tts")
        tmp.mkdir(parents=True, exist_ok=True)
        t0 = time.perf_counter()
        info: dict[str, Any] = {}

        async def job() -> tuple[list, int]:
            r = await self.engines.acquire(spec.id)
            info["ready_seconds"] = round(time.perf_counter() - t0, 3)
            chunks, sr, gen = [], spec.sample_rate, 0.0
            try:
                groups = [segments[i:i + batch] for i in range(0, len(segments), batch)]
                for gi, group in enumerate(groups):
                    out = await r.worker.call(
                        "synthesize", timeout=900, text=group, language=language, reference=reference,
                        instruct=instruct, params=params, seed=None if seed is None else seed + gi,
                        out_prefix=str(tmp / f"g{gi}"))
                    gen += out["seconds"]
                    sr = out["sample_rate"]
                    for path in out["paths"]:
                        x, _ = sf.read(path, dtype="float32")
                        chunks.append(x)
                    r.last_memory = out.get("memory") or r.last_memory
                    r.host_rss = out.get("host_rss") or r.host_rss
                info["generate_seconds"] = round(gen, 3)
                info["device"] = r.device.get("name")
            finally:
                self.engines.release(r)
            return chunks, sr

        rec: dict[str, Any] = {"kind": "speak", "model_id": spec.id, "source": source, "chars": len(text)}
        try:
            chunks, sr = await self.queue.run(priority, f"speak {spec.id}", job, rec)
        except NoRoom as e:
            raise VoiceError(str(e), code="no_room", status=409, data=e.data) from None
        except WorkerError as e:
            if e.kind == "oom":
                raise VoiceError("The GPU ran out of memory for this text: shorter text, or unload another model",
                                 code="oom", status=409) from None
            raise VoiceError(str(e), code=e.kind if e.kind == "user" else "engine",
                             status=400 if e.kind == "user" else 502) from None
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        wav = audio.normalize(audio.concat(chunks, sr, gap=0.22))
        duration = len(wav) / sr if sr else 0
        info.update({"model_id": spec.id, "sample_rate": sr, "seconds": round(duration, 3), "segments": len(segments),
                     "elapsed": round(time.perf_counter() - t0, 3), "seed": seed, "params": params,
                     "language": language, "instruct": instruct,
                     "rtf": round(info.get("generate_seconds", 0) / duration, 3) if duration else None})
        rec.update(audio_seconds=info["seconds"], rtf=info["rtf"])
        return _wav_bytes(wav, sr), info

    # -- hearing ----------------------------------------------------------------------------------------------------
    async def transcribe(self, data: bytes, *, language: str = "auto", model_id: str = "",
                         priority: int = INTERACTIVE, source: str = "") -> dict[str, Any]:
        from . import audio
        from app.services._ids import new_id

        model_id = model_id or self.default_model("stt")
        if not model_id:
            raise VoiceError("No local speech recognition model is installed (Whisper)", code="not_installed",
                             status=409)
        spec = self._spec(model_id)
        self._need_gate()
        if not self.installer.installed(spec):
            raise VoiceError(f"{spec.name} isn't installed", code="not_installed", status=409)
        try:
            x, sr = audio.decode(data, 16000)
        except audio.AudioError as e:
            raise VoiceError(str(e), code="bad_audio") from None
        path = self.s.tmp_dir / f"{new_id('stt')}.wav"
        audio.write_wav(path, x, sr)
        t0 = time.perf_counter()

        async def job() -> dict[str, Any]:
            r = await self.engines.acquire(spec.id)
            try:
                return await r.worker.call("transcribe", timeout=600, path=str(path), language=language or "auto")
            finally:
                self.engines.release(r)

        try:
            out = await self.queue.run(priority, f"hear {spec.id}", job, {"kind": "hear", "model_id": spec.id,
                                                                            "source": source})
        except NoRoom as e:
            raise VoiceError(str(e), code="no_room", status=409, data=e.data) from None
        except WorkerError as e:
            raise VoiceError(str(e), code="engine", status=502) from None
        finally:
            path.unlink(missing_ok=True)
        return {"text": out.get("text", ""), "language": out.get("language", ""), "model_id": spec.id,
                "seconds": round(out.get("seconds", 0), 3), "elapsed": round(time.perf_counter() - t0, 3)}

    # -- voices -----------------------------------------------------------------------------------------------------
    async def add_reference(self, vid: str, data: bytes, *, label: str, transcript: str = "",
                            language: str = "", start: float | None = None, end: float | None = None,
                            replace: bool = True) -> dict[str, Any]:
        from . import audio

        try:
            ref = await asyncio.to_thread(self.voices.add_reference, vid, data, label=label, transcript=transcript,
                                          language=language, start=start, end=end, replace=replace)
        except audio.AudioError as e:
            raise VoiceError(str(e), code="bad_audio") from None
        except KeyError:
            raise VoiceError("No such voice", code="gone", status=404) from None
        except ValueError as e:
            raise VoiceError(str(e), code="bad_input") from None
        if not ref.get("transcript") and self.usable("stt"):
            # (the local Whisper writes what the clip says: cloning needs the exact words)
            try:
                f = self.s.refs_dir / ref["file"]
                heard = await self.transcribe(f.read_bytes(), language=ref.get("language") or "auto",
                                              priority=PREVIEW, source="studio")
                ref = self.store.update_reference(ref["id"], transcript=heard["text"]) or ref
            except VoiceError as e:
                log.info("reference transcript: %s", e)
        self.on_change("voices")
        return ref

    async def trim_reference(self, rid: str, start: float | None, end: float | None) -> dict[str, Any]:
        from . import audio

        try:
            ref = await asyncio.to_thread(self.voices.trim_reference, rid, start, end)
        except KeyError:
            raise VoiceError("No such clip", code="gone", status=404) from None
        except (ValueError, audio.AudioError) as e:
            raise VoiceError(str(e), code="bad_input") from None
        self.on_change("voices")
        return ref

    def duplicate_voice(self, vid: str, name: str = "") -> dict[str, Any]:
        try:
            v = self.voices.duplicate(vid, name)
        except KeyError:
            raise VoiceError("No such voice", code="gone", status=404) from None
        self.on_change("voices")
        return v

    def voice_id_for(self, profile: str | None) -> str:
        """a batch line's ``profile``: a voice's id, or its name (any case)"""
        p = str(profile or "").strip()
        if not p:
            return ""
        vs = self.voices.list()
        hit = next((v for v in vs if v["id"] == p), None) or next((v for v in vs if v["name"].lower() == p.lower()), None)
        if hit is None:
            raise VoiceError(f"No profile named {p}", code="gone", status=404)
        return hit["id"]

    # -- Voice Studio: a line made, kept in the history ----------------------------------------------------------------
    async def generate(self, *, model_id: str = "", text: str, voice_id: str = "", feeling: str = "neutral",
                       mode: str = "auto", language: str = "auto", instruct: str = "",
                       params: dict[str, Any] | None = None, seed: int | None = None, source: str = "studio",
                       batch_id: str = "", batch_index: int | None = None, priority: int = PREVIEW) -> dict[str, Any]:
        """A line in a profile's voice (``clone``: its clip of the feeling, else its neutral one), in a described voice
        (``design``: the instruction), or ``auto`` (the profile's clip when it has one, else the model's own voice) —
        then kept in the history with everything that made it. ``seed`` None: a random one, recorded."""
        model_id = model_id or self.default_model("tts")
        if not model_id:
            raise VoiceError("No speech model is installed", code="not_installed", status=409)
        spec = self._spec(model_id)
        feats = set(spec.features)
        voice = None
        if voice_id:
            voice = self.voices.get(voice_id)
            if voice is None:
                raise VoiceError("No such profile", code="gone", status=404)
        mode = mode if mode in MODES else "auto"
        reference = None
        if mode == "clone":
            if voice is None:
                raise VoiceError("Pick a profile to clone its voice", code="needs_voice")
            reference = self.voices.resolve(voice["id"], feeling)
            if reference is None:
                raise VoiceError("This profile has no clip yet", code="no_clip")
        elif mode == "design":
            if not ({"design", "instruct"} & feats):
                raise VoiceError(f"{spec.name} can't make a voice from a description", code="unsupported")
            if not (instruct or "").strip():
                raise VoiceError("Describe the voice to design it", code="needs_instruct")
        else:
            reference = self.voices.resolve(voice["id"], feeling) if voice else None
            if not (instruct or "").strip() and voice and voice.get("instruct") and reference is None:
                instruct = voice["instruct"]
        merged = dict(params or {})
        if voice and voice.get("default_model") == spec.id:
            merged = {**(voice.get("default_params") or {}), **merged}
        if seed is None:
            seed = random.randint(0, 2**31 - 1)
        wav, info = await self.synthesize(spec.id, text, reference=reference, language=language or "auto",
                                          instruct=instruct, params=merged, seed=int(seed), priority=priority,
                                          source=source)
        entry = self.history.add(wav, {
            "source": source, "model_id": spec.id, "voice_id": voice["id"] if voice else "",
            "voice_name": voice["name"] if voice else "", "feeling": feeling or "", "mode": mode,
            "ref_label": (reference or {}).get("label", ""), "language": info.get("language") or language or "auto",
            "text": text, "instruct": info.get("instruct") or "", "params": info.get("params") or {},
            "seed": info.get("seed"), "sample_rate": info.get("sample_rate"), "seconds": info.get("seconds"),
            "ready_seconds": info.get("ready_seconds"), "generate_seconds": info.get("generate_seconds"),
            "rtf": info.get("rtf"), "batch_id": batch_id, "batch_index": batch_index})
        await asyncio.to_thread(self._prune_history)
        self.on_change("history")
        entry["info"] = {k: info.get(k) for k in ("segments", "device", "elapsed")}
        return entry

    def _prune_history(self) -> int:
        return self.history.prune(int(self.s.history_max_entries), int(self.s.history_max_gb * _GIB))

    async def save_as_reference(self, hid: str, voice_id: str, label: str, transcript: str = "") -> dict[str, Any]:
        """a line from the history as one of a profile's clips (the user's own profiles: a built-in one is copied first)"""
        e = self.history.get(hid)
        if e is None:
            raise VoiceError("No such line in the history", code="gone", status=404)
        if voice_id.startswith("builtin:"):
            raise VoiceError("A built-in profile can't change: duplicate it first", code="builtin", status=409)
        f = self.history.path(e)
        if not f.is_file():
            raise VoiceError("Its audio is gone", code="gone", status=404)
        lang = e["language"] if e.get("language") not in ("", "auto") else ""
        return await self.add_reference(voice_id, f.read_bytes(), label=label, transcript=transcript or e["text"],
                                        language=lang)

    async def analyze(self, data: bytes, *, transcribe: bool = False, window: float = 10.0) -> dict[str, Any]:
        """a clip before it becomes a reference (Voice Studio → 도구): how it came, its level, silence and warnings,
        the best stretches to cut, and — with the local Whisper — its words and language"""
        from . import audio

        def work() -> dict[str, Any]:
            info = audio.probe(data)
            x, sr = audio.decode(data, audio.REF_SR)
            st = audio.stats(x, sr)
            return {"probe": info, "stats": st.to_dict(), "windows": audio.suggest_windows(x, sr, length=window)}

        try:
            out = await asyncio.to_thread(work)
        except audio.AudioError as e:
            raise VoiceError(str(e), code="bad_audio") from None
        out["transcript"] = None
        if transcribe and self.usable("stt"):
            out["transcript"] = await self.transcribe(data, priority=PREVIEW, source="studio")
        return out

    # -- Voice Studio: batches ------------------------------------------------------------------------------------------
    def create_batch(self, *, label: str, settings: dict[str, Any], content: str, fmt: str) -> dict[str, Any]:
        self._need_gate()
        try:
            lines = parse_batch(content, fmt)
        except BatchInputError as e:
            raise VoiceError(str(e), code="bad_input") from None
        if not lines:
            raise VoiceError("No lines to make", code="empty")
        too_long = next((i for i, x in enumerate(lines) if len(x["text"]) > self.s.max_text_chars), None)
        if too_long is not None:
            raise VoiceError(f"Line {too_long + 1} is longer than {self.s.max_text_chars} characters", code="too_long")
        for x in lines:  # (a profile a line names must exist before anything runs)
            if x.get("profile"):
                self.voice_id_for(x["profile"])
            if x.get("model") and x["model"] not in catalog.BY_ID:
                raise VoiceError(f"No model {x['model']}", code="unknown_model")
        keep = {k: settings.get(k) for k in ("model_id", "voice_id", "feeling", "mode", "language", "instruct",
                                             "params", "seed") if settings.get(k) not in (None, "")}
        b = self.batches.create(label or "", keep, lines)
        self.batch_runner.start(b["id"])
        self.on_change(f"batch:{b['id']}")
        return b

    def batch(self, bid: str) -> dict[str, Any]:
        b = self.batches.get(bid, items=True)
        if b is None:
            raise VoiceError("No such batch", code="gone", status=404)
        return b

    def retry_batch(self, bid: str, failed_only: bool = True) -> dict[str, Any]:
        b = self.batch(bid)
        if bid in self.batch_runner.running():
            raise VoiceError("It is still running", code="busy", status=409)
        for it in b["items"]:
            if it["state"] == "failed" or (not failed_only and it["state"] != "done"):
                self.batches.set_item(bid, it["idx"], state="queued", error="")
        self.batches.set(bid, state="queued", finished_at=None)
        self.batch_runner.start(bid)
        return self.batch(bid)

    async def delete_batch(self, bid: str) -> bool:
        self.batch(bid)
        if bid in self.batch_runner.running():
            self.batch_runner.cancel(bid)
            for _ in range(100):
                if bid not in self.batch_runner.running():
                    break
                await asyncio.sleep(0.1)
        n = await asyncio.to_thread(self.history.delete_batch, bid)
        self.batches.delete(bid)
        self.on_change(f"batch:{bid}")
        return n >= 0

    # -- Voice Studio: what the GPU is doing ------------------------------------------------------------------------
    def _our_pids(self) -> dict[int, str]:
        return {r.worker.pid: r.spec.id for r in self.engines.residents.values() if r.worker.pid}

    def _sample(self) -> list[dict[str, Any]]:
        tel = {t["index"]: t for t in system.telemetry()}
        ours = self._our_pids()
        mine: dict[int, int] = {}
        for a in system.gpu_apps():
            if a["pid"] in ours:
                mine[a["gpu"]] = mine.get(a["gpu"], 0) + a["used"]
        now = time.time()
        return [{"t": round(now, 1), "gpu": g.index, "util": tel.get(g.index, {}).get("util"), "used": g.used,
                 "temperature": tel.get(g.index, {}).get("temperature"), "power": tel.get(g.index, {}).get("power"),
                 "ours": mine.get(g.index, 0)} for g in system.gpus(max_age=0.0)]

    async def _sample_loop(self) -> None:
        while True:
            try:
                if self.gate().ok and self.s.engine_mode == "real":
                    for x in await asyncio.to_thread(self._sample):
                        self.series.append(x)
            except Exception as e:  # noqa: BLE001 - a sample missed is no matter
                log.debug("gpu sample: %s", e)
            await asyncio.sleep(5 if time.monotonic() < self._watch_until else 30)

    def overview(self, lang: str = "en") -> dict[str, Any]:
        """Voice Studio's 개요: each GPU (load, temperature, power, clock) and whose its memory is — this app's models
        (each worker, measured), other programs the driver shows, and what no process here accounts for (the host's
        display, other containers) — the models on it, the GPU queue (running, waiting, recent: for whom), events."""
        self._watch_until = time.monotonic() + 120
        g = self.gate()
        tel = {t["index"]: t for t in system.telemetry()}
        apps = system.gpu_apps()
        ours = self._our_pids()
        names = {m.id: m.name for m in catalog.CATALOG}
        gpus = []
        for x in system.gpus(max_age=1.0):
            mine = [{"model_id": ours[a["pid"]], "name": names.get(ours[a["pid"]], ours[a["pid"]]), "pid": a["pid"],
                     "bytes": a["used"]} for a in apps if a["gpu"] == x.index and a["pid"] in ours]
            others = [{"pid": a["pid"], "name": a["name"], "bytes": a["used"]} for a in apps
                      if a["gpu"] == x.index and a["pid"] not in ours]
            seen = sum(m["bytes"] for m in mine) + sum(o["bytes"] for o in others)
            gpus.append({**x.to_dict(), **{k: v for k, v in tel.get(x.index, {}).items() if k != "index"},
                         "usage": {"ours": mine, "others": others, "unseen": max(0, x.used - seen)}})
        residents = []
        for r in self.engines.status():
            spec = catalog.BY_ID.get(r["model_id"])
            residents.append({**r, "name": names.get(r["model_id"], r["model_id"]), "kind": spec.kind if spec else ""})
        return {
            "gate": g.to_dict(), "running": self._started, "gpus": gpus,
            "series": list(self.series),
            "residents": residents,
            "queue": self.queue.snapshot(),
            "events": self.engines.events[-50:][::-1],
            "host": {"memory": system.host_memory(), "cpu": system.cpu(),
                     "disk": {"models": system.disk(self.s.models_dir), "history": system.disk(self.history.root
                                                                                                 if self.history.root.exists()
                                                                                                 else self.s.home)}},
            "history": self.history.usage(),
            "batches": {"running": self.batch_runner.running()},
            "settings": {k: getattr(self.s, k) for k in RUNTIME},
        }

