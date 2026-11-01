"""Mate changes are pushed on /ws/sessions (``mates.changed``): every open
window (desktop overlay, quick chat, another tab or device) refetches its
mates instead of keeping the copy it loaded at startup — e.g. a new voice
volume reaches the window that is speaking."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def _login(client: TestClient) -> None:
    assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200


def _next_mates(ws) -> dict:
    """The next mates.changed message (session-list messages are skipped)."""
    while True:
        msg = ws.receive_json()
        if msg["type"] == "mates.changed":
            return msg["data"]


def test_mate_writes_are_announced_with_a_rising_version():
    with TestClient(app) as client:
        _login(client)
        with client.websocket_connect("/ws/sessions") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello"
            v0 = hello["data"]["mates_version"]

            m = client.post("/api/mates", json={"name": "Synced"}).json()
            ev = _next_mates(ws)
            assert ev["reason"] == "created" and ev["mate_id"] == m["id"] and ev["version"] > v0

            # the user's case: Voice → Volume 30 % → Save
            r = client.patch(f"/api/mates/{m['id']}", json={"voice": {"volume": 0.3}})
            assert r.status_code == 200 and r.json()["voice"]["volume"] == 0.3
            ev2 = _next_mates(ws)
            assert ev2["reason"] == "updated" and ev2["mate_id"] == m["id"] and ev2["version"] > ev["version"]
            # what a window refetches is the new value
            got = next(x for x in client.get("/api/mates").json() if x["id"] == m["id"])
            assert got["voice"]["volume"] == 0.3

            # persona / avatar / model changes too
            client.patch(f"/api/mates/{m['id']}", json={"persona": {"greeting": "Yo"}, "llm": {"effort": "high"}})
            assert _next_mates(ws)["reason"] == "updated"

            # memories (Memory tab in another window)
            mem = client.post(f"/api/mates/{m['id']}/memories", json={"text": "likes tea"}).json()
            ev_mem = _next_mates(ws)
            assert ev_mem["reason"] == "memory" and ev_mem["mate_id"] == m["id"]
            client.delete(f"/api/mates/{m['id']}/memories/{mem['id']}")
            assert _next_mates(ws)["reason"] == "memory"

            # "are you there?" answers with the mates version, so a window that
            # missed messages (asleep) still notices
            ws.send_json({"type": "sync"})
            while True:
                pong = ws.receive_json()
                if pong["type"] == "pong":
                    break
            assert pong["data"]["mates_version"] == _last_version(client)

            client.delete(f"/api/mates/{m['id']}")
            ev3 = _next_mates(ws)
            assert ev3["reason"] == "deleted" and ev3["mate_id"] == m["id"]


def test_a_patch_that_changes_nothing_is_not_announced():
    with TestClient(app) as client:
        _login(client)
        m = client.post("/api/mates", json={"name": "Quiet"}).json()
        svc = app.state.session_service
        before = svc.mates_version
        client.patch(f"/api/mates/{m['id']}", json={"voice": {"volume": m["voice"].get("volume", 1.0)}})
        assert svc.mates_version == before
        client.patch(f"/api/mates/{m['id']}", json={"voice": {"volume": 0.5}})
        assert svc.mates_version == before + 1
        client.delete(f"/api/mates/{m['id']}")


def _last_version(client: TestClient) -> int:
    return app.state.session_service.mates_version
