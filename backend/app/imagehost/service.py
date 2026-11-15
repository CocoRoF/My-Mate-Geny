"""Local image models, served from this machine's GPU — one service for the app (docs/local-image.md).

    ImageHost
      ├─ gate        can this machine run the engine (an NVIDIA GPU, a CUDA 13 driver, …): refused up front
      ├─ installer   ComfyUI (pinned, upstream) + its locked environment + the weights, after the license is accepted
      ├─ engine      ComfyUI as a process of its own, started for a job and stopped when idle (its VRAM goes back
      │              to the voice models); a stand-in for tests
      ├─ jobs        one at a time (they would only fight over the GPU): draft · edit · loop · cutout · matte, each
      │              kept in the history with what was asked and what came out
      └─ settings    which model each use takes, a recipe's knobs, the idle time — Image Studio sets them, the avatar
                     maker uses them

Image Studio (Settings → 로컬 모델 호스팅) only sets things up and tries them; the avatar maker is where they are used:
each of its stages runs here when the user picks the local engine for it (app/avatar/local.py).
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.services._ids import now_iso as _now
from app.voicehost import system

from . import catalog, gate as G
from .comfy import ComfyError
from .engines import ComfyEngine, FakeEngine, media
from .installer import Installer
from .settings import ImageSettings
from .store import ImageStore

log = logging.getLogger("app.imagehost")

#: a model file that failed to load once — ComfyUI's fast loader (comfy_aimdo) reads it straight to the GPU, and a read
#: can fail while the disk is busy (another model being downloaded): the same job right after runs fine, so it is run
#: once more before it counts as failed
TRANSIENT = ("hostbuf_file_reader_read failed", "HostBuffer allocation failed", "HostBuffer.read_file_slice failed")
RETRY_AFTER = 2.0


def transient(e: Exception) -> bool:
    return isinstance(e, ComfyError) and e.kind == "failed" and any(t in str(e) for t in TRANSIENT)

KINDS = ("draft", "edit", "loop", "cutout", "matte")
USE_OF = {"draft": "draft", "edit": "edit", "loop": "loop", "cutout": "cutout", "matte": "cutout"}
# the avatar maker's stages and the use each needs here
AVATAR_STAGES = {"design": "draft", "home": "cutout", "stills": "edit", "clips": "loop", "matte": "cutout"}
RUNTIME = {"idle_stop_seconds": (float, 0, 86400), "history_max_entries": (int, 20, 100000),
           "voice_room_gb": (float, -1, 16)}
GiB = 1 << 30


class ImageError(Exception):
    """a request the image engine can't serve: ``code`` for the UI (no_gpu, not_installed, license, busy, …)"""

    def __init__(self, message: str, code: str = "error", status: int = 400, data: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.data = data or {}


class Canceled(Exception):
    pass


def _files(d: Path) -> list[dict[str, Any]]:
    kinds = {".png": "image", ".jpg": "image", ".webp": "image", ".mp4": "video", ".webm": "video"}
    return [{"name": f.name, "kind": kinds.get(f.suffix.lower(), "file"), "bytes": f.stat().st_size}
            for f in sorted(d.iterdir()) if f.is_file() and not f.name.startswith(("in-", "."))]


class ImageHost:
    def __init__(self, db, settings: ImageSettings | None = None) -> None:
        self.s = settings or ImageSettings.from_app()
        self.store = ImageStore(db)
        self.installer = Installer(self.s)
        self.engine: ComfyEngine | FakeEngine = (
            FakeEngine(self.s) if self.s.engine_mode == "fake"
            else ComfyEngine(self.s, self.installer.python, lambda: self.installer.comfy_dir))
        self.on_change: Callable[[str], None] = lambda what: None
        self.installer.on_change = lambda model_id: self.on_change(f"model:{model_id}")
        # others on the GPU asked to make room before a job: (bytes needed) → None (the voice models: app/main.py)
        self.make_room: list[Callable[[int], Awaitable[None]]] = []
        # … and the room the engine leaves them while it runs (bytes; app/main.py: VoiceHost.room_for_speech)
        self.voice_room: Callable[[], int] = lambda: 0
        if isinstance(self.engine, ComfyEngine):
            self.engine.voice_room = lambda: self.voice_room()
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._done: dict[str, asyncio.Event] = {}
        self._canceled: set[str] = set()
        self._worker: asyncio.Task | None = None
        self._started = False
        self._gate: tuple[float, G.ImageGate] | None = None
        self.live: dict[str, dict[str, Any]] = {}  # the running job's progress (not stored)
        self._last_ping = 0.0
        self._apply_settings()

    # -- lifecycle --------------------------------------------------------------------------------------------------
    async def start(self) -> None:
        if self.s.engine_mode == "off":
            return
        try:
            self.s.ensure_dirs()
        except OSError as e:
            log.warning("local image: its folders can't be made: %s", e)
            return
        for j in self.store.unfinished():  # (a restart stopped them: their caller will ask again)
            self.store.update_job(j["id"], state="failed", error="interrupted by a restart", ended_at=_now())
        try:
            await asyncio.to_thread(self.engine.reap)
        except Exception:  # noqa: BLE001 - best effort
            log.exception("local image: reaping an old engine")
        self._worker = asyncio.create_task(self._loop())
        self._started = True

    async def stop(self) -> None:
        await self.installer.close()
        if self._worker:
            self._worker.cancel()
        await self.engine.stop()

    # -- settings ---------------------------------------------------------------------------------------------------
    def _apply_settings(self) -> None:
        self._server_values = {k: getattr(self.s, k, None) for k in RUNTIME}
        self._server_values["history_max_entries"] = 500
        self.history_max_entries = 500
        for key, (kind, lo, hi) in RUNTIME.items():
            v = self.store.setting(f"runtime:{key}")
            if v is None:
                continue
            try:
                self._set(key, kind(min(hi, max(lo, kind(v)))))
            except (TypeError, ValueError):
                pass

    def _set(self, key: str, v: Any) -> None:
        if key == "history_max_entries":
            self.history_max_entries = int(v)
        else:
            setattr(self.s, key, v)

    def _get(self, key: str) -> Any:
        return self.history_max_entries if key == "history_max_entries" else getattr(self.s, key)

    def settings_doc(self) -> dict[str, Any]:
        return {"values": {k: self._get(k) for k in RUNTIME}, "defaults": dict(self._server_values),
                "bounds": {k: [lo, hi] for k, (_, lo, hi) in RUNTIME.items()},
                "models": {u: self.store.setting(f"default:{u}") or "" for u in catalog.USES},
                "recipes": {r.id: self.recipe_params(r.id) for r in catalog.RECIPES},
                "avatar": self.avatar_defaults(),
                "paths": {"home": str(self.s.home), "models": str(self.s.models_dir),
                          "engine": str(self.s.runtime_dir), "history": str(self.s.history_dir)},
                "engine_mode": self.s.engine_mode, "device": self.s.device}

    def put_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        for key, (kind, lo, hi) in RUNTIME.items():
            if key not in patch:
                continue
            v = patch[key]
            if v is None:
                self.store.put_setting(f"runtime:{key}", None)
                self._set(key, self._server_values[key])
                continue
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ImageError(f"{key} must be a number", code="bad_input")
            v = kind(min(hi, max(lo, v)))
            self.store.put_setting(f"runtime:{key}", v)
            self._set(key, v)
        for use, mid in (patch.get("models") or {}).items():
            if use not in catalog.USES:
                raise ImageError(f"no such use: {use}", code="bad_input")
            mid = str(mid or "")
            if mid and (mid not in catalog.BY_ID or use not in catalog.BY_ID[mid].uses):
                raise ImageError(f"{mid} can't be used for {use}", code="bad_input")
            self.store.put_setting(f"default:{use}", mid or None)
        for rid, params in (patch.get("recipes") or {}).items():
            r = catalog.RECIPE_BY_ID.get(rid)
            if r is None:
                raise ImageError(f"no such recipe: {rid}", code="bad_input")
            self.store.put_setting(f"recipe:{rid}", catalog.clean_params(r, params) if params else None)
        if "avatar" in patch:
            av = patch["avatar"] or {}
            clean = {k: v for k, v in av.items() if k in AVATAR_STAGES and v in ("local", "higgsfield")}
            self.store.put_setting("avatar:engines", clean or None)
        if "history_max_entries" in patch:
            self._prune()
        self.on_change("settings")
        return self.settings_doc()

    def recipe_params(self, rid: str) -> dict[str, Any]:
        r = catalog.RECIPE_BY_ID[rid]
        return catalog.clean_params(r, self.store.setting(f"recipe:{rid}") or {})

    # -- what this machine can do -----------------------------------------------------------------------------------
    def gate(self, fresh: bool = False) -> G.ImageGate:
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
            raise ImageError(g.message, code=g.code, status=409, data=g.to_dict())
        if not self._started:
            raise ImageError("Local image models aren't running on this server", code="off", status=409)

    def installed(self, use: str | None = None) -> list[str]:
        return [m.id for m in catalog.CATALOG if (use is None or use in m.uses) and self.installer.installed(m)]

    def model_for(self, use: str, chosen: str = "") -> str:
        """the model a use takes: the one asked for while it is installed, else the one set in Image Studio, else the
        first installed in the recipes' order"""
        have = set(self.installed(use))
        for mid in (chosen, self.store.setting(f"default:{use}") or ""):
            if mid in have:
                return mid
        order = [mid for r in catalog.RECIPES if r.use == use for mid in r.models]
        return next((mid for mid in order if mid in have), next(iter(sorted(have)), ""))

    def usable(self, use: str) -> bool:
        return self.ready() and bool(self.model_for(use))

    def avatar_defaults(self) -> dict[str, str]:
        return dict(self.store.setting("avatar:engines") or {})

    def avatar_engines(self, lang: str = "en") -> dict[str, Any]:
        """for the avatar maker's estimate: each stage — can it run here, on which model, what the user chose"""
        chosen = self.avatar_defaults()
        out = {}
        for stage, use in AVATAR_STAGES.items():
            mid = self.model_for(use) if self.ready() else ""
            m = catalog.BY_ID.get(mid)
            out[stage] = {"use": use, "ready": bool(mid), "model": mid, "model_name": m.name if m else "",
                          "seconds": m.seconds.get(lang) if m else "",
                          "default": chosen.get(stage) or ("local" if mid else "higgsfield")}
        return {"available": self.ready(), "gate": self.gate().code, "stages": out}

    # -- status for the UI ------------------------------------------------------------------------------------------
    def status(self, lang: str = "en") -> dict[str, Any]:
        models = []
        for m in catalog.CATALOG:
            d = m.to_dict(lang)
            d.update(self.installer.status(m))
            d["license_accepted"] = self.store.license_record(m.id)
            models.append(d)
        recipes = []
        for r in catalog.RECIPES:
            d = r.to_dict(lang)
            d["model"] = self.model_for(r.use)
            d["ready"] = bool(d["model"]) and self.ready()
            d["values"] = self.recipe_params(r.id)
            recipes.append(d)
        gs = system.gpus()
        return {
            "gate": self.gate().to_dict(),
            "running": self._started,
            "engine": {**self.engine.describe(), "installed": self.installer.engine_ready(),
                       "version": "ComfyUI 0.45.0", "vram": self._engine_vram()},
            "system": {"platform": system.platform_key(), "container": system.in_container(),
                       "gpus": [x.to_dict() for x in gs], "memory": system.host_memory(),
                       "disk": {"models": system.disk(self.s.models_dir)}},
            "models": models,
            "recipes": recipes,
            "defaults": {u: self.model_for(u) for u in catalog.USES},
            "queue": self.queue_snapshot(),
            "avatar": self.avatar_engines(lang),
        }

    def _engine_vram(self) -> int | None:
        pid = self.engine.pid()
        if not pid:
            return None
        held = system.gpu_processes()
        return held.get(pid)

    def queue_snapshot(self) -> dict[str, Any]:
        running = next(iter(self.live.items()), None)
        return {"running": {"id": running[0], **running[1]} if running else None, "waiting": self._queue.qsize()}

    # -- models -----------------------------------------------------------------------------------------------------
    def _model(self, model_id: str) -> catalog.ImageModel:
        m = catalog.BY_ID.get(model_id)
        if m is None:
            raise ImageError(f"No such model: {model_id}", code="unknown_model", status=404)
        return m

    def install(self, model_id: str, accept_license: bool) -> dict[str, Any]:
        m = self._model(model_id)
        self._need_gate()
        if not accept_license and not self.store.license_record(m.id):
            raise ImageError(f"Read and accept the license of {m.name} first ({m.license.name})", code="license",
                             status=409, data={"license": m.to_dict()["license"]})
        if accept_license:
            self.store.accept_license(m.id, m.license.name, m.license.url)
        p = self.installer.start(m)
        self.on_change(f"model:{m.id}")
        return p.to_dict()

    def cancel_install(self, model_id: str) -> bool:
        return self.installer.cancel(self._model(model_id).id)

    async def remove(self, model_id: str) -> dict[str, Any]:
        m = self._model(model_id)
        if self.installer.busy(m.id):
            raise ImageError("It is being installed; cancel the install first", code="busy", status=409)
        if self.live:
            raise ImageError("A job is running; try again when it is done", code="busy", status=409)
        await self.engine.free()
        freed = await asyncio.to_thread(self.installer.remove, m)
        self.on_change(f"model:{m.id}")
        return {"freed": freed}

    async def stop_engine(self) -> bool:
        if self.engine.busy():
            raise ImageError("A job is running", code="busy", status=409)
        await self.engine.stop()
        self.on_change("engine")
        return True

    async def release_gpu(self) -> bool:
        """another model needs the GPU: the engine stops if it is idle (→ whether it gave anything back)"""
        if not self.engine.running() or self.engine.busy() or self.live:
            return False
        await self.engine.stop()
        self.on_change("engine")
        return True

    # -- jobs -------------------------------------------------------------------------------------------------------
    def submit(self, kind: str, *, inputs: dict[str, Any], params: dict[str, Any] | None = None, source: str = "studio",
               model_id: str = "") -> dict[str, Any]:
        """a job into the queue → its record (``wait`` for the result). Inputs are files (paths) and text; the files
        are copied into the job's folder, so the history keeps what it was made from."""
        if kind not in KINDS:
            raise ImageError(f"no such job: {kind}", code="bad_input")
        self._need_gate()
        use = USE_OF[kind]
        mid = self.model_for(use, model_id)
        if not mid:
            raise ImageError(f"No model for {use} is installed (Image Studio → Models)", code="not_installed",
                             status=409, data={"use": use})
        clean_in: dict[str, Any] = {}
        files: dict[str, Path] = {}
        for k, v in (inputs or {}).items():
            if k in ("image", "end_image", "clip", "original") and v:
                p = Path(str(v))
                if not p.is_file():
                    raise ImageError(f"{k}: no such file", code="bad_input")
                files[k] = p
                clean_in[k] = p.name
            elif k == "refs":
                ps = [Path(str(x)) for x in (v or [])][:3]
                for i, p in enumerate(ps):
                    if not p.is_file():
                        raise ImageError("refs: no such file", code="bad_input")
                    files[f"ref{i}"] = p
                clean_in["refs"] = [p.name for p in ps]
            elif k in ("prompt", "negative"):
                clean_in[k] = str(v or "")[:4000]
            elif k in ("box", "exclude") and v:
                clean_in[k] = [int(x) for x in list(v)[:4]]
        need = {"draft": ("prompt",), "edit": ("image", "prompt"), "loop": ("image", "prompt"), "cutout": ("image",),
                "matte": ("clip",)}[kind]
        missing = [k for k in need if not clean_in.get(k)]
        if missing:
            raise ImageError("missing: " + ", ".join(missing), code="bad_input")
        job = self.store.add_job(kind=kind, recipe=kind if kind in catalog.RECIPE_BY_ID else "cutout", model_id=mid,
                                 source=source[:80], inputs=clean_in, params=dict(params or {}))
        d = self.s.history_dir / job["id"]
        d.mkdir(parents=True, exist_ok=True)
        for k, p in files.items():
            shutil.copyfile(p, d / f"in-{k}{p.suffix.lower()}")
        self._done[job["id"]] = asyncio.Event()
        self._queue.put_nowait(job["id"])
        self.on_change(f"job:{job['id']}")
        return job

    async def wait(self, jid: str, timeout: float = 7200) -> dict[str, Any]:
        ev = self._done.get(jid)
        if ev is not None:
            try:
                await asyncio.wait_for(ev.wait(), timeout)
            except asyncio.TimeoutError:
                raise ImageError("the job is taking too long", code="timeout", status=504) from None
        job = self.store.job(jid)
        if job is None:
            raise ImageError("No such job", code="gone", status=404)
        return job

    async def run(self, kind: str, **kw: Any) -> dict[str, Any]:
        return await self.wait(self.submit(kind, **kw)["id"])

    async def cancel(self, jid: str) -> bool:
        job = self.store.job(jid)
        if job is None or job["state"] not in ("queued", "running"):
            return False
        self._canceled.add(jid)
        if job["state"] == "running":
            await self.engine.interrupt()
        return True

    def job(self, jid: str) -> dict[str, Any] | None:
        j = self.store.job(jid)
        if j is not None and jid in self.live:
            j["live"] = self.live[jid]
        return j

    def job_file(self, jid: str, name: str) -> Path | None:
        if "/" in name or "\\" in name or name.startswith("."):
            return None
        p = self.s.history_dir / jid / name
        return p if p.is_file() else None

    def delete_jobs(self, ids: list[str]) -> list[str]:
        gone = self.store.delete_jobs(ids)
        for jid in gone:
            shutil.rmtree(self.s.history_dir / jid, ignore_errors=True)
        if gone:
            self.on_change("history")
        return gone

    def _prune(self) -> int:
        old = self.store.oldest_unstarred(self.history_max_entries)
        return len(self.delete_jobs(old)) if old else 0

    async def _loop(self) -> None:
        while True:
            jid = await self._queue.get()
            try:
                await self._one(jid)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the loop must survive anything
                log.exception("image job %s", jid)
            finally:
                self.live.pop(jid, None)
                ev = self._done.pop(jid, None)
                if ev:
                    ev.set()
                self.on_change(f"job:{jid}")
            if self._queue.empty():
                await asyncio.to_thread(self._prune)

    async def _one(self, jid: str) -> None:
        job = self.store.job(jid)
        if job is None:
            return
        if jid in self._canceled:
            self._canceled.discard(jid)
            self.store.update_job(jid, state="canceled", error="canceled", ended_at=_now())
            return
        t0 = time.time()
        self.store.update_job(jid, state="running", started_at=_now())
        self.live[jid] = {"kind": job["kind"], "model_id": job["model_id"], "source": job["source"], "step": "starting",
                          "value": 0, "max": 0, "started": t0}
        self.on_change(f"job:{jid}")
        try:
            m = catalog.get(job["model_id"])
            if isinstance(self.engine, ComfyEngine):
                await self._room(m)
            try:
                params, extra = await self._execute(job, m)
            except ComfyError as e:
                if not transient(e) or jid in self._canceled:
                    raise
                log.warning("image job %s: %s — running it once more", jid, e)
                await asyncio.sleep(RETRY_AFTER)
                params, extra = await self._execute(job, m)
            if jid in self._canceled:
                raise Canceled()
            self.store.update_job(jid, state="done", outputs=_files(self.s.history_dir / jid), seconds=round(time.time() - t0, 1),
                                  ended_at=_now(), params={**job["params"], **params, "result": extra})
        except Canceled:
            self.store.update_job(jid, state="canceled", error="canceled", ended_at=_now(),
                                  seconds=round(time.time() - t0, 1))
        except Exception as e:  # noqa: BLE001 - whatever went wrong, the job ends failed (never left "running")
            code = e.kind if isinstance(e, ComfyError) else "failed"
            msg = str(e) if not isinstance(e, ComfyError) or e.kind != "oom" else (
                "The GPU ran out of memory for this job: close other programs that use it, or try a smaller size.")
            log.warning("image job %s failed (%s): %s", jid, code, e)
            self.store.update_job(jid, state="failed", error=f"[{code}] {msg}"[:600], ended_at=_now(),
                                  seconds=round(time.time() - t0, 1))
        finally:
            self._canceled.discard(jid)

    async def _room(self, m: catalog.ImageModel) -> None:
        """the voice models move out of the way first (those a call holds stay)"""
        need = int((m.vram_gb or 4) * GiB) - int(self.engine.reserve_gb * GiB) if isinstance(self.engine, ComfyEngine) \
            else int((m.vram_gb or 4) * GiB)
        need = max(int(2 * GiB), need)  # (what is left to the voice models stays: the engine offloads the rest)
        for ask in self.make_room:
            try:
                await ask(need)
            except Exception as e:  # noqa: BLE001 - best effort: ComfyUI offloads what doesn't fit
                log.info("image job: room on the GPU: %s", e)

    def _progress(self, jid: str, step: str):
        def cb(p) -> None:
            live = self.live.get(jid)
            if live is None:
                return
            live.update(step=step, value=p.value, max=p.max, node=p.node)
            now = time.time()
            if now - self._last_ping > 1.0:
                self._last_ping = now
                self.on_change(f"job:{jid}")
        return cb

    def _step(self, jid: str, step: str) -> None:
        if jid in self.live:
            self.live[jid].update(step=step, value=0, max=0)
            self.on_change(f"job:{jid}")

    async def _execute(self, job: dict[str, Any], m: catalog.ImageModel) -> tuple[dict[str, Any], dict[str, Any]]:
        jid, kind, inp, prm = job["id"], job["kind"], job["inputs"], job["params"]
        d = self.s.history_dir / jid
        src = {p.stem[3:]: p for p in d.glob("in-*")}
        py = self.engine.media_python()
        prefix = f"geny/{jid}"
        if kind == "draft":
            rp = self.recipe_params("draft")
            steps = int(prm.get("steps") or rp.get("steps") or m.defaults.get("steps", 30))
            cfg = float(prm.get("cfg") or rp.get("cfg") or m.defaults.get("cfg", 5.0))
            w, h = int(prm.get("width") or 832), int(prm.get("height") or 1216)
            count = max(1, min(8, int(prm.get("count") or 1)))
            seed = prm.get("seed")
            self._step(jid, "drawing")
            files = await self.engine.draft(m, prompt=inp["prompt"], negative=inp.get("negative", ""), width=w,
                                            height=h, steps=steps, cfg=cfg, seed=None if seed is None else int(seed),
                                            count=count, prefix=prefix, on_progress=self._progress(jid, "drawing"))
            for i, f in enumerate(files, 1):
                shutil.move(str(f), d / f"{i}.png")
            return {"steps": steps, "cfg": cfg, "width": w, "height": h, "count": count}, {"pictures": len(files)}
        if kind == "edit":
            rp = self.recipe_params("edit")
            mp = float(prm.get("megapixels") or rp.get("megapixels") or 1.0)
            refs = [src[k] for k in sorted(src) if k.startswith("ref")]
            self._step(jid, "editing")
            raw = await self.engine.edit(m, image=src["image"], prompt=inp["prompt"], refs=refs, megapixels=mp,
                                         steps=int(prm.get("steps") or m.defaults.get("steps", 4)),
                                         seed=prm.get("seed"), prefix=prefix, on_progress=self._progress(jid, "editing"))
            extra: dict[str, Any] = {}
            if prm.get("match", True):  # (back at the picture's size, its colours fitted where the edit left it be)
                self._step(jid, "finishing")
                extra = await media(py, "match", {"image": str(raw), "original": str(src["image"]),
                                                  "out": str(d / "edit.png"), "exclude": inp.get("exclude")})
                Path(raw).unlink(missing_ok=True)
            else:
                shutil.move(str(raw), d / "edit.png")
            return {"megapixels": mp}, extra
        if kind == "cutout":
            self._step(jid, "masking")
            mask = await self.engine.mask(m, image=src["image"], prefix=prefix, on_progress=self._progress(jid, "masking"))
            shutil.move(str(mask), d / "mask.png")
            extra = await media(py, "cut", {"image": str(src["image"]), "mask": str(d / "mask.png"),
                                            "out": str(d / "cut.png")})
            return {}, extra
        if kind == "matte":
            self._step(jid, "masking")
            masks = await self.engine.video_mask(m, clip=src["clip"], prefix=prefix,
                                                 on_progress=self._progress(jid, "masking"))
            self._step(jid, "finishing")
            extra = await media(py, "nobg", {"clip": str(src["clip"]), "masks": [str(x) for x in masks],
                                             "out": str(d / "nobg.mp4"), "auto_mask": isinstance(self.engine, FakeEngine)})
            for x in masks:
                Path(x).unlink(missing_ok=True)
            return {}, extra
        if kind == "loop":
            return await self._loop_job(job, m, src, d, py, prefix)
        raise ValueError(kind)

    async def _loop_job(self, job: dict[str, Any], m: catalog.ImageModel, src: dict[str, Path], d: Path, py: str,
                        prefix: str) -> tuple[dict[str, Any], dict[str, Any]]:
        from PIL import Image  # noqa: PLC0415

        jid, inp, prm = job["id"], job["inputs"], job["params"]
        rp = self.recipe_params("loop")
        base = src["image"]
        with Image.open(base) as im:
            W, H = im.size
        box = inp.get("box")
        if box:  # (the model sees her, not the empty canvas: more of its pixels on her)
            x0, y0, x1, y1 = max(0, box[0]), max(0, box[1]), min(W, box[2]), min(H, box[3])
            if x1 - x0 < 64 or y1 - y0 < 64:
                box = None
            else:
                box = [x0, y0, x1, y1]
        bw, bh = (box[2] - box[0], box[3] - box[1]) if box else (W, H)
        # (`size`: a budget of size × size pixels, spent in the picture's own shape — the time a clip takes goes by
        #  its pixels, so a tall crop of her gets more height for the same time as the measured square)
        size = int(prm.get("size") or rp.get("size") or m.defaults.get("size", 640))
        s = (size * size / (bw * bh)) ** 0.5
        from . import graphs as Gr  # noqa: PLC0415

        w, h = Gr.snap(bw * s, lo=256, hi=1280), Gr.snap(bh * s, lo=256, hi=1280)
        model_in = base
        if box:
            model_in = d / "in-crop.png"
            with Image.open(base) as im:
                im.convert("RGB").crop(tuple(box)).save(model_in)
        fps = int(prm.get("fps") or m.defaults.get("fps", 24))
        seconds = max(1.0, min(10.0, float(prm.get("seconds") or 5)))
        steps = int(prm.get("steps") or rp.get("steps") or m.defaults.get("steps", 20))
        end = src.get("end_image")
        self._step(jid, "animating")
        frames = await self.engine.frames(m, image=model_in, prompt=inp["prompt"], negative=inp.get("negative", ""),
                                          width=w, height=h, seconds=seconds, fps=fps, steps=steps,
                                          seed=prm.get("seed"), end_image=end, prefix=prefix,
                                          on_progress=self._progress(jid, "animating"))
        self._step(jid, "finishing")
        extra = await media(py, "loop", {"frames": [str(f) for f in frames], "base": str(base), "box": box,
                                         "out": str(d / "loop.mp4"), "fps": fps, "ease": int(prm.get("ease", 3)),
                                         "poster": str(d / "poster.jpg")})
        for f in frames:
            Path(f).unlink(missing_ok=True)
        return {"size": [w, h], "fps": fps, "seconds": seconds, "steps": steps, "box": box}, extra

    # -- history for the UI -----------------------------------------------------------------------------------------
    def history(self, **kw: Any) -> dict[str, Any]:
        items, total = self.store.jobs(**kw)
        for j in items:
            if j["id"] in self.live:
                j["live"] = self.live[j["id"]]
        return {"items": items, "total": total}

    def star(self, jid: str, starred: bool) -> dict[str, Any] | None:
        j = self.store.update_job(jid, starred=starred)
        self.on_change("history")
        return j


