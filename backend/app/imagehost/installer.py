"""Installing the image engine and its models (docs/local-image.md "Installing").

The engine is ComfyUI — GPL-3.0, so it is fetched from upstream at a pinned commit and run as a program of its own,
never copied into this repository — in a Python environment made with uv from this platform's lock file
(runtimes/comfy[.<platform>].txt: torch for CUDA 13.0 on Linux and Windows, Metal on Apple Silicon). Weights come from
Hugging Face, one file at a time in a child process (a stalled transfer can be killed and retried), each into ComfyUI's
model folder it belongs to, at the revision the catalog pins. A model is installed when every file it needs is there
at its exact size; files several models share are kept while any installed model needs them.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import shutil
import sys
import tarfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.portability import subprocess_flags
from app.voicehost import system

from . import catalog
from .settings import ImageSettings

log = logging.getLogger("app.imagehost.installer")

COMFY_REPO = "Comfy-Org/ComfyUI"
COMFY_VERSION = "0.45.0"
COMFY_REV = "989d93d0d968e704c589ce0146bb18c77f6b50cc"
TORCH_INDEX = "https://download.pytorch.org/whl/cu130"
RUNTIMES = Path(__file__).resolve().parent / "runtimes"


class InstallError(Exception):
    pass


@dataclass
class Progress:
    state: str = "idle"  # idle | queued | engine | weights | done | error | cancelled
    message: str = ""
    done_bytes: int = 0
    total_bytes: int = 0
    started_at: float = 0.0
    error: str = ""
    log: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        frac = self.done_bytes / self.total_bytes if self.total_bytes else None
        return {"state": self.state, "message": self.message, "done_bytes": self.done_bytes,
                "total_bytes": self.total_bytes, "fraction": frac, "started_at": self.started_at, "error": self.error,
                "log": self.log[-8:]}


def venv_python(d: Path) -> Path:
    return d / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


class Installer:
    ENGINE = "_engine"

    def __init__(self, settings: ImageSettings) -> None:
        self.s = settings
        self.progress: dict[str, Progress] = {}
        self._lock = asyncio.Lock()
        self._tasks: dict[str, asyncio.Task] = {}
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self.on_change = lambda what: None

    # ── the engine ──
    @property
    def comfy_dir(self) -> Path:
        return self.s.runtime_dir / "ComfyUI"

    @property
    def venv_dir(self) -> Path:
        return self.s.runtime_dir / "venv"

    def lock_path(self) -> Path:
        own = RUNTIMES / f"comfy.{system.platform_key()}.txt"
        return own if own.exists() else RUNTIMES / "comfy.txt"

    def _engine_mark(self) -> str:
        try:
            return hashlib.sha256(self.lock_path().read_bytes() + COMFY_REV.encode()).hexdigest()[:16]
        except OSError:
            return ""

    def engine_ready(self) -> bool:
        if self.s.engine_mode == "fake":
            return True
        marker = self.venv_dir / ".ready"
        return (self.comfy_dir / "main.py").is_file() and marker.is_file() and marker.read_text() == self._engine_mark()

    def python(self) -> str:
        return str(venv_python(self.venv_dir))

    # ── the weights ──
    def file_path(self, f: catalog.FileSpec) -> Path:
        return self.s.models_dir / f.folder / f.name

    def file_ready(self, f: catalog.FileSpec) -> bool:
        p = self.file_path(f)
        try:
            return p.is_file() and p.stat().st_size == f.size
        except OSError:
            return False

    def weights_ready(self, m: catalog.ImageModel) -> bool:
        return self.s.engine_mode == "fake" and self._fake_marked(m) or all(self.file_ready(f) for f in m.files)

    def _fake_marked(self, m: catalog.ImageModel) -> bool:
        return (self.s.models_dir / f".fake-{m.id}").exists()

    def installed(self, m: catalog.ImageModel) -> bool:
        return self.engine_ready() and self.weights_ready(m)

    def missing_bytes(self, m: catalog.ImageModel) -> int:
        return sum(f.size for f in m.files if not self.file_ready(f))

    def status(self, m: catalog.ImageModel) -> dict[str, Any]:
        p = self.progress.get(m.id)
        return {"installed": self.installed(m), "weights": self.weights_ready(m), "engine": self.engine_ready(),
                "missing_bytes": self.missing_bytes(m), "progress": p.to_dict() if p else None,
                "busy": self.busy(m.id)}

    # ── install / cancel ──
    def busy(self, key: str) -> bool:
        t = self._tasks.get(key)
        return bool(t and not t.done())

    def start(self, m: catalog.ImageModel) -> Progress:
        if self.busy(m.id):
            return self.progress[m.id]
        p = Progress(state="queued", message="queued", started_at=time.time())
        self.progress[m.id] = p
        self._tasks[m.id] = asyncio.create_task(self._install(m, p))
        return p

    def cancel(self, key: str) -> bool:
        t = self._tasks.get(key)
        if not t or t.done():
            return False
        proc = self._procs.get(key)
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        t.cancel()
        return True

    async def close(self) -> None:
        running = [t for k, t in self._tasks.items() if not t.done() and self.cancel(k)]
        if running:
            await asyncio.wait(running, timeout=10)

    async def _install(self, m: catalog.ImageModel, p: Progress) -> None:
        async with self._lock:  # one at a time: the disk and the network are shared
            try:
                self._check_room(m)
                if self.s.engine_mode == "fake":
                    self.s.models_dir.mkdir(parents=True, exist_ok=True)
                    (self.s.models_dir / f".fake-{m.id}").write_text("1")
                else:
                    if not self.engine_ready():
                        await self._install_engine(p, m.id)
                    await self._download(m, p)
                p.state, p.message = "done", "installed"
                p.done_bytes = p.total_bytes
            except asyncio.CancelledError:
                p.state, p.error, p.message = "cancelled", "cancelled", "cancelled"
                self.on_change(m.id)
                raise
            except Exception as e:  # noqa: BLE001 - shown to the user
                log.exception("install %s", m.id)
                p.state, p.error = "error", (str(e) if isinstance(e, InstallError) else f"{type(e).__name__}: {e}")
                p.message = "failed"
            finally:
                self._procs.pop(m.id, None)
            self.on_change(m.id)

    def _check_room(self, m: catalog.ImageModel) -> None:
        need = self.missing_bytes(m) + (0 if self.engine_ready() else int(6.5e9))
        free = shutil.disk_usage(self.s.models_dir if self.s.models_dir.exists() else self.s.home.parent).free
        if need > free - int(2e9):
            raise InstallError(f"Not enough disk space: {need / 1e9:.1f} GB needed, {free / 1e9:.1f} GB free")

    async def _install_engine(self, p: Progress, key: str) -> None:
        """ComfyUI's source at the pinned commit + its environment from the lock file"""
        if sys.version_info[:2] != (3, 12):
            raise InstallError("The image engine needs Python 3.12 for its environment")
        uv = self.s.uv()
        if not uv:
            raise InstallError("uv is not available on this server (pip install uv)")
        lock = self.lock_path()
        if not lock.exists():
            raise InstallError(f"lock file missing: {lock}")
        self.s.runtime_dir.mkdir(parents=True, exist_ok=True)
        if not (self.comfy_dir / "main.py").is_file():
            p.state, p.message = "engine", f"ComfyUI {COMFY_VERSION}"
            import httpx

            async with httpx.AsyncClient(follow_redirects=True, timeout=180) as c:
                r = await c.get(f"https://codeload.github.com/{COMFY_REPO}/tar.gz/{COMFY_REV}")
                r.raise_for_status()
            stage = self.comfy_dir.with_name("ComfyUI.partial")
            shutil.rmtree(stage, ignore_errors=True)
            stage.mkdir(parents=True)
            with tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz") as tar:
                for member in tar.getmembers():
                    parts = Path(member.name).parts[1:]
                    if not parts or ".." in parts or member.issym() or member.islnk():
                        continue
                    member.name = str(Path(*parts))
                    tar.extract(member, stage, filter="data")
            (stage / "UPSTREAM.json").write_text(json.dumps({"repo": COMFY_REPO, "commit": COMFY_REV,
                                                             "version": COMFY_VERSION, "license": "GPL-3.0"}))
            shutil.rmtree(self.comfy_dir, ignore_errors=True)
            stage.rename(self.comfy_dir)
        p.state, p.message = "engine", "Python environment"
        cache = self.s.runtime_dir / ".uv-cache"
        env = dict(os.environ, UV_CACHE_DIR=str(cache), UV_LINK_MODE="hardlink", UV_PYTHON_DOWNLOADS="never")
        env.pop("VIRTUAL_ENV", None)
        shutil.rmtree(self.venv_dir, ignore_errors=True)
        await self._run([*uv, "venv", "-q", "-p", self.s.python, str(self.venv_dir)], env, p, key)
        cmd = [*uv, "pip", "install", "-p", str(venv_python(self.venv_dir)), "--no-deps", "-r", str(lock)]
        if "+cu" in lock.read_text():
            cmd += ["--index-strategy", "unsafe-best-match", "--extra-index-url", TORCH_INDEX]
        await self._run(cmd, env, p, key)
        (self.venv_dir / ".ready").write_text(self._engine_mark())
        p.log.append("engine ready")

    async def _run(self, cmd: list[str], env: dict[str, str], p: Progress, key: str) -> None:
        proc = await asyncio.create_subprocess_exec(*cmd, env=env, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT, **subprocess_flags())
        self._procs[key] = proc
        tail: list[str] = []
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip()
            if text:
                tail = (tail + [text])[-20:]
                p.log = (p.log + [text[:300]])[-40:]
        if await proc.wait() != 0:
            raise InstallError(f"{Path(cmd[0]).name} {' '.join(cmd[1:3])} failed: " + " | ".join(tail[-5:]))

    async def _download(self, m: catalog.ImageModel, p: Progress) -> None:
        p.state, p.message = "weights", "listing files"
        todo = [f for f in m.files if not self.file_ready(f)]
        p.total_bytes = sum(f.size for f in todo)
        p.done_bytes = 0
        done = 0
        for f in todo:
            p.message = f.name
            await self._fetch(m.id, f, p, done)
            if not self.file_ready(f):
                raise InstallError(f"{f.name} came out the wrong size")
            done += f.size
            p.done_bytes = done
        p.log.append(f"{m.id}: {p.total_bytes / 1e9:.2f} GB")

    async def _fetch(self, key: str, f: catalog.FileSpec, p: Progress, base: int) -> None:
        """one file in a child process (a stalled transfer is killed after 90 s without progress and retried)"""
        stage = self.s.models_dir / ".download" / f.repo.replace("/", "__")
        dest = self.file_path(f)
        code = ("import sys; from huggingface_hub import hf_hub_download as d; "
                "print(d(sys.argv[1], sys.argv[2], revision=sys.argv[3], local_dir=sys.argv[4], "
                "endpoint=sys.argv[5] or None))")
        env = dict(os.environ, HF_HUB_DISABLE_XET="1", HF_HUB_DISABLE_PROGRESS_BARS="1")
        last = ""
        for attempt in range(1, 6):
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-c", code, f.repo, f.path, f.revision, str(stage), self.s.hf_endpoint,
                env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **subprocess_flags())
            self._procs[key] = proc
            seen, still = -1, 0.0
            while proc.returncode is None:
                try:
                    await asyncio.wait_for(proc.wait(), 2)
                    break
                except asyncio.TimeoutError:
                    pass
                part = 0
                inc = stage / ".cache" / "huggingface" / "download"
                if inc.exists():
                    for x in inc.rglob("*.incomplete"):
                        try:
                            part = max(part, x.stat().st_size)
                        except OSError:
                            pass
                p.done_bytes = base + part
                if part > seen:
                    seen, still = part, 0.0
                else:
                    still += 2
                if still >= 90:
                    proc.kill()
                    await proc.wait()
                    last = "no progress for 90 s"
                    break
            if proc.returncode == 0:
                got = Path((await proc.stdout.read()).decode().strip().splitlines()[-1]) if proc.stdout else None
                if got and got.is_file():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(got, dest)
                    return
            elif proc.stderr is not None:
                err = (await proc.stderr.read()).decode(errors="replace").strip().splitlines()
                last = err[-1][:300] if err else f"exit {proc.returncode}"
            p.log.append(f"{f.name}: {last} ({attempt}/5)")
            await asyncio.sleep(min(30, 3 * attempt))
        raise InstallError(f"Could not download {f.name}: {last}")

    # ── remove ──
    def remove(self, m: catalog.ImageModel) -> int:
        """this model's files that no other installed model needs → the bytes freed"""
        keep = {f.key for other in catalog.CATALOG if other.id != m.id and self.installed(other) for f in other.files}
        freed = 0
        for f in m.files:
            if f.key in keep:
                continue
            path = self.file_path(f)
            if path.is_file():
                freed += path.stat().st_size
                path.unlink()
        (self.s.models_dir / f".fake-{m.id}").unlink(missing_ok=True)
        return freed
