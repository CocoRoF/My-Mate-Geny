"""Session-list change feed (/ws/sessions): every device's sidebar refetches
only when the server's list version moves — no polling."""

import asyncio
import threading

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import app
from tests.test_sessions import _services


def _login(client: TestClient) -> None:
    assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200


def test_feed_announces_changes_and_list_reports_its_version(tmp_path):
    with TestClient(app) as client:
        _login(client)
        with client.websocket_connect("/ws/sessions") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello"
            v0 = hello["data"]["version"]

            r = client.get("/api/sessions")
            assert int(r.headers["X-Sessions-Version"]) == v0  # in sync: nothing to fetch

            s = client.post("/api/sessions", json={
                "provider": "claude", "model": "", "connection_id": None,
                "workspace_path": str(tmp_path), "title": "synced",
            }).json()
            ev = ws.receive_json()
            assert ev["type"] == "sessions.changed"
            assert ev["data"]["reason"] == "created" and ev["data"]["sid"] == s["id"]
            assert ev["data"]["version"] > v0

            client.patch(f"/api/sessions/{s['id']}", json={"title": "renamed"})
            ev2 = ws.receive_json()
            assert ev2["data"]["reason"] == "updated" and ev2["data"]["version"] > ev["data"]["version"]
            r = client.get("/api/sessions")
            assert int(r.headers["X-Sessions-Version"]) == ev2["data"]["version"]
            assert r.headers["Cache-Control"] == "no-store"

            ws.send_json({"type": "sync"})  # back from the background: "are you there?"
            pong = ws.receive_json()
            assert pong == {"type": "pong", "data": {"version": ev2["data"]["version"]}}

            client.delete(f"/api/sessions/{s['id']}")
            ev3 = ws.receive_json()
            assert ev3["data"]["reason"] == "deleted" and ev3["data"]["sid"] == s["id"]


def test_feed_refuses_unauthenticated_sockets():
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/ws/sessions") as ws:
                ws.receive_json()
        assert exc.value.code == 4401


def test_changes_from_a_worker_thread_reach_the_loop(db, tmp_path):
    svc = _services(db)

    async def main():
        q = svc.subscribe_list()
        v0 = svc.list_version
        t = threading.Thread(target=svc.create, kwargs={"provider": "claude", "workspace_path": str(tmp_path)})
        t.start()
        t.join()
        msg = await asyncio.wait_for(q.get(), 2)
        assert msg["data"]["reason"] == "created" and msg["data"]["version"] == v0 + 1
        # a turn starting/ending (run.state) also moves the list (running dots, order)
        svc._publish("sess_x", {"type": "run.state", "data": {"running": True}})
        assert (await asyncio.wait_for(q.get(), 2))["data"]["reason"] == "running"
        svc.unsubscribe_list(q)

    asyncio.run(main())
