"""What reaches a TTS engine: no markdown (app.mate.voice.speakable_text). The page sends clean sentences; this is
the server's safety net for any other caller."""

from __future__ import annotations

import secrets

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import netio, voice


@pytest.mark.parametrize("text, said", [
    ("안녕하세요! 오늘 기분 어때요? 좋아요~", "안녕하세요! 오늘 기분 어때요? 좋아요~"),  # plain chat: as is
    ("Hello there. How are you?", "Hello there. How are you?"),
    ("**굵게** 그리고 *기울임* `npm ci`", "굵게 그리고 기울임 npm ci"),
    ("See [the docs](https://example.com/a.b) now", "See the docs now"),
    ("주소 https://example.org/x?y=1 는 빼요", "주소 는 빼요"),
    ("코드:\n```python\nprint('never')\n```\n끝", "코드: 끝"),
    ("열린 코드\n```js\nalert(1)", "열린 코드"),
    ("| a | b |\n|---|---|\n| 1 | 2 |\n다음", "다음"),
    ("## 제목\n- 항목\n  - [ ] 할 일\n1. 첫째\n> 인용", "제목 항목 할 일 첫째 인용"),
    ("<script>alert(1)</script><b>bold</b> ok", "bold ok"),
    ("![a cat](https://e.com/c.png) 고양이", "고양이"),
    ("---", ""),
])
def test_speakable_text(text, said):
    assert voice.speakable_text(text) == said


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


class Recorder:
    def __init__(self):
        self.calls = []

    async def __call__(self, method, url, *, headers=None, json_body=None, data=None, timeout=60):
        self.calls.append({"method": method, "url": url, "json": json_body})
        return netio.Response(200, b"ID3" + b"\x00" * 64, {"content-type": "audio/mpeg"})


def test_speech_reads_no_markdown(client, monkeypatch):
    rec = Recorder()
    monkeypatch.setattr(netio, "request", rec)
    client.put("/api/mates/settings", json={"openai_key": "sk-test"})
    r = client.post("/api/mates", json={"name": "Speech text", "voice": {"tts": {"engine": "openai"}}})
    mid = r.json()["id"]
    tag = secrets.token_hex(4)
    r = client.post(f"/api/mates/{mid}/speech", json={"text": f"**{tag}** 확인 [문서](https://e.com)\n```\ncode\n```"})
    assert r.status_code == 200, r.text
    assert rec.calls[-1]["json"]["input"] == f"{tag} 확인 문서"
    # nothing left to say: a clear 400, no request
    n = len(rec.calls)
    r = client.post(f"/api/mates/{mid}/speech", json={"text": "```\nonly code\n```"})
    assert r.status_code == 400 and len(rec.calls) == n
    client.put("/api/mates/settings", json={"openai_key": ""})
    client.delete(f"/api/mates/{mid}")
