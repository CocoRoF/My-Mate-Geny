"""Lite history pages (services/history_lite.py) and the session-wide
aggregates (services/history_aggregates.py): a lite page re-expanded with the
originals the events endpoint returns is the full page (deltas merged into the
same text, task snapshots into the same state); the aggregates extended
event by event equal a fresh fold; per-tool preview rules; the running turn
stays whole; the API (opt-in, the events endpoint, auth)."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import history_lite
from app.services.history_aggregates import SessionAggregates
from app.services.history_page import HistoryPager
from tests.test_history_paging import Chat, _svc

BIG = "\n".join(f"line {i}: " + "x" * 60 for i in range(40))  # ~2.8 KB of tool output


def build(c: Chat, turns: int = 9, big: str = BIG) -> dict:
    """A real-shaped chat: big tool payloads, streamed deltas around context
    reports, background work reporting across turns, subagents, todos."""
    ids: dict = {}
    c.msg("assistant", "Hi, I'm Geny", meta={"internal": True, "kind": "greeting"})
    for k in range(turns):
        c.msg("user", f"question {k}")
        c.ev("session.start", {"provider": "claude"})
        for part in ("Let me ", "think ", "about it."):
            c.ev("thinking.delta", {"text": part})
        c.ev("context.update", {"tokens": 1000 + k, "window": 200000, "threshold": 160000,
                                "model_window": 200000, "window_source": "cli", "auto_compact": True})
        c.ev("text.delta", {"text": "Sure"})
        c.ev("text.delta", {"text": " — on it.\n"})
        t = f"toolu_{k}"
        c.ev("tool.use", {"id": f"{t}_bash", "name": "Bash",
                          "input": {"command": "cat <<'EOF'\n" + "y" * 600 + "\nEOF", "description": "Dump"}})
        c.ev("tool.result", {"id": f"{t}_bash", "output": big, "is_error": False})
        c.ev("tool.use", {"id": f"{t}_small", "name": "Bash", "input": {"command": "ls", "description": "List"}})
        c.ev("tool.result", {"id": f"{t}_small", "output": "a\nb", "is_error": False})
        c.ev("tool.use", {"id": f"{t}_write", "name": "Write",
                          "input": {"file_path": f"/w/f{k}.py", "content": "print(1)\n" * 60}})
        c.ev("tool.result", {"id": f"{t}_write", "output": "File created", "is_error": False})
        c.ev("tool.use", {"id": f"{t}_edit", "name": "Edit",
                          "input": {"file_path": f"/w/f{k}.py", "old_string": "a" * 300, "new_string": "b" * 300,
                                    "replace_all": False}})
        c.ev("tool.result", {"id": f"{t}_edit", "output": "edited", "is_error": False})
        c.ev("tool.use", {"id": f"{t}_fail", "name": "Bash", "input": {"command": "false"}})
        c.ev("tool.result", {"id": f"{t}_fail", "output": "boom\n" * 300, "is_error": True})
        c.ev("tool.use", {"id": f"{t}_patch", "name": "apply_patch",
                          "input": {"changes": [{"path": f"/w/p{k}.py", "kind": "add", "diff": "+x\n" * 100},
                                                {"path": "/w/q.py", "kind": "update", "diff": "-a\n+b\n" * 50}]}})
        c.ev("tool.result", {"id": f"{t}_patch", "output": "ok", "is_error": False})
        c.ev("tool.use", {"id": f"{t}_todo", "name": "TodoWrite",
                          "input": {"todos": [{"content": f"step {i} of turn {k} " + "z" * 20,
                                               "status": "pending"} for i in range(12)]}})
        c.ev("tool.result", {"id": f"{t}_todo", "output": "ok", "is_error": False})
        c.ev("tool.use", {"id": f"{t}_mate", "name": "mcp__mate__read_session",
                          "input": {"session_id": "sess_x"}})
        c.ev("tool.result", {"id": f"{t}_mate", "output": json.dumps({"title": "T", "body": "q" * 1000}),
                             "is_error": False})
        # a foreground subagent: prompt, steps, nested calls, its report
        c.ev("tool.use", {"id": f"{t}_agent", "name": "Agent",
                          "input": {"description": "Survey", "subagent_type": "Explore", "prompt": "p" * 600}})
        c.ev("subagent.text", {"parent": f"{t}_agent", "text": "Looking around"})
        c.ev("tool.use", {"id": f"{t}_sub", "name": "Read", "parent": f"{t}_agent",
                          "input": {"file_path": "/w/shot.png"}})
        c.ev("tool.result", {"id": f"{t}_sub", "output": big, "is_error": False, "parent": f"{t}_agent",
                             "images": [{"id": "att_1", "name": "shot.png", "kind": "image"}]})
        c.ev("task.update", {"task_id": f"a{k}", "tool_use_id": f"{t}_agent", "status": "running",
                             "is_backgrounded": False, "tool_uses": 1})
        c.ev("task.update", {"task_id": f"a{k}", "tool_use_id": f"{t}_agent", "status": "running",
                             "tool_uses": 2, "activity": "Reading"})
        report = "The report follows:\n  # Findings\n  " + "r" * 800
        agent = {"status": "completed", "agent_type": "Explore", "result": "# Findings\n" + "r" * 800} \
            if k % 2 else None
        c.ev("tool.result", {"id": f"{t}_agent", "output": report, "is_error": False,
                             **({"agent": agent} if agent else {})})
        c.ev("task.update", {"task_id": f"a{k}", "tool_use_id": f"{t}_agent", "status": "completed",
                             "summary": "done"})
        if k == 2:  # background work launched here keeps reporting in later turns
            c.ev("tool.use", {"id": "toolu_bg", "name": "Agent",
                              "input": {"description": "dig", "prompt": "go " * 120, "run_in_background": True}})
            c.ev("tool.result", {"id": "toolu_bg", "output": "launched", "is_error": False,
                                 "agent": {"status": "async_launched", "is_async": True}})
            ids["bg_started"] = c.t.timestamp()
        if k >= 2:
            c.ev("task.update", {"task_id": "tbg", "tool_use_id": "toolu_bg", "status": "running",
                                 "is_backgrounded": True, "tool_uses": k, **({"phase": "start"} if k == 2 else {})})
            c.ev("subagent.text", {"parent": "toolu_bg", "text": f"still digging {k}"})
            c.ev("tool.use", {"id": f"toolu_bgsub{k}", "name": "Bash", "parent": "toolu_bg",
                              "input": {"command": "grep -r " + "w" * 400}})
            c.ev("tool.result", {"id": f"toolu_bgsub{k}", "output": big, "is_error": False, "parent": "toolu_bg"})
            c.ev("task.update", {"task_id": "tbg", "tool_use_id": "toolu_bg", "status": "running",
                                 "activity": f"grep {k}", **({"phase": "dig"} if k == 2 else {})})
        if k == 4:
            c.ev("notice", {"level": "info", "code": "context.compacted", "message": "Context compacted",
                            "trigger": "auto", "pre_tokens": 150000, "post_tokens": 20000})
        c.ev("text.delta", {"text": "All "})
        c.ev("text.delta", {"text": "done."})
        c.ev("turn.complete", {"text": "Sure — on it.\nAll done.", "model": "claude-opus-5-5", "cost_usd": 0.1,
                               "cost_kind": "turn", "provider": "claude",
                               "usage": {"input_tokens": 10, "output_tokens": 5}})
        c.msg("assistant", "Sure — on it.\nAll done.")
    return ids


@pytest.fixture
def chat(db, tmp_path):
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path), title="lite")
    return svc, Chat(db, s["id"])


def walk(svc, sid, first: int = 3, older: int = 2, **kw):
    pages = [svc.history_page(sid, turns=first, **kw)]
    while pages[-1]["page"]["has_more"]:
        pages.append(svc.history_page(sid, turns=older, before=pages[-1]["page"]["cursor"], **kw))
    return pages


def timeline(messages, events):
    items = [((m.get("created_at") or ""), 0, 0, None) for m in messages]
    items += [((e.get("timestamp") or ""), 1, e.get("eid") or 0, e) for e in events]
    items.sort(key=lambda x: x[:3])
    return [x[3] for x in items]


def expand_check(full_page, lite_page, originals) -> dict:
    """Every full event is in the lite page — as itself, re-expanded from its
    original, inside a folded task.update or a merged delta run — or is a
    context report; returns counts of each."""
    full = {e["eid"]: e for e in full_page["events"]}
    lite = {e["eid"]: e for e in lite_page["events"]}
    assert set(lite) <= set(full)
    seen = {"lazy": 0, "folded": 0, "merged": 0, "echo": 0}
    covered = set()
    for e in lite_page["events"]:
        orig = full[e["eid"]]
        data = e["data"]
        if e.get("lazy"):
            assert originals[e["eid"]] == orig  # the endpoint hands back the stored event
            data = orig["data"]
            seen["lazy"] += 1
        if e.get("covers"):
            merged: dict = {}
            for c in e["covers"]:
                assert full[c]["type"] == "task.update"
                merged.update(full[c]["data"])
                covered.add(c)
            assert data == merged and e["covers"][-1] == e["eid"]
            seen["folded"] += len(e["covers"]) - 1
        elif e["type"] in ("text.delta", "thinking.delta"):
            pass
        elif e["type"] == "turn.complete" and "text" in orig["data"] and "text" not in data:
            assert data == {k: v for k, v in orig["data"].items() if k != "text"}
            seen["echo"] += 1
        else:
            assert data == orig["data"], (e["eid"], e["type"])
        if not e.get("covers") and e["type"] not in ("text.delta", "thinking.delta"):
            assert {k: v for k, v in e.items() if k not in ("data", "lazy")} == \
                {k: v for k, v in orig.items() if k != "data"}
    drop = {eid for eid, e in full.items() if e["type"] == "context.update"} | (covered - set(lite))
    line = [e for e in timeline(full_page["messages"], full_page["events"]) if e is None or e["eid"] not in drop]
    run: list = []
    for e in line:
        if e is not None and e["type"] in ("text.delta", "thinking.delta"):
            assert not run or run[-1]["type"] == e["type"]
            run.append(e)
            if e["eid"] in lite:
                merged_ev = lite[e["eid"]]
                assert merged_ev["type"] == e["type"] and merged_ev["timestamp"] == run[0]["timestamp"]
                assert merged_ev["data"] == {"text": "".join(p["data"]["text"] for p in run)}
                seen["merged"] += len(run) - 1
                run = []
            continue
        assert not run, "a delta run broken before its merged event"
    assert not run
    deltas = {eid for eid, e in full.items() if e["type"] in ("text.delta", "thinking.delta")}
    assert set(lite) | covered | drop | deltas == set(full)
    return seen


def test_lite_pages_reexpand_to_the_full_ones(chat):
    svc, c = chat
    build(c)
    sid = c.sid
    full, lite = walk(svc, sid), walk(svc, sid, lite=True)
    assert len(full) == len(lite) > 2
    totals = {"lazy": 0, "folded": 0, "merged": 0, "echo": 0}
    for f, l in zip(full, lite):
        assert l["page"].pop("lite") == history_lite.LITE_VERSION
        assert f["page"] == l["page"] and f["before"] == l["before"] and f["messages"] == l["messages"]
        lazy = [e["eid"] for e in l["events"] if e.get("lazy")]
        originals = {e["eid"]: e for e in svc.events_by_id(sid, lazy)}
        for k, v in expand_check(f, l, originals).items():
            totals[k] += v
        assert len(json.dumps(l)) < len(json.dumps(f)) / 1.5
    assert all(totals.values()), totals  # every rule applied somewhere


def test_per_tool_rules(chat):
    svc, c = chat
    build(c, turns=3)
    deep = "/w/" + "very/deep/" * 40 + "file.py"  # a path longer than any preview: never cut
    c.ev("tool.use", {"id": "toolu_deep", "name": "Edit", "input": {"file_path": deep, "old_string": "a" * 999,
                                                                   "new_string": "b"}})
    c.ev("tool.use", {"id": "toolu_deeppatch", "name": "apply_patch",
                      "input": {"changes": [{"path": deep, "kind": "add", "diff": "+x\n" * 300}]}})
    page = svc.history_page(c.sid, turns=1, lite=True)
    deep_ev = [e for e in page["events"] if e["data"].get("id") in ("toolu_deep", "toolu_deeppatch")]
    assert deep_ev[0]["data"]["input"] == {"file_path": deep} and deep_ev[0]["lazy"]
    assert deep_ev[1]["data"]["input"] == {"changes": [{"path": deep, "kind": "add"}]}
    assert page["before"]["changes"]["files"]  # (the panel's list keeps working)
    ev = {(e["type"], e["data"].get("id")): e for e in page["events"] if e["type"] in ("tool.use", "tool.result")}
    use = lambda s: ev[("tool.use", f"toolu_2_{s}")]  # noqa: E731
    res = lambda s: ev[("tool.result", f"toolu_2_{s}")]  # noqa: E731
    # Edit / Write: the content left out as a unit, the path (row, panel) stays
    assert use("edit")["data"]["input"] == {"file_path": "/w/f2.py", "replace_all": False}
    assert use("edit")["lazy"]["input"]["cut"] == ["new_string", "old_string"]
    assert use("write")["data"]["input"] == {"file_path": "/w/f2.py"}
    # apply_patch: each change keeps path + kind (row target, changed files)
    assert use("patch")["data"]["input"]["changes"] == [{"path": "/w/p2.py", "kind": "add"},
                                                        {"path": "/w/q.py", "kind": "update"}]
    # Bash / Agent: long strings cut to their start, short ones and key order kept
    inp = use("bash")["data"]["input"]
    assert list(inp) == ["command", "description"] and inp["description"] == "Dump"
    assert len(inp["command"]) == history_lite.STR_PREVIEW and inp["command"].startswith("cat <<'EOF'")
    agent = use("agent")["data"]["input"]
    assert agent["description"] == "Survey" and agent["subagent_type"] == "Explore" and len(agent["prompt"]) == 200
    # whole: small inputs, TodoWrite, the mate's tools
    for s in ("small", "todo", "mate"):
        assert "lazy" not in use(s)
    # results: big ones previewed; failed, mate, small and Agent reports without agent.result whole
    assert res("bash")["data"]["output"] == BIG[:history_lite.OUTPUT_PREVIEW]
    assert res("bash")["lazy"]["output"] == {"size": len(BIG), "lines": 40}
    for s in ("fail", "mate", "small", "agent"):  # (turn 2: no agent.result)
        assert "lazy" not in res(s), s
    sub = res("sub")
    assert sub["lazy"] and sub["data"]["images"] and sub["data"]["parent"] == "toolu_2_agent"
    odd = svc.history_page(c.sid, turns=2, lite=True)  # turn 1's Agent has agent.result: its output may go lite
    r1 = next(e for e in odd["events"] if e["type"] == "tool.result" and e["data"].get("id") == "toolu_1_agent")
    assert r1["lazy"] and r1["data"]["agent"]["result"].startswith("# Findings")
    # no context reports; the echoed answer left out; deltas merged
    assert not [e for e in page["events"] if e["type"] == "context.update"]
    done = next(e for e in page["events"] if e["type"] == "turn.complete")
    assert "text" not in done["data"] and done["data"]["cost_usd"] == 0.1
    texts = [e["data"]["text"] for e in page["events"] if e["type"] == "text.delta"]
    assert texts == ["Sure — on it.\n", "All done."]
    assert [e["data"]["text"] for e in page["events"] if e["type"] == "thinking.delta"] == ["Let me think about it."]


def test_task_updates_fold_within_a_turn_only(chat):
    svc, c = chat
    build(c, turns=6)
    full, lite = walk(svc, c.sid), walk(svc, c.sid, lite=True)
    n_full = sum(1 for p in full for e in p["events"] if e["type"] == "task.update")
    n_lite = sum(1 for p in lite for e in p["events"] if e["type"] == "task.update")
    assert n_lite < n_full
    for p in lite:
        for e in p["events"]:
            if e.get("covers"):
                # never across a turn boundary: every folded update between the same user messages
                full_ev = {x["eid"]: x for q in full for x in q["events"]}
                ts = [full_ev[i]["timestamp"] for i in e["covers"]]
                users = [m["created_at"] for q in full for m in q["messages"] if m["role"] == "user"]
                assert not any(ts[0] < u < ts[-1] for u in users)


def test_running_turn_stays_whole(chat, db):
    svc, c = chat
    build(c, turns=3)
    c.msg("user", "one more")
    c.ev("session.start", {"provider": "claude"})
    c.ev("tool.use", {"id": "toolu_live", "name": "Bash", "input": {"command": "z" * 3000}})
    c.ev("tool.result", {"id": "toolu_live", "output": BIG, "is_error": False})
    pager = HistoryPager(db, None, SessionAggregates())
    page = pager.page(c.sid, turns=2, lite=True, running=True)
    live = [e for e in page["events"] if e["data"].get("id") == "toolu_live"]
    assert len(live) == 2 and not any(e.get("lazy") for e in live)
    assert any(e.get("lazy") for e in page["events"])  # the turn before it is lite
    idle = pager.page(c.sid, turns=2, lite=True, running=False)
    assert all(e.get("lazy") for e in idle["events"] if e["data"].get("id") == "toolu_live")


def test_pinned_background_work_is_lite_and_complete(chat, db):
    svc, c = chat
    ids = build(c, turns=7)
    db.execute(
        "INSERT INTO bg_tasks (session_id, task_id, tool_use_id, status, is_backgrounded, started_at, updated_at) "
        "VALUES (?, 'tbg', 'toolu_bg', 'running', 1, ?, ?)", (c.sid, ids["bg_started"], c.t.isoformat()))
    full = svc.history_page(c.sid, turns=2)
    lite = svc.history_page(c.sid, turns=2, lite=True)
    fp, lp = full["summary"]["pinned"], lite["summary"]["pinned"]
    assert fp and [e["eid"] for e in fp] == [e["eid"] for e in lp]
    lazy = {e["eid"]: e for e in svc.events_by_id(c.sid, [e["eid"] for e in lp if e.get("lazy")])}
    assert lazy and [lazy[e["eid"]] if e.get("lazy") else e for e in lp] == fp


def test_aggregates_extend_exactly(chat, db):
    svc, c = chat
    shared = SessionAggregates()
    cached = HistoryPager(db, None, shared)
    build(c, turns=1)
    for k in range(5):  # legacy running cost totals, failures, todos, edits, then git snapshots
        c.msg("user", f"more {k}")
        c.ev("session.start", {"provider": "claude"})
        c.ev("tool.use", {"id": f"toolu_x{k}", "name": "Edit", "input": {"file_path": f"/w/x{k}.py",
                                                                          "old_string": "a", "new_string": "b"}})
        c.ev("tool.result", {"id": f"toolu_x{k}", "output": "no", "is_error": k % 2 == 0})
        c.ev("tool.use", {"id": f"toolu_t{k}", "name": "TodoWrite", "input": {"todos": [{"content": f"t{k}"}]}})
        c.ev("turn.complete", {"text": "ok", "cost_usd": 0.5 + k, "provider": "claude", "model": "claude-x"})
        if k == 3:
            c.ev("turn.changes", {"repos": [{"root": "/w", "files": [{"path": "g.py", "status": "A"}]}]})
        for turns in (1, 2, 4):
            a = cached.page(c.sid, turns=turns)  # extended from the last request
            b = HistoryPager(db).page(c.sid, turns=turns)  # folded from scratch
            assert a == b
            if a["page"]["has_more"]:
                assert cached.page(c.sid, turns=1, before=a["page"]["cursor"]) == \
                    HistoryPager(db).page(c.sid, turns=1, before=a["page"]["cursor"])
    agg = shared.get(db, c.sid)
    assert agg.names["toolu_x0"] == "Edit" and "toolu_x0" in agg.failed and "toolu_x1" not in agg.failed
    assert [round(t["data"]["cost_usd"], 6) for t in agg.terminal][-4:] == [1.0, 1.0, 1.0, 1.0]  # per turn
    svc.history_page(c.sid, turns=1)
    assert c.sid in svc.history_aggregates._by_sid
    svc.delete(c.sid)  # deleting a chat drops its records
    assert c.sid not in svc.history_aggregates._by_sid


# ---- API ----


@pytest.fixture
def client():
    with TestClient(app) as cl:
        assert cl.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield cl


def test_api_lite_is_opt_in_and_events_endpoint(client, tmp_path):
    svc = app.state.session_service
    s = svc.create(provider="claude", workspace_path=str(tmp_path), title="api lite")
    other = svc.create(provider="claude", workspace_path=str(tmp_path), title="another")
    c = Chat(svc._db, s["id"])
    c.t = datetime.now(timezone.utc) + timedelta(seconds=1)
    build(c, turns=4)
    sid = s["id"]
    old = client.get(f"/api/history/{sid}", params={"turns": 2}).json()  # an old client: full pages
    assert "lite" not in old["page"] and not any("lazy" in e or "covers" in e for e in old["events"])
    new = client.get(f"/api/history/{sid}", params={"turns": 2, "lite": 1}).json()
    assert new["page"]["lite"] == 1 and new["session"]["id"] == sid and "summary" in new
    assert len(json.dumps(new)) < len(json.dumps(old)) / 1.5
    older = client.get(f"/api/history/{sid}", params={"turns": 2, "lite": 1, "before": new["page"]["cursor"]}).json()
    assert any(e.get("lazy") for e in older["events"])
    lazy = [e["eid"] for e in new["events"] + older["events"] if e.get("lazy")]
    got = client.post(f"/api/history/{sid}/events", json={"eids": lazy}).json()["events"]
    full = {e["eid"]: e for e in svc.events(sid)}
    assert [e["eid"] for e in got] == sorted(lazy) and all(e == full[e["eid"]] for e in got)
    one = client.get(f"/api/history/{sid}/events/{lazy[0]}").json()
    assert one == full[lazy[0]]
    # another chat's events are not found through this one
    assert client.post(f"/api/history/{other['id']}/events", json={"eids": lazy}).json() == {"events": []}
    assert client.get(f"/api/history/{other['id']}/events/{lazy[0]}").status_code == 404
    assert client.post("/api/history/sess_nope/events", json={"eids": lazy}).status_code == 404
    assert client.post(f"/api/history/{sid}/events", json={"eids": list(range(501))}).status_code == 422
    assert client.get(f"/api/history/{sid}", params={"turns": 2, "lite": 2}).status_code == 422
    # signed out: nothing
    with TestClient(app) as anon:
        assert anon.post(f"/api/history/{sid}/events", json={"eids": lazy}).status_code == 401
        assert anon.get(f"/api/history/{sid}/events/{lazy[0]}").status_code == 401


def test_write_frontend_fixture(chat, db):
    """The frontend equivalence test's fixture (test/fixtures/lite-history.json):
    full pages, lite pages and the originals of every previewed event.
    Regenerate: HRH_WRITE_LITE_FIXTURE=1 pytest tests/test_history_lite.py -k fixture"""
    svc, c = chat
    ids = build(c, turns=5, big=BIG[:900])
    db.execute(
        "INSERT INTO bg_tasks (session_id, task_id, tool_use_id, status, is_backgrounded, started_at, updated_at) "
        "VALUES (?, 'tbg', 'toolu_bg', 'running', 1, ?, ?)", (c.sid, ids["bg_started"], c.t.isoformat()))
    sid = c.sid

    def resp(p, newest):
        if not newest:
            return {"session_id": sid, **p}
        return {"session_id": sid, "session": {"id": sid, "cli_info": None}, "running": False, **p,
                "account": None, "live_usage": None}

    full, lite = walk(svc, sid, first=2, older=1), walk(svc, sid, first=2, older=1, lite=True)
    lazy = [e["eid"] for p in lite for e in p["events"] + p.get("summary", {}).get("pinned", []) if e.get("lazy")]
    fixture = {"sid": sid, "full": [resp(p, i == 0) for i, p in enumerate(full)],
               "lite": [resp(p, i == 0) for i, p in enumerate(lite)],
               "events": {str(e["eid"]): e for e in svc.events_by_id(sid, lazy)}}
    assert lazy and len(full) == 4 and full[0]["summary"]["pinned"]
    path = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "test", "fixtures", "lite-history.json")
    if os.environ.get("HRH_WRITE_LITE_FIXTURE"):
        with open(path, "w") as fh:
            json.dump(fixture, fh, ensure_ascii=False)
    else:  # the committed fixture is what this code produces (modulo the random session id)
        with open(path) as fh:
            saved = json.load(fh)
        same = json.dumps(fixture, ensure_ascii=False).replace(sid, saved["sid"]).replace(sid[-8:], saved["sid"][-8:])
        assert json.loads(same) == saved, "regenerate the fixture (see the docstring)"
