"""Memory v2 (docs/mate-memory-affinity.md §4) through the store, the service and the API: the migration of
memories saved before kinds, dedup/merge, edits, the core in the system prompt vs recall in the per-turn
<context> block, the prompt key (no restart for the mate's own writes or for edits outside the core), the
user's corrections reaching the mate, the tracker, the tools, housekeeping and the routes."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate.service import MateService
from app.mate.store import MateError, MateStore
from app.providers.base import TurnRequest
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


def _svc(db):
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    store = MateStore(db, vault)
    return store, MateService(svc, store)


def _turn(mates, mate_id, text="hi", cli=None):
    session = mates.conversation(mate_id)["session"]
    req = TurnRequest(messages=[{"role": "user", "content": text}], model="", cwd="/tmp", cli_session_id=cli)
    mates.configure_engine(session, req)
    return req, open(req.system_prompt_file, encoding="utf-8").read()


def test_migration_of_old_memories_is_safe_and_idempotent(db):
    store, _ = _svc(db)
    m = store.create(name="Old")
    # rows as the previous version wrote them: only id, text, created_at (the new columns get their defaults)
    for i, text in enumerate(["사용자 이름은 현석", "Prefers short answers", "The repo uses FastAPI"]):
        db.execute("INSERT INTO mate_memories (id, mate_id, text, created_at) VALUES (?, ?, ?, ?)",
                   (f"mem_old{i}", m["id"], text, f"2026-01-0{i + 1}T00:00:00+00:00"))
    assert store.migrate_memories() == 3
    rows = {r["id"]: r for r in store.memories(m["id"])}
    assert [rows[f"mem_old{i}"]["kind"] for i in range(3)] == ["profile", "preference", "fact"]
    assert rows["mem_old0"]["pinned"] and not rows["mem_old1"]["pinned"]
    assert rows["mem_old2"]["updated_at"] == "2026-01-03T00:00:00+00:00" and rows["mem_old2"]["text"] == "The repo uses FastAPI"
    assert all(r["status"] == "active" and r["importance"] == 3 for r in rows.values())
    store.update_memory(m["id"], "mem_old2", {"kind": "plan"}, by_user=True)
    assert store.migrate_memories() == 0  # once only: the user's later choices stay
    assert store.memory(m["id"], "mem_old2")["kind"] == "plan"


def test_add_merges_duplicates_and_reports_similar(db):
    store, _ = _svc(db)
    m = store.create(name="M")
    a = store.add_memory(m["id"], "Likes green tea", kind="preference")
    assert not a["merged"] and a["source"] == "mate" and a["kind"] == "preference"
    b = store.add_memory(m["id"], "likes green tea!", kind="preference", importance=5)
    assert b["merged"] and b["id"] == a["id"] and b["importance"] == 5
    assert len(store.memories(m["id"])) == 1
    c = store.add_memory(m["id"], "Likes green tea", kind="fact")  # another kind: its own memory
    assert not c["merged"]
    d = store.add_memory(m["id"], "Likes green tea with honey in the morning", kind="preference")
    assert d["merged"]  # one contains the other: the longer text wins
    assert store.memory(m["id"], a["id"])["text"] == "Likes green tea with honey in the morning"
    e = store.add_memory(m["id"], "현석은 아메리카노를 좋아해", kind="preference")
    f = store.add_memory(m["id"], "현석은 아메리카노 좋아함", kind="preference")
    assert not f["merged"] and [x["id"] for x in f["similar"]] == [e["id"]]
    with pytest.raises(MateError):
        store.add_memory(m["id"], "x", kind="secret")
    with pytest.raises(MateError):
        store.add_memory(m["id"], "dentist", kind="plan", due_at="next tuesday")
    plan = store.add_memory(m["id"], "Dentist", kind="plan", due_at="2026-11-03 15:00")
    assert plan["due_at"] == "2026-11-03T15:00"
    ctx = store.add_memory(m["id"], "Busy with the move this week", kind="context")
    assert ctx["expires_at"] and not store.add_memory(m["id"], "Pinned?", pinned=True)["pinned"]  # (only the user pins)


def test_update_bulk_search_and_sort(db):
    store, _ = _svc(db)
    m = store.create(name="M")
    x = store.add_memory(m["id"], "Works at a bank", kind="profile", by_user=True)
    y = store.add_memory(m["id"], "Trip to Busan", kind="plan", due_at="2026-12-01", importance=5, by_user=True)
    store.update_memory(m["id"], x["id"], {"text": "Works at a startup", "pinned": True}, by_user=True)
    got = store.memory(m["id"], x["id"])
    assert got["text"] == "Works at a startup" and got["pinned"]
    store.update_memory(m["id"], y["id"], {"pinned": True})  # the mate can't pin
    assert not store.memory(m["id"], y["id"])["pinned"]
    assert [r["id"] for r in store.memories(m["id"], q="busan")] == [y["id"]]
    assert [r["id"] for r in store.memories(m["id"], q="부산 trip")] == [y["id"]]
    assert store.memories(m["id"], sort="importance")[0]["id"] == y["id"]
    assert store.bulk_memories(m["id"], [y["id"], "mem_nope"], "archive") == 1
    assert [r["id"] for r in store.memories(m["id"])] == [x["id"]]
    assert [r["id"] for r in store.memories(m["id"], status="archived")] == [y["id"]]
    assert store.memory_counts(m["id"]) == {"active": 1, "done": 0, "archived": 1, "core": 1}
    with pytest.raises(MateError):
        store.update_memory(m["id"], x["id"], {"status": "gone"})
    with pytest.raises(KeyError):
        store.update_memory(m["id"], "mem_nope", {"text": "x"})


def test_core_in_the_prompt_recall_per_turn_and_no_restart_for_the_mates_writes(db):
    store, mates = _svc(db)
    m = store.create(name="Rin", persona={"language": "ko"})
    store.add_memory(m["id"], "사용자 이름은 현석", kind="profile", by_user=True)
    for i in range(30):  # enough that not everything is core
        store.add_memory(m["id"], f"메모 {i} 항목 {i * 7} 번호 {i * 13}", kind="fact")
    store.add_memory(m["id"], "치과 예약은 다음 주 화요일", kind="plan", due_at="2026-12-08")
    req, prompt = _turn(mates, m["id"], "치과 예약 언제였지?")
    assert "사용자 이름은 현석" in prompt and "치과" not in prompt  # core vs the rest
    assert "You remember 31 more things" in prompt
    assert req.preamble.startswith("<context>\nNow: ") and "치과 예약은 다음 주 화요일" in req.preamble
    key1 = req.prompt_key
    # the mate's own memory writes: same key (no restart)
    store.add_memory(m["id"], "고양이 이름은 나비", kind="fact")
    req2, _ = _turn(mates, m["id"], "치과 예약 언제였지?", cli="cli-1")
    assert req2.prompt_key == key1
    assert "치과 예약은" not in req2.preamble  # already in this engine session's context (tracker)
    # a fresh engine context (no session to resume) is told again
    req3, _ = _turn(mates, m["id"], "치과 예약 언제였지?")
    assert "치과 예약은" in req3.preamble
    used = [r for r in store.memories(m["id"]) if r["text"].startswith("치과")][0]
    assert used["use_count"] == 2 and used["last_used_at"]


def test_user_edits_outside_the_core_reach_the_mate_without_a_restart(db):
    store, mates = _svc(db)
    m = store.create(name="Rin")
    for i in range(30):
        store.add_memory(m["id"], f"note {i} about project alpha number {i}", kind="fact")
    req, _ = _turn(mates, m["id"])
    key = req.prompt_key
    victim = store.memories(m["id"])[5]
    store.update_memory(m["id"], victim["id"], {"text": "note 5 was wrong, it is project beta"}, by_user=True)
    gone = store.memories(m["id"])[6]
    store.delete_memory(m["id"], gone["id"], by_user=True)
    req2, _ = _turn(mates, m["id"], cli="cli-1")
    assert req2.prompt_key == key  # not in the core: no restart
    assert f"[{victim['id']}] changed: note 5 was wrong" in req2.preamble
    assert f"[{gone['id']}] deleted — don't rely on it" in req2.preamble
    req3, _ = _turn(mates, m["id"], cli="cli-1")
    assert "changed your memory" not in req3.preamble  # told once
    # a core change (a pin) reloads the engine
    store.update_memory(m["id"], victim["id"], {"pinned": True}, by_user=True)
    req4, prompt4 = _turn(mates, m["id"], cli="cli-1")
    assert req4.prompt_key != key and "project beta" in prompt4


def test_recall_level_and_self_save_prefs(db):
    store, mates = _svc(db)
    m = store.create(name="Rin")
    for i in range(30):
        store.add_memory(m["id"], f"tea fact {i}", kind="fact")
    req, _ = _turn(mates, m["id"], "tea?")
    assert req.preamble.count("(fact) tea fact") == 8
    mates.update(m["id"], {"prefs": {"memory": {"recall": "off"}}})
    req2, _ = _turn(mates, m["id"], "tea?")
    assert "tea fact" not in req2.preamble and req2.prompt_key == req.prompt_key  # per turn: no restart
    mates.update(m["id"], {"prefs": {"memory": {"self_save": False}}})
    req3, prompt3 = _turn(mates, m["id"], "tea?")
    assert "only when the user explicitly asks" in prompt3 and req3.prompt_key != req.prompt_key


async def test_tools_remember_update_forget_recall(db):
    store, mates = _svc(db)
    m = store.create(name="Rin")
    sid = mates.conversation(m["id"])["session_id"]
    ctx = mates.token_info(mates._token(m["id"], sid))
    text, err = await mates.call_tool(ctx, "remember", {"text": "Dentist appointment", "kind": "plan",
                                                        "due": "2026-11-03T15:00", "importance": 4})
    assert not err and "(plan, due 2026-11-03 15:00) Dentist appointment" in text
    mid = text.split("[")[1].split("]")[0]
    text, err = await mates.call_tool(ctx, "remember", {"text": "dentist appointment", "kind": "plan"})
    assert not err and "Already known" in text
    text, err = await mates.call_tool(ctx, "update_memory", {"id": f"[{mid}]", "due": "2026-11-04"})
    assert not err and "due 2026-11-04" in text
    text, err = await mates.call_tool(ctx, "recall", {"query": "dentist"})
    assert not err and mid in text
    text, err = await mates.call_tool(ctx, "update_memory", {"id": mid, "status": "done"})
    assert not err and "status done" in text
    text, _ = await mates.call_tool(ctx, "recall", {"query": "dentist"})
    assert "Nothing in your memory" in text
    text, _ = await mates.call_tool(ctx, "recall", {"query": "dentist", "include_done": True})
    assert mid in text and "status done" in text
    text, err = await mates.call_tool(ctx, "remember", {"text": "x", "due": "soon"})
    assert err and "YYYY-MM-DD" in text
    text, err = await mates.call_tool(ctx, "update_memory", {"id": "mem_nope", "text": "x"})
    assert err
    text, err = await mates.call_tool(ctx, "forget", {"id": mid, "reason": "done"})
    assert not err and store.memory(m["id"], mid) is None


def test_housekeeping_runs_once_a_day(db):
    store, mates = _svc(db)
    m = store.create(name="Rin")
    old = store.add_memory(m["id"], "dentist", kind="plan", due_at="2020-01-01")
    _turn(mates, m["id"])
    assert store.memory(m["id"], old["id"])["status"] == "done"


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


def test_memory_routes(client):
    m = client.post("/api/mates", json={"name": "Routes"}).json()
    base = f"/api/mates/{m['id']}/memories"
    a = client.post(base, json={"text": "Likes tea", "kind": "preference", "importance": 4, "pinned": True}).json()
    assert a["kind"] == "preference" and a["pinned"] and a["source"] == "user" and a["merged"] is False
    assert client.post(base, json={"text": "likes tea", "kind": "preference"}).json()["merged"] is True
    assert client.post(base, json={"text": "x", "kind": "nope"}).status_code == 400
    p = client.post(base, json={"text": "Trip", "kind": "plan", "due_at": "2026-12-01"}).json()
    r = client.patch(f"{base}/{p['id']}", json={"text": "Trip to Jeju", "importance": 5})
    assert r.status_code == 200 and r.json()["text"] == "Trip to Jeju"
    assert client.patch(f"{base}/mem_nope", json={"text": "x"}).status_code == 404
    rows = client.get(base, params={"sort": "importance"}).json()
    assert [x["id"] for x in rows] == [p["id"], a["id"]] and all(x["core"] for x in rows)
    assert [x["id"] for x in client.get(base, params={"q": "jeju"}).json()] == [p["id"]]
    assert [x["id"] for x in client.get(base, params={"kind": "plan"}).json()] == [p["id"]]
    assert client.get(base, params={"status": "nope"}).status_code == 400
    prev = client.post(f"{base}/preview", json={"text": "jeju?"}).json()
    assert prev["level"] == "normal" and len(prev["core"]) == 2 and prev["block"].startswith("<context>")
    assert client.post(f"{base}/bulk", json={"ids": [p["id"]], "action": "archive"}).json() == {"changed": 1}
    assert client.get(f"{base}/stats").json() == {"active": 1, "done": 0, "archived": 1, "core": 1}
    assert client.post(f"{base}/bulk", json={"ids": "x", "action": "archive"}).status_code == 400
    assert client.delete(f"{base}/{a['id']}").json()["deleted"] is True
    tz = client.put("/api/mates/settings", json={"timezone": "Asia/Seoul"}).json()
    assert tz["timezone"] == "Asia/Seoul"
    assert client.put("/api/mates/settings", json={"timezone": "Mars/Base"}).status_code == 400
    assert client.put("/api/mates/settings", json={"timezone": ""}).json()["timezone"] == ""


def test_context_block_shape():
    from app.mate.prompt import context_block

    block = context_block(datetime(2026, 11, 2, 19, 5), "Asia/Seoul",
                          recalled=[{"id": "mem_1", "text": "Dentist", "kind": "plan", "due_at": "2026-11-03"}],
                          changes=[{"id": "mem_2", "op": "deleted"}], relation=["Relationship: familiar."])
    assert block.splitlines() == [
        "<context>", "Now: 2026-11-02 (Mon) 19:05 Asia/Seoul", "Relationship: familiar.",
        "Memories that may help (use them only if relevant):", "- [mem_1] (plan, due 2026-11-03) Dentist",
        "The user changed your memory since your last message:", "- [mem_2] deleted — don't rely on it any more.",
        "</context>"]
    assert json.dumps(block)  # (plain text)
    assert datetime.now(timezone.utc)
