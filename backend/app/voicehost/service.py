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
import io
import itertools
import logging
import shutil
import time
from typing import Any, Awaitable, Callable

from . import catalog, gate as G, system, textsplit
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


class VoiceError(Exception):
    """a request local voice can't serve: ``code`` for the UI (no_gpu, not_installed, license, no_room, …)"""

    def __init__(self, message: str, code: str = "error", status: int = 400, data: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.data = data or {}


class GpuQueue:
    """One GPU job at a time (they would only compete for memory and slow each other down). Waiting jobs go by
    priority — a mate's words, then a preview, then a load — and in order of arrival within one."""

    def __init__(self, engines: EngineManager) -> None:
        self.engines = engines
        self._q: asyncio.PriorityQueue = asyncio.PriorityQueue()
        self._seq = itertools.count()
        self._task: asyncio.Task | None = None
        self.running: str = ""

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def close(self) -> None:
        if self._task:
            self._task.cancel()

    def waiting(self) -> int:
        return self._q.qsize()

    async def run(self, priority: int, label: str, job: Callable[[], Awaitable[Any]]) -> Any:
        fut = asyncio.get_running_loop().create_future()
        self._q.put_nowait((priority, next(self._seq), label, job, fut))
        return await fut

    async def _loop(self) -> None:
        while True:
            _prio, _seq, label, job, fut = await self._q.get()
            if fut.cancelled():
                continue
            self.running = label
            try:
                result = await job()
                if not fut.cancelled():
                    fut.set_result(result)
            except Exception as e:  # noqa: BLE001 - the caller gets it
                if not fut.cancelled():
                    fut.set_exception(e)
            finally:
                self.running = ""
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
        self.on_change: Callable[[str], None] = lambda what: None  # (every open window refetches: app/main.py)
        self.installer.on_change = lambda model_id: self.on_change(f"model:{model_id}")
        self._gate: tuple[float, G.Gate] | None = None
        self._started = False

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

    async def stop(self) -> None:
        await self.installer.close()
        if not self._started:
            return
        await self.queue.close()
        await self.engines.close()

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
            "defaults": {"tts": self.default_model("tts"), "stt": self.default_model("stt")},
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

    async def load(self, model_id: str) -> dict[str, Any]:
        spec = self._spec(model_id)
        self._need_gate()
        if not self.installer.installed(spec):
            raise VoiceError(f"{spec.name} isn't installed", code="not_installed", status=409)
        try:
            r = await self.queue.run(BACKGROUND, f"load {spec.id}", lambda: self.engines.load(spec.id))
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

    async def prewarm(self, model_id: str) -> None:
        """on the GPU before it is needed (a call ringing): best effort, never an error"""
        try:
            spec = catalog.get(model_id)
            if self.ready() and self.installer.installed(spec):
                await self.queue.run(INTERACTIVE, f"warm {spec.id}", lambda: self.engines.load(spec.id))
        except Exception as e:  # noqa: BLE001
            log.info("prewarm %s: %s", model_id, e)

    # -- speaking ---------------------------------------------------------------------------------------------------
    async def synthesize(self, model_id: str, text: str, *, reference: dict[str, Any] | None = None,
                         language: str = "auto", instruct: str = "", params: dict[str, Any] | None = None,
                         seed: int | None = None, priority: int = INTERACTIVE) -> tuple[bytes, dict[str, Any]]:
        """One line (or a long text) in a voice → (WAV bytes, what it took). ``reference``: {path, text, language}
        (voices.resolve), or None for a model that can make a voice of its own (OmniVoice: auto / design)."""
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
        params = catalog.clean_params(spec, params or {})
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

        try:
            chunks, sr = await self.queue.run(priority, f"speak {spec.id}", job)
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
                     "elapsed": round(time.perf_counter() - t0, 3),
                     "rtf": round(info.get("generate_seconds", 0) / duration, 3) if duration else None})
        return _wav_bytes(wav, sr), info

    # -- hearing ----------------------------------------------------------------------------------------------------
    async def transcribe(self, data: bytes, *, language: str = "auto", model_id: str = "",
                         priority: int = INTERACTIVE) -> dict[str, Any]:
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
            out = await self.queue.run(priority, f"hear {spec.id}", job)
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
                            language: str = "") -> dict[str, Any]:
        from . import audio

        try:
            ref = await asyncio.to_thread(self.voices.add_reference, vid, data, label=label, transcript=transcript,
                                          language=language)
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
                                              priority=PREVIEW)
                ref = self.store.update_reference(ref["id"], transcript=heard["text"]) or ref
            except VoiceError as e:
                log.info("reference transcript: %s", e)
        self.on_change("voices")
        return ref
