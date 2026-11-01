"""The relationship engine (app/mate/affinity.py, docs/mate-memory-affinity.md §5) under simulated time — grace
days then accelerating decay with a cap and a floor, daily caps, lively days, streaks, warmth and rudeness
(sadness never costs), pause, sensitivity, hysteresis, earned × warmth, mood — and the same engine for real time
and for a recompute from history; then the service (seed from history, turn and memory hooks, the prompt guide
and the per-turn lines without a restart) and the routes."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import affinity as A
from app.mate.prompt import base_prompt, prompt_key
from app.mate.service import MateService
from app.mate.store import MateStore
from app.providers.base import TurnRequest
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

TZ = ZoneInfo("Asia/Seoul")
T0 = datetime(2026, 9, 1, 12, 0, tzinfo=TZ)  # a Tuesday noon


def day(n: int, hour: int = 12, minute: int = 0) -> datetime:
    return (T0 + timedelta(days=n)).replace(hour=hour, minute=minute)


def talk(r, at, text="hello", reply=""):
    A.advance(r, at, TZ)
    A.credit_turn(r, at, TZ, text, reply)


def whys(r):
    return [e["why"] for e in r["log"]]


def test_grace_days_then_accelerating_decay_with_cap_and_floor():
    assert [A.decay_for(n) for n in range(1, 10)] == [0, 0, 0, 4.0, 5.6, 7.84, 10.98, 15.0, 15.0]
    r = A.new()
    talk(r, day(0))
    A.set_value(r, 80, day(0), TZ)
    A.advance(r, day(9), TZ)  # days 1–3 free, 4..8 cost
    losses = [(e["why"], e["d"]) for e in r["log"] if e["why"].startswith("quiet")]
    assert losses == [("quiet_4", -4.0), ("quiet_5", -5.6), ("quiet_6", -7.84), ("quiet_7", -10.98), ("quiet_8", -15.0)]
    assert r["affinity"] == pytest.approx(80 - 43.42)
    A.advance(r, day(40), TZ)
    assert r["affinity"] == A.FLOOR  # never below the floor
    again = A.clone(r)
    A.advance(again, day(40, 18), TZ)
    assert again == r  # (the same day: nothing more)


def test_a_talk_late_in_the_day_is_never_lost_to_settling():
    """memora plan/61: a timer settled the day before its talk was counted — only ever losses."""
    r = A.new()
    talk(r, day(0, 23, 59))
    A.advance(r, day(1, 0, 1), TZ)
    A.advance(r, day(1, 0, 16), TZ)
    assert whys(r) == ["talk"] and r["affinity"] == 6


def test_daily_gains_lively_warm_cap_and_streaks():
    r = A.new()
    for i in range(14):
        talk(r, day(0, 9, i), "고마워!" if i < 6 else "ok")
    assert whys(r).count("talk") == 1 and whys(r).count("lively") == 1
    assert sum(e["d"] for e in r["log"] if e["why"] == "warm") == A.WARM_CAP  # four warm turns, capped
    assert r["affinity"] == 6 + 3 + 2
    s = A.new()
    for n in range(7):
        talk(s, day(n))
    assert s["streak_days"] == 7 and whys(s).count("streak") == 6 and whys(s).count("streak_week") == 1
    assert s["affinity"] == 7 * 6 + 6 * 1 + 2
    talk(s, day(9))  # a gap: the streak starts over
    assert s["streak_days"] == 1


def test_the_daily_gain_cap():
    r = A.new()
    talk(r, day(0))
    A.set_value(r, 30, day(0), TZ)
    for _ in range(5):
        A.credit_memory(r, day(0, 13), TZ)
    for i in range(14):
        talk(r, day(0, 14, i), "thanks, great!")
    gained = sum(e["d"] for e in r["log"] if e["why"] in ("talk", "lively", "warm", "memory", "streak"))
    assert gained == A.GAIN_CAP  # 6 + 3 (memories) + 2 (warm) + 3 (lively) = 14 → 12


def test_rudeness_costs_a_little_sadness_never():
    r = A.new()
    talk(r, day(0))
    A.set_value(r, 50, day(0), TZ)
    for i in range(6):
        talk(r, day(0, 13, i), "shut up, you're useless")
    assert sum(e["d"] for e in r["log"] if e["why"] == "rude") == -A.RUDE_CAP
    s = A.new()
    talk(s, day(0))
    A.set_value(s, 50, day(0), TZ)
    talk(s, day(0, 13), "오늘 너무 힘들고 우울해…")
    assert "rude" not in whys(s) and s["affinity"] == 50
    assert A.mood(s, day(0, 13, 30), TZ)["label"] == "concerned"
    assert A.mood(s, day(0, 16), TZ)["label"] != "concerned"  # (two hours later)


def test_pause_off_and_sensitivity():
    r = A.new()
    talk(r, day(0))
    A.set_value(r, 60, day(0), TZ)
    A.set_switch(r, "paused", True, day(0, 13), TZ)
    A.advance(r, day(20), TZ)
    talk(r, day(20))
    assert r["affinity"] == 60 and r["turns"] == 1  # nothing moved, nothing counted
    A.set_switch(r, "paused", False, day(20, 13), TZ)
    talk(r, day(21))
    assert r["affinity"] == 66  # (the days of the pause cost nothing afterwards either)
    off = A.new()
    off["enabled"] = False
    talk(off, day(0))
    assert off["affinity"] == 0 and off["turns"] == 0
    half = A.new()
    half["sensitivity"] = 0.5
    talk(half, day(0))
    A.set_value(half, 80, day(0), TZ)
    A.advance(half, day(5), TZ)
    assert [e["d"] for e in half["log"] if e["why"] == "talk"] == [3.0]
    assert [e["d"] for e in half["log"] if e["why"].startswith("quiet")] == [-2.0]


def test_hysteresis_and_earned_times_warmth():
    assert A.warmth_index(21, 0) == 0 and A.warmth_index(22, 0) == 1  # in only 2 past the floor
    assert A.warmth_index(18, 1) == 1 and A.warmth_index(16.9, 1) == 0  # out only 3 below it
    assert A.warmth_index(90, 0) == 3 and A.warmth_index(5, 3) == 0
    r = A.new()
    talk(r, day(0))
    A.set_value(r, 90, day(0), TZ)
    assert r["stage"] == "new"  # warm, but they've only just met (earned: new)
    for n in range(1, 4):
        for i in range(5):
            talk(r, day(n, 10, i))
    assert A.earned_stage(r) == "familiar" and r["stage"] == "familiar"
    assert any(m["key"] == "stage_familiar" for m in r["milestones"])
    A.set_value(r, 10, day(3), TZ)
    assert r["stage"] == "new"  # min(earned, warmth); the milestone stays (history)
    assert any(m["key"] == "stage_familiar" for m in r["milestones"])


def test_mood_baseline_circadian_and_results():
    r = A.new()
    talk(r, day(0, 14), "thanks!")
    assert A.mood(r, day(0, 3), TZ)["label"] == "sleepy"
    noon = A.mood(r, day(0, 14, 1), TZ)
    assert noon["valence"] > A.BASELINE["new"] and noon["energy"] < A.CIRCADIAN[14]  # (just talked: a bit spent)
    later = A.mood(r, day(1, 14), TZ)
    assert later["valence"] == pytest.approx(A.BASELINE["new"], abs=0.01) and later["label"] == "focused"
    A.mood_result(r, day(1, 14), ok=False)
    assert A.mood(r, day(1, 14), TZ)["valence"] < A.BASELINE["new"]
    assert set(A.MOODS) >= {A.mood(r, day(1, h), TZ)["label"] for h in range(24)}


def _history():
    ev = []
    for n in (0, 1, 2, 3, 5, 9, 10, 11, 25):
        for i in range(3 if n % 2 else 13):
            ev.append((day(n, 9, i).astimezone(timezone.utc), "turn", ("thanks!" if i == 0 else "hi", "[joy] ok")))
    ev += [(day(n, 10).astimezone(timezone.utc), "memory", None) for n in (1, 1, 1, 1, 9, 25)]
    return ev


def test_recompute_equals_real_time():
    now = day(30)
    real = A.new()
    for at, what, arg in sorted(_history(), key=lambda e: (e[0], 0 if e[1] == "turn" else 1)):
        A.advance(real, at, TZ)
        if what == "turn":
            A.credit_turn(real, at, TZ, *arg)
        else:
            A.credit_memory(real, at, TZ)
    A.advance(real, now, TZ)
    again = A.replay(list(reversed(_history())), now, TZ)  # (order of the input doesn't matter)
    assert again["affinity"] == real["affinity"] and again["stage"] == real["stage"]
    assert again["log"][:-1] == real["log"] and again["log"][-1]["why"] == "recomputed"
    assert again["turns"] == real["turns"] == 3 * 13 + 6 * 3 and again["memories"] == 6


def test_view_and_summary_shapes():
    r = A.replay(_history(), day(30), TZ)
    v = A.view(r, day(30), TZ)
    assert v["stats"]["turns"] == 57 and v["stats"]["grace_days"] == 3 and v["next"]["stage"] in A.STAGES
    assert v["log"][0]["why"] == "recomputed" and v["mood"]["label"] in A.MOODS
    s = A.summary(r, day(30), TZ)
    assert set(s) == {"enabled", "paused", "stage", "affinity", "mood", "show_indicator", "avatar_mood"}
    assert isinstance(s["affinity"], int)


# ---- the service ----

def _svc(db):
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    store = MateStore(db, vault)
    return svc, store, MateService(svc, store)


def _engine(mates, mate_id, text="hi", cli=None):
    session = mates.conversation(mate_id)["session"]
    req = TurnRequest(messages=[{"role": "user", "content": text}], model="", cwd="/tmp", cli_session_id=cli)
    mates.configure_engine(session, req)
    return req, open(req.system_prompt_file, encoding="utf-8").read()


def test_existing_mates_are_seeded_from_their_history(db):
    svc, store, mates = _svc(db)
    m = store.create(name="Old")
    sid = mates.conversation(m["id"])["session_id"]
    db.execute("DELETE FROM mate_relation WHERE mate_id = ?", (m["id"],))  # (as before relationships existed)
    base = datetime.now(timezone.utc) - timedelta(days=4)
    for n in range(3):
        for role, text, meta in (("user", "hi", None), ("assistant", "[smile] hello", None),
                                 ("user", "<delegation_result …>", json.dumps({"internal": True}))):
            db.execute("INSERT INTO messages (id, session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                       (f"msg_{n}_{role}_{len(text)}", sid, role, text, meta, (base + timedelta(days=n)).isoformat()))
    store.add_memory(m["id"], "likes tea", kind="preference")
    v = MateService(svc, store).relation_view(m["id"])  # (a restart: the seed pass)
    assert v["stats"]["turns"] == 3 and v["stats"]["active_days"] == 3 and v["stats"]["memories"] == 1
    assert v["affinity"] > 0 and v["log"][0]["why"] == "recomputed"
    assert MateService(svc, store).relation_view(m["id"])["affinity"] == v["affinity"]  # seeded once


def test_turns_and_memories_move_it_and_the_prompt_gets_lines_only_on_change(db):
    svc, store, mates = _svc(db)
    m = store.create(name="Rin", persona={"language": "ko"})
    req, prompt = _engine(mates, m["id"])
    assert "## Between you and the user" in prompt and "never guilt-trip" in prompt.lower()
    assert "Relationship: new — day" not in req.preamble and "Your state: " in req.preamble  # (no turn yet)
    mates._relation_turn(m["id"], {"input": "고마워!", "text": "[joy] 천만에요", "meta": None})
    mates._relation_turn(m["id"], {"input": "<delegation_result>", "text": "", "meta": {
        "internal": True, "kind": "delegation_result", "delegations": [{"status": "ok"}]}})
    v = mates.relation_view(m["id"])
    assert v["stats"]["turns"] == 1 and v["affinity"] == 6.5
    store.add_memory(m["id"], "고양이 이름은 나비", kind="fact")
    assert mates.relation_view(m["id"])["stats"]["memories"] == 1
    req2, _ = _engine(mates, m["id"], cli="c1")
    assert "Relationship: new — day 1 together." in req2.preamble
    req3, _ = _engine(mates, m["id"], cli="c1")
    assert "Relationship:" not in req3.preamble and "Your state:" not in req3.preamble  # told already
    assert req3.prompt_key == req2.prompt_key  # affinity moves never restart the engine
    req4, _ = _engine(mates, m["id"])  # a fresh context: told again
    assert "Relationship:" in req4.preamble


def test_turning_it_off_removes_the_guide_and_says_so(db):
    svc, store, mates = _svc(db)
    m = store.create(name="Rin")
    req, _ = _engine(mates, m["id"])
    mates.relation_update(m["id"], {"enabled": False})
    req2, prompt2 = _engine(mates, m["id"], cli="c1")
    assert "## Between you and the user" not in prompt2 and req2.prompt_key != req.prompt_key
    assert "The relationship is now off" in req2.preamble and "Relationship:" not in req2.preamble
    mates._relation_turn(m["id"], {"input": "hi", "text": "", "meta": None})
    assert mates.relation_view(m["id"])["stats"]["turns"] == 0  # off: nothing tracked
    assert "relationship" not in base_prompt("R", {}, None).lower()
    assert prompt_key("R", {}, 0, None, relation=True) != prompt_key("R", {}, 0, None)


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


def test_relation_routes(client):
    m = client.post("/api/mates", json={"name": "Rel"}).json()
    assert m["relation"]["stage"] == "new" and m["relation"]["show_indicator"] is True
    base = f"/api/mates/{m['id']}/relation"
    v = client.get(base).json()
    assert v["enabled"] and v["affinity"] == 0 and v["stats"]["grace_days"] == 3
    v = client.patch(base, json={"affinity": 55, "sensitivity": 9, "show_indicator": False}).json()
    assert v["affinity"] == 55 and v["sensitivity"] == 1.5 and v["show_indicator"] is False
    assert v["log"][0]["why"] == "manual"
    assert client.patch(base, json={"affinity": "lots"}).status_code == 400
    assert client.patch(base, json={"affinity": True}).status_code == 400
    v = client.patch(base, json={"paused": True}).json()
    assert v["paused"] and v["log"][0]["why"] == "paused_on"
    got = next(x for x in client.get("/api/mates").json() if x["id"] == m["id"])
    assert got["relation"]["affinity"] == 55 and got["relation"]["paused"] is True
    assert client.post(f"{base}/reset", json={"mode": "nope"}).status_code == 400
    v = client.post(f"{base}/reset", json={"mode": "zero"}).json()
    assert v["affinity"] == 0 and v["paused"] is True and v["sensitivity"] == 1.5  # settings kept
    v = client.post(f"{base}/reset", json={"mode": "recompute"}).json()
    assert v["log"][0]["why"] == "recomputed"
    assert client.get("/api/mates/mate_nope/relation").status_code == 404


# ---- the timezone: days counted where the user's midnight is ----

def test_replay_keeps_the_users_own_changes():
    """A value set by hand and a fresh start, replayed when they happened, give what real time gave."""
    real = A.new()
    ev = sorted(_history(), key=lambda e: (e[0], 0 if e[1] == "turn" else 1))

    def until(t):
        for at, what, arg in [e for e in ev if e[0] < t]:
            ev.remove((at, what, arg))
            A.advance(real, at, TZ)
            A.credit_turn(real, at, TZ, *arg) if what == "turn" else A.credit_memory(real, at, TZ)
        A.advance(real, t, TZ)

    until(day(4, 15))
    A.set_value(real, 80, day(4, 15), TZ)
    until(day(12, 15))
    real = A.reset(real, day(12, 15), TZ)
    until(day(30))
    assert [m["kind"] for m in real["marks"]] == ["set", "reset"]
    again = A.replay(_history(), day(30), TZ, marks=A.marks_of(real))
    assert (again["affinity"], again["stage"], again["turns"]) == (real["affinity"], real["stage"], real["turns"])
    # a document from before marks: read from its log
    old = A.replay(_history(), day(8), TZ)
    A.set_value(old, 70, day(8), TZ)
    old["marks"] = []
    assert A.marks_of(old) == [{"at": A._iso(day(8)), "kind": "set", "v": 70.0}]


def _talks_across_midnight(db, sid, base):
    """Talks at 23:30 and 08:30 Seoul time on consecutive days: one UTC day (14:30, 23:30 UTC), two Seoul days."""
    rows = []
    for n in range(3):
        d = (base + timedelta(days=2 * n)).astimezone(ZoneInfo("Asia/Seoul")).replace(hour=23, minute=30)
        rows += [d, d + timedelta(hours=9)]
    for i, at in enumerate(rows):
        for role, text in (("user", "hi there"), ("assistant", "[smile] hello")):
            db.execute("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                       (f"msg_tz_{i}_{role}", sid, role, text,
                        (at + timedelta(seconds=1 if role == "assistant" else 0)).astimezone(timezone.utc).isoformat()))


def test_the_fallback_zone_is_named_and_a_reported_timezone_recounts_the_relationship(db):
    svc, store, mates = _svc(db)
    m = store.create(name="Chae")
    sid = mates.conversation(m["id"])["session_id"]
    tz, key = store.tz_and_key()
    assert store._setting("timezone") == "" and key.startswith("local:") and tz is not None
    _talks_across_midnight(db, sid, datetime.now(timezone.utc) - timedelta(days=8))

    # the server counted in UTC (a container) before any browser said the user's zone
    store.update_settings({"timezone": "UTC"})
    db.execute("DELETE FROM mate_relation WHERE mate_id = ?", (m["id"],))
    utc = mates.relation_view(m["id"])
    assert store.relation_doc(m["id"])["tz"] == "UTC"
    assert utc["stats"]["active_days"] == 3 and utc["stats"]["turns"] == 6

    changes: list[str] = []
    store.on_change = lambda reason, mate_id=None: changes.append(reason)
    store.update_settings({"timezone": "Asia/Seoul"})  # the console fills it from the browser
    mates.timezone_changed()
    doc = store.relation_doc(m["id"])
    seoul = mates.relation_view(m["id"])
    assert doc["tz"] == "Asia/Seoul" and "relation" in changes  # announced: indicators move without a reload
    assert seoul["stats"]["active_days"] == 6 and seoul["stats"]["turns"] == 6
    assert seoul["affinity"] > utc["affinity"]
    expected = A.replay(mates._history_events(store.get(m["id"])), datetime.now(timezone.utc), ZoneInfo("Asia/Seoul"))
    assert seoul["affinity"] == round(expected["affinity"], 1) and seoul["stage"] == expected["stage"]
    assert any(e["why"].startswith("timezone UTC → Asia/Seoul") for e in seoul["log"])
    # the same zone again: nothing recounted
    before = store.relation_doc(m["id"])
    mates.timezone_changed()
    assert store.relation_doc(m["id"]) == before


def test_a_recount_keeps_a_value_set_by_hand_and_the_switches(db):
    svc, store, mates = _svc(db)
    store.update_settings({"timezone": "UTC"})
    m = store.create(name="Hand")
    sid = mates.conversation(m["id"])["session_id"]
    _talks_across_midnight(db, sid, datetime.now(timezone.utc) - timedelta(days=8))
    db.execute("DELETE FROM mate_relation WHERE mate_id = ?", (m["id"],))
    mates.relation_view(m["id"])
    mates.relation_update(m["id"], {"affinity": 66, "sensitivity": 1.2, "show_indicator": False})
    mates.relation_update(m["id"], {"paused": True})
    store.update_settings({"timezone": "Asia/Seoul"})
    mates.timezone_changed()
    v = mates.relation_view(m["id"])
    assert v["affinity"] == 66 and v["paused"] is True and v["sensitivity"] == 1.2 and v["show_indicator"] is False
    assert v["stats"]["active_days"] == 6  # …and the days counted in Seoul


def test_a_doc_from_before_zones_is_recounted_once(db):
    svc, store, mates = _svc(db)
    store.update_settings({"timezone": "Asia/Seoul"})
    m = store.create(name="Legacy")
    sid = mates.conversation(m["id"])["session_id"]
    _talks_across_midnight(db, sid, datetime.now(timezone.utc) - timedelta(days=8))
    utc = A.replay(mates._history_events(store.get(m["id"])), datetime.now(timezone.utc), timezone.utc)
    utc.pop("tz")
    utc.pop("marks")
    store.save_relation(m["id"], utc)  # as the last deploy seeded it: in the container's UTC, no zone recorded
    assert store.relation_doc(m["id"])["active_days"] == 3
    v = MateService(svc, store).relation_view(m["id"])  # (a restart)
    assert v["stats"]["active_days"] == 6 and store.relation_doc(m["id"])["tz"] == "Asia/Seoul"


def test_setting_the_timezone_over_http_recounts(client):
    m = client.post("/api/mates", json={"name": "TzRoute"}).json()
    mates = app.state.mate_service
    sid = mates.conversation(m["id"])["session_id"]
    _talks_across_midnight(app.state.db, sid, datetime.now(timezone.utc) - timedelta(days=8))
    assert client.put("/api/mates/settings", json={"timezone": "UTC"}).status_code == 200
    client.post(f"/api/mates/{m['id']}/relation/reset", json={"mode": "recompute"})
    assert client.get(f"/api/mates/{m['id']}/relation").json()["stats"]["active_days"] == 3
    assert client.put("/api/mates/settings", json={"timezone": "Asia/Seoul"}).status_code == 200
    got = next(x for x in client.get("/api/mates").json() if x["id"] == m["id"])  # (the list's indicator too)
    v = client.get(f"/api/mates/{m['id']}/relation").json()
    assert v["stats"]["active_days"] == 6 and got["relation"]["affinity"] == round(v["affinity"])
    client.delete(f"/api/mates/{m['id']}")
