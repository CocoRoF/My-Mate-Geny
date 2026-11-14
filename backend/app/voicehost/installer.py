"""모델 받기 — Get a model: its engine runtime (a Python environment) and its weights, installed on demand.

Runtimes are installed from lock files frozen from environments benchmarked on an RTX 5070 (app/voicehost/runtimes/
*.txt), with uv, into the runtimes dir, made from the backend's own interpreter (CPython 3.12, as the lock files are).
All runtimes share uv's cache on that disk, so torch and the CUDA libraries are downloaded once and hard-linked into
each environment. CosyVoice is not a pip package: its runtime also gets a pinned archive of its source and of its
Matcha-TTS submodule (no git needed). Weights are only the files the runtime reads (catalog include/exclude), into the
models dir, each file in a killable child process (a stalled transfer is retried; a thread could not be stopped); the
revision that was downloaded is recorded. Both dirs belong on the fastest local disk: load time is mostly reading
weights (measured 180 MB/s HDD vs ~2 GB/s NVMe).

Nothing is downloaded before the user has seen the model's license and accepted it (recorded with the time).
"""

from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import io
import json
import logging
import os
import shutil
import sys
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.portability import subprocess_flags

from . import catalog, system
from .settings import VoiceSettings

log = logging.getLogger("app.voicehost.installer")

TORCH_INDEX = "https://download.pytorch.org/whl/cu128"  # torch for CUDA 12.8: Linux and Windows (macOS: PyPI's)
# CosyVoice's source and its Matcha-TTS submodule, pinned (the runtime was benchmarked with exactly these)
COSYVOICE_REV = "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
MATCHA_REV = "dd9105b34bf2be2230f4aa1e4769fb586a3c824e"
SOURCES = {
    "cosy": (("CosyVoice", f"https://codeload.github.com/FunAudioLLM/CosyVoice/zip/{COSYVOICE_REV}"),
             ("CosyVoice/third_party/Matcha-TTS",
              f"https://codeload.github.com/shivammehta25/Matcha-TTS/zip/{MATCHA_REV}")),
}


@dataclass(frozen=True)
class Runtime:
    name: str
    engines: tuple[str, ...]
    lock: str
    download_gb: float  # first install only; later runtimes reuse the shared cache
    disk_gb: float      # the environment on disk once installed (the shared cache counted once)


RUNTIMES = (
    Runtime("qwen", ("qwen3_tts", "whisper"), "qwen.txt", 3.7, 7.5),
    Runtime("omni", ("omnivoice",), "omni.txt", 3.7, 7.5),
    Runtime("cosy", ("cosyvoice3",), "cosy.txt", 3.9, 8.0),
)
RUNTIME_OF = {e: r for r in RUNTIMES for e in r.engines}


@dataclass
class Progress:
    state: str = "idle"  # idle | queued | runtime | source | weights | done | error | cancelled
    message: str = ""
    done_bytes: int = 0
    total_bytes: int = 0
    started_at: float = 0.0
    error: str = ""
    log: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        frac = self.done_bytes / self.total_bytes if self.total_bytes else None
        return {"state": self.state, "message": self.message, "done_bytes": self.done_bytes,
                "total_bytes": self.total_bytes, "fraction": frac, "started_at": self.started_at,
                "error": self.error, "log": self.log[-8:]}


class InstallError(Exception):
    pass


def _dir_size(p: Path) -> int:
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def venv_python(d: Path) -> Path:
    return d / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


class Installer:
    def __init__(self, settings: VoiceSettings, store) -> None:
        self.s = settings
        self.store = store
        self.progress: dict[str, Progress] = {}
        self._lock = asyncio.Lock()
        self._tasks: dict[str, asyncio.Task] = {}
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self.on_change = lambda model_id: None  # (the service tells every open window)

    # -- state --------------------------------------------------------------------------------------------------
    def lock_path(self, rt: Runtime) -> Path:
        """this platform's lock file: runtimes/<name>.<platform>.txt (Windows, macOS), runtimes/<name>.txt (Linux)"""
        own = self.s.runtimes_spec_dir / rt.lock.replace(".txt", f".{system.platform_key()}.txt")
        return own if own.exists() else self.s.runtimes_spec_dir / rt.lock

    def _lock_hash(self, rt: Runtime) -> str:
        try:
            h = hashlib.sha256(self.lock_path(rt).read_bytes())
            for _, url in SOURCES.get(rt.name, ()):
                h.update(url.encode())
            return h.hexdigest()[:16]
        except OSError:
            return ""

    def runtime_dir(self, rt: Runtime) -> Path:
        return self.s.runtimes_dir / rt.name

    def source_dir(self, rt: Runtime) -> Path:
        return self.s.runtimes_dir / "src" / rt.name

    def runtime_ready(self, rt: Runtime) -> bool:
        marker = self.runtime_dir(rt) / ".ready"
        try:
            return marker.read_text().strip() == self._lock_hash(rt)
        except OSError:
            return False

    def python_for(self, engine: str) -> str | None:
        if engine in self.s.engine_python:
            return self.s.engine_python[engine]
        rt = RUNTIME_OF.get(engine)
        if rt is None or not self.runtime_ready(rt):
            return None
        return str(venv_python(self.runtime_dir(rt)))

    def worker_env(self, engine: str) -> dict[str, str]:
        rt = RUNTIME_OF.get(engine)
        if rt is not None and rt.name in SOURCES:
            return {"GENY_VOICE_COSYVOICE_SRC": str(self.source_dir(rt) / "CosyVoice")}
        return {}

    def model_dir(self, spec: catalog.ModelSpec) -> Path:
        return self.s.models_dir / spec.id

    def weights_ready(self, spec: catalog.ModelSpec) -> bool:
        return (self.model_dir(spec) / ".complete.json").exists()

    def installed(self, spec: catalog.ModelSpec) -> bool:
        if self.s.engine_mode == "fake":
            return self.weights_ready(spec)
        return self.weights_ready(spec) and self.python_for(spec.engine) is not None

    def downloaded(self, spec: catalog.ModelSpec) -> dict[str, Any]:
        try:
            return json.loads((self.model_dir(spec) / ".complete.json").read_text())
        except (OSError, ValueError):
            return {}

    def status(self, spec: catalog.ModelSpec) -> dict[str, Any]:
        p = self.progress.get(spec.id)
        rt = RUNTIME_OF.get(spec.engine)
        done = self.downloaded(spec)
        return {
            "installed": self.installed(spec),
            "weights_ready": self.weights_ready(spec),
            "runtime": rt.name if rt else None,
            "runtime_ready": bool(rt and (self.s.engine_mode == "fake" or self.python_for(spec.engine))),
            "disk_bytes": int(done.get("bytes") or 0),
            "revisions": done.get("revisions") or {},
            "installed_at": done.get("at"),
            "license_accepted": self.store.license_record(spec.id),
            "progress": p.to_dict() if p else None,
        }

    def need_bytes(self, spec: catalog.ModelSpec) -> int:
        """what an install would still put on disk (with room for unpacking)"""
        need = 0 if self.weights_ready(spec) else int(spec.download_gb * system.GiB * 1.1)
        rt = RUNTIME_OF.get(spec.engine)
        if rt and self.s.engine_mode != "fake" and spec.engine not in self.s.engine_python and not self.runtime_ready(rt):
            cached = (self.s.runtimes_dir / ".uv-cache").exists()
            need += int((rt.disk_gb * 0.3 if cached else rt.disk_gb) * system.GiB)
        return need

    # -- install ------------------------------------------------------------------------------------------------
    def busy(self, model_id: str) -> bool:
        t = self._tasks.get(model_id)
        return bool(t and not t.done())

    def start(self, spec: catalog.ModelSpec) -> Progress:
        if self.busy(spec.id):
            return self.progress[spec.id]
        p = Progress(state="queued", message="queued", started_at=time.time())
        self.progress[spec.id] = p
        self._tasks[spec.id] = asyncio.create_task(self._install(spec, p))
        return p

    def cancel(self, model_id: str) -> bool:
        t = self._tasks.get(model_id)
        if not t or t.done():
            return False
        proc = self._procs.get(model_id)
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        t.cancel()
        return True

    async def close(self) -> None:
        """The app is stopping: an install in progress stops with it (its uv or download process killed — never left
        running on its own); the next start shows it cancelled, and installing again picks up the files it has."""
        procs = [pr for pr in self._procs.values() if pr.returncode is None]
        running = [t for mid, t in self._tasks.items() if not t.done() and self.cancel(mid)]
        if running:
            await asyncio.wait(running, timeout=10)
        for pr in procs:  # (killed by cancel: reaped here, not left a zombie)
            try:
                await asyncio.wait_for(pr.wait(), 5)
            except (asyncio.TimeoutError, ProcessLookupError):
                pass

    async def _install(self, spec: catalog.ModelSpec, p: Progress) -> None:
        async with self._lock:  # one install at a time: disk and network are shared
            try:
                self._check_room(spec)
                rt = RUNTIME_OF.get(spec.engine)
                if self.s.engine_mode != "fake" and rt and spec.engine not in self.s.engine_python \
                        and not self.runtime_ready(rt):
                    await self._install_runtime(rt, p, spec.id)
                if not self.weights_ready(spec):
                    await self._download(spec, p)
                p.state, p.message = "done", "installed"
                p.done_bytes = p.total_bytes
            except asyncio.CancelledError:
                p.state, p.error, p.message = "cancelled", "cancelled", "cancelled"
                self.on_change(spec.id)
                raise
            except Exception as e:  # noqa: BLE001 - reported to the UI
                log.exception("install %s", spec.id)
                p.state, p.error = "error", (str(e) if isinstance(e, InstallError) else f"{type(e).__name__}: {e}")
                p.message = "failed"
            finally:
                self._procs.pop(spec.id, None)
            self.on_change(spec.id)

    def _check_room(self, spec: catalog.ModelSpec) -> None:
        need = self.need_bytes(spec)
        for d in {self.s.models_dir, self.s.runtimes_dir}:
            d.mkdir(parents=True, exist_ok=True)
        free = min(system.disk(self.s.models_dir)["free"], system.disk(self.s.runtimes_dir)["free"])
        if need and free and free < need + 2 * system.GiB:
            raise InstallError(f"Not enough disk space: about {need / system.GiB:.1f} GB more is needed and "
                               f"{free / system.GiB:.1f} GB is free.")

    async def _install_runtime(self, rt: Runtime, p: Progress, model_id: str) -> None:
        if sys.version_info[:2] != (3, 12):
            raise InstallError(f"The engine environments need Python 3.12; this server runs "
                               f"{sys.version_info[0]}.{sys.version_info[1]}.")
        uv = self.s.uv()
        if not uv:
            raise InstallError("uv is not available on this server (pip install uv).")
        lock = self.lock_path(rt)
        if not lock.exists():
            raise InstallError(f"lock file missing: {lock}")
        if rt.name in SOURCES:
            await self._fetch_sources(rt, p)
        d = self.runtime_dir(rt)
        cache = self.s.runtimes_dir / ".uv-cache"
        if d.exists():
            shutil.rmtree(d)
        p.state, p.message = "runtime", f"runtime {rt.name}"
        p.total_bytes = int(rt.download_gb * system.GiB)
        p.done_bytes = 0
        cache_before = _dir_size(cache) if cache.exists() else 0
        env = dict(os.environ, UV_CACHE_DIR=str(cache), UV_LINK_MODE="hardlink", UV_PYTHON_DOWNLOADS="never")
        env.pop("VIRTUAL_ENV", None)
        await self._run([*uv, "venv", "-q", "-p", self.s.python, str(d)], env, p, model_id)

        async def watch() -> None:
            while True:
                await asyncio.sleep(2)
                grown = (_dir_size(cache) if cache.exists() else 0) - cache_before
                p.done_bytes = min(max(grown, 0), p.total_bytes)

        w = asyncio.create_task(watch())
        try:
            cmd = [*uv, "pip", "install", "-p", str(venv_python(d)), "--no-deps", "-r", str(lock)]
            if "+cu" in lock.read_text():  # (CUDA builds of torch: their own index; a Mac's torch is on PyPI)
                cmd += ["--index-strategy", "unsafe-best-match", "--extra-index-url", TORCH_INDEX]
            bc = self.s.runtimes_spec_dir / "build-constraints.txt"
            if bc.exists():
                cmd += ["--build-constraint", str(bc)]
            await self._run(cmd, env, p, model_id)
        finally:
            w.cancel()
        (d / ".ready").write_text(self._lock_hash(rt))
        p.log.append(f"runtime {rt.name} ready")

    async def _fetch_sources(self, rt: Runtime, p: Progress) -> None:
        """the engine's own source, pinned: GitHub archives unpacked into runtimes/src/<runtime>"""
        import httpx

        root = self.source_dir(rt)
        marker = root / ".ready"
        want = "\n".join(u for _, u in SOURCES[rt.name])
        if marker.exists() and marker.read_text() == want:
            return
        p.state, p.message = "source", f"source {rt.name}"
        stage = root.with_name(root.name + ".partial")
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir(parents=True)
        async with httpx.AsyncClient(follow_redirects=True, timeout=120) as client:
            for sub, url in SOURCES[rt.name]:
                p.log.append(f"source {url.rsplit('/', 3)[-3]}")
                r = await client.get(url)
                r.raise_for_status()
                if len(r.content) > 300 * 1024 * 1024:
                    raise InstallError("source archive too large")
                dest = stage / sub
                with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                    names = z.namelist()
                    top = names[0].split("/", 1)[0] + "/"
                    for n in names:
                        if not n.startswith(top) or n.endswith("/"):
                            continue
                        rel = n[len(top):]
                        if not rel or rel.startswith(("asset/", ".git")) or ".." in Path(rel).parts:
                            continue
                        out = dest / rel
                        out.parent.mkdir(parents=True, exist_ok=True)
                        with z.open(n) as src, open(out, "wb") as f:
                            shutil.copyfileobj(src, f)
        shutil.rmtree(root, ignore_errors=True)
        stage.rename(root)
        marker.write_text(want)

    async def _run(self, cmd: list[str], env: dict[str, str], p: Progress, model_id: str) -> None:
        proc = await asyncio.create_subprocess_exec(*cmd, env=env, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT, **subprocess_flags())
        self._procs[model_id] = proc
        tail: list[str] = []
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip()
            if text:
                tail.append(text)
                del tail[:-20]
                p.log.append(text[:300])
                del p.log[:-40]
        code = await proc.wait()
        if code != 0:
            raise InstallError(f"{os.path.basename(cmd[0])} {' '.join(cmd[1:3])} failed ({code}): "
                               + " | ".join(tail[-5:]))

    def _plan(self, spec: catalog.ModelSpec) -> list[tuple[catalog.RepoFiles, str, list[tuple[str, int]]]]:
        from huggingface_hub import HfApi

        api = HfApi(endpoint=self.s.hf_endpoint or None)
        plan = []
        for repo in spec.repos:
            info = api.model_info(repo.repo_id, revision=repo.revision, files_metadata=True)
            files = []
            for sib in info.siblings or []:
                name = sib.rfilename
                if repo.include and not any(fnmatch.fnmatch(name, pat) for pat in repo.include):
                    continue
                if any(fnmatch.fnmatch(name, pat) for pat in repo.exclude):
                    continue
                files.append((name, int(sib.size or 0)))
            # (the exact commit: every file comes from it, and it is recorded)
            plan.append((repo, info.sha or repo.revision, files))
        return plan

    async def _fetch(self, model_id: str, repo: catalog.RepoFiles, revision: str, name: str, dest: Path, p: Progress,
                     base: int) -> None:
        """One file in a child process, so a stalled transfer can be killed and retried (a thread cannot).

        Plain HTTP (HF_HUB_DISABLE_XET): the xet client once stalled for 25 min at 470 MB without failing.
        """
        inc_dir = dest / ".cache" / "huggingface" / "download"
        code = ("import sys; from huggingface_hub import hf_hub_download as d; "
                "d(sys.argv[1], sys.argv[2], revision=sys.argv[3], local_dir=sys.argv[4], endpoint=sys.argv[5] or None)")
        env = dict(os.environ, HF_HUB_DISABLE_XET="1", HF_HUB_DISABLE_PROGRESS_BARS="1")
        last_err = ""
        for attempt in range(1, 6):
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-c", code, repo.repo_id, name, revision, str(dest), self.s.hf_endpoint,
                env=env, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE, **subprocess_flags())
            self._procs[model_id] = proc
            seen, still = -1, 0.0
            while proc.returncode is None:
                try:
                    await asyncio.wait_for(proc.wait(), 2)
                    break
                except asyncio.TimeoutError:
                    pass
                part = 0
                if inc_dir.exists():
                    for f in inc_dir.rglob("*.incomplete"):
                        try:
                            part = max(part, f.stat().st_size)
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
                    last_err = "no progress for 90 s: retrying"
                    break
            if proc.returncode == 0 and (dest / name).exists():
                return
            if proc.returncode not in (None, 0, -9):
                err = (await proc.stderr.read()).decode(errors="replace").strip().splitlines() if proc.stderr else []
                last_err = err[-1][:300] if err else f"exit {proc.returncode}"
            p.log.append(f"{name}: {last_err} ({attempt}/5)")
            p.message = f"{name} (retry {attempt}/5)"
            await asyncio.sleep(min(30, 3 * attempt))
        raise InstallError(f"Could not download {name}: {last_err}")

    async def _download(self, spec: catalog.ModelSpec, p: Progress) -> None:
        p.state, p.message = "weights", "listing files"
        plan = await asyncio.to_thread(self._plan, spec)
        target = self.model_dir(spec)
        target.mkdir(parents=True, exist_ok=True)
        p.total_bytes = sum(sz for _, _, files in plan for _, sz in files)
        p.done_bytes = 0
        finished = 0
        for repo, revision, files in plan:
            dest = target / repo.subdir if repo.subdir else target
            for name, size in files:
                path = dest / name
                if not (path.exists() and path.stat().st_size == size):
                    p.message = name
                    await self._fetch(spec.id, repo, revision, name, dest, p, finished)
                finished += size
                p.done_bytes = finished
        shutil.rmtree(target / ".cache", ignore_errors=True)
        (target / ".complete.json").write_text(json.dumps({
            "model_id": spec.id, "repos": [r.repo_id for r, _, _ in plan],
            "revisions": {r.repo_id: rev for r, rev, _ in plan}, "files": sum(len(f) for _, _, f in plan),
            "bytes": p.total_bytes, "at": time.time()}))
        p.log.append(f"weights {spec.id} ready ({p.total_bytes / system.GiB:.2f} GiB)")

    # -- remove -------------------------------------------------------------------------------------------------
    def remove(self, spec: catalog.ModelSpec) -> dict[str, Any]:
        freed = 0
        d = self.model_dir(spec)
        if d.exists():
            freed += _dir_size(d)
            shutil.rmtree(d)
        removed_runtime = None
        rt = RUNTIME_OF.get(spec.engine)
        if rt and spec.engine not in self.s.engine_python:
            still_used = any(self.weights_ready(m) for m in catalog.CATALOG if RUNTIME_OF.get(m.engine) == rt)
            if not still_used and self.runtime_dir(rt).exists():
                freed += _dir_size(self.runtime_dir(rt))
                shutil.rmtree(self.runtime_dir(rt))
                shutil.rmtree(self.source_dir(rt), ignore_errors=True)
                removed_runtime = rt.name
            if not any(self.runtime_dir(r).exists() for r in RUNTIMES):
                cache = self.s.runtimes_dir / ".uv-cache"
                if cache.exists():
                    freed += _dir_size(cache)
                    shutil.rmtree(cache, ignore_errors=True)
        self.progress.pop(spec.id, None)
        return {"freed_bytes": freed, "removed_runtime": removed_runtime}
