"""Voice: the request each TTS/STT provider gets (HTTP mocked at
app.mate.netio.request), the disk cache, 204 for browser voices, clear
errors for missing keys/URLs, voice listings."""

from __future__ import annotations

import json
import secrets

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import netio, voice


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


class Recorder:
    def __init__(self):
        self.calls = []
        self.routes = []  # (predicate, response)

    def on(self, pred, resp):
        self.routes.append((pred, resp))

    async def __call__(self, method, url, *, headers=None, json_body=None, data=None, timeout=60):
        self.calls.append({"method": method, "url": url, "headers": headers or {}, "json": json_body, "data": data})
        for pred, resp in self.routes:
            if pred(method, url):
                return resp
        return netio.Response(404, b'{"detail": "no route"}', {"content-type": "application/json"})


@pytest.fixture
def http(monkeypatch):
    rec = Recorder()
    monkeypatch.setattr(netio, "request", rec)
    voice._voices_cache.clear()
    return rec


def _mate(client, tts=None, stt=None):
    r = client.post("/api/mates", json={"name": "Voice", "voice": {"tts": tts or {}, "stt": stt or {}}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


MP3 = netio.Response(200, b"ID3" + b"\x00" * 64, {"content-type": "audio/mpeg"})
WAV = netio.Response(200, b"RIFF" + b"\x00" * 64, {"content-type": "audio/wav"})


def test_browser_voice_is_204(client, http):
    mid = _mate(client)
    assert client.post(f"/api/mates/{mid}/speech", json={"text": "hi"}).status_code == 204
    assert http.calls == []
    assert client.post(f"/api/mates/{mid}/transcribe", files={"file": ("a.webm", b"x", "audio/webm")}).status_code == 400


def test_openai_tts_request_and_cache(client, http):
    client.put("/api/mates/settings", json={"openai_key": "sk-test"})
    mid = _mate(client, {"engine": "openai", "voice": "nova", "speed": 1.25})
    http.on(lambda m, u: u.endswith("/audio/speech"), MP3)
    text = "안녕하세요 " + secrets.token_hex(4)
    r = client.post(f"/api/mates/{mid}/speech", json={"text": text, "emotion": "joy"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.content == MP3.body
    assert r.headers["x-speech-cache"] == "miss"
    call = http.calls[-1]
    assert call["method"] == "POST" and call["url"] == "https://api.openai.com/v1/audio/speech"
    assert call["headers"]["Authorization"] == "Bearer sk-test"
    assert call["json"] == {"model": "gpt-4o-mini-tts", "voice": "nova", "input": text, "response_format": "mp3",
                            "speed": 1.25, "instructions": "Speak in a natural, joy tone."}
    r2 = client.post(f"/api/mates/{mid}/speech", json={"text": text, "emotion": "joy"})
    assert r2.headers["x-speech-cache"] == "hit" and r2.content == MP3.body and len(http.calls) == 1
    # key removed in Global settings -> 204 + "fall back to the browser voice"; upstream failure -> 502
    client.put("/api/mates/settings", json={"openai_key": ""})
    r = client.post(f"/api/mates/{mid}/speech", json={"text": "new text"})
    assert r.status_code == 204 and r.headers["x-speech-fallback"] == "browser"
    assert "OpenAI" in r.headers["x-speech-fallback-reason"] and len(http.calls) == 1
    client.put("/api/mates/settings", json={"openai_key": "sk-test"})
    http.routes = [(lambda m, u: True, netio.Response(401, b'{"error": {"message": "Incorrect API key"}}',
                                                      {"content-type": "application/json"}))]
    r = client.post(f"/api/mates/{mid}/speech", json={"text": "other text"})
    assert r.status_code == 502 and "Incorrect API key" in r.json()["detail"]


def test_elevenlabs_tts_request(client, http):
    mid = _mate(client, {"engine": "elevenlabs", "voice": "", "model": ""})
    client.put("/api/mates/settings", json={"elevenlabs_key": "xi-key"})
    r = client.post(f"/api/mates/{mid}/speech", json={"text": "hi"})
    assert r.status_code == 400 and "voice" in r.json()["detail"] and "Voice" in r.json()["detail"]
    client.patch(f"/api/mates/{mid}", json={"voice": {"tts": {"voice": "v123"}}})
    http.on(lambda m, u: "text-to-speech" in u, MP3)
    r = client.post(f"/api/mates/{mid}/speech", json={"text": "hello " + secrets.token_hex(3)})
    assert r.status_code == 200
    call = http.calls[-1]
    assert call["url"] == "https://api.elevenlabs.io/v1/text-to-speech/v123?output_format=mp3_44100_128"
    assert call["headers"]["xi-api-key"] == "xi-key" and call["json"]["model_id"] == "eleven_multilingual_v2"
    http.on(lambda m, u: "/v1/voices" in u, netio.Response(200, json.dumps({"voices": [
        {"voice_id": "v1", "name": "Rachel", "labels": {"accent": "american"}, "preview_url": "https://x/p.mp3"}]}).encode(),
        {"content-type": "application/json"}))
    vs = client.get("/api/mates/voices?engine=elevenlabs").json()["voices"]
    assert vs == [{"id": "v1", "name": "Rachel", "language": "american", "category": None,
                   "labels": {"accent": "american"}, "preview_url": "https://x/p.mp3"}]


PROFILES = {"voices": [{"id": "mao_pro", "name": "마오", "language": "ko", "is_template": False, "ref_audios": [
    {"emotion": "neutral", "file": "/voices/mao_pro/ref_neutral.wav", "prompt_text": "안녕하세요", "prompt_lang": "ko"},
    {"emotion": "joy", "file": "/voices/mao_pro/ref_joy.wav", "prompt_text": "와 신난다", "prompt_lang": "ko"},
]}]}


def test_omnivoice_profile_and_emotion_reference(client, http):
    mid = _mate(client, {"engine": "omnivoice", "profile": "mao_pro"})
    client.put("/api/mates/settings", json={"omnivoice_url": ""})
    r = client.post(f"/api/mates/{mid}/speech", json={"text": "x"})
    assert r.status_code == 204 and "OmniVoice" in r.headers["x-speech-fallback-reason"]
    client.put("/api/mates/settings", json={"omnivoice_url": "http://omni:9880/"})
    http.on(lambda m, u: u == "http://omni:9880/voices", netio.Response(200, json.dumps(PROFILES).encode(),
                                                                        {"content-type": "application/json"}))
    http.on(lambda m, u: u == "http://omni:9880/tts", WAV)
    text = "좋아요 " + secrets.token_hex(3)
    r = client.post(f"/api/mates/{mid}/speech", json={"text": text, "emotion": "smile"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    tts = http.calls[-1]
    assert tts["json"] == {"text": text, "mode": "clone", "speed": 1.0, "audio_format": "wav", "language": "ko",
                           "ref_audio_path": "/voices/mao_pro/ref_joy.wav", "ref_text": "와 신난다"}
    r = client.post(f"/api/mates/{mid}/speech", json={"text": text + "!", "emotion": "sad"})  # no sadness clip
    assert http.calls[-1]["json"]["ref_audio_path"] == "/voices/mao_pro/ref_neutral.wav"
    assert sum(1 for c in http.calls if c["url"].endswith("/voices")) == 1  # profiles cached
    vs = client.get("/api/mates/voices?engine=omnivoice").json()["voices"]
    assert vs == [{"id": "mao_pro", "name": "마오", "language": "ko", "emotions": ["joy", "neutral"]}]
    client.patch(f"/api/mates/{mid}", json={"voice": {"tts": {"profile": "ghost"}}})
    assert "ghost" in client.post(f"/api/mates/{mid}/speech", json={"text": "z"}).json()["detail"]
    assert voice.resolve_emotion_ref({"ref_audios": []}, "joy") == (None, "")


def test_http_tts_url_shapes(client, http):
    mid = _mate(client, {"engine": "http", "voice": "alice"})
    client.put("/api/mates/settings", json={"http_tts_url": "http://tts.local:8000/v1", "http_tts_key": "k"})
    http.on(lambda m, u: True, MP3)
    assert client.post(f"/api/mates/{mid}/speech", json={"text": "hey " + secrets.token_hex(3)}).status_code == 200
    assert http.calls[-1]["url"] == "http://tts.local:8000/v1/audio/speech"
    assert http.calls[-1]["headers"] == {"Authorization": "Bearer k"} and http.calls[-1]["json"]["voice"] == "alice"


def test_transcription_openai_and_whisper(client, http):
    client.put("/api/mates/settings", json={"openai_key": "sk-stt", "whisper_url": "http://whisper:9000"})
    mid = _mate(client, stt={"engine": "openai", "language": "ko"})
    http.on(lambda m, u: u.endswith("/audio/transcriptions"),
            netio.Response(200, json.dumps({"text": " 안녕 "}).encode(), {"content-type": "application/json"}))
    r = client.post(f"/api/mates/{mid}/transcribe", files={"file": ("rec.webm", b"OPUSDATA", "audio/webm")})
    assert r.status_code == 200 and r.json()["text"] == "안녕"
    call = http.calls[-1]
    assert call["url"] == "https://api.openai.com/v1/audio/transcriptions"
    assert call["headers"]["Authorization"] == "Bearer sk-stt"
    assert call["headers"]["Content-Type"].startswith("multipart/form-data; boundary=")
    body = call["data"]
    assert b'name="model"\r\n\r\ngpt-4o-mini-transcribe' in body and b'name="language"\r\n\r\nko' in body
    assert b'filename="rec.webm"\r\nContent-Type: audio/webm\r\n\r\nOPUSDATA' in body
    client.patch(f"/api/mates/{mid}", json={"voice": {"stt": {"engine": "whisper"}}})
    client.post(f"/api/mates/{mid}/transcribe", files={"file": ("rec.webm", b"x", "audio/webm")})
    assert http.calls[-1]["url"] == "http://whisper:9000/v1/audio/transcriptions"
    assert "Authorization" not in http.calls[-1]["headers"]
    assert b"whisper-1" in http.calls[-1]["data"]


def test_voice_listing(client, http):
    vs = client.get("/api/mates/voices?engine=openai").json()["voices"]
    nova = next(v for v in vs if v["id"] == "nova")
    assert nova["name"] == "Nova" and "tts-1" in nova["models"]
    assert next(v for v in vs if v["id"] == "verse")["models"] == ["gpt-4o-mini-tts"]
    assert client.get("/api/mates/voices?engine=browser").json()["voices"] == []
    assert client.get("/api/mates/voices?engine=martian").status_code == 400


def test_speech_draft_settings_preserve_existing_voice_and_validate(client):
    mid = _mate(client, stt={"engine": "whisper", "silence": 1.2})
    url = f"/api/mates/{mid}"
    initial = client.get(url).json()["voice"]["stt"]
    assert initial["merge_fragments"] is True and initial["continuation_grace"] == 1.8
    assert initial["ignore_short_fragments"] is False
    r = client.patch(url, json={"voice": {"stt": {"continuation_grace": 2.4, "auto_send": True}}})
    assert r.status_code == 200
    stt = r.json()["voice"]["stt"]
    assert stt["continuation_grace"] == 2.4 and stt["engine"] == "whisper" and stt["silence"] == 1.2
    for patch in ({"merge_fragments": "yes"}, {"ignore_short_fragments": {}}, {"continuation_grace": True}):
        assert client.patch(url, json={"voice": {"stt": patch}}).status_code == 400
    assert client.patch(url, json={"voice": {"stt": {"continuation_grace": 99}}}).json()["voice"]["stt"]["continuation_grace"] == 5
