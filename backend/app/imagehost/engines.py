"""The two engines behind Image Studio's jobs — the same calls, the same files out:

* :class:`ComfyEngine` — ComfyUI (comfy.py) running the recipes' graphs (graphs.py) with the catalog's files;
* :class:`FakeEngine` — a stand-in that draws plain pictures and frames on the CPU (tests and the desktop E2E, no GPU).

What the engine makes is raw: a draft, an edit at the model's size, a mask, a loop's frames, a clip's masks. The
finishing — colours, the loop's seam, the cut-out, the subject-on-black clip — is media.py's, run by :func:`media`
with the engine environment's Python (or, for the stand-in, any Python that has numpy and Pillow).
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.portability import subprocess_flags

from . import catalog, graphs as G
from .comfy import ComfyError, ComfyProcess, Progress
from .settings import ImageSettings

MEDIA = Path(__file__).resolve().parent / "media.py"
OnProgress = Callable[[Progress], Awaitable[None] | None] | None


class MediaError(Exception):
    pass


async def media(python: str, cmd: str, args: dict[str, Any], *, timeout: float = 1800) -> dict[str, Any]:
    """one finishing step (media.py) → its answer"""
    proc = await asyncio.create_subprocess_exec(python, "-I", str(MEDIA), cmd, json.dumps(args),
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                **subprocess_flags())
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise MediaError(f"{cmd} took longer than {timeout:.0f} s") from None
    lines = [x for x in out.decode(errors="replace").splitlines() if x.startswith("{")]
    try:
        res = json.loads(lines[-1]) if lines else {}
    except ValueError:
        res = {}
    if not res.get("ok"):
        tail = err.decode(errors="replace").strip().splitlines()[-3:]
        raise MediaError(res.get("error") or " | ".join(tail) or f"{cmd} failed ({proc.returncode})")
    return res


def stand_in_python() -> str:
    """for the stand-in: this Python when it has numpy and Pillow (the backend's own dependencies)"""
    if importlib.util.find_spec("numpy") and importlib.util.find_spec("PIL"):
        return sys.executable
    raise MediaError("the stand-in engine needs numpy and Pillow")


class ComfyEngine:
    name = "comfyui"

    MIN_RESERVE_GB = 1.0  # (ComfyUI's own headroom, measured: less and a 12 GB card runs out mid-step)

    def __init__(self, settings: ImageSettings, python: Callable[[], str], comfy_dir: Callable[[], Path],
                 voice_room: Callable[[], int] | None = None) -> None:
        self.s = settings
        self._python = python
        self._comfy_dir = comfy_dir
        self.voice_room = voice_room or (lambda: 0)
        self.proc: ComfyProcess | None = None
        self.reserve_gb = self.MIN_RESERVE_GB

    def reserve(self) -> float:
        """the GPU memory ComfyUI keeps free (GB): its own headroom, plus room for the voice models"""
        room = self.s.voice_room_gb if self.s.voice_room_gb >= 0 else self.voice_room() / (1 << 30)
        return round(self.MIN_RESERVE_GB + max(0.0, room), 1)

    # ── the process ──
    def _process(self) -> ComfyProcess:
        if self.proc is None:
            self.proc = ComfyProcess(python=self._python(), comfy_dir=self._comfy_dir(), models_dir=self.s.models_dir,
                                     work_dir=self.s.work_dir, flags=list(self.s.comfy_flags),
                                     idle_stop_seconds=self.s.idle_stop_seconds)
        self.proc.idle_stop_seconds = self.s.idle_stop_seconds
        if not self.proc.running():  # (the reserve is fixed while it runs: worked out again at each start)
            self.reserve_gb = self.reserve()
            self.proc.flags = ["--reserve-vram", f"{self.reserve_gb:g}", *self.s.comfy_flags]
        return self.proc

    def running(self) -> bool:
        return self.proc is not None and self.proc.running()

    def busy(self) -> bool:
        return self.proc is not None and self.proc.busy

    def pid(self) -> int | None:
        return self.proc.proc.pid if self.running() and self.proc and self.proc.proc else None

    def describe(self) -> dict[str, Any]:
        p = self.proc
        return {"engine": self.name, "running": self.running(), "busy": self.busy(), "pid": self.pid(),
                "reserve_gb": self.reserve_gb if self.running() else self.reserve(),
                "port": p.port if p and self.running() else None, "started_at": p.started_at if p else 0,
                "last_used": p.last_used if p else 0, "log": list(p.log)[-12:] if p else []}

    async def stop(self) -> None:
        if self.proc is not None:
            await self.proc.stop()

    def reap(self) -> bool:
        """a ComfyUI the backend's previous run left behind → stopped"""
        return self._process().reap() if self.s.work_dir.exists() else False

    async def free(self) -> None:
        if self.proc is not None:
            await self.proc.free()

    async def interrupt(self) -> None:
        if self.proc is not None:
            await self.proc.interrupt()

    def media_python(self) -> str:
        return self._python()

    async def _run(self, built: G.Built, on_progress: OnProgress, timeout: float = 3600) -> list[Path]:
        files = await self._process().run(built.graph, built.output, on_progress=on_progress, timeout=timeout)
        if not files:
            raise ComfyError("the job made nothing", "failed")
        return files

    def _stage(self, src: Path) -> str:
        return self._process().stage_input(src)

    # ── the jobs ──
    async def draft(self, m: catalog.ImageModel, *, prompt: str, negative: str, width: int, height: int, steps: int,
                    cfg: float, seed: int | None, count: int, prefix: str, on_progress: OnProgress = None) -> list[Path]:
        out: list[Path] = []
        for i in range(count):  # (one at a time: a batch of 4 at 1 MP is no faster on 12 GB and fails all together)
            b = G.anima_txt2img(prompt, model=m.file("model"), text_encoder=m.file("text_encoder"), vae=m.file("vae"),
                                width=width, height=height, steps=steps, cfg=cfg,
                                sampler=str(m.defaults.get("sampler", "er_sde")), negative=negative,
                                seed=None if seed is None else seed + i, prefix=prefix)
            out += await self._run(b, on_progress, 900)
        return out

    async def edit(self, m: catalog.ImageModel, *, image: Path, prompt: str, refs: list[Path], megapixels: float,
                   steps: int, seed: int | None, prefix: str, on_progress: OnProgress = None) -> Path:
        b = G.klein_edit(self._stage(image), prompt, model=m.file("model"), text_encoder=m.file("text_encoder"),
                         vae=m.file("vae"), refs=tuple(self._stage(r) for r in refs), megapixels=megapixels,
                         steps=steps, seed=seed, prefix=prefix)
        return (await self._run(b, on_progress, 900))[0]

    async def mask(self, m: catalog.ImageModel, *, image: Path, prefix: str, on_progress: OnProgress = None) -> Path:
        b = G.foreground_mask(self._stage(image), model=m.file("remover"), prefix=prefix)
        return (await self._run(b, on_progress, 600))[0]

    async def video_mask(self, m: catalog.ImageModel, *, clip: Path, prefix: str,
                         on_progress: OnProgress = None) -> list[Path]:
        b = G.video_mask(self._stage(clip), model=m.file("remover"), prefix=prefix)
        return await self._run(b, on_progress, 1800)

    async def frames(self, m: catalog.ImageModel, *, image: Path, prompt: str, negative: str, width: int, height: int,
                     seconds: float, fps: int, steps: int, seed: int | None, end_image: Path | None, prefix: str,
                     on_progress: OnProgress = None) -> list[Path]:
        d = m.defaults
        b = G.wan_loop(self._stage(image), prompt, model=m.file("model"), text_encoder=m.file("text_encoder"),
                       vae=m.file("vae"), width=width, height=height, seconds=seconds, fps=fps, steps=steps,
                       cfg=float(d.get("cfg", 6.0)), shift=float(d.get("shift", 8.0)),
                       sampler=str(d.get("sampler", "uni_pc")), negative=negative, seed=seed, prefix=prefix,
                       end_image=self._stage(end_image) if end_image else None)
        return await self._run(b, on_progress, 5400)


class FakeEngine:
    """Plain pictures and frames on the CPU, through the same finishing as the real engine."""

    name = "fake"

    def __init__(self, settings: ImageSettings) -> None:
        self.s = settings
        self.jobs = 0
        self.delay = 0.05

    def running(self) -> bool:
        return False

    def busy(self) -> bool:
        return False

    def pid(self) -> int | None:
        return None

    def describe(self) -> dict[str, Any]:
        return {"engine": self.name, "running": False, "busy": False, "pid": None, "jobs": self.jobs}

    async def stop(self) -> None:
        return None

    def reap(self) -> bool:
        return False

    async def free(self) -> None:
        return None

    async def interrupt(self) -> None:
        return None

    def media_python(self) -> str:
        return stand_in_python()

    def _out(self, prefix: str, i: int = 0, ext: str = ".png") -> Path:
        p = self.s.work_dir / "output" / f"{prefix}_{self.jobs:04d}_{i:05d}{ext}"
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    async def _tick(self, on_progress: OnProgress, steps: int = 3) -> None:
        self.jobs += 1
        for i in range(steps):
            await asyncio.sleep(self.delay)
            if on_progress:
                r = on_progress(Progress(node="fake", value=i + 1, max=steps))
                if asyncio.iscoroutine(r):
                    await r

    async def draft(self, m: catalog.ImageModel, *, prompt: str, negative: str, width: int, height: int, steps: int,
                    cfg: float, seed: int | None, count: int, prefix: str, on_progress: OnProgress = None) -> list[Path]:
        await self._tick(on_progress)
        out = []
        for i in range(count):
            p = self._out(prefix, i)
            await media(self.media_python(), "fake-draft", {"out": str(p), "width": G.snap(width), "height": G.snap(height),
                                                            "seed": (seed or 0) + i, "prompt": prompt})
            out.append(p)
        return out

    async def edit(self, m: catalog.ImageModel, *, image: Path, prompt: str, refs: list[Path], megapixels: float,
                   steps: int, seed: int | None, prefix: str, on_progress: OnProgress = None) -> Path:
        await self._tick(on_progress)
        p = self._out(prefix)
        await media(self.media_python(), "fake-edit", {"image": str(image), "out": str(p), "prompt": prompt})
        return p

    async def mask(self, m: catalog.ImageModel, *, image: Path, prefix: str, on_progress: OnProgress = None) -> Path:
        await self._tick(on_progress, 1)
        p = self._out(prefix)
        await media(self.media_python(), "fake-mask", {"image": str(image), "out": str(p)})
        return p

    async def video_mask(self, m: catalog.ImageModel, *, clip: Path, prefix: str,
                         on_progress: OnProgress = None) -> list[Path]:
        await self._tick(on_progress, 1)
        return []  # (no masks: the finishing keeps every frame whole)

    async def frames(self, m: catalog.ImageModel, *, image: Path, prompt: str, negative: str, width: int, height: int,
                     seconds: float, fps: int, steps: int, seed: int | None, end_image: Path | None, prefix: str,
                     on_progress: OnProgress = None) -> list[Path]:
        await self._tick(on_progress)
        d = self.s.work_dir / "output" / f"{prefix}_{self.jobs:04d}"
        shutil.rmtree(d, ignore_errors=True)
        res = await media(self.media_python(), "fake-frames", {"base": str(image), "dir": str(d), "width": width,
                                                               "height": height, "frames": G.frames(seconds, fps)})
        return [Path(f) for f in res["files"]]
