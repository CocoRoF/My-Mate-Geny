"""Training a voice, the server's side (docs/local-voice.md "Training a voice"): the recordings of one person → a LoRA
adapter for a speech model (OmniVoice, Qwen3-TTS, CosyVoice3) that the voice then speaks with on that model. The run
itself is app/voicehost/train (its own process in the model's runtime); here: the runs (voice_trainings — one per model;
those started together share the recordings, and what was heard in them once), the queue, what a run needs (the
model, Whisper's weights, the speaker check), room on the GPU, and the GPU's other users.

- One run at a time. It waits while a call holds its models or the GPU is short; it pauses (computing stops, the GPU
  stays) while a mate speaks; when the GPU memory is wanted — a model to load, an image job — it saves where it is and
  leaves (``released``), and goes on from there once the GPU is free again. A restart of the server goes on the same way.
- When it is done and the adapter is better than the voice without it, the adapter is put on the voice for that
  model (voice_adapters): the voice speaks with it there (the models it wasn't trained for clone from its clips as
  before); it can be taken off or removed.
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from app.portability import subprocess_flags
from app.services._ids import new_id, now_iso

from . import audio, catalog, system
from .train import PREFIX
from .workerproc import SRC_ROOT, _capped

log = logging.getLogger("app.voicehost.training")
GiB = system.GiB

STT_ID = "whisper-large-v3-turbo"
# the models that learn a voice, and what each takes on the GPU while it trains (measured at most on an RTX 5070, and
# some room): docs/local-voice.md "Training a voice"
NEED_GB = {"omnivoice": 6.0, "qwen3-tts-0.6b-base": 6.0, "qwen3-tts-1.7b-base": 8.0, "cosyvoice3-0.5b": 8.0}
HOST_GB = 12           # its process's memory ceiling (Whisper and OmniVoice in fp32, her data)
MIN_SECONDS = 60.0     # less of her than this isn't worth a run
CALM_S = 20.0          # a mate's words this recent: not yet (it would only pause again)
STATES = ("queued", "waiting", "running", "released", "done", "failed", "canceled", "interrupted")
ACTIVE = ("queued", "waiting", "running", "released")


class TrainingError(Exception):
    def __init__(self, message: str, code: str = "error", status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class Trainings:
    def __init__(self, host) -> None:
        self.h = host
        self.s = host.s
        self.db = host.store.db
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS voice_trainings(id TEXT PRIMARY KEY, voice_id TEXT NOT NULL, "
            "model_id TEXT NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', language TEXT NOT NULL "
            "DEFAULT 'auto', inputs TEXT NOT NULL DEFAULT '[]', progress TEXT NOT NULL DEFAULT '{}', data TEXT NOT NULL "
            "DEFAULT '{}', result TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT "
            "'', created_at TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT '', finished_at TEXT NOT NULL DEFAULT '')")
        if "group_id" not in {r[1] for r in self.db.query("PRAGMA table_info(voice_trainings)")}:
            self.db.execute("ALTER TABLE voice_trainings ADD COLUMN group_id TEXT NOT NULL DEFAULT ''")
        # the run whose adapter a voice speaks with, on each model
        self.db.execute("CREATE TABLE IF NOT EXISTS voice_adapters(voice_id TEXT NOT NULL, model_id TEXT NOT NULL, "
                        "run_id TEXT NOT NULL, PRIMARY KEY(voice_id, model_id))")
        have = {r[1] for r in self.db.query("PRAGMA table_info(voice_voices)")}
        if "adapter" in have:  # (OmniVoice's, from before every model learned: kept where it was put)
            for v in self.db.query("SELECT id, adapter FROM voice_voices WHERE adapter != ''"):
                self.db.execute("INSERT OR IGNORE INTO voice_adapters(voice_id, model_id, run_id) VALUES(?,?,?)",
                                (v["id"], "omnivoice", v["adapter"]))
            self.db.execute("UPDATE voice_voices SET adapter='' WHERE adapter != ''")
        self._task: asyncio.Task | None = None
        self._watch: asyncio.Task | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._current = ""
        self._wake = asyncio.Event()
        self._paused = False
        self._last_word = 0.0       # (the last time a mate spoke: interactive jobs)
        self._speaking = 0
        self._exited: asyncio.Event | None = None
        self.events: dict[str, collections.deque] = {}

    @property
    def root(self) -> Path:
        return self.s.home / "training"

    def run_dir(self, rid: str) -> Path:
        return self.root / rid

    # -- lifecycle --------------------------------------------------------------------------------------------------
    def start(self) -> None:
        # (the server stopped under a run: it goes on from its saved step, or starts over from its recordings)
        for r in self.db.query("SELECT id FROM voice_trainings WHERE state IN ('running','waiting')"):
            self._set(r["id"], state="released" if (self.run_dir(r["id"]) / "state" / "state.json").exists() else "queued")
        self._task = asyncio.create_task(self._loop())
        self._watch = asyncio.create_task(self._watch_loop())

    async def close(self) -> None:
        for t in (self._task, self._watch):
            if t:
                t.cancel()
        await self._leave("release", wait=20)

    # -- the runs ---------------------------------------------------------------------------------------------------
    def _row(self, r) -> dict[str, Any]:
        d = dict(r)
        for k in ("inputs", "progress", "data", "result"):
            try:
                d[k] = json.loads(d[k] or "{}")
            except ValueError:
                d[k] = {} if k != "inputs" else []
        v = self.db.query_one("SELECT name FROM voice_voices WHERE id=?", (d["voice_id"],))
        d["voice_name"] = v["name"] if v else ""
        spec = catalog.BY_ID.get(d["model_id"])
        d["model_name"] = spec.name if spec else d["model_id"]
        d["applied"] = self.adapters(d["voice_id"]).get(d["model_id"]) == d["id"]
        d["samples"] = sorted(p.name for p in (self.run_dir(d["id"]) / "samples").glob("*.wav")) \
            if (self.run_dir(d["id"]) / "samples").is_dir() else []
        if d["stage"] == "kit" and d["state"] in ACTIVE:  # (what it fetches: how far)
            key = {"stt": STT_ID, "speaker": catalog.SPEAKER_CHECK.id}.get(d["progress"].get("what") or "", "")
            got = self.h.installer.progress.get(key)
            if got is not None and got.total_bytes:
                d["progress"] = {**d["progress"], "done_bytes": got.done_bytes, "total_bytes": got.total_bytes}
        return d

    def list(self, voice_id: str = "") -> list[dict[str, Any]]:
        q, args = "SELECT * FROM voice_trainings", ()
        if voice_id:
            q, args = q + " WHERE voice_id=?", (voice_id,)
        return [self._row(r) for r in self.db.query(q + " ORDER BY created_at DESC", args)]

    def get(self, rid: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM voice_trainings WHERE id=?", (rid,))
        if r is None:
            return None
        d = self._row(r)
        d["events"] = list(self.events.get(rid, ()))
        return d

    def _set(self, rid: str, **kw: Any) -> None:
        for k in ("inputs", "progress", "data", "result"):
            if k in kw and not isinstance(kw[k], str):
                kw[k] = json.dumps(kw[k], ensure_ascii=False)
        cols = ", ".join(f"{k}=?" for k in kw)
        self.db.execute(f"UPDATE voice_trainings SET {cols} WHERE id=?", (*kw.values(), rid))
        self.h.on_change(f"training:{rid}")

    def kit(self) -> dict[str, Any]:
        """what a run needs and whether it is here (the Train page: the models that can learn, what it will fetch)"""
        stt = catalog.BY_ID[STT_ID]
        ins = self.h.installer
        models = [{"id": mid, "name": catalog.BY_ID[mid].name, "installed": ins.installed(catalog.BY_ID[mid]),
                   "need_gb": gb} for mid, gb in NEED_GB.items() if mid in catalog.BY_ID]
        return {"models": models,
                "stt": {"id": STT_ID, "ready": ins.weights_ready(stt), "gb": stt.download_gb, "license": stt.license.name},
                "speaker": {"ready": ins.weights_ready(catalog.SPEAKER_CHECK), "gb": catalog.SPEAKER_CHECK.download_gb,
                            "license": catalog.SPEAKER_CHECK.license.name},
                "min_seconds": MIN_SECONDS}

    def adapters(self, voice_id: str) -> dict[str, str]:
        """{model id: the run whose adapter the voice speaks with there}"""
        return {r["model_id"]: r["run_id"]
                for r in self.db.query("SELECT model_id, run_id FROM voice_adapters WHERE voice_id=?", (voice_id,))}

    async def create(self, *, voice_id: str, files: list[tuple[str, bytes]], language: str = "",
                     accept_licenses: bool = False, model_ids: list[str] | None = None) -> list[dict[str, Any]]:
        """a run for each model (empty: every installed one that learns) for a voice, from these recordings (audio or
        video, any length) and the voice's own clips; they go one after another, the recordings heard once. What it
        fetches the first time (Whisper's weights, the speaker check) is fetched once its licenses are accepted."""
        need = [s for s in (catalog.BY_ID[STT_ID], catalog.SPEAKER_CHECK)
                if not self.h.installer.weights_ready(s) and not self.h.store.license_record(s.id)]
        if need and not accept_licenses and self.s.engine_mode != "fake":
            raise TrainingError("Accept the licenses of what training fetches first: "
                                + ", ".join(f"{s.name} ({s.license.name})" for s in need), "license", 409)
        for s in need:
            self.h.store.accept_license(s.id, s.license.name, s.license.url)
        v = self.h.voices.get(voice_id)
        if v is None or v.get("builtin"):
            raise TrainingError("Pick one of your voices (or make one) to train", "no_voice", 404)
        ins = self.h.installer
        wanted = [m for m in dict.fromkeys(model_ids or []) if m]
        for m in wanted:
            if m not in NEED_GB or m not in catalog.BY_ID:
                raise TrainingError(f"{m} can't learn a voice", "not_trainable", 400)
            if not ins.installed(catalog.BY_ID[m]):
                raise TrainingError(f"Training needs {catalog.BY_ID[m].name}: install it first (Models)", "needs_model", 409)
        if not wanted:
            wanted = [m for m in NEED_GB if m in catalog.BY_ID and ins.installed(catalog.BY_ID[m])]
        if not wanted:
            raise TrainingError("Training needs a speech model that learns (OmniVoice, Qwen3-TTS, CosyVoice3): "
                                "install one first (Models)", "needs_model", 409)
        busy = {r["model_id"] for r in self.list(voice_id) if r["state"] in ACTIVE}
        if busy & set(wanted):
            raise TrainingError("This voice is already being trained", "busy", 409)
        rid = new_id("vt")
        d = self.run_dir(rid)
        (d / "inputs").mkdir(parents=True, exist_ok=True)
        inputs, total = [], 0.0
        try:
            for i, (name, data) in enumerate(files):
                try:
                    x, _ = await asyncio.to_thread(audio.decode, data, audio.REF_SR)
                except Exception as e:  # noqa: BLE001 - a file it can't read is said by name
                    raise TrainingError(f"{name}: can't be read as audio ({e})", "bad_audio") from None
                p = d / "inputs" / f"in{i:03d}.wav"
                await asyncio.to_thread(_write, p, x)
                inputs.append({"name": name, "file": p.name, "seconds": round(len(x) / audio.REF_SR, 1)})
                total += len(x) / audio.REF_SR
            for ref in v.get("references") or []:  # (her clips are her too)
                f = self.h.voices.reference_file(voice_id, ref["id"])
                if f is not None and ref.get("label") not in ("laugh", "yawn"):
                    p = d / "inputs" / f"ref-{ref['id']}.wav"
                    shutil.copyfile(f, p)
                    inputs.append({"name": f"{ref.get('label')}.wav", "file": p.name, "seconds": round(ref.get("duration") or 0, 1),
                                   "clip": True})
                    total += float(ref.get("duration") or 0)
        except BaseException:
            shutil.rmtree(d, ignore_errors=True)
            raise
        if total < MIN_SECONDS:
            shutil.rmtree(d, ignore_errors=True)
            raise TrainingError(f"Too short: {total:.0f} s of recordings — at least {MIN_SECONDS:.0f} s (3 minutes or "
                                f"more is better)", "too_short")
        lang = language or v.get("language") or "auto"
        made = []
        for i, mid in enumerate(wanted):  # (the first run keeps the recordings; the others link to them)
            run = rid if i == 0 else new_id("vt")
            if run != rid:
                (self.run_dir(run) / "inputs").mkdir(parents=True, exist_ok=True)
                for inp in inputs:
                    _link(d / "inputs" / inp["file"], self.run_dir(run) / "inputs" / inp["file"])
            self.db.execute("INSERT INTO voice_trainings(id, voice_id, model_id, state, language, inputs, created_at, "
                            "group_id) VALUES(?,?,?,?,?,?,?,?)", (run, voice_id, mid, "queued", lang,
                                                                  json.dumps(inputs, ensure_ascii=False), now_iso(), rid))
            self.h.on_change(f"training:{run}")
            made.append(run)
        self._wake.set()
        return [self.get(r) for r in made]  # type: ignore[misc]

    async def cancel(self, rid: str) -> dict[str, Any]:
        r = self.get(rid)
        if r is None:
            raise TrainingError("No such training", "gone", 404)
        if r["state"] not in ACTIVE:
            return r
        if self._current == rid:
            await self._leave("stop", wait=30)
        self._set(rid, state="canceled", finished_at=now_iso())
        shutil.rmtree(self.run_dir(rid) / "state", ignore_errors=True)
        return self.get(rid)  # type: ignore[return-value]

    async def delete(self, rid: str) -> None:
        r = self.get(rid)
        if r is None:
            raise TrainingError("No such training", "gone", 404)
        if r["state"] in ACTIVE:
            await self.cancel(rid)
        self.db.execute("DELETE FROM voice_adapters WHERE run_id=?", (rid,))
        self.db.execute("DELETE FROM voice_trainings WHERE id=?", (rid,))
        shutil.rmtree(self.run_dir(rid), ignore_errors=True)
        self.events.pop(rid, None)
        self.h.on_change(f"training:{rid}")

    def apply(self, rid: str, on: bool) -> dict[str, Any]:
        r = self.get(rid)
        if r is None:
            raise TrainingError("No such training", "gone", 404)
        if on and not (self.run_dir(rid) / "adapter" / "adapter_config.json").exists():
            raise TrainingError("This training has no adapter to use", "no_adapter", 409)
        if on:
            self.db.execute("INSERT INTO voice_adapters(voice_id, model_id, run_id) VALUES(?,?,?) ON CONFLICT(voice_id, "
                            "model_id) DO UPDATE SET run_id=excluded.run_id", (r["voice_id"], r["model_id"], rid))
        else:
            self.db.execute("DELETE FROM voice_adapters WHERE voice_id=? AND model_id=? AND run_id=?",
                            (r["voice_id"], r["model_id"], rid))
        self.h.on_change(f"voice:{r['voice_id']}")
        return self.get(rid)  # type: ignore[return-value]

    def adapter_for(self, voice_id: str, spec: catalog.ModelSpec) -> tuple[str, str] | None:
        """(run id, adapter dir) the voice speaks with on this model, or None: only an adapter made for this model, from
        the revision installed now (one from an older revision would not fit it)"""
        if spec.id not in NEED_GB or not voice_id:
            return None
        rid = self.adapters(voice_id).get(spec.id, "")
        if not rid:
            return None
        a = self.run_dir(rid) / "adapter"
        try:
            meta = json.loads((a / "geny.json").read_text())
        except (OSError, ValueError):
            return None
        if meta.get("model_id", spec.id) != spec.id:
            return None
        rev = (self.h.installer.downloaded(spec).get("revisions") or {}).get(spec.repos[0].repo_id, "")
        if meta.get("base_revision") and rev and not rev.startswith(meta["base_revision"]):
            return None
        return rid, str(a)

    def sample(self, rid: str, name: str) -> Path | None:
        if "/" in name or "\\" in name or not name.endswith(".wav"):
            return None
        p = self.run_dir(rid) / "samples" / name
        return p if p.is_file() else None

    # -- the GPU's other users ------------------------------------------------------------------------------------
    def speaking(self, on: bool) -> None:
        """a mate's words are being made (GpuQueue, interactive jobs): the run pauses meanwhile"""
        self._speaking = max(0, self._speaking + (1 if on else -1))
        self._last_word = time.time()
        if on:
            self._say("pause")

    async def release_gpu(self) -> bool:
        """EngineManager.others: a voice model can't find room — the run leaves the GPU (saving where it is)"""
        if not self._proc or self._proc.returncode is not None:
            return False
        await self._leave("release", wait=30)
        return True

    async def make_room_for(self, need: int) -> None:
        """the image host's make_room: an image job wants ``need`` bytes"""
        gpu = self.h.engines._gpu()
        if gpu is not None and gpu.free < need:
            await self.release_gpu()

    def _say(self, word: str) -> None:
        p = self._proc
        if p is None or p.returncode is not None or p.stdin is None:
            return
        try:
            p.stdin.write((word + "\n").encode())
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            return
        if word in ("pause", "resume"):
            self._paused = word == "pause"

    async def _leave(self, word: str, wait: float) -> None:
        p, ev = self._proc, self._exited
        if p is None or p.returncode is not None:
            return
        self._say(word)
        try:
            if ev is not None:
                await asyncio.wait_for(ev.wait(), wait)
            else:
                await asyncio.wait_for(p.wait(), wait)
        except asyncio.TimeoutError:
            try:
                p.kill()
            except ProcessLookupError:
                pass

    async def _watch_loop(self) -> None:
        """a call holds its models: the run pauses; a mate's words over a while ago: it goes on"""
        while True:
            await asyncio.sleep(1.0)
            if self._proc is None or self._proc.returncode is not None:
                continue
            calling = any(self.h.engines.pins.values())
            busy = calling or self._speaking > 0 or time.time() - self._last_word < 3.0
            if busy and not self._paused:
                self._say("pause")
            elif not busy and self._paused:
                self._say("resume")

    # -- the queue --------------------------------------------------------------------------------------------------
    def _ready_to_run(self, need_gb: float) -> tuple[bool, str]:
        if any(self.h.engines.pins.values()):
            return False, "a call"
        if self._speaking or time.time() - self._last_word < CALM_S:
            return False, "speaking"
        gpu = self.h.engines._gpu()
        if gpu is not None and gpu.free < need_gb * GiB:
            return False, "gpu"
        return True, ""

    async def _loop(self) -> None:
        await asyncio.sleep(2)
        while True:
            try:
                await asyncio.wait_for(self._wake.wait(), 15)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()
            r = self.db.query_one("SELECT * FROM voice_trainings WHERE state IN ('queued','waiting','released') "
                                  "ORDER BY created_at, rowid LIMIT 1")  # (a group's runs in the order they were asked)
            if r is None:
                continue
            try:
                await self._one(self._row(r))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - the run ends failed, never stuck
                log.exception("training %s", r["id"])
                self._set(r["id"], state="failed", code="failed", error=str(e)[:400], finished_at=now_iso())
            finally:
                self._current = ""
                self._proc = None

    async def _kit(self, rid: str, spec: catalog.ModelSpec) -> None:
        """the model's runtime up to date (it gained the training's packages), Whisper's weights, the speaker check"""
        ins = self.h.installer
        if self.s.engine_mode == "fake":
            return
        rt = ins.runtime_of(spec.engine)
        if rt is not None and not ins.runtime_ready(rt) and spec.engine not in self.s.engine_python:
            self._set(rid, stage="kit", progress={"what": "runtime"})
            await ins.refresh_runtimes()
            if not ins.runtime_ready(rt):
                raise TrainingError(f"{spec.name}'s environment couldn't be brought up to date for training", "runtime")
        for spec, what in ((catalog.BY_ID[STT_ID], "stt"), (catalog.SPEAKER_CHECK, "speaker")):
            if not ins.weights_ready(spec):
                self._set(rid, stage="kit", progress={"what": what})
                if not await ins.ensure_weights(spec):
                    raise TrainingError(f"{spec.name} couldn't be downloaded", "download")

    async def _room(self, rid: str, need_gb: float) -> None:
        """the GPU free enough: idle voice models move out of the way; while a call or a mate's words go on, it waits"""
        waited = 0.0
        while True:
            ok, why = self._ready_to_run(need_gb)
            if not ok and why == "gpu":
                try:
                    await self.h.engines.make_room_for(int(need_gb * GiB), "room for a voice training")
                    await self.h.engines._ask_others()
                except Exception:  # noqa: BLE001
                    pass
                system.invalidate()
                ok, why = self._ready_to_run(need_gb)
            if ok:
                return
            self._set(rid, state="waiting", stage="", progress={"waiting_for": why})
            await asyncio.sleep(10)
            waited += 10

    async def _one(self, r: dict[str, Any]) -> None:
        rid = r["id"]
        self._current = rid
        spec = catalog.BY_ID.get(r["model_id"])
        if spec is None or r["model_id"] not in NEED_GB:
            raise TrainingError(f"{r['model_id']} can't learn a voice", "not_trainable")
        need_gb = NEED_GB[spec.id]
        await self._kit(rid, spec)
        await self._room(rid, need_gb)
        d = self.run_dir(rid)
        v = self.h.voices.get(r["voice_id"]) or {}
        ref = self.h.voices.resolve(r["voice_id"], "neutral") if v.get("references") else None
        ins = self.h.installer
        gpu = self.h.engines._gpu()
        shared = ""  # (another model's run of the same recordings has heard them)
        if r.get("group_id") and not (d / "data.json").exists():
            for o in self.db.query("SELECT id FROM voice_trainings WHERE group_id=? AND id != ?", (r["group_id"], rid)):
                if (self.run_dir(o["id"]) / "data.json").exists():
                    shared = str(self.run_dir(o["id"]) / "data.json")
                    break
        job = {"run_id": rid, "engine": spec.engine, "model_id": spec.id, "language": r["language"], "shared_data": shared,
               "inputs": [{"path": str(d / "inputs" / i["file"]), "name": i["name"], "file": i["file"]} for i in r["inputs"]],
               "model_dir": str(ins.model_dir(spec)), "whisper_dir": str(ins.model_dir(catalog.BY_ID[STT_ID])),
               "speaker_dir": str(ins.model_dir(catalog.SPEAKER_CHECK)), "out_dir": str(d),
               "vram_fraction": round(min(0.9, need_gb * GiB / gpu.total), 3) if gpu else 0.6, "seed": 42,
               "base_revision": (ins.downloaded(spec).get("revisions") or {}).get(spec.repos[0].repo_id, "")[:12],
               "reference": {"path": ref["path"], "text": ref["text"]} if ref and ref.get("text") else None,
               "limits": dict(self.s.training_limits)}
        (d / "job.json").write_text(json.dumps(job, ensure_ascii=False))
        fake = self.s.engine_mode == "fake"
        python = sys.executable if fake else ins.python_for(spec.engine)
        if not python:
            raise TrainingError(f"{spec.name}'s environment isn't installed", "needs_model", 409)
        argv = [python, "-s", "-m", "app.voicehost.train", str(d)] + (["--fake"] if fake else [])
        if not fake:
            argv = _capped(argv, HOST_GB)
        env = {**_env(), **ins.worker_env(spec.engine)}
        self._set(rid, state="running", started_at=r.get("started_at") or now_iso(), error="", code="")
        self.events.setdefault(rid, collections.deque(maxlen=200))
        self._paused = False
        self._exited = asyncio.Event()
        self._proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env, cwd=str(SRC_ROOT), **subprocess_flags())
        last: dict[str, Any] = {}
        tail: collections.deque = collections.deque(maxlen=40)

        async def errs() -> None:
            assert self._proc and self._proc.stderr
            async for line in self._proc.stderr:
                t = line.decode(errors="replace").rstrip()
                if t:
                    tail.append(t)
                    log.debug("training %s: %s", rid, t)

        et = asyncio.create_task(errs())
        assert self._proc.stdout
        async for line in self._proc.stdout:
            t = line.decode(errors="replace").rstrip()
            if not t.startswith(PREFIX):
                continue
            try:
                ev = json.loads(t[len(PREFIX):])
            except ValueError:
                continue
            last = ev
            self._event(rid, ev)
        await self._proc.wait()
        await et
        self._exited.set()
        stage = last.get("stage")
        if stage == "done":
            result = {k: last.get(k) for k in ("improved", "best_step", "steps", "base", "tuned", "evals", "kept_s",
                                                "language", "minutes", "conditions")}
            self._tidy(d)
            if last.get("improved"):  # (on the voice, and its clip, first: the run is never seen done before them)
                self.apply(rid, True)
                await self._give_clip(r["voice_id"], d)
            self._set(rid, state="done", stage="done", result=result, finished_at=now_iso(), progress={})
        elif stage == "released":
            self._set(rid, state="released", progress={"released_at": time.time()})
        elif stage == "canceled":
            self._set(rid, state="canceled", finished_at=now_iso())
        else:
            err = last.get("error") or ("\n".join(list(tail)[-3:]) or f"exit {self._proc.returncode}")
            self._set(rid, state="failed", code=last.get("code") or "failed", error=str(err)[:600], finished_at=now_iso())
        self._wake.set()

    def _event(self, rid: str, ev: dict[str, Any]) -> None:
        stage = ev.get("stage", "")
        ev["t"] = time.time()
        self.events.setdefault(rid, collections.deque(maxlen=200)).append(ev)
        kw: dict[str, Any] = {}
        if stage in ("prepare", "transcribe", "screen", "tokens", "baseline", "train", "eval"):
            kw["stage"] = stage
        if stage == "screen":
            kw["data"] = {k: ev.get(k) for k in ("kept", "kept_s", "dropped", "language")}
        if stage in ("baseline", "eval"):
            row = self.db.query_one("SELECT result FROM voice_trainings WHERE id=?", (rid,))
            res = json.loads((row["result"] if row else "") or "{}")
            if stage == "baseline":
                res["base"] = ev.get("metrics")
            else:
                res.setdefault("evals", []).append({"step": ev.get("step"), "metrics": ev.get("metrics"), "best": ev.get("best")})
                if ev.get("best"):
                    res["tuned"] = ev.get("metrics")
            kw["result"] = res
        if stage in ("prepare", "transcribe", "tokens", "train", "eval", "paused", "resumed"):
            kw["progress"] = {k: v for k, v in ev.items() if k not in ("metrics", "t")}
        if kw:
            self._set(rid, **kw)

    def _tidy(self, d: Path) -> None:
        """a finished run keeps its recordings (to train again), its adapter, samples and report — not its cuts"""
        shutil.rmtree(d / "segments", ignore_errors=True)
        shutil.rmtree(d / "state", ignore_errors=True)

    async def _give_clip(self, voice_id: str, d: Path) -> None:
        """a voice made for training with no clip of its own gets one: her clearest utterance (the other models
        clone from it; OmniVoice speaks from it too)"""
        v = self.h.voices.get(voice_id) or {}
        if v.get("references"):
            return
        try:
            data = json.loads((d / "data.json").read_text())
        except (OSError, ValueError):
            return
        good = [g for g in data.get("segments", []) if not g.get("left_out") and 5 <= g.get("seconds", 0) <= 12]
        if not good:
            return
        g = max(good, key=lambda g: g.get("similarity", 0))
        f = d / "inputs" / str(g.get("file") or "")
        if not f.is_file():
            return

        def add() -> None:
            import io

            import soundfile as sf

            x, sr = sf.read(str(f), dtype="float32")
            buf = io.BytesIO()
            sf.write(buf, x[int(g["start"] * sr): int(g["end"] * sr)], sr, format="WAV", subtype="PCM_16")
            lang = data.get("language", "auto")
            self.h.voices.add_reference(voice_id, buf.getvalue(), label="neutral", transcript=g.get("text", ""),
                                        language=lang if lang in texts_langs() else "auto")

        try:
            await asyncio.to_thread(add)
            self.h.on_change(f"voice:{voice_id}")
        except Exception:  # noqa: BLE001 - the adapter is there either way
            log.exception("a clip for %s", voice_id)


def texts_langs() -> set[str]:
    from .train.texts import WHISPER

    return set(WHISPER)


def _link(src: Path, dst: Path) -> None:
    """the same recording in another run of the group: a hard link where the disk allows it"""
    import os

    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def _write(p: Path, x) -> None:
    import soundfile as sf

    sf.write(str(p), x, audio.REF_SR, subtype="PCM_16")


def _env() -> dict[str, str]:
    import os

    env = dict(os.environ)
    env["PYTHONPATH"] = str(SRC_ROOT)
    env.pop("PYTHONHOME", None)
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    env.setdefault("TOKENIZERS_PARALLELISM", "false")
    env.setdefault("TQDM_DISABLE", "1")
    env.setdefault("HF_HUB_OFFLINE", "1")
    env.pop("CAPPED_MEM", None)
    return env
