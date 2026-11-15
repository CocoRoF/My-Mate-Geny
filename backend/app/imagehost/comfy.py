"""The image engine: a ComfyUI process this app starts, talks to over its HTTP / WebSocket API on 127.0.0.1, and stops
(docs/local-image.md "The engine"). ComfyUI is GPL-3.0: it is installed from upstream at a pinned commit as a program
of its own (installer.py) and never imported here — only spoken to.

One process, one job at a time. It is started when a job needs it and stopped after `idle_stop_seconds` without one:
stopping the process is the only way to give every byte of VRAM back (the voice models share the GPU). Its memory flags
follow what was measured on a 12 GB card (docs/local-image.md "Measured").
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import socket
import sys
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.portability import kill_tree, subprocess_flags

log = logging.getLogger("app.imagehost.comfy")

READY_TIMEOUT = 240.0        # the first start compiles and loads: generous
STALL_TIMEOUT = 900.0        # no progress message for this long: the job is given up
POLL_S = 0.7


class ComfyError(RuntimeError):
    """``kind``: start (the process would not come up), rejected (the graph was refused), failed (it ran and failed),
    oom (out of GPU memory), stopped (cancelled / the process went away)"""

    def __init__(self, message: str, kind: str = "failed") -> None:
        super().__init__(message)
        self.kind = kind


@dataclass
class Progress:
    node: str = ""
    value: int = 0
    max: int = 0
    message: str = ""
    started_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {"node": self.node, "value": self.value, "max": self.max, "message": self.message,
                "elapsed": round(time.time() - self.started_at, 1)}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _death_signal():
    """on Linux, a function for the child (between fork and exec) that asks for SIGTERM when the backend dies however
    it dies — an orphaned ComfyUI would hold the GPU's memory until someone found it. Resolved here, in the parent:
    the child only calls it (nothing that could wait on a lock another thread held at the fork)."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        import ctypes  # noqa: PLC0415

        prctl = ctypes.CDLL(None, use_errno=True).prctl
    except (OSError, AttributeError):
        return None
    return lambda: prctl(1, int(signal.SIGTERM))  # PR_SET_PDEATHSIG


def _ours(pid: int, comfy_dir: Path) -> bool:
    try:
        import psutil  # noqa: PLC0415

        p = psutil.Process(pid)
        return "main.py" in p.cmdline() and Path(p.cwd()).resolve() == comfy_dir.resolve()
    except Exception:  # noqa: BLE001 - gone, or not ours to look at
        return False


class ComfyProcess:
    """Start, watch and stop one ComfyUI; run graphs on it."""

    def __init__(self, *, python: str, comfy_dir: Path, models_dir: Path, work_dir: Path, port: int = 0,
                 flags: list[str] | None = None, env: dict[str, str] | None = None,
                 idle_stop_seconds: float = 120.0) -> None:
        self.python = python
        self.comfy_dir = Path(comfy_dir)
        self.models_dir = Path(models_dir)
        self.work = Path(work_dir)
        self.port = port or free_port()
        self.flags = flags if flags is not None else ["--reserve-vram", "1.0", "--disable-pinned-memory"]
        self.env = env or {}
        self.idle_stop_seconds = idle_stop_seconds
        self.proc: asyncio.subprocess.Process | None = None
        self.log: deque[str] = deque(maxlen=200)
        self._reader: asyncio.Task | None = None
        self._idle: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self.started_at = 0.0
        self.last_used = 0.0
        self.busy = False
        self.progress: Progress | None = None

    # ── where things go ──
    @property
    def input_dir(self) -> Path:
        return self.work / "input"

    @property
    def output_dir(self) -> Path:
        return self.work / "output"

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _pidfile(self) -> Path:
        return self.work / "comfy.pid"

    def reap(self) -> bool:
        """a ComfyUI a previous run of the backend left (it died before stopping it) → stopped"""
        try:
            pid = int(self._pidfile().read_text().strip())
        except (OSError, ValueError):
            return False
        self._pidfile().unlink(missing_ok=True)
        if not _ours(pid, self.comfy_dir):
            return False
        log.warning("stopping the ComfyUI a previous run left (pid %s)", pid)
        kill_tree(pid)
        return True

    def running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    def _paths_config(self) -> Path:
        """the models folder as ComfyUI's extra model paths (its own folders stay empty: the app owns the weights)"""
        self.work.mkdir(parents=True, exist_ok=True)
        cfg = self.work / "extra_model_paths.yaml"
        folders = ["checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "background_removal",
                   "upscale_models", "clip_vision", "model_patches"]
        lines = ["geny:", f"  base_path: {self.models_dir}"] + [f"  {f}: {f}" for f in folders]
        cfg.write_text("\n".join(lines) + "\n")
        return cfg

    # ── start / stop ──
    async def start(self) -> None:
        async with self._lock:
            if self.running():
                return
            import httpx

            self.input_dir.mkdir(parents=True, exist_ok=True)
            self.output_dir.mkdir(parents=True, exist_ok=True)
            cmd = [self.python, "main.py", "--listen", "127.0.0.1", "--port", str(self.port),
                   "--disable-auto-launch", "--extra-model-paths-config", str(self._paths_config()),
                   "--input-directory", str(self.input_dir), "--output-directory", str(self.output_dir),
                   "--disable-metadata", *self.flags]
            # TORCH_DISABLE_NATIVE_JIT: torch's own Triton kernels (bmm outer product, …) compile a C stub with the
            # machine's gcc and Python headers on first use — missing on most machines (python3.12-dev), and the
            # job fails; the plain CUDA kernels are as fast for these graphs (measured: docs/local-image.md)
            env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "HF_HUB_OFFLINE": "1",
                   "TRANSFORMERS_OFFLINE": "1", "DO_NOT_TRACK": "1", "TORCH_DISABLE_NATIVE_JIT": "1", **self.env}
            env.pop("VIRTUAL_ENV", None)
            self.log.clear()
            self.proc = await asyncio.create_subprocess_exec(
                *cmd, cwd=str(self.comfy_dir), env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                **({"start_new_session": True, "preexec_fn": _death_signal()} if os.name != "nt"
                   else subprocess_flags()))
            self._pidfile().write_text(str(self.proc.pid))
            self._reader = asyncio.create_task(self._read())
            t0 = time.monotonic()
            async with httpx.AsyncClient(timeout=2.0) as c:
                while time.monotonic() - t0 < READY_TIMEOUT:
                    if self.proc.returncode is not None:
                        raise ComfyError(f"ComfyUI exited while starting ({self.proc.returncode}): {self.tail(6)}", "start")
                    try:
                        if (await c.get(f"{self.base}/system_stats")).status_code == 200:
                            self.started_at = time.time()
                            self.last_used = time.time()
                            log.info("ComfyUI up on :%s in %.1f s", self.port, time.monotonic() - t0)
                            self._arm_idle()
                            return
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.5)
            await self._kill()
            raise ComfyError(f"ComfyUI did not come up in {READY_TIMEOUT:.0f} s: {self.tail(6)}", "start")

    async def _read(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip()
            if text:
                self.log.append(text[:400])

    def tail(self, n: int = 10) -> str:
        return " | ".join(list(self.log)[-n:])

    async def stop(self) -> None:
        async with self._lock:
            await self._kill()

    async def _kill(self) -> None:
        if self._idle:
            self._idle.cancel()
            self._idle = None
        p = self.proc
        self.proc = None
        self._pidfile().unlink(missing_ok=True)
        if p is None or p.returncode is not None:
            return
        if os.name == "nt":  # (no process groups: the tree, at once — ComfyUI keeps nothing worth a clean exit)
            kill_tree(p.pid)
            await p.wait()
            log.info("ComfyUI stopped")
            return
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(p.wait(), 8)
        except asyncio.TimeoutError:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await p.wait()
        log.info("ComfyUI stopped")

    def _arm_idle(self) -> None:
        if self._idle:
            self._idle.cancel()
        if self.idle_stop_seconds <= 0:
            return

        async def wait() -> None:
            while True:
                await asyncio.sleep(max(5.0, self.idle_stop_seconds / 4))
                if not self.busy and time.time() - self.last_used >= self.idle_stop_seconds:
                    log.info("ComfyUI idle %.0f s: stopping (the GPU back to the others)", self.idle_stop_seconds)
                    await self.stop()
                    return

        self._idle = asyncio.create_task(wait())

    # ── running a graph ──
    def stage_input(self, src: Path, name: str | None = None) -> str:
        """a file for a graph's LoadImage: copied into ComfyUI's input folder → the name the graph uses"""
        import hashlib
        import shutil

        data = Path(src).read_bytes()
        name = name or f"{hashlib.sha256(data).hexdigest()[:24]}{Path(src).suffix.lower() or '.png'}"
        dest = self.input_dir / "geny" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copyfile(src, dest)
        return f"geny/{name}"

    async def run(self, graph: dict[str, Any], output_node: str, *,
                  on_progress: Callable[[Progress], Awaitable[None] | None] | None = None,
                  timeout: float = 3600.0) -> list[Path]:
        """Queue the graph, follow it, return the files its output node saved (in order)."""
        import httpx

        await self.start()
        self.busy = True
        self.progress = Progress()
        client_id = uuid.uuid4().hex
        try:
            async with httpx.AsyncClient(timeout=30.0) as c:
                r = await c.post(f"{self.base}/prompt", json={"prompt": graph, "client_id": client_id})
                if r.status_code != 200:
                    raise ComfyError(f"ComfyUI refused the graph: {r.text[:600]}", "rejected")
                pid = r.json()["prompt_id"]
                watcher = asyncio.create_task(self._watch(client_id, on_progress))
                try:
                    t0 = time.monotonic()
                    while True:
                        if not self.running():
                            raise ComfyError(f"ComfyUI went away during the job: {self.tail(6)}", "stopped")
                        h = (await c.get(f"{self.base}/history/{pid}")).json().get(pid)
                        if h:
                            st = h.get("status") or {}
                            if st.get("status_str") == "error":
                                msg = next((m[1].get("exception_message", "") for m in st.get("messages", [])
                                            if m and m[0] == "execution_error"), "") or "the job failed"
                                kind = "oom" if "out of memory" in msg.lower() or "allocation on device" in msg.lower() else "failed"
                                raise ComfyError(msg.strip()[:600], kind)
                            if st.get("completed") or st.get("status_str") == "success":
                                out = (h.get("outputs") or {}).get(output_node) or {}
                                return self._files(out)
                        if time.monotonic() - t0 > timeout:
                            await self.interrupt()
                            raise ComfyError(f"the job took longer than {timeout:.0f} s", "failed")
                        if self.progress and time.time() - self.progress.started_at > STALL_TIMEOUT and not self.progress.max:
                            pass  # (loading a large model sends nothing for a while)
                        await asyncio.sleep(POLL_S)
                finally:
                    watcher.cancel()
        finally:
            self.busy = False
            self.last_used = time.time()
            self.progress = None
            self._arm_idle()

    def _files(self, out: dict[str, Any]) -> list[Path]:
        files = []
        for key in ("images", "videos", "gifs", "audio"):
            for f in out.get(key) or []:
                p = self.output_dir / (f.get("subfolder") or "") / f["filename"]
                if p.is_file():
                    files.append(p)
        return files

    async def _watch(self, client_id: str, on_progress: Callable[[Progress], Awaitable[None] | None] | None) -> None:
        """the WebSocket's progress messages → self.progress (and the callback); silent failures are fine (polling
        decides the result)"""
        try:
            import websockets
        except ImportError:
            return
        try:
            async with websockets.connect(f"ws://127.0.0.1:{self.port}/ws?clientId={client_id}", max_size=None) as ws:
                async for raw in ws:
                    if not isinstance(raw, str):
                        continue
                    try:
                        m = json.loads(raw)
                    except ValueError:
                        continue
                    t, d = m.get("type"), m.get("data") or {}
                    p = self.progress
                    if p is None:
                        continue
                    if t == "executing" and d.get("node"):
                        p.node, p.value, p.max = str(d["node"]), 0, 0
                    elif t == "progress":
                        p.value, p.max = int(d.get("value") or 0), int(d.get("max") or 0)
                    else:
                        continue
                    if on_progress:
                        r = on_progress(p)
                        if asyncio.iscoroutine(r):
                            await r
        except Exception:  # noqa: BLE001 - progress is a nicety
            return

    async def interrupt(self) -> None:
        import httpx

        if not self.running():
            return
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                await c.post(f"{self.base}/interrupt")
        except httpx.HTTPError:
            pass

    async def free(self) -> None:
        """unload the models and free the cache (the process stays)"""
        import httpx

        if not self.running():
            return
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                await c.post(f"{self.base}/free", json={"unload_models": True, "free_memory": True})
        except httpx.HTTPError:
            pass

    async def stats(self) -> dict[str, Any] | None:
        import httpx

        if not self.running():
            return None
        try:
            async with httpx.AsyncClient(timeout=3.0) as c:
                return (await c.get(f"{self.base}/system_stats")).json()
        except (httpx.HTTPError, ValueError):
            return None
