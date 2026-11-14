"""Voice Studio (app/voicehost: generate, history, batch, analysis; docs/local-voice.md "Voice Studio"), with the
stand-in engine in a real worker process — no GPU, no downloads: a line made in a profile's voice and kept with
everything that made it, the history's search / stars / limits, a line saved as a profile's clip, profiles copied
and trimmed, the settings, the overview's record of who used the GPU, batches from text / CSV / JSON (run, zipped,
retried), and a clip's analysis."""

from __future__ import annotations

import asyncio
import io
import json
import zipfile

import numpy as np
import pytest
import soundfile as sf

from app.voicehost import audio, batch as B, voices as V
from app.voicehost.service import VoiceError, VoiceHost
from app.voicehost.settings import VoiceSettings
from tests.test_voicehost import mark_installed, wav_bytes


@pytest.fixture()
def vs(tmp_path):
    s = VoiceSettings(home=tmp_path / "voice", engine_mode="fake", idle_unload_seconds=0)
    s.ensure_dirs()
    mark_installed(s, "omnivoice", "qwen3-tts-0.6b-base", "whisper-large-v3-turbo")
    return s


@pytest.fixture()
async def vh(db, vs):
    h = VoiceHost(db, vs)
    await h.start()
    yield h
    await h.stop()


def _speech(seconds: float = 12.0, sr: int = 24000) -> bytes:
    """a 'voice': a tone that comes and goes (speech-like gaps), padded with silence"""
    t = np.arange(int(seconds * sr)) / sr
    x = 0.3 * np.sin(2 * np.pi * 180 * t) * (np.sin(2 * np.pi * 0.7 * t) > -0.2)
    x = np.concatenate([np.zeros(sr), x, np.zeros(sr)]).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, x, sr, format="WAV")
    return buf.getvalue()


# ---- a line made, kept with what made it ----

async def test_a_line_in_a_profiles_voice_is_kept_with_everything_that_made_it(vh):
    vh.put_model_defaults("qwen3-tts-0.6b-base", {"temperature": 0.7})
    e = await vh.generate(model_id="qwen3-tts-0.6b-base", text="오늘은 정말 무서웠어.", voice_id="builtin:chaerin",
                          feeling="fear", mode="clone", language="ko")
    # (no fear clip in the built-in voice: its chain goes to sadness)
    assert e["ref_label"] == "sadness" and e["feeling"] == "fear" and e["voice_name"] == "한채린"
    assert e["mode"] == "clone" and e["source"] == "studio" and isinstance(e["seed"], int)
    assert e["params"]["temperature"] == 0.7  # (the model's default parameters, kept with the line)
    x, sr = sf.read(str(vh.history.path(e)), dtype="float32")
    assert sr == e["sample_rate"] and abs(len(x) / sr - e["seconds"]) < 0.05
    # the same seed again: the record says which (the stand-in engine ignores it, a real one repeats the line)
    again = await vh.generate(model_id="qwen3-tts-0.6b-base", text="오늘은 정말 무서웠어.", voice_id="builtin:chaerin",
                              feeling="fear", mode="clone", seed=e["seed"])
    assert again["seed"] == e["seed"]
    # design needs a description; a model that only clones can't
    with pytest.raises(VoiceError) as err:
        await vh.generate(model_id="omnivoice", text="hi", mode="design")
    assert err.value.code == "needs_instruct"
    with pytest.raises(VoiceError) as err:
        await vh.generate(model_id="qwen3-tts-0.6b-base", text="hi", mode="design", instruct="calm")
    assert err.value.code == "unsupported"
    d = await vh.generate(model_id="omnivoice", text="Hello there.", mode="design", instruct="female, low pitch, calm")
    assert d["voice_id"] == "" and d["ref_label"] == "" and d["instruct"] == "female, low pitch, calm"
    # who used the GPU: the studio, by model
    recent = vh.queue.snapshot()["recent"]
    assert any(r["source"] == "studio" and r["kind"] == "speak" and r["model_id"] == "omnivoice" and r["ok"]
               for r in recent)


async def test_the_history_is_searched_starred_and_kept_within_its_limits(vh):
    for i in range(6):
        await vh.generate(model_id="omnivoice", text=f"line {i} about the sea", voice_id="builtin:seoa",
                          feeling="joy", mode="clone")
    page = vh.history.list(q="sea", limit=4)
    assert page["total"] == 6 and len(page["items"]) == 4 and page["items"][0]["text"] == "line 5 about the sea"
    first = vh.history.list(limit=100)["items"][-1]
    vh.history.update(first["id"], starred=True, note="keep")
    assert vh.history.list(starred=True)["total"] == 1
    facets = vh.history.facets()
    assert facets["voices"][0]["name"] == "메스가키" and facets["models"][0]["value"] == "omnivoice"
    # a smaller limit: the oldest unstarred go, the starred one stays
    vh.put_settings({"history_max_entries": 50})
    vh.history.prune(3, 10**12)
    left = vh.history.list(limit=100)["items"]
    assert len(left) == 3 and any(x["id"] == first["id"] and x["note"] == "keep" for x in left)
    assert vh.history.delete([x["id"] for x in left]) == 3
    assert vh.history.usage()["count"] == 0


async def test_a_line_becomes_a_profiles_clip_and_profiles_are_copied_and_trimmed(vh):
    e = await vh.generate(model_id="omnivoice", text="이건 레퍼런스로 쓸 문장이에요.", voice_id="builtin:chaerin",
                          feeling="neutral", mode="clone", language="ko")
    with pytest.raises(VoiceError) as err:
        await vh.save_as_reference(e["id"], "builtin:chaerin", "joy")
    assert err.value.code == "builtin"
    copy = vh.duplicate_voice("builtin:chaerin", "채린 연습")
    assert copy["builtin"] is False and len(copy["references"]) == 5 and copy["name"] == "채린 연습"
    ref = await vh.save_as_reference(e["id"], copy["id"], "smile")
    assert ref["label"] == "smile" and ref["transcript"] == "이건 레퍼런스로 쓸 문장이에요."
    v = vh.voices.get(copy["id"])
    assert sorted(r["label"] for r in v["references"]) == sorted(["neutral", "joy", "sadness", "anger", "surprise",
                                                                    "smile"])
    # a new clip for a feeling takes the old one's place
    await vh.add_reference(copy["id"], _speech(8), label="smile", transcript="다시")
    v = vh.voices.get(copy["id"])
    assert [r["transcript"] for r in v["references"] if r["label"] == "smile"] == ["다시"]
    # trimmed to 2–6 s
    smile = next(r for r in v["references"] if r["label"] == "smile")
    cut = await vh.trim_reference(smile["id"], 2.0, 6.0)
    assert abs(cut["duration"] - 4.0) < 0.05
    with pytest.raises(VoiceError):
        await vh.trim_reference(smile["id"], 1.0, 1.2)  # (under half a second)
    # an upload cut to a range keeps that range only
    r2 = await vh.add_reference(copy["id"], _speech(12), label="fear", transcript="무서워", start=1.0, end=6.0)
    assert abs(r2["duration"] - 5.0) < 0.05
    # the profile's own fields
    vh.store.update_voice(copy["id"], description="연습용", default_model="omnivoice",
                          default_params={"num_step": 24}, tags=["ko", "test"], starred=True)
    v = vh.voices.get(copy["id"])
    assert v["description"] == "연습용" and v["default_params"] == {"num_step": 24} and v["starred"] is True
    g = await vh.generate(model_id="omnivoice", text="기본값이 따라와요.", voice_id=copy["id"], mode="clone")
    assert g["params"].get("num_step") == 24  # (the profile's defaults, for its own model)


def test_a_mates_tags_pick_clips_through_a_chain():
    assert V.chain_of("worried") == ("fear", "sadness") and V.feeling_of("worried") == "fear"
    assert V.chain_of("greet") == ("smile", "joy") and V.feeling_of("thinking") == "neutral"
    assert set(V.FEELINGS) >= {"neutral", "joy", "sadness", "anger", "surprise", "fear", "disgust", "smile"}


async def test_settings_change_while_running_and_stay_in_their_bounds(vh):
    doc = vh.put_settings({"vram_budget_fraction": 2.0, "idle_unload_seconds": 120, "history_max_gb": 1})
    assert doc["values"]["vram_budget_fraction"] == 0.95 and vh.s.idle_unload_seconds == 120
    assert doc["values"]["history_max_gb"] == 1.0 and doc["bounds"]["park_ram_gb"] == [0, 64]
    with pytest.raises(VoiceError):
        vh.put_settings({"park_ram_gb": "lots"})
    doc = vh.put_settings({"default_tts": "qwen3-tts-0.6b-base"})
    assert vh.default_model("tts") == "qwen3-tts-0.6b-base" and doc["default_tts"] == "qwen3-tts-0.6b-base"
    with pytest.raises(VoiceError):
        vh.put_settings({"default_tts": "whisper-large-v3-turbo"})  # (not a speech model)
    vh.put_settings({"vram_budget_fraction": None})
    assert vh.s.vram_budget_fraction == VoiceSettings(home=vh.s.home).vram_budget_fraction
    # kept across a restart
    vh.put_settings({"park_ram_gb": 3})
    again = VoiceHost(vh.store.db, VoiceSettings(home=vh.s.home, engine_mode="fake"))
    assert again.s.park_ram_gb == 3.0 and again.s.idle_unload_seconds == 120


async def test_the_overview_says_whose_gpu_memory_it_is(vh, monkeypatch):
    from app.voicehost import system

    await vh.generate(model_id="omnivoice", text="warm up", mode="auto")
    worker = next(iter(vh.engines.residents.values())).worker.pid
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [system.Gpu(0, "Test GPU", 12 << 30, 5 << 30, 7 << 30, 30,
                                                                        "580.1", "12.0")])
    monkeypatch.setattr(system, "telemetry", lambda: [{"index": 0, "util": 30.0, "temperature": 50.0, "power": 80.0}])
    monkeypatch.setattr(system, "gpu_apps", lambda: [{"gpu": 0, "pid": worker, "name": "python", "used": 2 << 30},
                                                     {"gpu": 0, "pid": 4242, "name": "ollama", "used": 1 << 30}])
    o = vh.overview("ko")
    u = o["gpus"][0]["usage"]
    assert [m["model_id"] for m in u["ours"]] == ["omnivoice"] and u["ours"][0]["bytes"] == 2 << 30
    assert u["others"] == [{"pid": 4242, "name": "ollama", "bytes": 1 << 30}] and u["unseen"] == 2 << 30
    assert o["gpus"][0]["temperature"] == 50.0 and o["residents"][0]["name"] == "OmniVoice"
    assert o["queue"]["recent"][0]["source"] == "studio" and o["history"]["count"] == 1


# ---- batches ----

def test_batch_input_reads_text_csv_and_json():
    lines = B.parse("안녕하세요.\n[joy] 와 신난다!\n\n[sad]   ...그랬구나.", "txt")
    assert [x.get("feeling") for x in lines] == [None, "joy", "sad"] and lines[2]["text"] == "...그랬구나."
    lines = B.parse('text,emotion,seed,profile\n"Hello, there",joy,7,한채린\nBye,,,', "csv")
    assert lines[0] == {"text": "Hello, there", "feeling": "joy", "seed": 7, "profile": "한채린"} and lines[1] == {"text": "Bye"}
    assert B.parse("only text\nsecond", "csv") == [{"text": "only text"}, {"text": "second"}]
    lines = B.parse(json.dumps(["a", {"text": "b", "emotion": "anger", "instruct": "loud"}]), "json")
    assert lines[1] == {"text": "b", "feeling": "anger", "instruct": "loud"}
    with pytest.raises(B.BatchInputError):
        B.parse("\n".join(f"line {i}" for i in range(501)), "txt")
    with pytest.raises(B.BatchInputError):
        B.parse("{}", "json")


async def test_a_batch_runs_line_by_line_zips_and_retries(vh, tmp_path, monkeypatch):
    b = vh.create_batch(label="인사 모음", fmt="txt", content="안녕하세요.\n[joy] 반가워요!\n[anger] 그만해요.",
                        settings={"model_id": "qwen3-tts-0.6b-base", "voice_id": "builtin:seoa", "mode": "clone"})
    for _ in range(200):
        if vh.batches.get(b["id"])["state"] not in ("queued", "running"):
            break
        await asyncio.sleep(0.05)
    done = vh.batch(b["id"])
    assert done["state"] == "done" and done["done"] == 3 and done["failed"] == 0
    assert [it["state"] for it in done["items"]] == ["done"] * 3
    hist = vh.history.list(batch_id=b["id"])["items"]
    assert [h["ref_label"] for h in hist] == ["neutral", "joy", "anger"] and all(h["source"] == "batch" for h in hist)
    z = zipfile.ZipFile(vh.batch_runner.zip_to(b["id"], tmp_path / "b.zip", "flac"))
    names = z.namelist()
    assert names[0].startswith("0001_") and names[0].endswith(".flac") and "manifest.json" in names
    man = json.loads(z.read("manifest.json"))
    assert [x["state"] for x in man["lines"]] == ["done"] * 3 and man["lines"][1]["clip"] == "joy"
    # a batch's lines aren't pruned by the history's limits
    vh.history.prune(0, 0)
    assert vh.history.list(batch_id=b["id"])["total"] == 3
    # an unknown profile is caught before anything runs
    with pytest.raises(VoiceError) as err:
        vh.create_batch(label="", fmt="csv", content="text,profile\nhi,nobody", settings={"model_id": "omnivoice"})
    assert err.value.code == "gone"
    # a line that fails, then is retried
    real = vh.generate
    calls = {"n": 0}

    async def flaky(**kw):
        calls["n"] += 1
        if calls["n"] == 2:
            raise VoiceError("boom", code="engine")
        return await real(**kw)

    monkeypatch.setattr(vh, "generate", flaky)
    b2 = vh.create_batch(label="", fmt="txt", content="하나\n둘\n셋", settings={"model_id": "omnivoice", "mode": "auto"})
    for _ in range(200):
        if vh.batches.get(b2["id"])["state"] not in ("queued", "running"):
            break
        await asyncio.sleep(0.05)
    assert vh.batch(b2["id"])["state"] == "done_with_errors"
    vh.retry_batch(b2["id"])
    for _ in range(200):
        if vh.batches.get(b2["id"])["state"] not in ("queued", "running"):
            break
        await asyncio.sleep(0.05)
    again = vh.batch(b2["id"])
    assert again["state"] == "done" and again["done"] == 3
    assert await vh.delete_batch(b2["id"]) and vh.history.list(batch_id=b2["id"])["total"] == 0


async def test_a_batch_a_restart_stopped_can_be_resumed(db, vs):
    h = VoiceHost(db, vs)
    b = h.batches.create("멈춘 일", {"model_id": "omnivoice", "mode": "auto"}, [{"text": "하나"}, {"text": "둘"}])
    h.batches.set(b["id"], state="running")
    await h.start()  # (a restart: what was running is marked so)
    try:
        assert h.batches.get(b["id"])["state"] == "interrupted"
        h.retry_batch(b["id"], failed_only=False)
        for _ in range(200):
            if h.batches.get(b["id"])["state"] not in ("queued", "running"):
                break
            await asyncio.sleep(0.05)
        assert h.batch(b["id"])["done"] == 2
    finally:
        await h.stop()


# ---- a clip before it becomes a reference ----

async def test_a_clip_is_analyzed_with_the_best_stretches_to_cut(vh):
    out = await vh.analyze(_speech(20, 44100), transcribe=True, window=8)
    assert out["probe"]["sample_rate"] == 44100 and out["probe"]["channels"] == 1
    assert 21 < out["stats"]["duration"] < 23 and out["windows"]
    w = out["windows"][0]
    assert abs((w["end"] - w["start"]) - 8) < 0.1 and w["silence"] < 0.55
    assert out["transcript"]["text"].startswith("가짜 전사")
    assert audio.suggest_windows(np.zeros(24000 * 10, dtype=np.float32), 24000) == []  # (all silence: none)
    with pytest.raises(VoiceError):
        await vh.analyze(b"not audio at all")


async def test_a_short_upload_is_refused(vh):
    v = vh.voices.create("짧은 목소리")
    with pytest.raises(VoiceError) as err:
        await vh.add_reference(v["id"], wav_bytes(0.4), label="neutral")
    assert err.value.code == "bad_input"
