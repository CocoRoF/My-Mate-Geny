"""Personal memory contracts against synthetic history; never production data."""

import json
from datetime import UTC, datetime

import pytest

from app.mate.consolidation import Consolidator
from app.mate.knowledge import record_message
from app.mate.store import MateError
from app.providers.base import ProviderEvent
from tests.test_mate_memory_v2 import _svc, _turn


def setup(db):
    store, mates = _svc(db)
    mate = store.create(name="기억 검증")
    sid = mates.conversation(mate["id"])["session_id"]
    return store, mates, mate["id"], sid


def test_transaction_nested_rollback_and_no_partial_memory(db):
    with db.transaction():
        db.execute("INSERT INTO memory_checkpoints VALUES('outer','yes')")
        with pytest.raises(ValueError), db.transaction():
            db.execute("INSERT INTO memory_checkpoints VALUES('inner','no')")
            raise ValueError()
        assert not db.query_one("SELECT 1 FROM memory_checkpoints WHERE key='inner'")
    assert db.query_one("SELECT 1 FROM memory_checkpoints WHERE key='outer'")
    with pytest.raises(ValueError), db.transaction():
        db.execute("DELETE FROM memory_checkpoints WHERE key='outer'")
        raise ValueError()
    assert db.query_one("SELECT 1 FROM memory_checkpoints WHERE key='outer'")


def test_distinct_negation_dates_short_correction_versions_cas(db):
    store, _, mid, _ = setup(db)
    a = store.add_memory(mid, "회의 2026-11-12 제품 개선 일정", kind="plan", due_at="2026-11-12")
    b = store.add_memory(mid, "회의 2026-11-19 제품 개선 일정", kind="plan", due_at="2026-11-19")
    assert a["id"] != b["id"] and not b["merged"]
    c = store.add_memory(mid, "The release has not been approved")
    d = store.add_memory(mid, "The release has been approved")
    assert c["id"] != d["id"]
    new = store.update_memory(
        mid, c["id"], {"text": "Release approved", "expected_revision": 1}, by_user=True
    )
    assert new["revision"] == 2
    assert [v["snapshot"]["text"] for v in store.knowledge.history(mid, c["id"])] == [
        "Release approved",
        "The release has not been approved",
    ]
    with pytest.raises(MateError) as exc:
        store.update_memory(mid, c["id"], {"text": "stale editor", "expected_revision": 1})
    assert exc.value.status == 409


def test_overdue_not_done_archive_never_quota_delete(db, monkeypatch):
    from app.mate import memory as M

    store, _, mid, _ = setup(db)
    p = store.add_memory(mid, "과거 미확인 예약", kind="plan", due_at="2020-01-01")
    store.housekeep(mid, datetime.now(UTC), datetime.now())
    assert store.memory(mid, p["id"])["status"] == "active"
    store.update_memory(mid, p["id"], {"status": "archived"})
    monkeypatch.setattr(M, "MAX_ROWS", 1)
    store.add_memory(mid, "새로운 기억")
    assert store.memory(mid, p["id"]) is not None


def test_fts_korean_scope_raw_details_and_revision(db):
    store, mates, mid, sid = setup(db)
    aid = mates._svc._add_message(
        sid, "user", "스튜디오 촬영 S42 뒤에 합정 토리하나에 갔어. 링크는 https://example.test/map"
    )
    hit = store.knowledge.search(mid, "촬영", scope="mate")["items"][0]
    assert hit["source_id"] == "msg:" + aid and hit["evidence_type"] == "asserted"
    assert store.knowledge.evidence(mid, hit["source_id"], hit["revision"])["messages"][0][
        "text"
    ].startswith("스튜디오")
    other = store.create(name="다른 메이트")
    assert not store.knowledge.search(other["id"], "토리하나", scope="all")["items"]
    with pytest.raises(ValueError):
        store.knowledge.evidence(other["id"], hit["source_id"])
    db.execute(
        "UPDATE messages SET content=? WHERE id=?", ("S42 식당은 고쳐서 토리야로 기억해", aid)
    )
    record_message(db, aid)
    with pytest.raises(ValueError):
        store.knowledge.evidence(mid, hit["source_id"], 1)
    assert not store.knowledge.search(mid, "토리하나")["items"]


def test_picture_case_paraphrases_two_hops_and_distractor(db):
    store, mates, mid, sid = setup(db)
    texts = [
        "2026-10-08 스튜디오 촬영 S42를 합정에서 했어.",
        "S42 끝나고 저녁 식사 D17을 민수와 했어.",
        "D17 가게는 토리하나, 숯불 닭꼬치 전문점. 지도 https://example.test/tori",
        "2026-10-20 다른 촬영 S99는 강남이고 그날 가게는 별식당이야.",
    ]
    episodes = []
    for text, entities in zip(
        texts, [["S42", "합정"], ["S42", "D17", "민수"], ["D17", "토리하나"], ["S99", "강남"]]
    ):
        aid = mates._svc._add_message(sid, "user", text)
        episodes.append(
            store.knowledge.episode(
                mid,
                {
                    "source_id": "msg:" + aid,
                    "title": text[:25],
                    "quote": text,
                    "entities": entities,
                },
            )
        )
    # General language-model query planning supplies alternative concepts, not
    # fabricated evidence. Graph traversal then links the separate raw records.
    hits = store.knowledge.search(
        mid, "그때 사진 찍고 먹었던 야키토리집", aliases=["스튜디오 촬영", "숯불 닭꼬치"]
    )["items"]
    assert any("토리하나" in h["excerpt"] for h in hits)
    meal = store.knowledge.get_episode(mid, episodes[2]["id"])
    assert any(
        e["origin"] == episodes[1]["id"] or e["target"] == episodes[1]["id"]
        for e in meal["related"]
    )
    assert all(h["source_id"] != "fabricated" for h in hits)
    # No matching evidence means no invented answer.
    assert store.knowledge.search(mid, "북극곰우주선")["items"] == []


def test_grounded_evidence_rejects_fabrication_and_forget_prevents_backfill(db):
    store, mates, mid, sid = setup(db)
    text = "합정 토리하나에서 저녁 식사했어"
    aid = mates._svc._add_message(sid, "user", text)
    mem = store.add_memory(mid, text)
    source_id = "msg:" + aid
    with pytest.raises(ValueError):
        store.knowledge.attach(mid, mem["id"], source_id, "서울역 식당")
    store.knowledge.attach(mid, mem["id"], source_id, text)
    store.delete_memory(mid, mem["id"], by_user=True)
    assert store.knowledge.history(mid, mem["id"]) == []
    assert store.knowledge.search(mid, "토리하나")["items"] == []
    store.knowledge.backfill()
    assert store.knowledge.search(mid, "토리하나")["items"] == []
    assert (
        db.query_one("SELECT state FROM memory_jobs WHERE source_id=?", (source_id,))["state"]
        == "excluded"
    )
    with pytest.raises(MateError):
        store.add_memory(mid, text)
    # Explicit user input may deliberately re-add an assertion, not its excluded source.
    assert store.add_memory(mid, text, by_user=True)["id"]


def test_pending_speech_internal_screens_and_keys_not_indexed(db):
    store, mates, mid, sid = setup(db)
    for content, meta in [
        ("비밀 화면 식당", {"internal": True, "kind": "screen_observation"}),
        ("취소 조각 식당", {"speech_cancelled": True}),
        ("미완성 식당", {"speech_group": "g", "speech_pending": True}),
        ("api_key=" + "x" * 30, None),
    ]:
        mates._svc._add_message(sid, "user", content, meta=meta)
    assert not store.knowledge.search(mid, "식당")["items"]
    aid = mates._svc._add_message(
        sid, "user", "완성 식당 토리하나", meta={"speech_group": "g", "speech_pending": False}
    )
    assert len(store.knowledge.search(mid, "식당")["items"]) == 1
    assert (
        db.query_one("SELECT revision FROM memory_sources WHERE message_id=?", (aid,))["revision"]
        == 2
    )
    with pytest.raises(MateError):
        store.add_memory(mid, "api_key=" + "x" * 30)


def test_context_is_acked_after_delivery_and_compaction_resets(db):
    store, mates, mid, sid = setup(db)
    for i in range(30):
        store.add_memory(mid, f"계획 고유메모 {i} 항목 {i * 31}")
    victim = store.memories(mid)[5]
    store.update_memory(mid, victim["id"], {"text": "계획 수정된 사실"}, by_user=True)
    req, _ = _turn(mates, mid, "계획")
    assert store.take_memory_changes(mid)
    assert not db.query_one("SELECT 1 FROM memory_context WHERE mate_id=?", (mid,))
    req.on_context_delivered()
    assert not store.take_memory_changes(mid)
    assert store.memory(mid, victim["id"])["use_count"] == 1
    mates._svc._add_event(sid, ProviderEvent(type="notice", data={"code": "context.compacted"}))
    req2, _ = _turn(mates, mid, "계획", cli="cli")
    assert "수정된 사실" in req2.preamble


async def test_extractor_retry_idempotence_quote_guard_and_self_save(db):
    store, mates, mid, sid = setup(db)
    aid = mates._svc._add_message(sid, "user", "매운 음식을 좋아해. 촬영 S42가 끝났어.")
    worker = Consolidator(mates)

    async def extract(mate, source):
        return {
            "facts": [{"quote": "매운 음식을 좋아해.", "kind": "preference"}],
            "episodes": [{"title": "촬영 S42", "quote": "촬영 S42가 끝났어.", "entities": ["S42"]}],
        }, {}

    assert await worker.once(extract)
    assert not await worker.once(extract)
    assert len(store.memories(mid)) == 1
    mem = store.memories(mid)[0]
    assert (
        store.knowledge.memory_details(mid, mem["id"])["evidence"][0]["source_id"] == "msg:" + aid
    )
    assert store.knowledge.stats(mid)["jobs"] == {"done": 1}
    # A malicious/incorrect extractor cannot save an unsupported fact.
    bid = mates._svc._add_message(sid, "user", "고양이 이름은 나비야")

    async def bad(mate, source):
        return {"facts": [{"quote": "개 이름은 멍멍"}]}, {}

    await worker.once(bad)
    assert len(store.memories(mid)) == 1
    assert (
        db.query_one("SELECT state FROM memory_jobs WHERE source_id=?", ("msg:" + bid,))["state"]
        == "pending"
    )
    store.update(mid, {"prefs": {"memory": {"self_save": False}}})
    cid = mates._svc._add_message(sid, "user", "강아지 이름은 보리야")
    assert not db.query_one("SELECT 1 FROM memory_jobs WHERE source_id=?", ("msg:" + cid,))
    assert store.knowledge.search(mid, "보리")["items"]  # raw history still searchable


async def test_forget_during_extraction_wins_over_inflight_model(db):
    store, mates, mid, sid = setup(db)
    aid = mates._svc._add_message(sid, "user", "가게 이름은 토리하나")

    async def extract(mate, source):
        store.knowledge.exclude_source(mid, "msg:" + aid)
        return {"facts": [{"quote": "가게 이름은 토리하나"}]}, {}

    await Consolidator(mates).once(extract)
    assert store.memories(mid) == []
    assert store.knowledge.stats(mid)["jobs"] == {"excluded": 1}


def test_durable_requests_distinct_workers_restart_no_reexecution(db, tmp_path):
    store, mates, mid, sid = setup(db)
    worker = mates._svc.create(provider="claude", workspace_path=str(tmp_path), title="project")[
        "id"
    ]
    a = mates.tasks.create(worker, store.get(mid), sid, "page", "publish page", 0)
    b = mates.tasks.create(worker, store.get(mid), sid, "issue", "create issue", 0)
    assert a != b
    entries = mates.tasks.complete(worker, {"status": "ok", "text": "reported success"})
    assert len(entries) == 2
    assert mates.tasks.get(mid, a)["verification"] == "unverified"
    recovered = mates.tasks.recover()
    assert len(recovered) == 2
    mates._svc._add_message(
        sid,
        "user",
        "result",
        meta={"internal": True, "delegation_requests": [a], "delegation_receipts": [a + ":1"]},
    )
    assert [r[1]["request_id"] for r in mates.tasks.recover()] == [b]
    c = mates.tasks.create(worker, store.get(mid), sid, "third", "external write", 0)
    rec = mates.tasks.recover()
    assert next(e for _, e in rec if e["request_id"] == c)["verification"] == "unknown"
    with pytest.raises(ValueError):
        mates.tasks.get(store.create(name="other")["id"], a)


def test_dirty_outbox_repair_never_returns_stale_or_sensitive_original(db):
    store, mates, mid, sid = setup(db)
    aid = mates._svc._add_message(sid, "user", "토리하나에서 촬영")
    source = "msg:" + aid
    db.execute("UPDATE messages SET content=? WHERE id=?", ("토리하나 api_key=" + "x" * 32, aid))
    assert db.query_one("SELECT 1 FROM memory_dirty WHERE message_id=?", (aid,))
    assert not store.knowledge.search(mid, "토리하나")["items"]
    with pytest.raises(ValueError):
        store.knowledge.evidence(mid, source)
    store.knowledge.backfill()
    assert not db.query_one("SELECT 1 FROM memory_dirty WHERE message_id=?", (aid,))
    assert (
        db.query_one("SELECT eligible FROM memory_sources WHERE id=?", (source,))["eligible"] == 0
    )


def test_search_without_fts_and_pagination_time_filters(db):
    store, mates, mid, sid = setup(db)
    for i in range(12):
        mates._svc._add_message(sid, "user", f"촬영 이후 식사 정보 {i}")
    store.knowledge.fts = False
    one = store.knowledge.search(mid, "촬영", limit=5)
    two = store.knowledge.search(mid, "촬영", limit=5, offset=one["next_offset"])
    assert len(one["items"]) == len(two["items"]) == 5
    assert not {h["source_id"] for h in one["items"]} & {h["source_id"] for h in two["items"]}
    assert not store.knowledge.search(mid, "촬영", since="2099-01-01")["items"]
    with pytest.raises(ValueError):
        store.knowledge.search(mid, "촬영", since="not-a-date")


def test_deleting_chat_purges_copies_and_fts_entries(db, tmp_path):
    store, mates, mid, _sid = setup(db)
    worker = mates._svc.create(provider="claude", workspace_path=str(tmp_path), title="work")["id"]
    aid = mates._svc._add_message(worker, "user", "기억할 사용자 선호 abc")
    mem = store.add_memory(mid, "기억할 사용자 선호 abc")
    store.knowledge.attach(mid, mem["id"], "msg:" + aid, "기억할 사용자 선호 abc")
    mates._svc.delete(worker)
    assert not store.memory(mid, mem["id"])
    assert not db.query_one("SELECT 1 FROM memory_sources WHERE message_id=?", (aid,))
    assert not db.query_one("SELECT 1 FROM memory_fts WHERE source_id=?", ("msg:" + aid,))


def test_background_receipt_does_not_suppress_final_or_interrupted_receipt(db, tmp_path):
    store, mates, mid, sid = setup(db)
    worker = mates._svc.create(provider="claude", workspace_path=str(tmp_path), title="work")["id"]
    rid = mates.tasks.create(worker, store.get(mid), sid, "work", "publish", 0)
    first = mates.tasks.complete(worker, {"status": "ok", "text": "still working"}, background=1)[
        0
    ][1]
    mates.tasks.mark_delivered([rid])
    mates._svc._add_message(
        sid, "user", "background", meta={"internal": True, "delegation_receipts": [rid + ":1"]}
    )
    assert first["receipt_revision"] == 1
    recovered = mates.tasks.recover()
    assert recovered[0][1]["request_id"] == rid and recovered[0][1]["receipt_revision"] == 2
    assert recovered[0][1]["verification"] == "unknown"


def test_real_execution_receipt_is_scoped_and_readable(db, tmp_path):
    store, mates, mid, sid = setup(db)
    worker = mates._svc.create(provider="claude", workspace_path=str(tmp_path), title="work")["id"]
    rid = mates.tasks.create(worker, store.get(mid), sid, "work", "read page", 0)
    ev = ProviderEvent(type="tool.result", data={"output": "page id=123 exists", "is_error": False})
    mates._svc._add_event(worker, ev)
    assert mates.tasks.read_receipt(mid, rid, ev.eid)["text"] == "page id=123 exists"
    with pytest.raises(ValueError):
        mates.tasks.read_receipt(mid, rid, 999999)


async def test_failed_extraction_still_records_numeric_usage_as_internal(db):
    from app.services.usage_week import week

    store, mates, mid, sid = setup(db)
    mates._svc._add_message(sid, "user", "별도의 개인 경험")

    async def invalid(mate, source):
        return None, {
            "cost_usd": 0.03,
            "cost_kind": "turn",
            "provider": "claude",
            "usage": {"input_tokens": 100, "output_tokens": 20},
            "text": "PRIVATE SHOULD NOT BE LOGGED",
        }

    await Consolidator(mates).once(invalid)
    assert store.knowledge.stats(mid)["cost"] == 0.03
    ev = db.query_one(
        "SELECT data FROM events WHERE session_id=? AND type='turn.complete' ORDER BY id DESC",
        (sid,),
    )
    assert "PRIVATE" not in ev["data"] and json.loads(ev["data"])["usage_source"] == "internal"
    internal = next(g for g in week(db)["sources"] if g["source"] == "internal")
    assert internal["cost_usd"] == 0.03 and internal["tokens"] == 120


def test_old_citation_is_not_presented_as_support_for_a_corrected_fact(db):
    store, mates, mid, sid = setup(db)
    aid = mates._svc._add_message(sid, "user", "이전에는 커피를 좋아했어")
    mem = store.add_memory(mid, "이전에는 커피를 좋아했어")
    store.knowledge.attach(mid, mem["id"], "msg:" + aid, "이전에는 커피를 좋아했어")
    store.update_memory(mid, mem["id"], {"text": "이제 커피를 마시지 않아"}, by_user=True)
    detail = store.knowledge.memory_details(mid, mem["id"])
    assert detail["evidence"] == []
    assert detail["versions"][1]["evidence"][0]["quote"] == "이전에는 커피를 좋아했어"
    assert detail["versions"][0]["evidence"] == []


def test_forget_in_flight_forces_new_provider_context_even_if_old_turn_writes_cli_id(db):
    store, mates, mid, sid = setup(db)
    mem = store.add_memory(mid, "잊어야 할 기존 사실", by_user=True)
    req, _ = _turn(mates, mid, "first", cli="old-cli")
    store.delete_memory(mid, mem["id"], by_user=True)
    mates._svc._set_cli_session(sid, "old-cli")  # a late completion of the old turn
    req.on_context_delivered()  # must not ACK the obsolete generation
    req2, prompt = _turn(mates, mid, "new question", cli="old-cli")
    assert req2.cli_session_id is None and "잊어야 할" not in prompt
    assert "잊어야 할" not in req2.preamble
    req2.on_context_delivered()
    assert (
        db.query_one("SELECT privacy_reset FROM memory_context WHERE mate_id=?", (mid,))[
            "privacy_reset"
        ]
        == 0
    )


def test_extractor_flags_disable_cli_session_copies_and_tool_catalog_fallback(tmp_path):
    from app.providers._codex_sealed import prepare
    from app.providers.base import TurnRequest
    from app.providers.claude_code import ClaudeCodeProvider
    from app.providers.codex import CodexProvider

    req = TurnRequest(
        messages=[],
        model="",
        cwd=str(tmp_path),
        tools=[],
        sealed=True,
        ephemeral=True,
        require_sealed_catalog=True,
        engine_home=str(tmp_path / "sealed"),
    )
    assert "--no-session-persistence" in ClaudeCodeProvider()._build_argv(req)
    assert "--ephemeral" in CodexProvider()._build_argv(req)
    with pytest.raises(ValueError, match="tool-free"):
        prepare(req, str(tmp_path / "no-source-catalog"))


def test_memory_evidence_api_and_cas_restore_and_forget():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        assert (
            client.post(
                "/api/auth/login", json={"username": "admin", "password": "test-pass"}
            ).status_code
            == 200
        )
        mate = app.state.mate_service.store.create(name="API source test")
        mid = mate["id"]
        sid = app.state.mate_service.conversation(mid)["session_id"]
        msg = app.state.session_service._add_message(sid, "user", "식당 이름은 토리하나야")
        mem = client.post(
            f"/api/mates/{mid}/memories", json={"text": "식당 이름은 토리하나야"}
        ).json()
        app.state.mate_service.store.knowledge.attach(
            mid, mem["id"], "msg:" + msg, "식당 이름은 토리하나야"
        )
        assert client.get(f"/api/mates/{mid}/knowledge/search?q=토리하나").json()["items"]
        assert (
            client.get(f"/api/mates/{mid}/knowledge/evidence/msg:{msg}?revision=1").status_code
            == 200
        )
        patched = client.patch(
            f"/api/mates/{mid}/memories/{mem['id']}",
            json={"text": "현재는 다른 식당", "expected_revision": 1},
        )
        assert patched.status_code == 200
        hist = client.get(f"/api/mates/{mid}/memories/{mem['id']}/history").json()
        assert len(hist["versions"]) == 2 and hist["evidence"] == []
        restored = client.post(
            f"/api/mates/{mid}/memories/{mem['id']}/restore-version",
            json={"revision": 1, "expected_revision": 2},
        )
        assert restored.status_code == 200 and restored.json()["revision"] == 3
        stale = client.post(
            f"/api/mates/{mid}/memories/{mem['id']}/restore-version",
            json={"revision": 1, "expected_revision": 2},
        )
        assert stale.status_code == 409
        assert client.get(f"/api/mates/{mid}/knowledge/status").status_code == 200
        assert client.delete(f"/api/mates/{mid}/knowledge/evidence/msg:{msg}").status_code == 200
        assert client.get(f"/api/mates/{mid}/knowledge/search?q=토리하나").json()["items"] == []


def test_long_evidence_can_be_read_at_search_hit_and_paged_without_losing_target(db):
    store, mates, mid, sid = setup(db)
    mates._svc._add_message(sid, "user", "앞 문맥 " * 5000)
    text = "오래된 기록 " * 1500 + "가게 이름은 토리하나야" + " 뒤의 내용 " * 1500
    msg = mates._svc._add_message(sid, "user", text)
    mates._svc._add_message(sid, "user", "이후 문맥 " * 5000)
    hit = next(
        h
        for h in store.knowledge.search(mid, "토리하나")["items"]
        if h["source_id"] == "msg:" + msg
    )
    evidence = store.knowledge.evidence(
        mid, hit["source_id"], offset=hit["offset"], before=3, after=3
    )
    target = next(m for m in evidence["messages"] if m["source_id"] == hit["source_id"])
    assert "토리하나" in target["text"]
    assert sum(len(m["text"]) for m in evidence["messages"]) <= 12000
    assert evidence["next_offset"] is not None
    next_page = store.knowledge.evidence(mid, hit["source_id"], offset=evidence["next_offset"])
    assert next_page["messages"][1]["offset"] > target["offset"]


def test_new_bridge_is_compatible_with_backend_before_idle_restart(monkeypatch):
    from app.mate.mcp_bridge import tools
    monkeypatch.delenv('HRH_MATE_MEMORY', raising=False)
    assert 'search_history' not in {t['name'] for t in tools()}
    monkeypatch.setenv('HRH_MATE_MEMORY','1')
    assert 'search_history' in {t['name'] for t in tools()}


def test_metadata_only_revision_preserves_citation_but_text_edit_does_not(db):
    store, mates, mid, sid = setup(db)
    msg = mates._svc._add_message(sid,'user','지금은 차를 좋아해')
    mem = store.add_memory(mid,'지금은 차를 좋아해')
    store.knowledge.attach(mid,mem['id'],'msg:'+msg,'지금은 차를 좋아해')
    store.update_memory(mid,mem['id'],{'importance':5})
    assert store.knowledge.memory_details(mid,mem['id'])['evidence']
    store.update_memory(mid,mem['id'],{'text':'차를 좋아하지 않아'},by_user=True)
    assert store.knowledge.memory_details(mid,mem['id'])['evidence'] == []


def test_partial_index_failure_keeps_dirty_outbox_and_retries_atomically(db, monkeypatch):
    import app.mate.knowledge as K
    store, mates, mid, sid = setup(db)
    original = K.terms
    monkeypatch.setattr(K,'terms',lambda _: (_ for _ in ()).throw(RuntimeError('simulated index interruption')))
    msg = mates._svc._add_message(sid,'user','식당은 토리하나')
    assert db.query_one('SELECT 1 FROM messages WHERE id=?',(msg,))
    assert not db.query_one('SELECT 1 FROM memory_sources WHERE message_id=?',(msg,))
    assert db.query_one('SELECT 1 FROM memory_dirty WHERE message_id=?',(msg,))
    monkeypatch.setattr(K,'terms',original)
    store.knowledge.backfill()
    assert store.knowledge.search(mid,'토리하나')['items']
    assert db.query_one('SELECT 1 FROM memory_jobs WHERE source_id=?',('msg:'+msg,))


async def test_background_core_change_reloads_launch_prompt_and_unknown_sources_are_labeled(db):
    from app.mate import memory as M
    store, mates, mid, sid = setup(db)
    old = store.add_memory(mid,'검증되지 않은 과거 메모')
    assert 'source=reported; verify original' in M.line(old)
    before, _ = _turn(mates,mid,'hi')
    mates._svc._add_message(sid,'user','내 고양이 이름은 나비야')
    async def extract(mate, source):
        return {'facts':[{'quote':'내 고양이 이름은 나비야','kind':'profile'}]}, {}
    await Consolidator(mates).once(extract)
    after, prompt = _turn(mates,mid,'hi',cli='old-cached-launch')
    assert after.prompt_key != before.prompt_key and '내 고양이 이름은 나비야' in prompt


def test_legacy_history_indexing_progress_is_not_misreported_as_no_record(db):
    store, _mates, mid, sid = setup(db)
    db.execute("INSERT INTO messages(id,session_id,role,content,created_at) VALUES('legacy-hidden',?,'user','옛 식당은 토리하나','2025-10-01T00:00:00+00:00')",(sid,))
    result = store.knowledge.search(mid,'토리하나')
    assert result['items'] == [] and result['indexing_pending'] == 1
    assert store.knowledge.stats(mid)['unindexed'] == 1
    store.knowledge.backfill()
    assert store.knowledge.search(mid,'토리하나')['items']
    assert store.knowledge.stats(mid)['unindexed'] == 0


def test_malformed_old_metadata_does_not_poison_following_history(db):
    store, mates, mid, sid = setup(db)
    db.execute("INSERT INTO messages(id,session_id,role,content,meta,created_at) VALUES('old-bad-meta',?,'user','안전하지 않은 원문','{broken','2024-01-01')",(sid,))
    mates._svc._add_message(sid,'user','올바른 식당 토리하나')
    store.knowledge.backfill()
    assert store.knowledge.search(mid,'토리하나')['items']
    assert not store.knowledge.allowed(mid,'msg:old-bad-meta')
