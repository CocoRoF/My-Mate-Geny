"""Paged history (services/history_page.py): whole turns per page, exact
cursors / has_more, per-turn costs on a slice, the session-wide summaries the
client used to derive from the full replay, pinned background work, mate
sessions, and the API."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

T0 = datetime(2026, 10, 1, 9, 0, 0, tzinfo=timezone.utc)


def _svc(db):
    vault = SecretVault(db)
    return SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))


class Chat:
    """Writes a chat's rows with a controlled clock (1 ms per row)."""

    def __init__(self, db, sid: str) -> None:
        self.db, self.sid, self.t = db, sid, T0
        self.n_msg = 0
        self.anchors: list[str] = []  # turn start times

    def tick(self) -> str:
        self.t += timedelta(milliseconds=1)
        return self.t.isoformat()

    def msg(self, role: str, content: str, meta: dict | None = None) -> str:
        at = self.tick()
        self.n_msg += 1
        self.db.execute(
            "INSERT INTO messages (id, session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (f"msg_{self.sid[-8:]}_{self.n_msg:05d}", self.sid, role, content, json.dumps(meta) if meta else None, at))
        if role == "user":
            self.anchors.append(at)
        return at

    def ev(self, type_: str, data: dict) -> int:
        at = self.tick()
        if type_ == "session.start" and data.get("trigger") == "background":
            self.anchors.append(at)
        return self.db.insert(
            "INSERT INTO events (session_id, seq, type, data, created_at) VALUES (?, 0, ?, ?, ?)",
            (self.sid, type_, json.dumps(data), at))

    def turn(self, k: int, *, cost: float | None = None, tools: list[tuple[str, dict]] = (), legacy: bool = False,
             auto: bool = False, error: bool = False) -> None:
        if not auto:
            self.msg("user", f"question {k}")
        self.ev("session.start", {"provider": "claude", **({"trigger": "background"} if auto else {})})
        for i, (name, inp) in enumerate(tools):
            tid = f"toolu_{k}_{i}"
            self.ev("tool.use", {"id": tid, "name": name, "input": inp})
            self.ev("tool.result", {"id": tid, "output": "x" * 50, "is_error": name == "Edit" and inp.get("fail", False)})
        self.ev("text.delta", {"text": f"answer {k}"})
        self.ev("context.update", {"tokens": 1000 + k, "window": 200000, "threshold": 160000,
                                   "model_window": 200000, "window_source": "cli", "auto_compact": True})
        data = {"text": f"answer {k}", "model": "claude-opus-5-5", "usage": {"input_tokens": 10, "output_tokens": 5}}
        if cost is not None:
            data["cost_usd"] = cost
            data["provider"] = "claude"
            if not legacy:
                data["cost_kind"] = "turn"
        if error:
            self.ev("error", {"code": "turn.interrupted", "message": "Stopped by user", **data})
        else:
            self.ev("turn.complete", data)
        self.msg("assistant", f"answer {k}")


@pytest.fixture
def chat(db, tmp_path):
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path), title="paged")
    return svc, Chat(db, s["id"])


def _walk(svc, sid, first: int = 5, older: int = 3):
    pages = [svc.history_page(sid, turns=first)]
    while pages[-1]["page"]["has_more"]:
        pages.append(svc.history_page(sid, turns=older, before=pages[-1]["page"]["cursor"]))
        assert len(pages) < 100
    return pages


def test_pages_are_whole_turns_and_cover_everything_once(chat):
    svc, c = chat
    c.msg("assistant", "Hi, I'm Geny", meta={"internal": True, "kind": "greeting"})  # before any turn
    for k in range(12):
        c.turn(k, cost=0.1)
        if k == 3:
            c.msg("steer", "also do Y")  # a steer stays inside its turn
            c.ev("user.steer", {"text": "also do Y"})
        if k == 5:
            c.ev("notice", {"level": "info", "code": "mate.delegation_held", "message": "idle notice"})
        if k == 7:
            c.turn(100, cost=0.2, auto=True)  # Claude started a turn by itself
    sid = c.sid
    full_ev = svc.events(sid)
    full_msg = svc.messages(sid)

    pages = _walk(svc, sid)
    newest = pages[0]
    assert newest["page"]["has_more"] and newest["page"]["turns"] == 5
    assert newest["page"]["cursor"] == c.anchors[-5]  # the 5th-newest turn starts the page
    assert newest["page"]["last_eid"] == max(e["eid"] for e in full_ev)
    # every cursor is a turn start; pages abut; the oldest page reaches the beginning
    for p in pages[:-1]:
        assert p["page"]["cursor"] in c.anchors
    for newer, older in zip(pages, pages[1:]):
        assert older["page"]["until"] == newer["page"]["cursor"]
    assert pages[-1]["page"]["cursor"] is None and not pages[-1]["page"]["has_more"]
    assert pages[-1]["messages"][0]["meta"]["kind"] == "greeting"  # the preamble rides with the oldest page
    # each page starts at its turn's first row (user message or auto start)
    for p in pages[:-1]:
        firsts = [m["created_at"] for m in p["messages"][:1]] + [e["timestamp"] for e in p["events"][:1]]
        assert min(firsts) == p["page"]["cursor"]
    # together: every message and event exactly once, same data as the full read
    eids = [e["eid"] for p in pages for e in p["events"]]
    assert sorted(eids) == [e["eid"] for e in full_ev] and len(eids) == len(set(eids))
    mids = sorted(m["id"] for p in pages for m in p["messages"])
    assert mids == sorted(m["id"] for m in full_msg)
    by_eid = {e["eid"]: e for e in full_ev}
    for p in pages:
        for e in p["events"]:
            assert e == by_eid[e["eid"]]
    # turns: 12 user turns + 1 auto turn
    assert sum(p["page"]["turns"] for p in pages) == 13


def test_since_reloads_from_a_cursor_and_beginning(chat):
    svc, c = chat
    for k in range(8):
        c.turn(k, cost=0.1)
    sid = c.sid
    p = svc.history_page(sid, turns=3)
    again = svc.history_page(sid, since=p["page"]["cursor"])
    assert [e["eid"] for e in again["events"]] == [e["eid"] for e in p["events"]]
    assert again["page"]["has_more"] and again["page"]["cursor"] == p["page"]["cursor"]
    c.turn(8, cost=0.1)  # new turn while away: since keeps the old start and adds it
    later = svc.history_page(sid, since=p["page"]["cursor"])
    assert len(later["events"]) > len(p["events"]) and later["page"]["turns"] == 4
    everything = svc.history_page(sid, since="")
    assert len(everything["events"]) == len(svc.events(sid)) and not everything["page"]["has_more"]


def test_costs_on_slices_match_full_normalization(chat):
    svc, c = chat
    # legacy persistent-engine turns: the CLI's running total, not per turn
    totals = [0.5, 1.25, 2.0, 0.3, 0.9, 1.4, 2.2, 3.0]
    for k, v in enumerate(totals):
        c.turn(k, cost=v, legacy=True)
    c.turn(50, cost=0.7)  # a per-turn value from a newer backend
    c.turn(51, cost=0.4, error=True)  # a stopped turn that still cost
    sid = c.sid
    full = {e["eid"]: e["data"] for e in svc.events(sid) if e["type"] in ("turn.complete", "error")}
    pages = _walk(svc, sid, first=2, older=2)
    for p in pages:
        for e in p["events"]:
            if e["type"] in ("turn.complete", "error"):
                assert e["data"] == full[e["eid"]]  # same per-turn value as the full read
    per_turn = [d["cost_usd"] for d in full.values()]
    total = sum(per_turn)
    assert pages[0]["summary"]["cost_usd"] == pytest.approx(total)
    assert pages[0]["summary"]["costed_turns"] == len(per_turn)
    assert pages[0]["summary"]["usage"]["input_tokens"] == 10 * len(per_turn)
    # "before" + what the page holds = the whole chat, on every page
    for p in pages:
        in_page = sum(e["data"]["cost_usd"] for e in p["events"] if e["type"] in ("turn.complete", "error"))
        later = sum(e["data"]["cost_usd"] for q in pages[: pages.index(p)] for e in q["events"]
                    if e["type"] in ("turn.complete", "error"))
        assert p["before"]["cost_usd"] + in_page + later == pytest.approx(total)
    assert pages[-1]["before"]["cost_usd"] == 0


def test_session_summaries(chat):
    svc, c = chat
    c.turn(0, tools=[("TodoWrite", {"todos": [{"content": "old plan", "status": "pending"}]})])
    c.turn(1, tools=[("Write", {"file_path": "/w/a.py", "content": "print(1)"}),
                     ("Edit", {"file_path": "/w/b.py", "old_string": "a", "new_string": "b", "fail": True})])
    c.turn(2, tools=[("TodoWrite", {"todos": [{"content": "new plan", "status": "in_progress"}]}),
                     ("Edit", {"file_path": "/w/a.py", "old_string": "1", "new_string": "2"})])
    c.ev("notice", {"level": "info", "code": "context.compacted", "message": "Context compacted",
                    "trigger": "auto", "pre_tokens": 150000, "post_tokens": 20000})
    c.turn(3)
    c.ev("context.update", {"tokens": 5555})  # a per-call report without the window
    for k in range(4, 8):
        c.turn(k)
    sid = c.sid
    p = svc.history_page(sid, turns=4)  # turns 4..7: no todos / edits in the page
    s, b = p["summary"], p["before"]
    assert s["context"]["tokens"] == 1007 and s["context"]["window"] == 200000
    assert s["last_compaction"]["pre_tokens"] == 150000
    assert b["todos"]["todos"][0]["content"] == "new plan"  # the latest TodoWrite before the page
    files = {f["path"]: f for f in b["changes"]["files"]}
    assert not b["changes"]["git"]
    assert files["/w/a.py"] == {"path": "/w/a.py", "ops": 2, "created": True, "failed": False}
    assert files["/w/b.py"]["failed"] is True
    assert [f["path"] for f in b["changes"]["files"]] == ["/w/b.py", "/w/a.py"]  # most recent last
    # git-based changes win once the chat has any
    c.ev("turn.changes", {"repos": [{"root": "/w", "files": [{"path": "c.py", "status": "A"}]}]})
    c.turn(8)
    p = svc.history_page(sid, turns=1)
    assert p["before"]["changes"] == {"git": True, "files": [{"path": "/w/c.py", "ops": 1, "created": True,
                                                              "failed": False}]}
    # /clear: no context any more
    c.ev("notice", {"level": "info", "code": "context.reset", "message": "Context cleared"})
    p = svc.history_page(sid, turns=1)
    assert p["summary"]["context"] is None and p["summary"]["last_compaction"] is None
    # an older page carries only its own "before"
    older = svc.history_page(sid, turns=2, before=p["page"]["cursor"])
    assert "summary" not in older and "before" in older


def test_running_background_work_is_pinned(chat, db):
    svc, c = chat
    c.turn(0)
    # turn 1 launches a background subagent that keeps reporting long after
    c.msg("user", "research in the background")
    c.ev("session.start", {"provider": "claude"})
    launch = c.ev("tool.use", {"id": "toolu_bg", "name": "Agent",
                               "input": {"description": "dig", "prompt": "go", "run_in_background": True}})
    c.ev("tool.result", {"id": "toolu_bg", "output": "launched", "is_error": False,
                         "agent": {"status": "async_launched", "is_async": True}})
    c.ev("turn.complete", {"text": "started it"})
    started = c.t.timestamp()  # the engine's clock, near the launch
    c.ev("task.update", {"task_id": "t1", "tool_use_id": "toolu_bg", "status": "running", "is_backgrounded": True})
    early = [c.ev("subagent.text", {"parent": "toolu_bg", "text": "looking"}),
             c.ev("tool.use", {"id": "toolu_sub1", "name": "Agent", "input": {}, "parent": "toolu_bg"}),
             c.ev("tool.use", {"id": "toolu_deep", "name": "Read", "input": {}, "parent": "toolu_sub1"})]
    other = c.ev("tool.result", {"id": "toolu_zzz", "output": "unrelated", "is_error": False})
    for k in range(2, 7):
        c.turn(k)
        if k == 4:
            late = c.ev("subagent.text", {"parent": "toolu_bg", "text": "still at it"})
    db.execute(
        "INSERT INTO bg_tasks (session_id, task_id, tool_use_id, status, is_backgrounded, started_at, updated_at) "
        "VALUES (?, 't1', 'toolu_bg', 'running', 1, ?, ?)", (c.sid, started, c.t.isoformat()))
    p = svc.history_page(c.sid, turns=3)  # turns 4..6: the launch is older
    pinned = [e["eid"] for e in p["summary"]["pinned"]]
    assert launch in pinned and all(e in pinned for e in early) and other not in pinned
    assert late in [e["eid"] for e in p["events"]] and late not in pinned  # the page has it
    # a finished task pins nothing
    db.execute("UPDATE bg_tasks SET status = 'completed'")
    assert svc.history_page(c.sid, turns=3)["summary"]["pinned"] == []


def test_query_plans_use_indexes(chat, db):
    svc, c = chat
    for k in range(3):
        c.turn(k)
    plan = db.query(
        "EXPLAIN QUERY PLAN SELECT id FROM events INDEXED BY idx_events_sid_ts "
        "WHERE session_id = ? AND created_at >= ? AND created_at < ? ORDER BY id", (c.sid, "", "z"))
    assert any("idx_events_sid_ts" in r["detail"] for r in plan)
    plan = db.query("EXPLAIN QUERY PLAN SELECT id FROM events WHERE session_id = ? AND id > ? ORDER BY id",
                    (c.sid, 0))
    assert any("idx_events_sid_id" in r["detail"] or "PRIMARY KEY" in r["detail"] for r in plan)


# ---- API ----


@pytest.fixture
def client():
    with TestClient(app) as cl:
        assert cl.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield cl


def test_api_paging_and_compat(client, tmp_path):
    svc = app.state.session_service
    s = svc.create(provider="claude", workspace_path=str(tmp_path), title="api")
    c = Chat(svc._db, s["id"])
    for k in range(7):
        c.turn(k, cost=0.1)
    sid = s["id"]
    full = client.get(f"/api/history/{sid}").json()  # no turns: the original whole-chat response
    assert "page" not in full and len(full["events"]) == len(svc.events(sid))
    first = client.get(f"/api/history/{sid}", params={"turns": 5}).json()
    assert first["page"]["has_more"] and first["session"]["id"] == sid and "summary" in first
    older = client.get(f"/api/history/{sid}", params={"turns": 10, "before": first["page"]["cursor"]}).json()
    assert not older["page"]["has_more"] and "session" not in older
    assert len(first["events"]) + len(older["events"]) == len(full["events"])
    assert client.get(f"/api/history/{sid}", params={"before": "x"}).status_code == 422
    assert client.get(f"/api/history/{sid}", params={"turns": 0}).status_code == 422
    since = client.get(f"/api/history/{sid}?since=").json()
    assert len(since["events"]) == len(full["events"])


def test_mate_session_pages(client):
    msvc = app.state.mate_service
    m = msvc.create({"name": "Pager", "persona": {"greeting": "Hello!"}})
    sid = msvc.conversation(m["id"])["session_id"]
    svc = app.state.session_service
    c = Chat(svc._db, sid)
    c.t = datetime.now(timezone.utc) + timedelta(seconds=1)  # after the seeded greeting
    for k in range(4):
        c.turn(k)
        # a delegated chat's result arrives as an internal user message (a turn of its own)
        c.msg("user", f"<delegation_result>{k}</delegation_result>",
              meta={"internal": True, "kind": "delegation_result", "delegations": []})
        c.ev("session.start", {"provider": "claude"})
        c.ev("turn.complete", {"text": f"relayed {k}"})
    first = client.get(f"/api/history/{sid}", params={"turns": 3}).json()
    assert first["session"]["kind"] == "mate" and first["page"]["turns"] == 3
    kinds = [(m_["meta"] or {}).get("kind") for m_ in first["messages"] if m_["role"] == "user"]
    assert "delegation_result" in kinds
    pages = [first]
    while pages[-1]["page"]["has_more"]:
        pages.append(client.get(f"/api/history/{sid}",
                                params={"turns": 3, "before": pages[-1]["page"]["cursor"]}).json())
    greet = pages[-1]["messages"][0]
    assert greet["meta"]["kind"] == "greeting"  # the greeting opens the oldest page
    assert sum(len(p["events"]) for p in pages) == len(svc.events(sid))
