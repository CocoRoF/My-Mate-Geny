"""Voice providers (Global settings): verification (cached, re-checked on
demand, dropped when a key/URL changes), model + voice listings, previews with
unsaved voice fields, and the browser fallback for an engine that isn't set
up. All HTTP is mocked at app.mate.netio.request — nothing real is called."""

from __future__ import annotations

import json
import secrets

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import netio, voice

JSON = {"content-type": "application/json"}


def jresp(status, doc):
    return netio.Response(status, json.dumps(doc).encode(), JSON)


class Fake:
    """Routes (method, url predicate) -> Response | Exception; records calls."""

    def __init__(self):
        self.calls = []
        self.routes = []

    def on(self, pred, resp):
        self.routes.insert(0, (pred, resp))  # newest first: a test can override a route

    async def __call__(self, method, url, *, headers=None, json_body=None, data=None, timeout=60):
        self.calls.append({"method": method, "url": url, "headers": headers or {}, "json": json_body})
        for pred, resp in self.routes:
            if pred(method, url):
                if isinstance(resp, Exception):
                    raise resp
                return resp
        return jresp(404, {"detail": "no route"})

    def urls(self):
        return [c["url"] for c in self.calls]


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        # a clean slate: no keys/URLs (other tests share the DB)
        c.put("/api/mates/settings", json={"google_key": None, "openai_key": None, "elevenlabs_key": None, "http_tts_key": None,
                                           "omnivoice_url": "", "whisper_url": "", "http_tts_url": ""})
        yield c


@pytest.fixture
def http(monkeypatch):
    fake = Fake()
    monkeypatch.setattr(netio, "request", fake)
    voice._voices_cache.clear()
    app.state.voice_service.providers._lists.clear()
    return fake


def _by(doc, kind, engine):
    return next(p for p in doc[kind] if p["engine"] == engine)


def test_nothing_configured(client, http):
    doc = client.get("/api/mates/providers").json()
    assert [p["engine"] for p in doc["tts"]] == ["openai", "google", "elevenlabs", "omnivoice", "http"]
    assert [p["engine"] for p in doc["stt"]] == ["openai", "google", "whisper", "elevenlabs"]
    for p in doc["tts"] + doc["stt"]:
        assert p["configured"] is False and p["ok"] is False and p["error"] is None and p["checked_at"] is None
    assert http.calls == []
    assert client.get("/api/mates/models?engine=elevenlabs&kind=tts").status_code == 400
    assert client.get("/api/mates/voices?engine=omnivoice").status_code == 400
    assert client.post("/api/mates/providers/martian/verify").status_code == 400


def test_openai_verified_cached_refreshed_and_dropped_on_change(client, http):
    http.on(lambda m, u: u == "https://api.openai.com/v1/models",
            jresp(200, {"data": [{"id": "gpt-4o-mini-tts"}, {"id": "gpt-4o-mini-transcribe"}, {"id": "tts-1"}]}))
    client.put("/api/mates/settings", json={"openai_key": "sk-good"})
    doc = client.get("/api/mates/providers").json()
    tts, stt = _by(doc, "tts", "openai"), _by(doc, "stt", "openai")
    assert tts["configured"] and tts["ok"] is True and tts["error"] is None and tts["checked_at"]
    assert stt["ok"] is True and tts["detail"] == "Key accepted"
    assert http.calls[-1]["method"] == "GET" and http.calls[-1]["headers"]["Authorization"] == "Bearer sk-good"
    assert len(http.calls) == 1  # one key, one check for TTS and STT
    assert "sk-good" not in json.dumps(doc)
    client.get("/api/mates/providers")
    assert len(http.calls) == 1  # cached
    client.get("/api/mates/providers?refresh=1")
    assert len(http.calls) == 2  # re-checked on demand
    # a new (bad) key drops the cached result; saving with ?verify=1 checks it right away
    http.on(lambda m, u: u.endswith("/v1/models"), jresp(401, {"error": {"message": "Incorrect API key provided"}}))
    r = client.put("/api/mates/settings?verify=1", json={"openai_key": "sk-bad"})
    assert r.status_code == 200 and r.json()["openai_key_set"] is True
    bad = _by(r.json()["providers"], "tts", "openai")
    assert bad["ok"] is False and "rejected the key" in bad["error"] and "Incorrect API key" in bad["error"]
    assert len(http.calls) == 3
    # an explicit verify
    http.on(lambda m, u: u.endswith("/v1/models"), jresp(200, {"data": [{"id": "whisper-1"}]}))
    v = client.post("/api/mates/providers/openai/verify").json()
    assert v["ok"] is True and "can't see gpt-4o-mini-tts" in v["detail"]
    # removing the key: not configured, no check
    n = len(http.calls)
    p = _by(client.put("/api/mates/settings?verify=1", json={"openai_key": None}).json()["providers"], "tts", "openai")
    assert p["configured"] is False and p["ok"] is False and len(http.calls) == n


def test_saving_one_provider_verifies_only_that_one(client, http):
    http.on(lambda m, u: u.startswith("https://api.elevenlabs.io/v1/voices"), jresp(200, {"voices": [{"voice_id": "a"}]}))
    http.on(lambda m, u: u == "http://whisper:8001/v1/models", jresp(200, {"data": [{"id": "openai/whisper-large-v3"}]}))
    r = client.put("/api/mates/settings?verify=1", json={"elevenlabs_key": "xi-1", "whisper_url": "http://whisper:8001/"})
    doc = r.json()
    assert doc["whisper_url"] == "http://whisper:8001"
    el, wh = _by(doc["providers"], "tts", "elevenlabs"), _by(doc["providers"], "stt", "whisper")
    assert el["ok"] is True and el["detail"] == "Key accepted · 1 voice in the account"
    assert http.calls[0]["headers"]["xi-api-key"] == "xi-1"
    assert wh["ok"] is True and "openai/whisper-large-v3" in wh["detail"]
    assert sorted(http.urls()) == ["http://whisper:8001/v1/models", "https://api.elevenlabs.io/v1/voices"]
    # a URL put again unchanged keeps its result (no new check)
    client.put("/api/mates/settings?verify=1", json={"whisper_url": "http://whisper:8001"})
    assert len(http.calls) == 2


def test_omnivoice_health_and_profiles(client, http):
    http.on(lambda m, u: u == "http://omni:9880/health", jresp(200, {"status": "ok", "phase": "ok"}))
    http.on(lambda m, u: u == "http://omni:9880/voices", jresp(200, {"voices": [
        {"id": "mao", "name": "마오", "language": "ko", "ref_audios": [{"emotion": "joy", "file": "/v/joy.wav"}]},
        {"id": "tpl", "name": "Template", "is_template": True, "ref_audios": []}]}))
    p = _by(client.put("/api/mates/settings?verify=1", json={"omnivoice_url": "http://omni:9880"}).json()["providers"],
            "tts", "omnivoice")
    assert p["ok"] is True and p["detail"] == "Ready · 2 voice profiles"
    vs = client.get("/api/mates/voices?engine=omnivoice").json()["voices"]
    assert vs[0] == {"id": "mao", "name": "마오", "language": "ko", "emotions": ["joy"]}
    assert vs[1]["category"] == "template"
    # still loading: reachable, says so
    http.on(lambda m, u: u.endswith("/health"), jresp(200, {"status": "loading", "phase": "warming"}))
    assert client.post("/api/mates/providers/omnivoice/verify").json()["detail"].startswith("Starting (warming)")
    http.on(lambda m, u: u.endswith("/health"), jresp(200, {"status": "error", "phase": "error"}))
    bad = client.post("/api/mates/providers/omnivoice/verify").json()
    assert bad["ok"] is False and "engine reports an error" in bad["error"]
    # not an OmniVoice at all / down
    http.on(lambda m, u: True, netio.UpstreamError("cannot reach http://omni:9880/health: Connection refused"))
    down = client.post("/api/mates/providers/omnivoice/verify").json()
    assert down["ok"] is False and "Connection refused" in down["error"]
    # languages for the voice language picker
    http.routes.clear()
    http.on(lambda m, u: u.endswith("/languages"), jresp(200, {"languages": ["english", "korean"]}))
    doc = client.get("/api/mates/models?engine=omnivoice&kind=tts").json()
    assert doc["models"] == [] and doc["languages"] == ["english", "korean"]


def test_whisper_fallbacks_and_default_model(client, http):
    client.put("/api/mates/settings", json={"whisper_url": "http://stt.local:8001/v1/audio/transcriptions"})
    http.on(lambda m, u: u == "http://stt.local:8001/v1/models", jresp(404, {"detail": "Not Found"}))
    http.on(lambda m, u: u == "http://stt.local:8001/health", netio.Response(200, b"", {}))
    p = client.post("/api/mates/providers/whisper/verify").json()
    assert p["ok"] is True and p["detail"] == "Reachable (it lists no models)"
    http.on(lambda m, u: u.endswith("/health"), jresp(503, {"detail": "down"}))
    p = client.post("/api/mates/providers/whisper/verify").json()
    assert p["ok"] is False and "neither /v1/models nor /health" in p["error"]
    # vLLM lists its model: the mate's transcription asks for it when none is chosen
    http.on(lambda m, u: u.endswith("/v1/models"), jresp(200, {"data": [{"id": "openai/whisper-large-v3"}]}))
    assert client.post("/api/mates/providers/whisper/verify").json()["ok"] is True
    models = client.get("/api/mates/models?engine=whisper&kind=stt").json()
    assert models["models"] == [{"id": "openai/whisper-large-v3", "name": "openai/whisper-large-v3"}]
    assert models["default"] == "openai/whisper-large-v3"
    mid = client.post("/api/mates", json={"name": "Ear", "voice": {"stt": {"engine": "whisper"}}}).json()["id"]
    http.on(lambda m, u: u.endswith("/audio/transcriptions"), jresp(200, {"text": "hello"}))
    r = client.post(f"/api/mates/{mid}/transcribe", files={"file": ("a.webm", b"x", "audio/webm")})
    assert r.json()["text"] == "hello"
    assert http.calls[-1]["url"] == "http://stt.local:8001/v1/audio/transcriptions"
    # (multipart body is in data, not recorded here) — the model sent is checked through the service directly
    assert app.state.voice_service.providers.default_model("whisper") == "openai/whisper-large-v3"
    # Missing credentials point to the provider settings' new location.
    client.put("/api/mates/settings", json={"whisper_url": ""})
    r = client.post(f"/api/mates/{mid}/transcribe", files={"file": ("a.webm", b"x", "audio/webm")})
    assert r.status_code == 400 and "Settings → Image and voice providers" in r.json()["detail"]


def test_http_tts_server(client, http):
    client.put("/api/mates/settings", json={"http_tts_url": "http://tts:8000/v1/audio/speech", "http_tts_key": "k1"})
    http.on(lambda m, u: u == "http://tts:8000/v1/models", jresp(404, {"detail": "nope"}))
    p = client.post("/api/mates/providers/http/verify").json()
    assert p["ok"] is True and "lists no models" in p["detail"]
    assert http.calls[-1]["headers"] == {"Authorization": "Bearer k1"}
    http.on(lambda m, u: u.endswith("/models"), jresp(401, {"detail": "bad token"}))
    p = client.post("/api/mates/providers/http/verify").json()
    assert p["ok"] is False and "rejected the key" in p["error"]
    http.on(lambda m, u: u.endswith("/models"), jresp(200, {"data": [{"id": "kokoro"}, {"id": "piper"}]}))
    assert client.post("/api/mates/providers/http/verify").json()["detail"] == "Reachable · 2 models"
    assert [m["id"] for m in client.get("/api/mates/models?engine=http&kind=tts").json()["models"]] == ["kokoro", "piper"]


def test_model_listings(client, http):
    tts = client.get("/api/mates/models?engine=openai&kind=tts").json()
    assert [m["id"] for m in tts["models"]] == ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] and tts["default"] == "gpt-4o-mini-tts"
    stt = client.get("/api/mates/models?engine=openai&kind=stt").json()
    assert {m["id"] for m in stt["models"]} == {"whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"}
    assert client.get("/api/mates/models?engine=openai&kind=video").status_code == 400
    assert client.get("/api/mates/models?engine=elevenlabs&kind=stt").status_code == 400
    assert client.get("/api/mates/models?engine=browser&kind=tts").json()["models"] == []
    assert http.calls == []  # fixed lists, nothing fetched
    client.put("/api/mates/settings", json={"elevenlabs_key": "xi-2"})
    http.on(lambda m, u: u == "https://api.elevenlabs.io/v1/models", jresp(200, [
        {"model_id": "eleven_multilingual_v2", "name": "Multilingual v2", "can_do_text_to_speech": True,
         "languages": [{"language_id": "ko", "name": "Korean"}, {"language_id": "en", "name": "English"}]},
        {"model_id": "eleven_english_sts_v2", "name": "STS", "can_do_text_to_speech": False},
        {"model_id": "eleven_flash_v2_5", "name": "Flash v2.5", "can_do_text_to_speech": True, "description": " fast "},
    ]))
    doc = client.get("/api/mates/models?engine=elevenlabs&kind=tts").json()
    assert [m["id"] for m in doc["models"]] == ["eleven_multilingual_v2", "eleven_flash_v2_5"]
    assert doc["models"][0]["languages"] == ["ko", "en"] and doc["models"][1]["description"] == "fast"
    assert doc["default"] == "eleven_multilingual_v2"
    assert http.calls[-1]["headers"]["xi-api-key"] == "xi-2"
    client.get("/api/mates/models?engine=elevenlabs&kind=tts")
    assert len(http.calls) == 1  # cached
    http.routes.clear()
    app.state.voice_service.providers._lists.clear()
    http.on(lambda m, u: True, jresp(401, {"detail": {"status": "invalid_api_key", "message": "Invalid API key"}}))
    r = client.get("/api/mates/models?engine=elevenlabs&kind=tts")
    assert r.status_code == 502 and "Invalid API key" in r.json()["detail"]


def test_elevenlabs_voices_full_listing(client, http):
    client.put("/api/mates/settings", json={"elevenlabs_key": "xi-3"})
    http.on(lambda m, u: u.startswith("https://api.elevenlabs.io/v1/voices"), jresp(200, {"voices": [
        {"voice_id": "p1", "name": "Rachel", "category": "premade",
         "labels": {"accent": "american", "gender": "female", "age": "young", "use_case": "narration", "description": ""},
         "preview_url": "https://cdn/p1.mp3"},
        {"voice_id": "c1", "name": "My clone", "category": "cloned", "labels": {}, "preview_url": None,
         "description": "my own voice"},
        {"voice_id": "s1", "name": "Jiyoung", "category": "professional", "labels": {"language": "ko"},
         "verified_languages": [{"language": "ko", "model_id": "eleven_multilingual_v2", "preview_url": "https://cdn/s1-ko.mp3"},
                                {"language": "en", "preview_url": None}],
         "preview_url": "https://cdn/s1.mp3"},
        {"name": "broken (no id)"},
    ]}))
    vs = client.get("/api/mates/voices?engine=elevenlabs").json()["voices"]
    assert [v["id"] for v in vs] == ["p1", "c1", "s1"]
    assert vs[0]["labels"] == {"accent": "american", "gender": "female", "age": "young", "use_case": "narration"}
    assert vs[0]["category"] == "premade" and vs[0]["language"] == "american"
    assert vs[1]["category"] == "cloned" and vs[1]["description"] == "my own voice" and vs[1]["preview_url"] is None
    assert vs[2]["language"] == "ko" and vs[2]["languages"] == ["en", "ko"]
    assert vs[2]["previews"] == {"ko": "https://cdn/s1-ko.mp3"}
    assert "show_legacy=true" in http.calls[-1]["url"]


def test_preview_with_unsaved_voice_and_fallback(client, http):
    client.put("/api/mates/settings", json={"openai_key": "sk-p"})
    mid = client.post("/api/mates", json={"name": "Preview", "voice": {"tts": {"engine": "browser"}}}).json()["id"]
    http.on(lambda m, u: u.endswith("/audio/speech"), netio.Response(200, b"ID3" + b"\x00" * 32, {"content-type": "audio/mpeg"}))
    text = "미리 듣기 " + secrets.token_hex(3)
    r = client.post(f"/api/mates/{mid}/speech",
                    json={"text": text, "tts": {"engine": "openai", "voice": "coral", "model": "tts-1", "speed": 1.5}})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg"
    assert http.calls[-1]["json"] == {"model": "tts-1", "voice": "coral", "input": text, "response_format": "mp3",
                                      "speed": 1.5}
    # nothing was saved
    assert client.get(f"/api/mates/{mid}").json()["voice"]["tts"]["engine"] == "browser"
    assert client.post(f"/api/mates/{mid}/speech", json={"text": "x"}).status_code == 204
    assert client.post(f"/api/mates/{mid}/speech", json={"text": "x", "tts": {"engine": "martian"}}).status_code == 400
    # an engine that isn't set up: 204 + the fallback headers, nothing called
    n = len(http.calls)
    r = client.post(f"/api/mates/{mid}/speech", json={"text": "y", "tts": {"engine": "elevenlabs", "voice": "v"}})
    assert r.status_code == 204 and r.headers["x-speech-fallback"] == "browser"
    assert "ElevenLabs" in r.headers["x-speech-fallback-reason"] and len(http.calls) == n


def test_config_base_url_hooks(client, http, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "mate_openai_base", "http://127.0.0.1:9/openai/v1/")
    monkeypatch.setattr(settings, "mate_elevenlabs_base", "http://127.0.0.1:9/eleven/v1")
    client.put("/api/mates/settings", json={"openai_key": "sk-x", "elevenlabs_key": "xi-x"})
    client.get("/api/mates/providers?refresh=1")
    assert sorted(http.urls()) == ["http://127.0.0.1:9/eleven/v1/voices", "http://127.0.0.1:9/openai/v1/models"]
