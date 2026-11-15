"""Laughs, sighs and yawns (app/voicehost/nonverbal.py, sounds.py; docs/local-voice.md "Laughs, sighs and yawns"): the
sounds people write found (and only those: 아하, 하키, 휴가, 흥미, 이리 와 are words), given to each engine the way it makes
them, a voice's own laugh put in where a line laughs — with the stand-in engine in a real worker process: a built-in
voice's shipped laughs, a profile's laughs made (and made by themselves the first time a line laughs), the routes, the
switch, and ElevenLabs' audio tags for a mate."""

from __future__ import annotations

import asyncio
import secrets

import numpy as np
import pytest
import soundfile as sf

from app.voicehost import nonverbal as NV
from app.voicehost.service import VoiceHost
from app.voicehost.settings import VoiceSettings
from tests.test_voicehost import mark_installed


def kinds(text: str) -> list[tuple[str, str]]:
    return [(s.kind, s.said or f"[{s.tag}]") for s in NV.find(text)]


# ---- what people write ----

def test_the_sounds_people_write_are_found_and_words_are_left_alone():
    assert kinds("자기야 헤헤 왜 그래 하하에헤") == [("giggle", "헤헤"), ("laugh", "하하에헤")]
    assert kinds("ㅋㅋㅋ 너 진짜 웃기다.") == [("laugh", "ㅋㅋㅋ")]
    assert kinds("하암~ 졸려.") == [("yawn", "하암~")]
    assert kinds("후우... 힘들다") == [("sigh", "후우...")]
    assert kinds("헉! 진짜?") == [("gasp", "헉!")]
    assert kinds("흥, 몰라 ㅠㅠ") == [("pout", "흥,"), ("sob", "ㅠㅠ")]
    assert kinds("푸하하! 에헤헤~ 히히히 깔깔 크크 후후") == [
        ("laugh", "푸하하!"), ("giggle", "에헤헤~"), ("giggle", "히히히"), ("laugh", "깔깔"), ("laugh", "크크"), ("giggle", "후후")]
    assert kinds("하… 진짜") == [("sigh", "하…")] and kinds("와! 대박") == [("wow", "와!")]
    assert kinds("haha that's funny, hehe") == [("laugh", "haha"), ("giggle", "hehe")]
    # words that only look like sounds
    for text in ("아하, 그렇구나", "하키 보러 가자", "휴가 가고 싶다", "흥미롭네", "이리 와 봐", "오호, 그래?", "휴대폰 어딨지",
                 "음... 그건 좀", "하품 나와"):
        assert kinds(text) == [], text


def test_a_tag_written_for_a_sound_is_that_sound_and_one_right_before_its_sound_is_one():
    assert kinds("[웃음] 고마워") == [("laugh", "[웃음]")]
    assert kinds("(한숨) 그래...") == [("sigh", "[한숨]")]
    assert kinds("*하품* 졸려") == [("yawn", "[하품]")]
    assert kinds("[laugh] okay") == [("laugh", "[laugh]")]
    assert kinds("[웃음] 헤헤 고마워") == [("laugh", "헤헤")]       # (the tag and the sound it names: one)
    assert kinds("자기야 [laughter] 헤헤") == [("laugh", "헤헤")]
    assert kinds("[스마일] 안녕") == []                              # (not a sound: left as it is)


# ---- what each engine is given ----

def test_each_engine_gets_the_sounds_the_way_it_makes_them():
    line = "자기야 헤헤 왜 그래 ㅋㅋ"
    assert NV.render(line, "omnivoice").text == "자기야 [laughter] 헤헤 왜 그래 [laughter] 크크"
    assert NV.render(line, "elevenlabs").text == "자기야 [giggles] 헤헤 왜 그래 [laughs] 크크"
    for engine in ("qwen3_tts", "cosyvoice3", "plain"):  # (no tags that help: the syllables, the letters said)
        assert NV.render(line, engine).text == "자기야 헤헤 왜 그래 크크"
    assert NV.render("헉! 진짜?", "omnivoice").text == "헉! [surprise-ah] 진짜?"
    assert NV.render("하암~ 졸려", "omnivoice").text == "[sigh] 하암~ 졸려"
    # a bare tag gets the sound's syllables (a tag alone comes out as a breath, or is refused: ElevenLabs)
    assert NV.render("(한숨) 그래", "omnivoice").text == "[sigh] 하아… 그래"
    assert NV.render("[웃음] 고마워", "elevenlabs").text == "[laughs] 하하하 고마워"
    assert NV.render("[웃음] 고마워", "qwen3_tts").text == "하하하 고마워"
    # an engine's own tag is kept for it, and never read out by another ("라우터": Qwen reading [laughter])
    assert NV.render("좋아 [laughter] 헤헤", "omnivoice").text == "좋아 [laughter] 헤헤"
    assert NV.render("좋아 [laughter] 헤헤", "qwen3_tts").text == "좋아 헤헤"
    assert NV.render("음 [question-ei] 그래?", "qwen3_tts").text == "음 그래?"
    assert NV.render("음 [question-ei] 그래?", "omnivoice").text == "음 [question-ei] 그래?"
    # off: read as written, but letters that are no speech still not read out
    off = NV.render("ㅋㅋ 고마워 ㅠㅠ", "omnivoice", on=False)
    assert off.text == "크크 고마워" and off.sounds == []
    assert NV.render("평범한 문장이에요.", "omnivoice").text == "평범한 문장이에요."


def test_a_line_in_parts_with_the_voices_laugh_put_where_it_laughs():
    parts, made = NV.parts("자기야 헤헤 왜 그래 하하에헤", "omnivoice", {"laugh", "giggle"})
    assert parts == [("say", "자기야"), ("sound", "giggle"), ("say", "왜 그래"), ("sound", "laugh")]
    assert [m["kind"] for m in made] == ["giggle", "laugh"] and all(m.get("clip") for m in made)
    # no laugh of the voice: the line as the engine makes it
    parts, made = NV.parts("자기야 헤헤 왜 그래", "omnivoice", set())
    assert parts == [("say", "자기야 [laughter] 헤헤 왜 그래")] and not made[0].get("clip")
    # CosyVoice3 makes up words for a part of two or three syllables: such a laugh stays in the line
    parts, _ = NV.parts("자기야 헤헤 왜 그래 하하에헤", "cosyvoice3", {"laugh", "giggle"})
    assert parts == [("say", "자기야 헤헤 왜 그래"), ("sound", "laugh")]
    # a short laugh (ㅋㅋㅋ, 하하) is a giggle; a line that is only a laugh is only the clip
    assert NV.parts("ㅋㅋㅋ 너 진짜 웃기다.", "qwen3_tts", {"laugh"})[0] == [("sound", "giggle"), ("say", "너 진짜 웃기다.")]
    assert NV.parts("하하하하하", "qwen3_tts", {"laugh"})[0] == [("sound", "laugh")]
    # a yawn takes a clip only when the voice has one
    assert NV.parts("하암~ 졸려", "qwen3_tts", {"laugh"})[0] == [("say", "하암~ 졸려")]
    assert NV.parts("하암~ 졸려", "qwen3_tts", {"yawn"})[0] == [("sound", "yawn"), ("say", "졸려")]
    assert NV.parts("ㅋㅋ 좋아", "omnivoice", {"laugh"}, on=False)[0] == [("say", "크크 좋아")]


# ---- in the service, with the stand-in engine ----

@pytest.fixture()
def vs(tmp_path):
    s = VoiceSettings(home=tmp_path / "voice", engine_mode="fake", idle_unload_seconds=0)
    s.ensure_dirs()
    mark_installed(s, "omnivoice", "qwen3-tts-0.6b-base")
    return s


@pytest.fixture()
async def vh(db, vs):
    h = VoiceHost(db, vs)
    await h.start()
    yield h
    await h.stop()


def _secs(vh, e) -> float:
    x, sr = sf.read(str(vh.history.path(e)), dtype="float32")
    return len(x) / sr


async def test_a_built_in_voice_laughs_with_its_own_laugh_and_reads_it_out_when_asked(vh):
    own = vh.voices.sound_clips("builtin:chaerin")
    assert len(own["laugh"]) == 3 and len(own["giggle"]) == 3  # (shipped: app/mate/builtin/voices/chaerin/sounds)
    # (and never cloned from: the line is cloned from a feeling's clip)
    assert vh.voices.resolve("builtin:chaerin")["label"] == "neutral"
    e = await vh.generate(model_id="qwen3-tts-0.6b-base", text="자기야 헤헤 왜 그래 하하에헤", voice_id="builtin:chaerin",
                          mode="clone", language="ko", seed=3)
    assert e["info"]["spoken"] == "자기야 [giggle] 왜 그래 [laugh]"
    assert [(s["kind"], s.get("clip")) for s in e["info"]["sounds"]] == [("giggle", "1"), ("laugh", "1")]
    assert e["text"] == "자기야 헤헤 왜 그래 하하에헤"  # (the history keeps what was written)
    off = await vh.generate(model_id="qwen3-tts-0.6b-base", text="자기야 헤헤 왜 그래 하하에헤", voice_id="builtin:chaerin",
                            mode="clone", language="ko", seed=3, nonverbal=False)
    assert off["info"]["sounds"] == [] and off["info"]["spoken"] == "자기야 헤헤 왜 그래 하하에헤"
    assert off["params"].get("_nonverbal") is False and "_nonverbal" not in e["params"]
    # the laugh is in the audio: longer than the words alone, and loud where it is
    words = await vh.generate(model_id="qwen3-tts-0.6b-base", text="자기야 왜 그래", voice_id="builtin:chaerin",
                              mode="clone", language="ko", seed=3)
    assert _secs(vh, e) > _secs(vh, words) + 1.0
    # nothing but a laugh: the clip is the line (no model needed for it)
    only = await vh.generate(model_id="qwen3-tts-0.6b-base", text="ㅋㅋㅋ", voice_id="builtin:chaerin", mode="clone")
    assert only["info"]["spoken"] == "[giggle]" and 0.3 < _secs(vh, only) <= 1.2


async def test_a_profiles_laugh_is_made_kept_used_and_forgotten(vh):
    v = vh.voices.create("내 목소리", "ko")
    await vh.add_reference(v["id"], sf_bytes(4.0), label="neutral", transcript="안녕하세요 저는 테스트 목소리예요")
    doc = vh.voice_sounds(v["id"])
    assert doc["made"] is None and doc["own"] == {} and doc["maker"] == "omnivoice"
    made = await vh.make_sounds(vh.voices.resolve(v["id"]), takes=4, keep=2)
    assert sorted(made["kinds"]) == ["giggle", "laugh"] and len(made["kinds"]["laugh"]) == 2
    doc = vh.voice_sounds(v["id"])
    assert doc["made"]["kinds"]["laugh"] == ["laugh-1.wav", "laugh-2.wav"] and doc["made"]["model_id"] == "omnivoice"
    assert vh.made_sound_file(v["id"], "laugh-1.wav").is_file()
    assert vh.made_sound_file(v["id"], "../../etc/passwd") is None
    e = await vh.generate(model_id="omnivoice", text="좋아 하하하하 고마워", voice_id=v["id"], mode="clone", seed=1)
    assert e["info"]["spoken"] == "좋아 [laugh] 고마워"
    # their own laugh comes first
    await vh.add_reference(v["id"], sf_bytes(1.2), label="laugh")
    await vh.add_reference(v["id"], sf_bytes(1.4), label="laugh")
    assert len(vh.voices.sound_clips(v["id"])["laugh"]) == 2  # (several of a sound: none replaced)
    assert vh.voice_sounds(v["id"])["own"] == {"laugh": 2}
    assert vh.voices.resolve(v["id"])["label"] == "neutral"
    assert vh.sounds.forget(vh.voices.resolve(v["id"])) and vh.voice_sounds(v["id"])["made"] is None


async def test_the_first_line_that_laughs_makes_the_voices_laugh_for_the_next(vh):
    v = vh.voices.create("새 목소리", "ko")
    await vh.add_reference(v["id"], sf_bytes(4.0), label="neutral", transcript="새 목소리의 기본 클립이에요")
    first = await vh.generate(model_id="omnivoice", text="ㅋㅋ 진짜 웃기다", voice_id=v["id"], mode="clone", seed=2)
    assert first["info"]["spoken"] == "[laughter] 크크 진짜 웃기다"  # (none yet: the model's own laugh)
    key = next(iter(vh._making))
    await asyncio.wait_for(vh._making[key], 60)
    nxt = await vh.generate(model_id="omnivoice", text="ㅋㅋ 진짜 웃기다", voice_id=v["id"], mode="clone", seed=2)
    assert nxt["info"]["spoken"] == "[giggle] 진짜 웃기다"
    # turned off: nothing made by itself
    vh.put_settings({"auto_sounds": False})
    w = vh.voices.create("또 다른 목소리", "ko")
    await vh.add_reference(w["id"], sf_bytes(4.0), label="neutral", transcript="또 다른 목소리예요")
    await vh.generate(model_id="omnivoice", text="하하하 좋아", voice_id=w["id"], mode="clone")
    assert not vh._making and vh.settings_doc()["auto_sounds"] is False


async def test_the_sounds_routes(client_vh):
    client, vh = client_vh
    v = client.post("/api/voice/voices", json={"name": "라우트", "language": "ko"}).json()
    r = client.post(f"/api/voice/voices/{v['id']}/sounds")
    assert r.status_code == 400 and r.json()["code"] == "no_clip"
    client.post(f"/api/voice/voices/{v['id']}/references", files={"file": ("a.wav", sf_bytes(4.0), "audio/wav")},
                data={"label": "neutral", "transcript": "라우트 테스트 목소리예요"})
    assert client.get(f"/api/voice/voices/{v['id']}/sounds").json()["made"] is None
    doc = client.post(f"/api/voice/voices/{v['id']}/sounds").json()
    assert doc["made"]["kinds"]["laugh"][0] == "laugh-1.wav"
    a = client.get(f"/api/voice/voices/{v['id']}/sounds/laugh-1.wav")
    assert a.status_code == 200 and a.headers["content-type"] == "audio/wav"
    assert client.get(f"/api/voice/voices/{v['id']}/sounds/nope.wav").status_code == 404
    up = client.post(f"/api/voice/voices/{v['id']}/references", files={"file": ("l.wav", sf_bytes(1.5), "audio/wav")},
                     data={"label": "laugh"}).json()
    assert up["label"] == "laugh"
    listed = next(x for x in client.get("/api/voice/voices").json()["voices"] if x["id"] == v["id"])
    assert sorted(r["label"] for r in listed["references"]) == ["laugh", "neutral"]
    e = client.post("/api/voice/generate", json={"model_id": "omnivoice", "voice_id": v["id"], "text": "하하하하 좋다",
                                                 "nonverbal": False}).json()
    assert e["info"]["sounds"] == [] and e["params"]["_nonverbal"] is False
    assert client.delete(f"/api/voice/voices/{v['id']}/sounds").json()["made"] is None


@pytest.fixture()
def client_vh(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app
    from app.voicehost import settings as VS

    monkeypatch.setattr(VS.VoiceSettings, "from_app", classmethod(
        lambda cls: _fake_settings(tmp_path)))
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c, app.state.voice_host


def _fake_settings(tmp_path):
    s = VoiceSettings(home=tmp_path / "voice-api", engine_mode="fake", idle_unload_seconds=0)
    s.ensure_dirs()
    mark_installed(s, "omnivoice")
    return s


def sf_bytes(seconds: float, sr: int = 24000) -> bytes:
    import io

    t = np.arange(int(seconds * sr)) / sr
    x = (0.25 * np.sin(2 * np.pi * 200 * t) * (np.sin(2 * np.pi * 1.3 * t) > -0.3)).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, x, sr, format="WAV")
    return buf.getvalue()


# ---- a mate's voice on ElevenLabs ----

def test_a_mate_on_elevenlabs_v4_gets_audio_tags_and_older_models_none(client, http):
    from tests.test_mate_voice import MP3, _mate

    mid = _mate(client, {"engine": "elevenlabs", "voice": "v123", "model": ""})
    client.put("/api/mates/settings", json={"elevenlabs_key": "xi-key"})
    http.on(lambda m, u: "text-to-speech" in u, MP3)
    tail = secrets.token_hex(3)
    assert client.post(f"/api/mates/{mid}/speech", json={"text": f"자기야 헤헤 하암~ {tail}"}).status_code == 200
    assert http.calls[-1]["json"]["text"] == f"자기야 [giggles] 헤헤 [yawns] 하암~ {tail}"
    client.patch(f"/api/mates/{mid}", json={"voice": {"tts": {"model": "eleven_flash_v2_5"}}})
    assert client.post(f"/api/mates/{mid}/speech", json={"text": f"ㅋㅋ 좋아 {tail}"}).status_code == 200
    assert http.calls[-1]["json"]["text"] == f"크크 좋아 {tail}"


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


@pytest.fixture()
def http(monkeypatch):
    from app.mate import netio, voice
    from tests.test_mate_voice import Recorder

    rec = Recorder()
    monkeypatch.setattr(netio, "request", rec)
    voice._voices_cache.clear()
    return rec
