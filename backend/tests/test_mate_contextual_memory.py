"""Regression cases for autonomous, evidence-backed conversational memory."""

import pytest

from app.mate.consolidation import Consolidator
from app.mate.knowledge import record_message
from tests.test_mate_knowledge import setup
from tests.test_mate_memory_v2 import _turn


async def test_new_name_and_later_relationship_are_batched_without_remember_request(db):
    store, mates, mid, sid = setup(db)
    a = mates._svc._add_message(sid, "user", "오늘은 서준 선배랑 점심 먹었어.")
    mates._svc._add_message(sid, "assistant", "어떤 분이야?")
    b = mates._svc._add_message(sid, "user", "같은 팀에서 같이 일하는 동료야.")
    # Foreground coding activity must not starve this idle mate's memory.
    mates._svc._tasks["unrelated-coding-session"] = object()
    calls = []

    async def extract(mate, source):
        calls.append(source)
        assert {"msg:" + a, "msg:" + b} == source["batch_ids"]
        assert [v["role"] for v in source["context"]] == ["user", "assistant", "user"]
        return {
            "facts": [
                {
                    "subject": "서준",
                    "subject_type": "person",
                    "kind": "fact",
                    "evidence": [
                        {
                            "source_id": "msg:" + a,
                            "revision": 1,
                            "quote": "서준 선배랑 점심 먹었어.",
                        },
                        {
                            "source_id": "msg:" + b,
                            "revision": 1,
                            "quote": "같은 팀에서 같이 일하는 동료야.",
                        },
                    ],
                }
            ]
        }, {"cost_usd": 0.01, "usage": {"input_tokens": 100, "output_tokens": 30}}

    worker = Consolidator(mates)
    assert await worker.once(extract)
    assert not await worker.once(extract)
    assert len(calls) == 1
    memory = store.memories(mid)[0]
    assert memory["subject"] == "서준" and memory["subject_type"] == "person"
    assert memory["text"] == "서준 선배랑 점심 먹었어. · 같은 팀에서 같이 일하는 동료야."
    evidence = store.knowledge.memory_details(mid, memory["id"])["evidence"]
    assert {r["source_id"] for r in evidence} == {"msg:" + a, "msg:" + b}
    assert store.knowledge.stats(mid)["jobs"] == {"done": 2}
    run = store.knowledge.stats(mid)["recent_runs"][0]
    assert run["state"] == "done" and run["sources"] == 2 and run["facts"] == 1
    assert db.query_one("SELECT SUM(cost) n FROM memory_jobs")["n"] == 0.01
    recalled = mates.preview_context(mid, "서준 선배 기억해?")
    assert memory["id"] in {m["id"] for m in recalled["core"] + recalled["recalled"]}
    request, prompt = _turn(mates, mid, "서준 선배 기억해?")
    assert "동료" in prompt + (request.preamble or "")
    usage = [r for r in mates._svc.events(sid) if r["data"].get("memory_extraction")]
    assert len(usage) == 1 and usage[0]["data"]["usage_source"] == "internal"
    mates._svc._tasks.clear()


async def test_previously_processed_name_is_context_for_new_pronoun(db):
    store, mates, mid, sid = setup(db)
    a = mates._svc._add_message(sid, "user", "윤하씨랑 만났어.")
    worker = Consolidator(mates)

    async def empty(mate, source):
        return {"facts": [], "episodes": []}, {}

    await worker.once(empty)
    b = mates._svc._add_message(sid, "user", "같이 일하는 디자이너야.")

    async def link(mate, source):
        assert source["batch_ids"] == {"msg:" + b}
        return {
            "facts": [
                {
                    "subject": "윤하",
                    "subject_type": "person",
                    "evidence": [
                        {"source_id": "msg:" + a, "quote": "윤하씨랑 만났어."},
                        {"source_id": "msg:" + b, "quote": "같이 일하는 디자이너야."},
                    ],
                }
            ]
        }, {}

    assert await worker.once(link)
    assert len(store.memories(mid)) == 1
    # A correction to either supporting source retracts the composite fact.
    db.execute("UPDATE messages SET content='잘못 말했어.' WHERE id=?", (a,))
    record_message(db, a)
    assert not store.memories(mid)


async def test_optional_ungrounded_entity_label_does_not_drop_valid_personal_fact(db):
    store, mates, mid, sid = setup(db)
    mates._svc._add_message(sid, "user", "나는 음식은 매운 걸 좋아해.")

    async def extract(mate, source):
        return {
            "facts": [
                {
                    "quote": "나는 음식은 매운 걸 좋아해.",
                    "kind": "preference",
                    "subject": "user",
                    "subject_type": "person",
                }
            ]
        }, {}

    await Consolidator(mates).once(extract)
    memory = store.memories(mid)[0]
    assert memory["kind"] == "preference" and memory["subject"] is None
    assert memory["subject_type"] == "other"
    assert store.knowledge.stats(mid)["jobs"] == {"done": 1}


async def test_multiline_source_quotes_remain_grounded_after_display_whitespace_normalization(db):
    store, mates, mid, sid = setup(db)
    a = mates._svc._add_message(sid, "user", "동료 이름은\n  지호야.")
    b = mates._svc._add_message(sid, "user", "지난주부터\n같이 프로젝트를 하고 있어.")

    async def extract(mate, source):
        return {
            "facts": [
                {
                    "evidence": [
                        {"source_id": "msg:" + a, "quote": "동료 이름은\n  지호야."},
                        {
                            "source_id": "msg:" + b,
                            "quote": "지난주부터\n같이 프로젝트를 하고 있어.",
                        },
                    ]
                }
            ]
        }, {}

    await Consolidator(mates).once(extract)
    memory = store.memories(mid)[0]
    assert "지호" in memory["text"]
    evidence = store.knowledge.memory_details(mid, memory["id"])["evidence"]
    assert len(evidence) == 2 and all("\n" in e["quote"] for e in evidence)


async def test_active_mate_waits_but_other_mate_can_consolidate(db):
    store, mates, mid, sid = setup(db)
    for i in range(105):
        mates._svc._add_message(sid, "user", f"아침은 오트밀을 먹어. {i}")
    other = store.create(name="다른 메이트")
    other_sid = mates.conversation(other["id"])["session_id"]
    mates._svc._add_message(other_sid, "user", "저녁에는 차를 마셔.")
    mates._svc._tasks[sid] = object()

    async def extract(mate, source):
        assert mate["id"] == other["id"]
        return {"facts": [{"quote": "저녁에는 차를 마셔.", "kind": "preference"}]}, {}

    assert await Consolidator(mates).once(extract)
    assert store.memories(mid) == []
    assert len(store.memories(other["id"])) == 1
    mates._svc._tasks.clear()


async def test_assistant_invention_and_cross_mate_sources_cannot_become_user_facts(db):
    store, mates, mid, sid = setup(db)
    mates._svc._add_message(sid, "assistant", "당신은 의사입니다.")
    a = mates._svc._add_message(sid, "user", "오늘은 맑네.")
    other = store.create(name="별도 메이트")
    osid = mates.conversation(other["id"])["session_id"]
    foreign = mates._svc._add_message(osid, "user", "의사로 일해.")

    async def bad(mate, source):
        return {
            "facts": [
                {
                    "evidence": [
                        {"source_id": "msg:" + foreign, "quote": "의사로 일해."},
                        {"source_id": "msg:" + a, "quote": "오늘은 맑네."},
                    ]
                }
            ]
        }, {}

    await Consolidator(mates).once(bad)
    assert not store.memories(mid)
    assert store.knowledge.stats(mid)["jobs"] == {"pending": 1}


async def test_self_save_off_mid_batch_cannot_commit_and_retry_respects_forget(db):
    store, mates, mid, sid = setup(db)
    a = mates._svc._add_message(sid, "user", "주말에는 수영을 해.")
    worker = Consolidator(mates)

    async def extract(mate, source):
        store.update(mid, {"prefs": {"memory": {"self_save": False}}})
        return {"facts": [{"quote": "주말에는 수영을 해."}]}, {}

    await worker.once(extract)
    assert not store.memories(mid)
    with pytest.raises(ValueError):
        worker.retry_failed(mid)
    store.update(mid, {"prefs": {"memory": {"self_save": True}}})
    db.execute("UPDATE memory_jobs SET state='failed',attempts=3")
    assert worker.retry_failed(mid) == 1
    assert db.query_one("SELECT attempts FROM memory_jobs")["attempts"] == 0
    store.knowledge.exclude_source(mid, "msg:" + a)
    db.execute("UPDATE memory_jobs SET state='failed'")
    assert worker.retry_failed(mid) == 0


async def test_legacy_empty_extractions_revisit_once_without_reviving_forgotten(db, monkeypatch):
    store, mates, mid, sid = setup(db)
    a = mates._svc._add_message(sid, "user", "동료 진우를 만났어.")
    b = mates._svc._add_message(sid, "user", "전 직장은 디자인 회사야.")
    db.execute("UPDATE memory_jobs SET state='done'")
    store.knowledge.exclude_source(mid, "msg:" + b)
    monkeypatch.setenv("MEMORY_CONSOLIDATION_ENABLED", "false")
    worker = Consolidator(mates)
    worker.start()
    jobs = {r["source_id"]: r["state"] for r in db.query("SELECT * FROM memory_jobs")}
    assert jobs["msg:" + a] == "pending" and jobs["msg:" + b] == "excluded"
    db.execute("UPDATE memory_jobs SET state='done' WHERE source_id=?", ("msg:" + a,))
    worker.start()
    assert (
        db.query_one("SELECT state FROM memory_jobs WHERE source_id=?", ("msg:" + a,))["state"]
        == "done"
    )
    await worker.stop()


def test_episodes_browse_paging_scope_and_forget(db):
    store, mates, mid, sid = setup(db)
    ids = []
    for i in range(3):
        text = f"화실 모임 E{i}에 갔어."
        a = mates._svc._add_message(sid, "user", text)
        ids.append("msg:" + a)
        store.knowledge.episode(mid, {"source_id": ids[-1], "quote": text, "title": f"모임 E{i}"})
    first = store.knowledge.episodes(mid, limit=2)
    second = store.knowledge.episodes(mid, limit=2, before=first["next_cursor"])
    assert len(first["items"]) == 2 and len(second["items"]) == 1
    assert not ({x["id"] for x in first["items"]} & {x["id"] for x in second["items"]})
    assert len(store.knowledge.episodes(mid, q="E0")["items"]) == 1
    assert not store.knowledge.episodes(mid, q="없는 사건")["items"]
    store.knowledge.exclude_source(mid, ids[1])
    assert len(store.knowledge.episodes(mid)["items"]) == 2
    other = store.create(name="분리된 메이트")
    assert not store.knowledge.episodes(other["id"])["items"]
