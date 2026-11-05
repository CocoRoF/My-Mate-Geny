import base64
import io
import json
import wave

import pytest
from fastapi.testclient import TestClient
from test_mate_providers import Fake, jresp

from app.main import app
from app.mate import google, netio


@pytest.fixture
def google_client(monkeypatch):
    fake = Fake()
    monkeypatch.setattr(netio, "request", fake)
    fake.on(
        lambda method, url: "/models?pageSize=" in url,
        jresp(
            200,
            {
                "models": [
                    {
                        "name": "models/gemini-test-tts",
                        "displayName": "Test speech",
                        "supportedGenerationMethods": ["generateContent"],
                    },
                    {
                        "name": "models/gemini-test-flash",
                        "supportedGenerationMethods": ["generateContent"],
                    },
                    {
                        "name": "models/gemini-test-image",
                        "supportedGenerationMethods": ["generateContent"],
                    },
                    {
                        "name": "models/text-embedding-test",
                        "supportedGenerationMethods": ["embedContent"],
                    },
                ]
            },
        ),
    )
    with TestClient(app) as client:
        assert (
            client.post(
                "/api/auth/login", json={"username": "admin", "password": "test-pass"}
            ).status_code
            == 200
        )
        previous_timezone = client.get("/api/mates/settings").json().get("timezone", "")
        client.put("/api/mates/settings", json={"google_key": None, "timezone": previous_timezone})
        yield client, fake
        client.put("/api/mates/settings", json={"google_key": None, "timezone": previous_timezone})


def test_google_key_is_write_only_catalog_is_media_only_and_verification_is_free(google_client):
    client, fake = google_client
    result = client.put(
        "/api/mates/settings?verify=true", json={"google_key": "google-fixture-secret"}
    )
    assert result.status_code == 200, result.text
    assert result.json()["google_key_set"] is True
    assert "google-fixture-secret" not in result.text
    result = client.get("/api/mates/providers").json()
    entry = next(p for p in result["tts"] if p["engine"] == "google")
    assert entry["configured"] and entry["ok"]
    assert [m["id"] for m in entry["media_models"]["image"]] == ["gemini-test-image"]
    assert "embedding" not in json.dumps(entry["media_models"])
    assert all(call["method"] == "GET" for call in fake.calls)
    models = client.get("/api/mates/models?engine=google&kind=tts").json()
    assert models["default"] == "gemini-test-tts"
    assert models["models"][0]["id"] == "gemini-test-tts"
    assert client.get("/api/mates/voices?engine=google").json()["voices"][0]["id"] == "Kore"
    # Editing an unrelated setting keeps the key, deletion really clears it.
    client.put("/api/mates/settings", json={"timezone": "Asia/Seoul"})
    assert client.get("/api/mates/settings").json()["google_key_set"] is True
    client.put("/api/mates/settings", json={"google_key": None})
    assert client.get("/api/mates/settings").json()["google_key_set"] is False


def test_google_tts_pcm_becomes_wav_and_transcription_uses_same_pipeline(google_client):
    client, fake = google_client
    client.put("/api/mates/settings?verify=true", json={"google_key": "google-fixture-secret"})
    fake.on(
        lambda m, u: "gemini-test-tts:generateContent" in u,
        jresp(
            200,
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "inlineData": {
                                        "data": base64.b64encode(b"\0\0" * 2400).decode(),
                                        "mimeType": "audio/L16;codec=pcm;rate=24000",
                                    }
                                }
                            ]
                        }
                    }
                ]
            },
        ),
    )
    fake.on(
        lambda m, u: "gemini-test-flash:generateContent" in u,
        jresp(200, {"candidates": [{"content": {"parts": [{"text": "이어 말한 한 문장"}]}}]}),
    )
    mate = client.post(
        "/api/mates",
        json={
            "name": "Google voice test",
            "voice": {
                "tts": {"engine": "google", "voice": "Kore", "model": "gemini-test-tts"},
                "stt": {"engine": "google", "model": "gemini-test-flash"},
            },
        },
    ).json()
    response = client.post(f"/api/mates/{mate['id']}/speech", json={"text": "검증용 문장"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("audio/wav")
    with wave.open(io.BytesIO(response.content), "rb") as wav:
        assert wav.getframerate() == 24000 and wav.getnframes() == 2400
    call = next(c for c in fake.calls if "gemini-test-tts:generateContent" in c["url"])
    assert call["headers"]["x-goog-api-key"] == "google-fixture-secret"
    assert (
        call["json"]["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"][
            "voiceName"
        ]
        == "Kore"
    )
    response = client.post(
        f"/api/mates/{mate['id']}/transcribe",
        files={"file": ("audio.webm", b"fixture audio", "audio/webm")},
    )
    assert response.status_code == 200, response.text
    assert response.json()["text"] == "이어 말한 한 문장"
    call = next(c for c in fake.calls if "gemini-test-flash:generateContent" in c["url"])
    assert call["json"]["contents"][0]["parts"][1]["inlineData"]["mimeType"] == "audio/webm"


@pytest.mark.asyncio
async def test_google_errors_and_catalog_pagination_redact_keys(monkeypatch):
    calls = []

    async def request(method, url, **kwargs):
        calls.append(url)
        if len(calls) == 1:
            return jresp(200, {"models": [], "nextPageToken": "second"})
        return jresp(403, {"error": {"message": "Invalid google-fixture-secret"}})

    monkeypatch.setattr(netio, "request", request)
    with pytest.raises(netio.UpstreamError) as error:
        await google.verify("google-fixture-secret")
    assert "pageToken=second" in calls[1]
    assert "google-fixture-secret" not in str(error.value)
