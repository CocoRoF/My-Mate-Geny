"""Which models are on the GPU, and what happens to the ones that are not needed.

Each loaded model is one worker process in its engine's environment. Three states, cheapest to resume first:

    ready   weights on the GPU                                       (resume: nothing)
    parked  process alive, weights in host RAM, GPU memory released  (resume: host->GPU copy, 0.2-0.6 s)
    (gone)  process stopped, nothing held                            (resume: start + load, 5-15 s)

Loading a model first makes room for it: it needs its measured peak VRAM (catalog vram_gb) free on the device
*as the driver reports it*, so memory used by other programs on a personal GPU is respected, not assumed. The least
recently used of our own models are moved out until it fits; if it still does not fit, the request fails with a
message that says how much is used by whom instead of letting CUDA run out of memory mid-generation. Each worker is
also capped (set_per_process_memory_fraction) at what it was admitted with, so one runaway request cannot take memory
another model was promised.

A model moved out is parked when the host has RAM to spare for its weights, otherwise stopped. Idle models go the
same way after idle_unload_seconds, and parked ones are stopped after parked_ttl_seconds: an idle machine holds no
GPU memory. A model can be pinned (a phone call with a mate who speaks with it): it stays on the GPU while pinned —
never idled out, never moved out for another model.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from . import catalog, system
from .settings import VoiceSettings
from .workerproc import WorkerError, WorkerProcess

log = logging.getLogger("app.voicehost.host")

GiB = 1 << 30
MARGIN = int(0.5 * GiB)  # headroom kept free on the device beyond a model's measured peak


class NoRoom(Exception):
    """not enough free GPU memory for a model, even after moving ours out: how much is needed and used by whom"""

    def __init__(self, message: str, data: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.data = data or {}


@dataclass
class Resident:
    spec: catalog.ModelSpec
    worker: WorkerProcess
    state: str = "starting"  # starting | loading | ready | parked | stopping
    last_used: float = field(default_factory=time.time)
    loaded_at: float = 0.0
    parked_at: float = 0.0
    load_info: dict[str, Any] = field(default_factory=dict)
    last_memory: dict[str, Any] = field(default_factory=dict)
    host_rss: int = 0
    busy: int = 0
    device: dict[str, Any] = field(default_factory=dict)

    @property
    def need(self) -> int:
        return int(self.spec.vram_gb * GiB)

    def describe(self) -> dict[str, Any]:
        return {
            "model_id": self.spec.id, "state": self.state, "busy": self.busy > 0,
            "last_used": self.last_used, "loaded_at": self.loaded_at, "parked_at": self.parked_at,
            "vram_estimate": self.need, "vram_reserved": self.last_memory.get("reserved", 0),
            "vram_peak": self.last_memory.get("peak_reserved", 0), "host_rss": self.host_rss,
            "host_peak": self.load_info.get("host_peak", 0),
            "pid": self.worker.pid, "device": self.device,
            "load_seconds": self.load_info.get("seconds"),
        }


class EngineManager:
    def __init__(self, settings: VoiceSettings, python_for, worker_env=None) -> None:
        self.s = settings
        self.python_for = python_for  # engine name -> interpreter path (or None when its runtime is missing)
        self.worker_env = worker_env or (lambda engine: {})  # engine name -> extra environment for its worker
        self.residents: dict[str, Resident] = {}
        self.pins: dict[str, int] = {}  # model id -> how many hold it on the GPU (calls)
        self._lock = asyncio.Lock()  # one placement decision at a time
        self._task: asyncio.Task | None = None
        self.events: list[dict[str, Any]] = []  # recent load/park/stop decisions, shown in the UI

    # -- lifecycle ----------------------------------------------------------------------------------------------
    def start(self) -> None:
        self._task = asyncio.create_task(self._idle_loop())

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
        for r in list(self.residents.values()):
            await self._stop(r, "shutdown")

    def _event(self, model_id: str, what: str, **extra: Any) -> None:
        e = {"t": time.time(), "model_id": model_id, "what": what, **extra}
        self.events.append(e)
        del self.events[:-50]
        log.info("%s %s %s", model_id, what, extra or "")

    # -- device accounting --------------------------------------------------------------------------------------
    def _gpu(self) -> system.Gpu | None:
        idx = int(self.s.device.split(":", 1)[1]) if self.s.device.startswith("cuda:") else 0
        gs = system.gpus(max_age=0.0)
        return next((g for g in gs if g.index == idx), gs[0] if gs else None)

    async def _settle(self) -> None:
        """The driver releases a stopped process's memory a moment after it exits."""
        await asyncio.sleep(0.4)
        system.invalidate()

    def _host_can_park(self, r: Resident) -> bool:
        mem = system.host_memory()
        weights = int(r.load_info.get("memory", {}).get("allocated", r.need))
        budget = int(self.s.park_ram_gb * GiB)
        parked = sum(int(x.load_info.get("memory", {}).get("allocated", 0)) for x in self.residents.values()
                     if x.state == "parked")
        return parked + weights <= budget and mem["available"] - weights > 2 * GiB

    async def _make_room_ram(self, host_need: int, exclude: str) -> None:
        """A new worker needs host RAM too; inside a container limit, running out kills a worker mid-request."""
        while system.host_memory()["available"] - host_need < MARGIN * 2:
            victims = sorted((r for r in self.residents.values()
                              if r.busy == 0 and r.spec.id != exclude and not self.pins.get(r.spec.id)),
                             key=lambda r: (r.state != "parked", r.last_used))  # parked ones first: they hold RAM only
            if not victims:
                return  # let the load try; the kernel limit is the last word
            await self._stop(victims[0], "room in host memory")

    async def _make_room(self, need: int, exclude: str) -> None:
        gpu = self._gpu()
        if gpu is None:
            return  # CPU mode: nothing to budget
        budget = int(gpu.total * self.s.vram_budget_fraction)
        while True:
            gpu = self._gpu()
            ours = [r for r in self.residents.values() if r.state == "ready" and r.spec.id != exclude]
            ours_used = sum(max(r.need, r.last_memory.get("reserved", 0)) for r in ours)
            fits_free = gpu.free - MARGIN >= need
            fits_budget = ours_used + need <= budget
            if fits_free and fits_budget:
                return
            victims = sorted((r for r in ours if r.busy == 0 and not self.pins.get(r.spec.id)), key=lambda r: r.last_used)
            if not victims:
                others = max(0, gpu.used - ours_used)
                free = max(0, gpu.free - MARGIN)
                raise NoRoom(
                    f"Not enough GPU memory: this model needs about {need / GiB:.1f} GB and {free / GiB:.1f} GB is free "
                    f"(of {gpu.total / GiB:.1f} GB, other programs use {others / GiB:.1f} GB and our models "
                    f"{ours_used / GiB:.1f} GB)",
                    {"need": need, "free": free, "total": gpu.total, "others": others, "ours": ours_used})
            v = victims[0]
            await self._evict(v, "room for another model")
            await self._settle()

    async def _evict(self, r: Resident, why: str) -> None:
        if r.state == "ready" and self._host_can_park(r):
            await self._park(r, why)
        else:
            await self._stop(r, why)

    # -- state changes ------------------------------------------------------------------------------------------
    async def _park(self, r: Resident, why: str) -> None:
        try:
            res = await r.worker.call("park", timeout=120)
        except WorkerError as e:
            self._event(r.spec.id, "park failed", error=str(e))
            await self._stop(r, "park failed")
            return
        if not res.get("parked"):
            await self._stop(r, why)
            return
        r.state, r.parked_at = "parked", time.time()
        r.host_rss = res.get("host_rss", r.host_rss)
        r.last_memory = res.get("memory", {})
        self._event(r.spec.id, "parked", why=why, seconds=round(res.get("seconds", 0), 2))

    async def _stop(self, r: Resident, why: str) -> None:
        r.state = "stopping"
        await r.worker.stop(timeout=10)
        self.residents.pop(r.spec.id, None)
        self._event(r.spec.id, "stopped", why=why)

    async def acquire(self, model_id: str) -> Resident:
        """The model on the GPU and ready, loading or resuming it as needed. Caller must release()."""
        spec = catalog.get(model_id)
        async with self._lock:
            r = self.residents.get(model_id)
            if r is not None and not r.worker.alive:
                self.residents.pop(model_id, None)
                self._event(model_id, "worker died")
                r = None
            if r is not None and r.state == "ready":
                r.busy += 1
                r.last_used = time.time()
                return r
            need = int(spec.vram_gb * GiB)
            await self._make_room(need, exclude=model_id)
            if r is None:
                # Loading peaks above the steady state (CPU copies of the weights before they move to the GPU).
                await self._make_room_ram(int(max(spec.host_gb, spec.load_peak_gb) * GiB), exclude=model_id)
            if r is not None and r.state == "parked":
                t0 = time.perf_counter()
                try:
                    res = await r.worker.call("resume", timeout=120)
                except WorkerError:
                    await self._stop(r, "resume failed")
                    r = None
                else:
                    r.state = "ready"
                    r.last_memory = res.get("memory", {})
                    r.host_rss = res.get("host_rss", r.host_rss)
                    self._event(model_id, "resumed", seconds=round(time.perf_counter() - t0, 2))
            if r is None:
                r = await self._load(spec)
            r.busy += 1
            r.last_used = time.time()
            return r

    def release(self, r: Resident, memory: dict[str, Any] | None = None, host_rss: int | None = None) -> None:
        r.busy = max(0, r.busy - 1)
        r.last_used = time.time()
        if memory:
            r.last_memory = memory
        if host_rss:
            r.host_rss = host_rss

    async def _load(self, spec: catalog.ModelSpec) -> Resident:
        py = self.python_for(spec.engine)
        fake = self.s.engine_mode == "fake"
        if not fake and not py:
            raise WorkerError(f"{spec.name}: its engine environment is not installed (download the model first)", "user")
        engine = "fake" if fake else spec.engine
        env = {} if fake else dict(self.worker_env(spec.engine))
        # (its own memory ceiling where the host can make one: its loading peak with room to spare)
        mem = 0.0 if fake else max(spec.load_peak_gb, spec.host_gb) * 1.5 + 1.5
        w = WorkerProcess(engine, python=py, env=env, label=spec.id, mem_gb=mem)
        r = Resident(spec=spec, worker=w)
        self.residents[spec.id] = r
        try:
            await w.start()
            r.state = "loading"
            gpu = self._gpu()
            cap = 0.0
            if gpu and gpu.total:
                # Admitted with its measured peak plus headroom for long inputs; never more than the budget.
                cap = min(self.s.vram_budget_fraction, (spec.vram_gb * GiB * 1.35 + MARGIN) / gpu.total)
            opts = dict(spec.load_options)
            if cap:
                opts["vram_fraction"] = round(cap, 4)
            info = await w.call("load", timeout=900, model_dir=str(self.s.models_dir / spec.id),
                                device=self.s.device, dtype="auto", options=opts, warmup=True)
        except Exception as e:
            await w.kill()
            self.residents.pop(spec.id, None)
            self._event(spec.id, "load failed", error=str(e))
            raise
        r.state, r.loaded_at = "ready", time.time()
        r.load_info = info
        r.device = info.get("device", {})
        r.last_memory = info.get("memory_idle") or info.get("memory") or {}
        r.host_rss = info.get("host_rss", 0)
        self._event(spec.id, "loaded", seconds=round(info.get("seconds", 0), 1), device=r.device.get("name"))
        return r

    async def unload(self, model_id: str, park: bool = False) -> bool:
        async with self._lock:
            r = self.residents.get(model_id)
            if r is None:
                return False
            if r.busy:
                raise WorkerError("This model is generating right now; it can be unloaded once it is done", "user")
            if park and r.state == "ready":
                await self._park(r, "requested")
            else:
                await self._stop(r, "requested")
            return True

    async def load(self, model_id: str) -> Resident:
        r = await self.acquire(model_id)
        self.release(r)
        return r

    async def trim(self) -> None:
        """Hand cached-but-unused CUDA blocks back once the queue is quiet (a long text inflates the pool)."""
        for r in list(self.residents.values()):
            if r.state == "ready" and r.busy == 0 and r.worker.alive:
                try:
                    res = await r.worker.call("trim", timeout=30)
                    r.last_memory = res.get("memory", r.last_memory)
                except WorkerError:
                    pass

    async def _idle_loop(self) -> None:
        while True:
            await asyncio.sleep(15)
            try:
                now = time.time()
                async with self._lock:
                    for r in list(self.residents.values()):
                        if not r.worker.alive:
                            self.residents.pop(r.spec.id, None)
                            self._event(r.spec.id, "worker died")
                        elif r.busy or self.pins.get(r.spec.id):
                            continue
                        elif (r.state == "ready" and self.s.idle_unload_seconds
                              and now - r.last_used > self.s.idle_unload_seconds):
                            await self._evict(r, "idle")
                        elif (r.state == "parked" and self.s.parked_ttl_seconds
                              and now - r.parked_at > self.s.parked_ttl_seconds):
                            await self._stop(r, "parked too long")
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the loop must survive anything
                log.exception("idle loop")

    # -- pins (a call keeps its models on the GPU) ------------------------------------------------------------------
    def pin(self, model_id: str) -> None:
        self.pins[model_id] = self.pins.get(model_id, 0) + 1

    def unpin(self, model_id: str) -> None:
        n = self.pins.get(model_id, 0) - 1
        if n > 0:
            self.pins[model_id] = n
        else:
            self.pins.pop(model_id, None)
            r = self.residents.get(model_id)
            if r is not None:
                r.last_used = time.time()  # (the idle clock starts when the call is over)

    def status(self) -> list[dict[str, Any]]:
        held = system.gpu_processes()
        out = []
        for r in self.residents.values():
            d = r.describe()
            d["pinned"] = bool(self.pins.get(r.spec.id))
            if r.worker.pid in held:
                d["vram_used"] = held[r.worker.pid]  # (what the driver says this worker holds)
            out.append(d)
        return out
