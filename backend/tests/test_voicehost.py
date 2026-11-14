"""Local voice models (app/voicehost, docs/local-voice.md): who may run them (the GPU check), the license before any
download, the GPU placement (measured VRAM, other programs respected, pins for calls), a real worker process speaking
and hearing with the stand-in engine (no GPU, no downloads), the voices (built-in 한채린 / 메스가키, the user's own,
clips by feeling), and a mate on the "local" engine — her speech, her transcription, her call."""

from __future__ import annotations

import asyncio
import io
import json
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.voicehost import catalog, gate as G, host, system, voices as V
from app.voicehost.installer import Installer
from app.voicehost.service import VoiceError, VoiceHost
from app.voicehost.settings import VoiceSettings

GiB = 1 << 30


def wav_bytes(seconds: float = 4.0, sr: int = 22050) -> bytes:
    t = np.arange(int(seconds * sr)) / sr
    x = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    x[: sr // 2] = 0  # leading silence, trimmed on upload
    buf = io.BytesIO()
    sf.write(buf, x, sr, format="WAV")
    return buf.getvalue()


def mark_installed(s: VoiceSettings, *model_ids: str) -> None:
    for mid in model_ids:
        d = s.models_dir / mid
        d.mkdir(parents=True, exist_ok=True)
        (d / ".complete.json").write_text(json.dumps({"bytes": 123, "revisions": {"x/y": "abc"}}))


def _gpu(total_gb: float = 12, used_gb: float = 0.5, driver: str = "580.159.03", cap: str = "12.0") -> system.Gpu:
    total, used = int(total_gb * GiB), int(used_gb * GiB)
    return system.Gpu(0, "Test GPU", total, used, total - used, 0, driver, cap)


@pytest.fixture()
def vs(tmp_path: Path) -> VoiceSettings:
    s = VoiceSettings(home=tmp_path / "voice", engine_mode="fake", idle_unload_seconds=0)
    s.ensure_dirs()
    return s


@pytest.fixture()
async def vh(db, vs):
    h = VoiceHost(db, vs)
    await h.start()
    yield h
    await h.stop()


# ---- who may run them ----

def test_the_gate_refuses_a_machine_without_a_suitable_gpu(monkeypatch):
    monkeypatch.setattr(system, "platform_key", lambda: "linux-x86_64")
    monkeypatch.setattr(system, "in_container", lambda: False)
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [])
    assert G.check("real").code == "no_gpu"
    # (in a container on a GPU host whose GPU wasn't passed through: says so)
    monkeypatch.setattr(system, "in_container", lambda: True)
    monkeypatch.setattr(system, "nvidia_devices", lambda: False)
    assert G.check("real").code == "gpu_not_passed"
    for gpu, code in ((_gpu(driver="535.104"), "old_driver"), (_gpu(cap="6.1"), "old_gpu"),
                      (_gpu(total_gb=2), "small_gpu"), (_gpu(), "ok")):
        monkeypatch.setattr(system, "gpus", lambda max_age=1.0, g=gpu: [g])
        assert G.check("real").code == code, code
    # (the engines' environments are made from the server's interpreter: another Python is said up front)
    monkeypatch.setattr(G, "PYTHON", (3, 99))
    g = G.check("real")
    assert g.code == "python" and g.detail["need"] == "3.99" and g.gpu is not None
    monkeypatch.setattr(system, "platform_key", lambda: "macos-arm64")
    assert G.check("real").code == "platform"
    assert G.check("off").code == "off" and G.check("fake").ok


def test_the_gate_names_missing_server_packages(monkeypatch):
    monkeypatch.setattr(system, "platform_key", lambda: "linux-x86_64")
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [_gpu()])
    monkeypatch.setattr(G, "_missing_packages", lambda: ["soxr"])
    g = G.check("real")
    assert not g.ok and g.code == "packages" and "soxr" in g.message


async def test_without_a_gpu_nothing_installs_or_loads(db, tmp_path, monkeypatch):
    # (before the start: the GPU sampler asks at once, and the answer is kept a few seconds)
    monkeypatch.setattr(G, "check", lambda mode="real", device="cuda:0": G.Gate(False, "no_gpu", "no GPU here"))
    h = VoiceHost(db, VoiceSettings(home=tmp_path / "v", engine_mode="real"))
    await h.start()
    try:
        for call in (lambda: h.install("omnivoice", True),):
            with pytest.raises(VoiceError) as e:
                call()
            assert e.value.code == "no_gpu" and e.value.status == 409
        with pytest.raises(VoiceError):
            await h.load("omnivoice")
        st = h.status("ko")
        assert st["gate"]["code"] == "no_gpu" and len(st["models"]) == len(catalog.CATALOG)
        # (the models are still listed, with what they need, in the language asked for)
        omni = next(m for m in st["models"] if m["id"] == "omnivoice")
        assert "Boson" in omni["license"]["name"] and omni["license"]["attribution"]
        assert any("10만" in s for s in omni["license"]["summary"]) and omni["repos"][0]["url"].startswith("https://")
    finally:
        await h.stop()


# ---- the license, then the download ----

async def test_a_license_is_accepted_before_anything_is_downloaded(vh, monkeypatch):
    with pytest.raises(VoiceError) as e:
        vh.install("omnivoice", False)
    assert e.value.code == "license"

    async def fake_download(self, spec, p):
        d = self.model_dir(spec)
        d.mkdir(parents=True, exist_ok=True)
        (d / ".complete.json").write_text(json.dumps({"bytes": 42, "revisions": {"k2-fsa/OmniVoice": "deadbeef"}}))

    monkeypatch.setattr(Installer, "_download", fake_download)
    vh.install("omnivoice", True)
    for _ in range(100):
        st = next(m for m in vh.status()["models"] if m["id"] == "omnivoice")
        if st["installed"]:
            break
        await asyncio.sleep(0.02)
    assert st["installed"] and st["progress"]["state"] == "done"
    assert st["license_accepted"]["license"].startswith("Apache-2.0") and st["license_accepted"]["accepted_at"]
    assert st["revisions"] == {"k2-fsa/OmniVoice": "deadbeef"}
    # accepted once: a reinstall needn't ask again
    await vh.remove("omnivoice")
    assert not next(m for m in vh.status()["models"] if m["id"] == "omnivoice")["installed"]
    vh.install("omnivoice", False)


async def test_stopping_the_app_stops_an_install_and_its_process(db, vs, monkeypatch):
    started = asyncio.Event()

    async def slow_download(self, spec, p):
        p.state = "weights"
        proc = await asyncio.create_subprocess_exec("sleep", "60")
        self._procs[spec.id] = proc
        started.set()
        await proc.wait()

    monkeypatch.setattr(Installer, "_download", slow_download)
    h = VoiceHost(db, vs)
    await h.start()
    h.install("omnivoice", True)
    await asyncio.wait_for(started.wait(), 5)
    proc = h.installer._procs["omnivoice"]
    await h.stop()
    assert proc.returncode is not None  # (killed, not left downloading on its own)
    assert h.installer.progress["omnivoice"].state == "cancelled"


def test_an_install_without_room_on_disk_is_refused(vs, db, monkeypatch):
    inst = Installer(vs, VoiceHost(db, vs).store)
    monkeypatch.setattr(system, "disk", lambda p: {"path": str(p), "total": 10 * GiB, "free": 1 * GiB})
    with pytest.raises(Exception) as e:
        inst._check_room(catalog.get("cosyvoice3-0.5b"))
    assert "disk space" in str(e.value)


# ---- the GPU: measured VRAM, other programs respected, pins ----

class FakeWorker:
    def __init__(self) -> None:
        self.alive = True
        self.calls: list[str] = []
        self.proc = None
        self.pid = None

    async def call(self, op, timeout=None, **kw):
        self.calls.append(op)
        if op == "park":
            return {"parked": True, "seconds": 0.1, "memory": {}}
        return {}

    async def stop(self, timeout=10):
        self.alive = False


def _resident(mgr: host.EngineManager, model_id: str, last_used: float) -> host.Resident:
    r = host.Resident(spec=catalog.get(model_id), worker=FakeWorker(), state="ready", last_used=last_used)
    r.load_info = {"memory": {"allocated": int(r.spec.vram_gb * 0.7 * GiB)}}
    mgr.residents[model_id] = r
    return r


@pytest.fixture()
def mgr(tmp_path, monkeypatch):
    s = VoiceSettings(home=tmp_path, park_ram_gb=0)  # parking disabled: evictions stop the process
    m = host.EngineManager(s, lambda e: None)
    monkeypatch.setattr(host.EngineManager, "_settle", lambda self: asyncio.sleep(0))
    return m


async def test_room_is_made_from_the_least_recently_used_and_never_from_a_pinned_model(mgr, monkeypatch):
    _resident(mgr, "qwen3-tts-1.7b-base", last_used=1)
    _resident(mgr, "omnivoice", last_used=2)

    def gpus(max_age=0.0):
        used = 0.5 + sum(r.spec.vram_gb for r in mgr.residents.values() if r.state == "ready")
        return [_gpu(12, used)]

    monkeypatch.setattr(system, "gpus", gpus)
    mgr.pin("qwen3-tts-1.7b-base")  # (a call holds it)
    await mgr._make_room(int(4.0 * GiB), exclude="qwen3-tts-0.6b-base")
    assert "qwen3-tts-1.7b-base" in mgr.residents and "omnivoice" not in mgr.residents
    mgr.unpin("qwen3-tts-1.7b-base")
    await mgr._make_room(int(6.5 * GiB), exclude="qwen3-tts-0.6b-base")
    assert "qwen3-tts-1.7b-base" not in mgr.residents


async def test_other_programs_on_the_gpu_are_respected(mgr, monkeypatch):
    monkeypatch.setattr(system, "gpus", lambda max_age=0.0: [_gpu(12, 10.0)])  # someone else holds 10 GB
    with pytest.raises(host.NoRoom) as e:
        await mgr._make_room(int(4.0 * GiB), exclude="x")
    assert e.value.data["others"] >= 9 * GiB and e.value.data["need"] == 4 * GiB


async def test_a_pinned_model_is_never_idled_out(mgr, monkeypatch):
    r = _resident(mgr, "omnivoice", last_used=time.time() - 3600)
    mgr.s.idle_unload_seconds = 60
    mgr.pin("omnivoice")
    real_sleep = asyncio.sleep
    monkeypatch.setattr(host.asyncio, "sleep", lambda s: real_sleep(0) if s == 15 else real_sleep(s))
    task = asyncio.create_task(mgr._idle_loop())
    await asyncio.sleep(0.05)
    assert "omnivoice" in mgr.residents and r.state == "ready"
    mgr.unpin("omnivoice")
    r.last_used = time.time() - 3600
    await asyncio.sleep(0.05)
    task.cancel()
    assert "omnivoice" not in mgr.residents


# ---- a real worker process (the stand-in engine) ----

async def test_a_worker_speaks_and_hears_over_its_socket(vh, vs):
    mark_installed(vs, "omnivoice", "whisper-large-v3-turbo", "qwen3-tts-0.6b-base")
    ref = vh.voices.resolve("builtin:chaerin", "joy")
    wav, info = await vh.synthesize("qwen3-tts-0.6b-base", "안녕하세요. 오늘은 날씨가 좋네요.", reference=ref,
                                    language="ko")
    x, sr = sf.read(io.BytesIO(wav), dtype="float32")
    assert sr == 24000 and len(x) > sr * 0.5 and info["model_id"] == "qwen3-tts-0.6b-base"
    assert any(r["model_id"] == "qwen3-tts-0.6b-base" and r["state"] == "ready" for r in vh.engines.status())
    heard = await vh.transcribe(wav, language="ko")
    assert heard["text"].startswith("가짜 전사") and heard["model_id"] == "whisper-large-v3-turbo"
    # (a model that clones needs a voice; one that can make its own doesn't)
    with pytest.raises(VoiceError) as e:
        await vh.synthesize("qwen3-tts-0.6b-base", "hi", reference=None)
    assert e.value.code == "needs_voice"
    wav2, _ = await vh.synthesize("omnivoice", "hello", reference=None, instruct="female, low pitch")
    assert len(wav2) > 1000
    await vh.unload("qwen3-tts-0.6b-base")
    assert not any(r["model_id"] == "qwen3-tts-0.6b-base" for r in vh.engines.status())


async def test_a_mates_words_go_before_a_preview(vh, vs):
    mark_installed(vs, "omnivoice")
    order: list[str] = []
    gate = asyncio.Event()

    async def slow():
        await gate.wait()
        order.append("first")

    async def job(name):
        order.append(name)

    running = asyncio.create_task(vh.queue.run(1, "busy", slow))
    await asyncio.sleep(0.01)
    later = asyncio.create_task(vh.queue.run(1, "preview", lambda: job("preview")))
    sooner = asyncio.create_task(vh.queue.run(0, "mate", lambda: job("mate")))
    await asyncio.sleep(0.01)
    gate.set()
    await asyncio.gather(running, later, sooner)
    assert order == ["first", "mate", "preview"]


# ---- voices ----

def test_the_built_in_voices_have_a_clip_and_its_words_for_every_feeling():
    vs_ = {v["id"]: v for v in V.builtins()}
    assert {"builtin:chaerin", "builtin:seoa"} <= set(vs_)
    assert vs_["builtin:chaerin"]["name"] == "한채린" and vs_["builtin:seoa"]["name"] == "메스가키"
    for v in (vs_["builtin:chaerin"], vs_["builtin:seoa"]):
        labels = {r["label"] for r in v["references"]}
        assert labels == {"neutral", "joy", "sadness", "anger", "surprise"} and labels <= set(V.FEELINGS), v["id"]
        for r in v["references"]:
            info = sf.info(r["file"])
            assert info.samplerate == 24000 and info.channels == 1 and 5 <= info.duration <= 15
            assert len(r["transcript"]) > 10
        assert "rights" in v and "owner" in v["rights"]


async def test_a_users_voice_takes_clips_by_feeling_and_a_line_picks_its_feeling(vh, vs):
    v = vh.voices.create("내 목소리", "ko")
    ref = await vh.add_reference(v["id"], wav_bytes(), label="neutral", transcript="안녕하세요 반가워요")
    assert ref["duration"] < 4.0  # (leading silence trimmed)
    await vh.add_reference(v["id"], wav_bytes(6), label="joy", transcript="와 신난다")
    assert vh.voices.resolve(v["id"], "laugh")["text"] == "와 신난다"
    assert vh.voices.resolve(v["id"], "angry")["text"] == "안녕하세요 반가워요"  # (no anger clip: neutral)
    # a clip without its words is transcribed by the local Whisper when it is installed
    mark_installed(vs, "whisper-large-v3-turbo")
    blank = await vh.add_reference(v["id"], wav_bytes(5), label="sadness")
    assert blank["transcript"].startswith("가짜 전사")
    assert vh.voices.delete(v["id"]) and vh.voices.get(v["id"]) is None
    with pytest.raises(ValueError):
        vh.voices.delete("builtin:chaerin")


# ---- a mate on the local engine ----

async def test_a_mate_speaks_and_hears_with_the_local_models(db, tmp_path, monkeypatch, vs):
    from tests.test_mate_delegation import _setup
    from app.mate.voice import VoiceService

    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    h = VoiceHost(db, vs)
    await h.start()
    try:
        voice = VoiceService(store)
        voice.local = h
        # nothing installed: her local voice falls back to the page's (said why)
        mate = store.create(name="하루", persona={"language": "ko"}, llm={"model": "m1"},
                            voice={"tts": {"engine": "local", "voice": "builtin:seoa"}, "stt": {"engine": "local"}})
        sp = await voice.speech(mate, "안녕!")
        assert sp is not None and sp.fallback and "No local speech model" in sp.fallback
        assert (await voice.providers.status())["tts"][0]["engine"] == "local"
        mark_installed(vs, "omnivoice", "whisper-large-v3-turbo")
        sp = await voice.speech(mate, "[joy] 와, 진짜요? 대박!", emotion="joy")
        assert sp.body[:4] == b"RIFF" and sp.media_type == "audio/wav" and not sp.cached
        again = await voice.speech(mate, "[joy] 와, 진짜요? 대박!", emotion="joy")
        assert again.cached  # (the same line in the same voice and feeling: from the cache)
        heard = await voice.transcribe(mate, sp.body, "a.wav", "audio/wav")
        assert heard["engine"] == "local" and heard["text"]
        assert voice.stt_fallback() == "local"
        models = await voice.providers.models("local", "tts")
        assert [m["id"] for m in models["models"]] == ["omnivoice"] and models["default"] == "omnivoice"
        # the model she chose was removed (or is the wrong kind): she speaks and hears with the one that is there
        chose = {**mate, "voice": {**mate["voice"], "tts": {**mate["voice"]["tts"], "model": "qwen3-tts-1.7b-base"}}}
        assert (await voice.speech(chose, "그래도 말할 수 있어요.")).body[:4] == b"RIFF"
        assert h.model_for("tts", "qwen3-tts-1.7b-base") == "omnivoice"
        assert h.model_for("stt", "omnivoice") == "whisper-large-v3-turbo"
        # her call: the record line on the local Whisper; her models held on the GPU while it lasts
        from app.mate.calls import CallService

        calls = CallService(mates)
        calls.voice = voice
        plan = calls.plan(store.get(mate["id"]), voice)
        assert plan["stt"] == {"mode": "record", "engine": "local", "fallback": "local"}
    finally:
        await h.stop()
