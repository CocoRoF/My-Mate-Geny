"""The Geny-State-System wired into a mate's turns (app/mate/gss/runtime.py): a reading taken before she answers, promises
read from a message, a hurt that stung remembered (and never counted as a new memory for the relationship), the State
Inspector and the simulator over HTTP."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.main import app
from app.mate import affinity as A
from test_mate_affinity import _engine, _svc


def _said(db, sid, text, mid):
    db.execute("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, datetime('now'))",
               (mid, sid, text))


def test_a_reading_before_her_turn_is_what_she_feels_by(db):
    svc, store, mates = _svc(db)
    m = store.create(name="Rin", persona={"language": "ko"})
    sid = mates.conversation(m["id"])["session_id"]
    _said(db, sid, "와 진짜 대단하시네요 ㅎㅎ", "msg_sarcasm")
    mates.gss.appraiser.put("msg_sarcasm", {"aimed": True, "acts": ["insult"], "intensity": 0.7, "owns": False, "sarcastic": True,
                                            "promise": None, "her_promise": None, "fulfills": [], "note": "", "by": "model"})
    req, _ = _engine(mates, m["id"], "와 진짜 대단하시네요 ㅎㅎ")
    assert "angry" in req.preamble  # (no rude word in it: the reading is what made her angry)
    assert store.state_doc(m["id"])["heard_by"] == "model"
    told = mates.gss.journal.recent(m["id"], layers=["told"])
    assert told and "<context>" in told[0]["data"]["block"]


def test_a_promise_read_from_a_message_is_kept_and_told_when_due(db):
    svc, store, mates = _svc(db)
    m = store.create(name="Rin", persona={"language": "ko"})
    mates.gss._on_read(m["id"], "msg_p", {"aimed": False, "acts": ["promise"], "intensity": 0.3, "owns": False, "sarcastic": False,
                                          "promise": {"what": "이따 파일 보내줄게", "due_in_hours": 1, "kind": "task"},
                                          "her_promise": None, "fulfills": [], "note": "", "by": "model"})
    doc = store.state_doc(m["id"])
    assert [p["what"] for p in doc["promises"]] == ["이따 파일 보내줄게"]
    assert any(e["layer"] == "promise" and e["kind"] == "made" for e in mates.gss.journal.recent(m["id"]))


def test_a_hurt_that_stung_is_remembered_and_isnt_a_new_memory_for_the_relationship(db):
    svc, store, mates = _svc(db)
    m = store.create(name="Rin", persona={"language": "ko"}, prefs={"user_name": "장하렴"})
    sid = mates.conversation(m["id"])["session_id"]
    mates._relation_turn(m["id"], {"input": "안녕", "text": "", "meta": None})
    for i, text in enumerate(["(Rin을 때린다)", "(Rin을 또 때린다)"]):
        _said(db, sid, text, f"msg_hit{i}")
        _engine(mates, m["id"], text)
        mates._on_turn_end(sid, {"trigger": "turn", "meta": None, "input": text, "text": "[angry:0.9] 하지 마.", "status": "ok"})
    mems = [x for x in store.memories(m["id"]) if x.get("source") == "gss"]
    assert len(mems) == 1 and mems[0]["text"].startswith("[우리 사이]") and "장하렴이 나를 때렸다" in mems[0]["text"]
    rel = store.relation_doc(m["id"])
    assert rel["memories"] == 0 and not any(e["why"] == "memory" for e in rel["log"])
    assert rel["trust"] < A.BONDS["trust"]
    assert any(e["layer"] == "said" for e in mates.gss.journal.recent(m["id"]))


def test_the_inspector_and_the_simulator_over_http():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        m = c.post("/api/mates", json={"name": "Gss"}).json()
        got = c.get(f"/api/mates/{m['id']}/gss").json()
        assert set(got) >= {"mate", "state", "temperament", "bonds", "promises", "repeats", "journal"}
        assert set(got["bonds"]) >= {"trust", "romance", "respect", "affinity", "words"}
        sim = c.post(f"/api/mates/{m['id']}/gss/simulate", json={"preset": "threat_sorry_love"}).json()
        assert sim["points"][0]["grudge"] > 0 and "threat_sorry_love" in sim["presets"]
        mine = c.post(f"/api/mates/{m['id']}/gss/simulate",
                      json={"steps": [{"after_min": 0, "say": "멍청아"}], "then_hours": [1], "temperament": {"holds": 2.0}}).json()
        assert len(mine["points"]) == 2
        bad = c.patch(f"/api/mates/{m['id']}", json={"prefs": {"temperament": "angry"}})
        assert bad.status_code == 400
        ok = c.patch(f"/api/mates/{m['id']}", json={"prefs": {"temperament": {"forgives": 1.3, "conflict": "withdraw"}}}).json()
        assert ok["prefs"]["temperament"] == {"forgives": 1.3, "conflict": "withdraw"}
        assert c.get(f"/api/mates/{m['id']}/gss").json()["temperament"]["conflict"] == "withdraw"
        c.delete(f"/api/mates/{m['id']}")
