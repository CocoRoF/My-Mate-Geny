"""ElevenLabs realtime speech-to-text for mates (docs/mate.md §5): the single-use token the page streams with
(the API key never in an answer or a log line), failures with a code + the fallback engine, the recording
fallback (/transcribe), the per-mate settings (auto-send, barge-in, pause), the provider listing."""

from __future__ import annotations

import json
import logging
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import netio, voice

KEY = "sk_eleven_SECRET_0123456789abcdef"
TOKEN = "sutkn_single_use_ABCDEF123456"


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        # (the test database is shared: start every test from "only ElevenLabs is set up")
        assert c.put("/api/mates/settings", json={"openai_key": "", "whisper_url": "", "elevenlabs_key": KEY}).status_code == 200
        app.state.voice_service._minted.clear()
        yield c


class Recorder:
    def __init__(self):
        self.calls = []
        self.routes = []

    def on(self, pred, resp):
        self.routes.append((pred, resp))

    async def __call__(self, method, url, *, headers=None, json_body=None, data=None, timeout=60):
        self.calls.append({"method": method, "url": url, "headers": headers or {}, "json": json_body, "data": data})
        for pred, resp in self.routes:
            if pred(method, url):
                if isinstance(resp, Exception):
                    raise resp
                return resp
        return netio.Response(404, b'{"detail": "no route"}', {"content-type": "application/json"})


@pytest.fixture
def http(monkeypatch):
    rec = Recorder()
    monkeypatch.setattr(netio, "request", rec)
    return rec


def _json(status, body):
    return netio.Response(status, json.dumps(body).encode(), {"content-type": "application/json"})


def _mate(client, stt=None, persona=None):
    r = client.post("/api/mates", json={"name": "Ears", "persona": persona or {"language": "ko"},
                                        "voice": {"stt": stt if stt is not None else {"engine": "elevenlabs"}}})
    assert r.status_code == 200, r.text
    return r.json()


is_token = lambda m, u: m == "POST" and u.endswith("/single-use-token/realtime_scribe")  # noqa: E731


def test_settings_defaults_and_persistence(client, http):
    m = _mate(client, stt={})
    stt = m["voice"]["stt"]
    assert stt["engine"] == "browser" and stt["auto_send"] is False and stt["barge_in"] is True and stt["silence"] == 1.2
    r = client.patch(f"/api/mates/{m['id']}", json={"voice": {"stt": {"engine": "elevenlabs", "auto_send": True,
                                                                       "barge_in": False, "silence": 0.8}}})
    assert r.status_code == 200, r.text
    got = client.get(f"/api/mates/{m['id']}").json()["voice"]["stt"]
    assert got == {"engine": "elevenlabs", "model": "", "language": "", "auto_send": True, "barge_in": False, "silence": 0.8,
                   "merge_fragments": True, "continuation_grace": 1.8, "ignore_short_fragments": False}
    # a partial update keeps the rest; the pause is clamped to what ElevenLabs takes
    client.patch(f"/api/mates/{m['id']}", json={"voice": {"stt": {"silence": 9}}})
    got = client.get(f"/api/mates/{m['id']}").json()["voice"]["stt"]
    assert got["silence"] == 3.0 and got["auto_send"] is True and got["engine"] == "elevenlabs"
    for bad in ({"auto_send": "yes"}, {"barge_in": 2}, {"silence": True}, {"engine": "scribe"}):
        assert client.patch(f"/api/mates/{m['id']}", json={"voice": {"stt": bad}}).status_code == 400, bad


def test_token_url_and_no_key_anywhere(client, http, caplog):
    caplog.set_level(logging.DEBUG)
    m = _mate(client, stt={"engine": "elevenlabs", "silence": 0.9}, persona={"language": "ko"})
    http.on(is_token, _json(200, {"token": TOKEN}))
    r = client.post(f"/api/mates/{m['id']}/stt/realtime")
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    out = r.json()
    url = urlparse(out["url"])
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert url.scheme == "wss" and url.netloc == "api.elevenlabs.io" and url.path == "/v1/speech-to-text/realtime"
    assert q == {"model_id": "scribe_v2_realtime", "token": TOKEN, "audio_format": "pcm_16000",
                 "commit_strategy": "vad", "vad_silence_threshold_secs": "0.9", "language_code": "ko"}
    assert out["sample_rate"] == 16000 and out["language"] == "ko" and out["expires_in"] == 900
    assert out["fallback"] == "elevenlabs"  # nothing else set up: the same key's batch model
    call = http.calls[-1]
    assert call["headers"]["xi-api-key"] == KEY and call["url"] == "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe"
    # the key: never in the answer, never in a log line; the token: only in the answer
    assert KEY not in r.text
    logs = "\n".join(rec.getMessage() for rec in caplog.records)
    assert KEY not in logs and TOKEN not in logs
    assert "realtime speech-to-text token issued" in logs
    # the language follows the reply language unless the mate's STT names one; empty = auto-detect
    client.patch(f"/api/mates/{m['id']}", json={"voice": {"stt": {"language": "en-US"}}})
    assert "language_code=en" in client.post(f"/api/mates/{m['id']}/stt/realtime").json()["url"]


def test_token_failures_have_a_code_and_a_fallback(client, http, caplog):
    caplog.set_level(logging.DEBUG)
    m = _mate(client)
    mid = m["id"]
    http.on(is_token, _json(401, {"detail": {"status": "invalid_api_key", "message": "Invalid API key"}}))
    r = client.post(f"/api/mates/{mid}/stt/realtime")
    assert r.status_code == 502
    assert r.json()["code"] == "auth" and "rejected the key" in r.json()["detail"]
    assert r.json()["fallback"] is None  # the key is the problem: not its batch model either
    # a Whisper server is set up: it transcribes the recording instead
    client.put("/api/mates/settings", json={"whisper_url": "http://whisper:9000"})
    assert client.post(f"/api/mates/{mid}/stt/realtime").json()["fallback"] == "whisper"
    client.put("/api/mates/settings", json={"whisper_url": ""})

    http.routes.clear()
    http.on(is_token, _json(401, {"detail": {"status": "quota_exceeded", "message": "This request exceeds your quota"}}))
    r = client.post(f"/api/mates/{mid}/stt/realtime")
    assert r.json()["code"] == "quota" and "credits" in r.json()["detail"]

    http.routes.clear()
    http.on(is_token, _json(429, {"detail": {"status": "too_many_concurrent_requests", "message": "slow down"}}))
    assert client.post(f"/api/mates/{mid}/stt/realtime").json()["code"] == "busy"

    # unreachable — and an error text that (somehow) quotes the key is redacted
    http.routes.clear()
    http.on(is_token, netio.UpstreamError(f"cannot reach api.elevenlabs.io: refused ({KEY})"))
    r = client.post(f"/api/mates/{mid}/stt/realtime")
    assert r.status_code == 502 and r.json()["code"] == "network" and r.json()["fallback"] == "elevenlabs"
    assert KEY not in r.text and "[redacted]" in r.text
    assert KEY not in "\n".join(rec.getMessage() for rec in caplog.records)

    # no key at all
    client.put("/api/mates/settings", json={"elevenlabs_key": ""})
    r = client.post(f"/api/mates/{mid}/stt/realtime")
    assert r.status_code == 400 and r.json()["code"] == "missing" and r.json()["fallback"] is None


def test_token_needs_the_engine_and_is_rate_limited(client, http):
    other = _mate(client, stt={"engine": "browser"})
    assert client.post(f"/api/mates/{other['id']}/stt/realtime").status_code == 400
    m = _mate(client)
    http.on(is_token, _json(200, {"token": TOKEN}))
    codes = [client.post(f"/api/mates/{m['id']}/stt/realtime").status_code for _ in range(voice.MINT_PER_MINUTE + 1)]
    assert codes[:-1] == [200] * voice.MINT_PER_MINUTE and codes[-1] == 429
    assert client.post(f"/api/mates/{m['id']}/stt/realtime").json()["code"] == "busy"


def test_recording_fallback(client, http):
    m = _mate(client, stt={"engine": "elevenlabs", "model": "scribe_v2_realtime"})
    mid = m["id"]
    wav = b"RIFF\x00\x00\x00\x00WAVEfmt " + b"\x00" * 64
    # only ElevenLabs: its batch model, with the language
    http.on(lambda mth, u: u.endswith("/v1/speech-to-text"), _json(200, {"text": " 안녕하세요 ", "language_code": "kor"}))
    r = client.post(f"/api/mates/{mid}/transcribe", files={"file": ("speech.wav", wav, "audio/wav")})
    assert r.status_code == 200, r.text
    assert r.json() == {"text": "안녕하세요", "language": "kor", "engine": "elevenlabs"}
    call = http.calls[-1]
    assert call["headers"]["xi-api-key"] == KEY
    assert b'name="model_id"\r\n\r\nscribe_v2' in call["data"] and b'name="language_code"\r\n\r\nko' in call["data"]
    # a Whisper server wins (free, local) — and gets its own default model, not the realtime one
    client.put("/api/mates/settings", json={"whisper_url": "http://whisper:9000"})
    http.on(lambda mth, u: u.endswith("/audio/transcriptions"), _json(200, {"text": "네"}))
    r = client.post(f"/api/mates/{mid}/transcribe", files={"file": ("speech.wav", wav, "audio/wav")})
    assert r.json()["engine"] == "whisper" and r.json()["text"] == "네"
    assert http.calls[-1]["url"] == "http://whisper:9000/v1/audio/transcriptions"
    assert b"scribe_v2_realtime" not in http.calls[-1]["data"]
    # an engine asked for explicitly (the key failed: skip ElevenLabs) / one that isn't set up
    r = client.post(f"/api/mates/{mid}/transcribe?engine=whisper", files={"file": ("speech.wav", wav, "audio/wav")})
    assert r.json()["engine"] == "whisper"
    r = client.post(f"/api/mates/{mid}/transcribe?engine=openai", files={"file": ("speech.wav", wav, "audio/wav")})
    assert r.status_code == 400 and "OpenAI" in r.json()["detail"]
    client.put("/api/mates/settings", json={"whisper_url": ""})
    # a failing batch call is a readable 502 without the key
    http.routes.clear()
    http.on(lambda mth, u: u.endswith("/v1/speech-to-text"), _json(401, {"detail": {"status": "quota_exceeded", "message": "no credits"}}))
    r = client.post(f"/api/mates/{mid}/transcribe", files={"file": ("speech.wav", wav, "audio/wav")})
    assert r.status_code == 502 and "credits" in r.json()["detail"] and KEY not in r.text
    # nothing on the server at all
    client.put("/api/mates/settings", json={"elevenlabs_key": ""})
    r = client.post(f"/api/mates/{mid}/transcribe", files={"file": ("speech.wav", wav, "audio/wav")})
    assert r.status_code == 400


def test_providers_list_elevenlabs_for_listening(client, http):
    http.on(lambda m, u: u.endswith("/voices"), _json(200, {"voices": [{"voice_id": "v1"}]}))
    st = client.get("/api/mates/providers?refresh=1").json()
    eleven = next(p for p in st["stt"] if p["engine"] == "elevenlabs")
    assert eleven["configured"] and eleven["ok"] and eleven["kind"] == "stt"
    models = client.get("/api/mates/models?engine=elevenlabs&kind=stt").json()
    assert models["default"] == "scribe_v2_realtime" and models["models"][0]["id"] == "scribe_v2_realtime"
