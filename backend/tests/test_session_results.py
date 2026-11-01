"""The sidebar's "Complete" / "Failed" / "Stopped" until seen: how a chat's last run ended is kept on the session
(``last_result``, ``last_result_at``) with when someone last had it open (``last_seen_at``); ``result_unseen`` is
true while a result is newer than that. Seen = the chat opened (a chat socket on screen, or POST …/seen) — and a
run that ends while the chat is on screen is seen as it ends. Every change moves the list feed (/ws/sessions)."""

import asyncio
import pathlib
import sqlite3
import time

from fastapi.testclient import TestClient

from app.db import Database
from app.main import app
from app.providers.base import ProviderEvent
from app.services import session_service as ss_mod
from tests.test_runs import SlowProvider, _svc


class QuickProvider:
    name = "claude"

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail

    async def run_turn_stream(self, req):
        yield ProviderEvent(type="session.start", data={"model": "fake"})
        await asyncio.sleep(0.05)
        if self.fail:
            yield ProviderEvent(type="error", data={"code": "provider.failed", "message": "boom"}, seq=1)
        else:
            yield ProviderEvent(type="turn.complete", data={"text": "done", "cli_session_id": "cli-1"}, seq=1)


async def _until_idle(q: asyncio.Queue) -> None:
    while True:
        m = await asyncio.wait_for(q.get(), timeout=5)
        if m["type"] == "run.state" and not m["data"]["running"]:
            return


def _listed(svc, sid):
    return next(x for x in svc.list_all() if x["id"] == sid)


async def _run(svc, sid, text="hi"):
    q = svc.subscribe(sid)
    svc.start_turn(sid, text)
    await _until_idle(q)
    svc.unsubscribe(sid, q)


async def test_a_run_ending_unwatched_is_unseen_until_opened(db, tmp_path, monkeypatch):
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: QuickProvider())
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path))
    assert _listed(svc, s["id"])["result_unseen"] is False  # nothing ran yet
    feed = svc.subscribe_list()

    await _run(svc, s["id"])
    row = _listed(svc, s["id"])
    assert row["last_result"] == "ok" and row["last_result_at"] and row["result_unseen"] is True
    reasons = []
    while not feed.empty():
        reasons.append(feed.get_nowait()["data"]["reason"])
    assert reasons[-1] == "idle"  # the list fetch after the run already carries the result

    v = svc.list_version
    assert svc.mark_seen(s["id"]) is True
    assert _listed(svc, s["id"])["result_unseen"] is False
    msg = feed.get_nowait()
    assert msg["data"] == {"version": v + 1, "reason": "seen", "sid": s["id"]}
    assert svc.mark_seen(s["id"]) is False  # nothing new: no announcement
    assert feed.empty()

    await _run(svc, s["id"], "again")  # a newer run: unseen again
    assert _listed(svc, s["id"])["result_unseen"] is True
    svc.unsubscribe_list(feed)


async def test_a_run_ending_on_screen_is_seen_as_it_ends(db, tmp_path, monkeypatch):
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: QuickProvider())
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path))
    a, b = object(), object()  # two sockets showing it (two devices)
    svc.set_viewing(s["id"], a, True)
    svc.set_viewing(s["id"], b, True)
    svc.set_viewing(s["id"], a, False)
    await _run(svc, s["id"])
    row = _listed(svc, s["id"])
    assert row["last_result"] == "ok" and row["result_unseen"] is False

    svc.set_viewing(s["id"], b, False)  # nobody looking now
    await _run(svc, s["id"], "more")
    assert _listed(svc, s["id"])["result_unseen"] is True
    svc.set_viewing(s["id"], b, True)  # opened again: seen
    assert _listed(svc, s["id"])["result_unseen"] is False


async def test_failed_and_stopped_runs(db, tmp_path, monkeypatch):
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path))
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: QuickProvider(fail=True))
    await _run(svc, s["id"])
    assert _listed(svc, s["id"])["last_result"] == "error"

    monkeypatch.setattr(ss_mod, "get_provider", lambda name: SlowProvider())
    q = svc.subscribe(s["id"])
    svc.start_turn(s["id"], "long one")
    while (await asyncio.wait_for(q.get(), timeout=5))["type"] != "tool.result":
        pass
    assert svc.stop(s["id"]) is True
    await _until_idle(q)
    row = _listed(svc, s["id"])
    assert row["last_result"] == "stopped" and row["result_unseen"] is True


async def test_mate_conversations_keep_no_result(db, tmp_path, monkeypatch):
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: QuickProvider())
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path))
    db.execute("UPDATE sessions SET kind = 'mate' WHERE id = ?", (s["id"],))
    svc._mate_sids.add(s["id"])
    await _run(svc, s["id"])
    assert svc.get(s["id"])["last_result"] is None


def test_auto_turn_taken_over_records_nothing(db, tmp_path):
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path))
    svc._record_result(s["id"], {"status": "error", "error": None, "trigger": "auto"})
    assert svc.get(s["id"])["last_result"] is None
    svc._record_result(s["id"], {"status": "ok", "trigger": "auto"})  # Claude finished background work by itself
    assert svc.get(s["id"])["last_result"] == "ok"


def test_old_databases_gain_the_columns(tmp_path):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat', provider TEXT "
                "NOT NULL, model TEXT NOT NULL DEFAULT '', connection_id TEXT, workspace_path TEXT NOT NULL, "
                "cli_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
    con.execute("INSERT INTO sessions (id, provider, workspace_path, created_at, updated_at) VALUES "
                "('sess_old', 'claude', '/tmp', '2026-01-01', '2026-01-01')")
    con.commit()
    con.close()
    d = Database(pathlib.Path(path))
    d.bootstrap()
    try:
        cols = {r["name"] for r in d.query("PRAGMA table_info(sessions)")}
        assert {"last_result", "last_result_at", "last_seen_at"} <= cols
        svc = _svc(d)
        row = _listed(svc, "sess_old")
        assert row["last_result"] is None and row["result_unseen"] is False
    finally:
        d.close()


def test_seen_endpoint_and_socket(tmp_path):
    with TestClient(app) as client:
        assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        svc = app.state.session_service
        s = client.post("/api/sessions", json={"provider": "claude", "model": "", "connection_id": None,
                                               "workspace_path": str(tmp_path), "title": "results"}).json()
        svc._record_result(s["id"], {"status": "ok"})
        assert next(x for x in client.get("/api/sessions").json() if x["id"] == s["id"])["result_unseen"] is True

        with client.websocket_connect("/ws/sessions") as feed:
            feed.receive_json()  # hello
            r = client.post(f"/api/sessions/{s['id']}/seen")
            assert r.status_code == 200 and r.json()["changed"] is True
            ev = feed.receive_json()
            assert ev["data"]["reason"] == "seen" and ev["data"]["sid"] == s["id"]
        assert next(x for x in client.get("/api/sessions").json() if x["id"] == s["id"])["result_unseen"] is False
        assert client.post("/api/sessions/sess_nope/seen").status_code == 404

        # a chat socket on screen: what ended is seen; one off screen (hidden tab) is not a viewer
        svc._record_result(s["id"], {"status": "error", "error": "x"})
        with client.websocket_connect(f"/ws/chat/{s['id']}") as ws:
            ws.send_json({"type": "attach", "after": 0, "visible": False})
            assert ws.receive_json()["type"] == "run.state"
            assert svc.is_viewed(s["id"]) is False
            assert svc.get(s["id"])["result_unseen"] is True
            ws.send_json({"type": "view", "visible": True})
            ws.send_json({"type": "attach", "after": 10**9})
            assert ws.receive_json()["type"] == "run.state"
            assert svc.is_viewed(s["id"]) is True
            assert svc.get(s["id"])["result_unseen"] is False
        for _ in range(50):  # (the socket's cleanup runs on the server's side of the close)
            if not svc.is_viewed(s["id"]):
                break
            time.sleep(0.02)
        assert svc.is_viewed(s["id"]) is False
        client.delete(f"/api/sessions/{s['id']}")
