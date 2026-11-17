"""Training a voice (app/voicehost/training.py + app/voicehost/train, docs/local-voice.md "Training a voice"), with
the stand-in run in its own process and the stand-in engine — no GPU, no downloads: recordings cut into utterances at
their pauses, how long a run trains, a run from upload to the adapter on the voice (and the voice speaking with it),
what is refused, cancelling and removing, pausing and leaving the GPU on the server's word, an adapter from another
OmniVoice not used, and runtimes from an older lock brought up to date in place."""

from __future__ import annotations

import asyncio
import io
import json
import os
import threading

import numpy as np
import pytest
import soundfile as sf

from app.routers.voice_local import _public_voice
from app.voicehost import catalog
from app.voicehost.service import INTERACTIVE, PREVIEW, VoiceHost
from app.voicehost.settings import VoiceSettings
from app.voicehost.train import segment, texts
from app.voicehost.train.control import Control, Released, Stopped
from app.voicehost.training import TrainingError
from tests.test_voicehost import mark_installed

SR = 24000


def talk(seconds: float, sr: int = SR, seed: int = 0) -> np.ndarray:
    """speech-like: bursts of a voice (2–6 s) with pauses (0.4–1 s) between, on a little noise"""
    rng = np.random.default_rng(seed)
    out = [np.zeros(int(sr * 0.5), np.float32)]
    total = 0.0
    while total < seconds:
        d = rng.uniform(2.0, 6.0)
        t = np.arange(int(d * sr)) / sr
        out.append((0.25 * np.sin(2 * np.pi * rng.uniform(150, 250) * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))).astype(np.float32))
        out.append(np.zeros(int(sr * rng.uniform(0.4, 1.0)), np.float32))
        total += d
    x = np.concatenate(out)
    return x + 0.001 * rng.standard_normal(len(x)).astype(np.float32)


def wav(x: np.ndarray, sr: int = SR) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, x, sr, format="WAV")
    return buf.getvalue()


@pytest.fixture()
def vs(tmp_path):
    s = VoiceSettings(home=tmp_path / "voice", engine_mode="fake", idle_unload_seconds=0)
    s.training_limits = {"fake_delay": 0.002}
    s.ensure_dirs()
    mark_installed(s, "omnivoice", "whisper-large-v3-turbo")
    return s


@pytest.fixture()
async def vh(db, vs):
    h = VoiceHost(db, vs)
    await h.start()
    yield h
    await h.stop()


async def done(h: VoiceHost, rid: str, states=("done", "failed", "canceled"), timeout: float = 40) -> dict:
    for _ in range(int(timeout / 0.1)):
        r = h.trainings.get(rid)
        if r and r["state"] in states:
            return r
        h.trainings._wake.set()
        await asyncio.sleep(0.1)
    raise AssertionError(f"still {h.trainings.get(rid)['state']}")


# ---- the parts ----

def test_a_recording_is_cut_into_utterances_at_its_pauses():
    x = talk(120)
    segs = segment.speech_segments(x, SR)
    lens = [(e - s) / SR for s, e in segs]
    assert len(segs) >= 10 and all(1.5 <= d <= 12.0 + 0.3 for d in lens)
    assert sum(lens) > 100  # (nearly all of the speech)
    assert all(segs[i][1] <= segs[i + 1][0] for i in range(len(segs) - 1))  # (in order, never overlapping)
    # one long breath: split at its quietest point; silence: nothing
    t = np.arange(SR * 30) / SR
    long = (0.3 * np.sin(2 * np.pi * 200 * t) * (0.55 + 0.45 * np.sin(2 * np.pi * 0.2 * t))).astype(np.float32)
    assert all((e - s) / SR <= 12.3 for s, e in segment.speech_segments(long, SR))
    assert segment.speech_segments(np.zeros(SR * 5, np.float32), SR) == []


def test_how_long_a_run_trains():
    assert segment.steps_for(4) == 200 and segment.steps_for(17) == 850 and segment.steps_for(60) == 1500
    assert segment.eval_every(200) == 33 and segment.eval_every(60) == 25
    assert texts.cer("오늘은 맑아요", "오늘은 맑아요.") == 0.0 and texts.cer("abcd", "abxd") == 0.25
    assert texts.eval_texts("ko")[0].startswith("오늘은") and texts.eval_texts("xx") == texts.EVAL["en"]


def test_the_servers_word_pauses_releases_and_stops_a_run():
    r, w = os.pipe()
    ctl = Control(os.fdopen(r))
    out = os.fdopen(w, "w")
    seen = []
    out.write("pause\n")
    out.flush()
    t = threading.Timer(0.3, lambda: (out.write("resume\n"), out.flush()))
    t.start()
    for _ in range(50):
        if ctl.paused:
            break
        threading.Event().wait(0.01)
    ctl.check(seen.append)
    assert seen == [True, False]
    out.write("release\n")
    out.flush()
    threading.Event().wait(0.1)
    with pytest.raises(Released):
        ctl.check()
    out.close()  # (the server went away)
    threading.Event().wait(0.1)
    ctl.released = False
    with pytest.raises(Stopped):
        ctl.check()


# ---- a run ----

async def test_a_voice_trained_from_its_recordings_speaks_with_its_adapter(vh):
    v = vh.voices.create("하나")
    await vh.add_reference(v["id"], wav(talk(8, seed=3)), label="neutral", transcript="안녕하세요 반가워요")
    r = (await vh.trainings.create(voice_id=v["id"], files=[("녹음.m4a", wav(talk(90, seed=1)))]))[0]
    assert r["state"] == "queued" and len(r["inputs"]) == 2 and r["inputs"][1]["clip"]  # (her clip is her too)
    r = await done(vh, r["id"])
    assert r["state"] == "done", r["error"]
    assert r["result"]["improved"] and r["result"]["tuned"]["none"]["similarity"] > r["result"]["base"]["none"]["similarity"]
    assert r["applied"] and r["data"]["kept"] > 5 and {"base-long-0.wav", "tuned-none-1.wav"} <= set(r["samples"])
    assert vh.trainings.sample(r["id"], "base-long-0.wav") and vh.trainings.sample(r["id"], "../job.json") is None
    d = vh.trainings.run_dir(r["id"])
    assert (d / "adapter" / "adapter_config.json").exists() and not (d / "segments").exists()  # (its cuts tidied)
    spec = catalog.BY_ID["omnivoice"]
    assert vh.trainings.adapter_for(v["id"], spec) == (r["id"], str(d / "adapter"))
    assert vh.trainings.adapter_for(v["id"], catalog.BY_ID["whisper-large-v3-turbo"]) is None
    # it speaks with it (the worker is given the adapter), and without it once taken off
    ref = vh.voices.resolve(v["id"], "neutral")
    _, info = await vh.synthesize("omnivoice", "오늘은 정말 좋은 날이에요.", reference=ref, language="ko")
    assert info.get("adapter") == r["id"]
    # (the studio shows it: the voice is marked trained, a line made with it says so in the history)
    assert _public_voice(vh.voices.get(v["id"]), vh.trainings.adapters(v["id"]))["adapters"] == {"omnivoice": r["id"]}
    e = await vh.generate(model_id="omnivoice", text="오늘은 정말 좋은 날이에요.", voice_id=v["id"], mode="clone")
    assert e["adapter"] == r["id"] and vh.history.get(e["id"])["adapter"] == r["id"]
    vh.trainings.apply(r["id"], False)
    _, info = await vh.synthesize("omnivoice", "오늘은 정말 좋은 날이에요.", reference=ref, language="ko")
    assert "adapter" not in info and vh.trainings.adapters(v["id"]) == {}
    assert (await vh.generate(model_id="omnivoice", text="고마워요.", voice_id=v["id"], mode="clone"))["adapter"] == ""
    vh.trainings.apply(r["id"], True)
    # an adapter made from another OmniVoice doesn't fit the one installed now
    meta = json.loads((d / "adapter" / "geny.json").read_text())
    (d / "adapter" / "geny.json").write_text(json.dumps({**meta, "base_revision": "0123abcd"}))
    done_file = vh.s.models_dir / "omnivoice" / ".complete.json"
    info_ = json.loads(done_file.read_text())
    done_file.write_text(json.dumps({**info_, "revisions": {spec.repos[0].repo_id: "c5fdb5ccb189"}}))
    assert vh.trainings.adapter_for(v["id"], spec) is None
    # removed: the voice no longer speaks with it, its files are gone
    await vh.trainings.delete(r["id"])
    assert not d.exists() and vh.trainings.get(r["id"]) is None
    assert vh.trainings.adapters(v["id"]) == {}


async def test_every_model_learns_from_the_same_recordings_heard_once(db, vs):
    mark_installed(vs, "qwen3-tts-0.6b-base", "cosyvoice3-0.5b")
    h = VoiceHost(db, vs)
    await h.start()
    try:
        v = h.voices.create("넷")
        runs = await h.trainings.create(voice_id=v["id"], files=[("a.wav", wav(talk(90, seed=2)))])
        # every installed model that learns (Qwen3-TTS 1.7B isn't installed), one run each, the recordings shared
        assert [r["model_id"] for r in runs] == ["omnivoice", "qwen3-tts-0.6b-base", "cosyvoice3-0.5b"]
        assert len({r["group_id"] for r in runs}) == 1 and runs[1]["model_name"] == "Qwen3-TTS 0.6B (Base)"
        assert (h.trainings.run_dir(runs[2]["id"]) / "inputs" / runs[2]["inputs"][0]["file"]).is_file()
        with pytest.raises(TrainingError) as e:  # (a model already learning this voice)
            await h.trainings.create(voice_id=v["id"], files=[("a.wav", wav(talk(90)))], model_ids=["cosyvoice3-0.5b"])
        assert e.value.code == "busy"
        rs = [await done(h, r["id"]) for r in runs]
        assert all(r["state"] == "done" and r["applied"] for r in rs), [r["error"] for r in rs]
        # the others didn't listen again: they went on from what the first one heard
        assert any(ev.get("stage") == "transcribe" for ev in h.trainings.get(rs[0]["id"])["events"])
        assert not any(ev.get("stage") == "transcribe" for ev in h.trainings.get(rs[1]["id"])["events"])
        assert rs[2]["result"]["conditions"] == ["long", "short"]  # (CosyVoice3 can't speak without a clip)
        assert h.trainings.adapters(v["id"]) == {r["model_id"]: r["id"] for r in rs}
        ref = h.voices.resolve(v["id"], "neutral")
        for r in rs:  # each model speaks with its own adapter
            assert h.trainings.adapter_for(v["id"], catalog.BY_ID[r["model_id"]])[0] == r["id"]
            _, info = await h.synthesize(r["model_id"], "오늘은 정말 좋은 날이에요.", reference=ref, language="ko")
            assert info.get("adapter") == r["id"]
        assert h.trainings.adapter_for(v["id"], catalog.BY_ID["qwen3-tts-1.7b-base"]) is None
        # one model again, alone; one that doesn't learn is refused
        again = await h.trainings.create(voice_id=v["id"], files=[("b.wav", wav(talk(90, seed=4)))],
                                         model_ids=["qwen3-tts-0.6b-base"])
        assert [r["model_id"] for r in again] == ["qwen3-tts-0.6b-base"]
        with pytest.raises(TrainingError) as e:
            await h.trainings.create(voice_id=v["id"], files=[("b.wav", wav(talk(90)))], model_ids=["whisper-large-v3-turbo"])
        assert e.value.code == "not_trainable"
        r2 = await done(h, again[0]["id"])
        assert h.trainings.adapters(v["id"])["qwen3-tts-0.6b-base"] == r2["id"]  # (the newer one put on)
        assert not h.trainings.get(rs[1]["id"])["applied"]
    finally:
        await h.stop()


async def test_an_omnivoice_adapter_from_before_stays_on(db, vs):
    h = VoiceHost(db, vs)
    await h.start()
    v = h.voices.create("다섯")
    await h.stop()
    # (a voice's adapter as the first version kept it: one column, OmniVoice's)
    db.execute("ALTER TABLE voice_voices ADD COLUMN adapter TEXT NOT NULL DEFAULT ''")
    db.execute("UPDATE voice_voices SET adapter='vt-old' WHERE id=?", (v["id"],))
    h = VoiceHost(db, vs)
    await h.start()
    try:
        assert h.trainings.adapters(v["id"]) == {"omnivoice": "vt-old"}
    finally:
        await h.stop()


async def test_a_new_voice_gets_its_clearest_utterance_as_its_clip(vh):
    v = vh.voices.create("새 목소리")
    r = (await vh.trainings.create(voice_id=v["id"], files=[("a.wav", wav(talk(80, seed=5)))]))[0]
    r = await done(vh, r["id"])
    assert r["state"] == "done"
    refs = vh.voices.get(v["id"])["references"]
    assert len(refs) == 1 and refs[0]["label"] == "neutral" and refs[0]["transcript"] == "가짜 전사"
    assert 5 <= refs[0]["duration"] <= 12.5


async def test_a_run_fetching_what_it_needs_says_how_far(vh):
    from app.voicehost.installer import Progress

    v = vh.voices.create("셋")
    row = {"id": "vt-x", "voice_id": v["id"], "model_id": "omnivoice", "state": "running", "stage": "kit", "inputs": "[]",
           "progress": json.dumps({"what": "stt"}), "data": "{}", "result": "{}"}
    assert "total_bytes" not in vh.trainings._row(row)["progress"]  # (nothing fetched yet: no bar to show)
    vh.installer.progress["whisper-large-v3-turbo"] = Progress(state="weights", done_bytes=400, total_bytes=1600)
    assert vh.trainings._row(row)["progress"] == {"what": "stt", "done_bytes": 400, "total_bytes": 1600}
    assert "total_bytes" not in vh.trainings._row({**row, "stage": "train", "progress": "{}"})["progress"]


async def test_what_a_run_refuses(vh):
    v = vh.voices.create("짧은")
    with pytest.raises(TrainingError) as e:
        await vh.trainings.create(voice_id=v["id"], files=[("a.wav", wav(talk(20)))])
    assert e.value.code == "too_short"
    assert not vh.trainings.root.exists() or not any(vh.trainings.root.iterdir())  # (nothing left of it)
    with pytest.raises(TrainingError) as e:
        await vh.trainings.create(voice_id="no-such-voice", files=[("a.wav", wav(talk(90)))])
    assert e.value.code == "no_voice"
    with pytest.raises(TrainingError) as e:
        await vh.trainings.create(voice_id=v["id"], files=[("a.wav", b"not audio")])
    assert e.value.code == "bad_audio"
    vh.s.training_limits = {"fake_delay": 0.2}
    r = (await vh.trainings.create(voice_id=v["id"], files=[("a.wav", wav(talk(90)))]))[0]
    with pytest.raises(TrainingError) as e:  # (one run of a voice at a time)
        await vh.trainings.create(voice_id=v["id"], files=[("a.wav", wav(talk(90)))])
    assert e.value.code == "busy"
    await done(vh, r["id"], states=("running",))
    r = await vh.trainings.cancel(r["id"])
    assert r["state"] == "canceled" and not r["applied"]


async def test_a_mate_speaking_pauses_a_run_and_a_model_needing_room_sends_it_away(vh):
    vh.s.training_limits = {"fake_delay": 0.05}
    v = vh.voices.create("멈춤")
    r = (await vh.trainings.create(voice_id=v["id"], files=[("a.wav", wav(talk(90)))]))[0]
    await done(vh, r["id"], states=("running",))
    for _ in range(100):
        if (vh.trainings.get(r["id"])["progress"] or {}).get("stage") == "train":
            break
        await asyncio.sleep(0.05)
    vh.trainings.speaking(True)
    for _ in range(60):
        if any(e.get("stage") == "paused" for e in vh.trainings.get(r["id"])["events"]):
            break
        await asyncio.sleep(0.05)
    assert any(e.get("stage") == "paused" for e in vh.trainings.get(r["id"])["events"])
    vh.trainings.speaking(False)
    vh.trainings._last_word = 0.0
    for _ in range(80):
        if any(e.get("stage") == "resumed" for e in vh.trainings.get(r["id"])["events"]):
            break
        await asyncio.sleep(0.05)
    assert any(e.get("stage") == "resumed" for e in vh.trainings.get(r["id"])["events"])
    # a model can't find room: the run leaves the GPU — and comes back to finish
    assert await vh.trainings.release_gpu()
    st = vh.trainings.get(r["id"])["state"]
    assert st in ("released", "running", "done")
    vh.s.training_limits = {"fake_delay": 0.001}
    r = await done(vh, r["id"])
    assert r["state"] == "done"


async def test_the_gpu_queue_tells_a_training_of_a_mates_words(vh):
    told = []
    vh.queue.on_interactive = told.append

    async def job():
        return 1

    await vh.queue.run(INTERACTIVE, "speak", job)
    await vh.queue.run(PREVIEW, "preview", job)
    assert told == [True, False]


# ---- runtimes from an older lock ----

async def test_a_runtime_from_an_older_lock_keeps_speaking_and_is_brought_up_to_date_in_place(tmp_path, db, monkeypatch):
    from app.voicehost import installer as I

    s = VoiceSettings(home=tmp_path / "voice", engine_mode="real")
    s.ensure_dirs()
    ins = I.Installer(s, __import__("app.voicehost.store", fromlist=["VoiceStore"]).VoiceStore(db))
    rt = I.RUNTIME_OF["omnivoice"]
    d = ins.runtime_dir(rt)
    py = I.venv_python(d)
    py.parent.mkdir(parents=True)
    py.write_text("")
    keep = d / "lib" / "kept.txt"
    keep.parent.mkdir(parents=True)
    keep.write_text("what the runtime had")
    (d / ".ready").write_text("an-older-lock")
    assert ins.runtime_usable(rt) and not ins.runtime_ready(rt) and ins.python_for("omnivoice") == str(py)
    ran = []

    async def fake_run(cmd, env, p, model_id):
        ran.append(cmd)

    monkeypatch.setattr(ins, "_run", fake_run)
    monkeypatch.setattr(s, "uv", lambda: ["uv"])
    assert await ins.refresh_runtimes() == ["omni"]
    assert ins.runtime_ready(rt) and keep.exists()  # (in place: nothing of it removed)
    assert ran and ran[0][:3] == ["uv", "pip", "install"] and "venv" not in ran[0]
    assert await ins.refresh_runtimes() == []  # (up to date: nothing to do)


# ---- the built-in voices ----

async def test_a_built_in_voice_learns_too(vh):
    r = (await vh.trainings.create(voice_id="builtin:chaerin", files=[("a.wav", wav(talk(80, seed=6)))]))[0]
    assert [i["name"] for i in r["inputs"] if i.get("clip")] == ["neutral.wav", "joy.wav", "sadness.wav", "anger.wav",
                                                                "surprise.wav"]  # (her clips, not her laughs)
    r = await done(vh, r["id"])
    assert r["state"] == "done" and r["applied"] and vh.trainings.adapters("builtin:chaerin") == {"omnivoice": r["id"]}
    ref = vh.voices.resolve("builtin:chaerin", "neutral")
    _, info = await vh.synthesize("omnivoice", "오늘은 정말 좋은 날이에요.", reference=ref, language="ko")
    assert info.get("adapter") == r["id"]
    # (no clip given to a voice that has its own: her five clips and three laughs, as before)
    assert len(vh.voices.get("builtin:chaerin")["references"]) == 8


def _asset(tmp_path, files: dict[str, bytes], name: str = "a.zip") -> tuple[str, dict]:
    import hashlib
    import zipfile

    z = tmp_path / name
    with zipfile.ZipFile(z, "w") as f:
        for n, b in files.items():
            f.writestr(n, b)
    data = z.read_bytes()
    return name, {"asset": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


async def test_the_built_in_voices_come_with_their_adapters(vh, tmp_path, monkeypatch):
    from app.voicehost import shipped

    rel = tmp_path / "release"
    rel.mkdir()
    adapter = {"adapter_config.json": b'{"peft_type": "LORA"}', "adapter_model.safetensors": b"fake",
               "geny.json": json.dumps({"engine": "omnivoice", "model_id": "omnivoice", "base_revision": ""}).encode(),
               "NOTICE.md": b"Built with Higgs Materials", "../evil.txt": b"no", "sub/adapter_model.safetensors": b"no"}
    name, entry = _asset(rel, adapter)
    monkeypatch.setattr(shipped, "RELEASE", rel.as_uri())
    vh.shipped.catalog = {("builtin:seoa", "omnivoice"): entry}
    spec = catalog.BY_ID["omnivoice"]
    # not fetched yet: no adapter (a line asks for it to be fetched meanwhile)
    assert vh.trainings.adapter_for("builtin:seoa", spec) is None
    await asyncio.sleep(0.2)
    if vh.shipped.ready("builtin:seoa", "omnivoice") is None:
        await vh.shipped.fetch_all()
    d = vh.shipped.ready("builtin:seoa", "omnivoice")
    assert d is not None and sorted(p.name for p in d.iterdir()) == ["NOTICE.md", "adapter_config.json",
                                                                     "adapter_model.safetensors", "geny.json"]
    assert not (vh.s.home / "adapters" / "evil.txt").exists() and not (d.parent / "evil.txt").exists()
    rid = vh.shipped.run_id("builtin:seoa", "omnivoice")
    assert vh.trainings.adapter_for("builtin:seoa", spec) == (rid, str(d))
    assert _public_voice(vh.voices.get("builtin:seoa"), vh.trainings.speaks_with("builtin:seoa"))["adapters"] == {"omnivoice": rid}
    ref = vh.voices.resolve("builtin:seoa", "neutral")
    _, info = await vh.synthesize("omnivoice", "오늘은 정말 좋은 날이에요.", reference=ref, language="ko")
    assert info.get("adapter") == rid
    assert vh.settings_doc()["shipped"] == [{"voice_id": "builtin:seoa", "model_id": "omnivoice", "bytes": entry["bytes"],
                                             "ready": True, "error": ""}]
    # off (Voice Studio → 설정): the voice as it was
    vh.put_settings({"shipped_adapters": False})
    assert vh.trainings.adapter_for("builtin:seoa", spec) is None and vh.trainings.speaks_with("builtin:seoa") == {}
    vh.put_settings({"shipped_adapters": True})
    # her own, trained here, goes first; removed, the shipped one again
    r = (await vh.trainings.create(voice_id="builtin:seoa", files=[("a.wav", wav(talk(80, seed=8)))]))[0]
    r = await done(vh, r["id"])
    assert vh.trainings.adapter_for("builtin:seoa", spec)[0] == r["id"]
    await vh.trainings.delete(r["id"])
    assert vh.trainings.adapter_for("builtin:seoa", spec)[0] == rid


async def test_a_shipped_adapter_that_isnt_what_it_says_is_not_used(vh, tmp_path, monkeypatch):
    from app.voicehost import shipped

    rel = tmp_path / "release"
    rel.mkdir()
    _, entry = _asset(rel, {"adapter_config.json": b"{}", "adapter_model.safetensors": b"x", "geny.json": b"{}"})
    monkeypatch.setattr(shipped, "RELEASE", rel.as_uri())
    vh.shipped.catalog = {("builtin:chaerin", "omnivoice"): {**entry, "sha256": "0" * 64}}
    await vh.shipped.fetch_all()
    assert vh.shipped.ready("builtin:chaerin", "omnivoice") is None
    assert "not the expected file" in vh.shipped.failed[("builtin:chaerin", "omnivoice")]
    assert not any((vh.s.home / "adapters").rglob("adapter_model.safetensors"))
    # nothing for a model not installed
    vh.shipped.catalog = {("builtin:chaerin", "cosyvoice3-0.5b"): entry}
    assert await vh.shipped.fetch_all() == []
