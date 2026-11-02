"""The Relationship panel's reads (docs/mate-memory-affinity.md §6.1): daily values from the change log — and from a
replay of the real history when the log lost its oldest entries — what the next stage still needs in its earned
and warmth parts, anniversaries, longest streak, the change kinds, and the route."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import affinity as A
from app.mate.service import MateService
from app.mate.store import MateStore
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

TZ = ZoneInfo("Asia/Seoul")
T0 = datetime(2026, 9, 1, 12, 0, tzinfo=TZ)


def day(n: int, hour: int = 12, minute: int = 0) -> datetime:
    return (T0 + timedelta(days=n)).replace(hour=hour, minute=minute)


def _history(talk_days=(0, 1, 2, 3, 5, 9, 10, 11, 25), per_day=lambda n: 3 if n % 2 else 13):
    ev = []
    for n in talk_days:
        for i in range(per_day(n)):
            ev.append((day(n, 9, i).astimezone(timezone.utc), "turn", ("thanks!" if i == 0 else "hi", "[joy] ok")))
    ev += [(day(n, 10).astimezone(timezone.utc), "memory", None) for n in (1, 1, 1, 1, 9, 25)]
    return ev


def _real_time(events, until):
    """The engine in real time, with the value at the end of each local day recorded as it happens."""
    r, ends = A.new(), {}
    evs = sorted(events, key=lambda e: (e[0], 0 if e[1] == "turn" else 1))
    d = day(0).date()
    while d <= until.date():
        end = datetime.combine(d + timedelta(days=1), datetime.min.time(), tzinfo=TZ)
        for at, what, arg in [e for e in evs if e[0] < end.astimezone(timezone.utc)]:
            evs.remove((at, what, arg))
            A.advance(r, at, TZ)
            A.credit_turn(r, at, TZ, *arg) if what == "turn" else A.credit_memory(r, at, TZ)
        A.advance(r, end, TZ)  # (the day is finished: its quiet cost is settled)
        ends[d.isoformat()] = round(r["affinity"], 1)
        d += timedelta(days=1)
    return r, ends


def test_daily_values_from_the_log_match_real_time_end_of_day_values():
    now = day(30, 15)
    _, ends = _real_time(_history(), day(29))
    r = A.replay(_history(), now, TZ)
    s = A.daily(r["log"], now.date(), TZ, 31)
    assert len(s) == 31 and s[0]["day"] == "2026-09-01" and s[-1]["day"] == "2026-10-01"
    for x in s[:-1]:
        assert x["v"] == ends.get(x["day"]), x
    assert s[-1]["v"] == round(r["affinity"], 1)
    # day 0 (the first talk): only gains; a quiet day after the grace days: only a loss, booked on that day
    first = next(x for x in s if x["day"] == day(0).date().isoformat())
    assert first["up"] > 0 and first["down"] == 0
    quiet = next(x for x in s if x["day"] == day(15).date().isoformat())
    assert quiet["up"] == 0 and quiet["down"] < 0
    # before the first talk: nothing yet
    before = A.daily(r["log"], day(3).date(), TZ, 7)
    assert [x["v"] for x in before[:3]] == [None, None, None] and before[3]["v"] is not None


def test_a_set_value_is_not_a_gain_and_kinds_of_changes():
    r = A.replay(_history(), day(30), TZ)
    A.set_value(r, 90, day(30, 13), TZ)
    s = A.daily(r["log"], day(30).date(), TZ, 7)
    assert s[-1]["v"] == 90.0 and s[-1]["up"] == 0  # (a value set by hand moves it, but it isn't "earned")
    ch = A.changes(r)
    assert ch[0]["why"] == "manual" and ch[0]["kind"] == "manual"
    kinds = {c["kind"] for c in ch}
    assert {"gain", "loss", "manual", "stage"} <= kinds
    ups = [c for c in ch if c["why"] == "stage_up"]
    assert {c["stage"] for c in ups} >= {"familiar"}
    assert all(c["kind"] == "gain" for c in ch if c["why"] in ("talk", "memory", "lively"))
    assert all(c["kind"] == "loss" for c in ch if c["why"].startswith("quiet_"))


def test_requirements_show_both_parts_and_the_stage_is_the_lower():
    r = A.new()
    r.update(active_days=5, turns=80, memories=12, affinity=30.0, warm=1, stage="familiar")
    q = A.requirements(r)
    assert q["stage"] == "trusted"
    # earned: trusted needs 10 days · 60 talks · 10 memories
    assert q["earned"]["need"] == {"days": 10, "turns": 60, "memories": 10}
    assert q["earned"]["left"] == {"days": 5, "turns": 0, "memories": 0} and q["earned"]["met"] is False
    assert q["warmth"]["target"] == A.BAND_FLOORS[2] + A.HYST_UP and q["warmth"]["left"] == 17.0
    assert q["warmth"]["met"] is False
    # earned all there, warmth behind: only warmth is missing
    r.update(active_days=12)
    q = A.requirements(r)
    assert q["earned"]["met"] and q["earned"]["ratio"] == 1.0 and not q["warmth"]["met"]
    r.update(stage="companion")
    assert A.requirements(r) is None


def test_anniversaries_and_longest_run():
    r = A.replay(_history(), day(30), TZ)
    an = A.anniversaries(r, day(30).date(), TZ)
    assert [a["days"] for a in an] == [7, 30, 100, 365]
    assert an[0] == {"days": 7, "day": "2026-09-07", "reached": True, "in_days": 0}
    assert an[1] == {"days": 30, "day": "2026-09-30", "reached": True, "in_days": 0}
    nxt = next(a for a in an if not a["reached"])
    assert nxt["days"] == 100 and nxt["in_days"] == (date(2026, 9, 1) + timedelta(days=99) - day(30).date()).days
    assert A.anniversaries(A.new(), day(1).date(), TZ) == []
    days = {day(n).date() for n in (0, 1, 2, 3, 5, 9, 10, 11, 25)}
    assert A.longest_run(days) == 4 and A.longest_run(set()) == 0


def test_replay_trace_keeps_every_change_past_the_log_limit(monkeypatch):
    monkeypatch.setattr(A, "LOG_MAX", 30)
    many = _history()
    trace: list = []
    r = A.replay(many, day(40), TZ, trace=trace)
    assert len(r["log"]) == A.LOG_MAX and len(trace) > A.LOG_MAX
    assert trace[-A.LOG_MAX:] == r["log"]
    # the trace after a fresh start (marks) still holds what came before it
    trace2: list = []
    A.replay(many, day(40), TZ, marks=[{"at": A._iso(day(9, 13)), "kind": "reset"}], trace=trace2)
    assert any(e["why"] == "reset" for e in trace2) and trace2[0]["why"] == "talk"


# ---- the service and the route ----

def _svc(db):
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    store = MateStore(db, vault)
    return svc, store, MateService(svc, store)


def _write(db, sid, times):
    for i, at in enumerate(times):
        for role, text, meta in (("user", "고마워!", None), ("assistant", "[smile] 네", None),
                                 ("user", "<delegation_result …>", json.dumps({"internal": True}))):
            db.execute("INSERT INTO messages (id, session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                       (f"msg_j_{i}_{role}_{len(text)}", sid, role, text, meta,
                        (at + timedelta(seconds=len(text))).astimezone(timezone.utc).isoformat()))


def test_journal_from_the_service(db):
    svc, store, mates = _svc(db)
    store.update_settings({"timezone": "Asia/Seoul"})
    m = store.create(name="Rin")
    sid = mates.conversation(m["id"])["session_id"]
    now = datetime.now(timezone.utc)
    talks = [now - timedelta(days=n, hours=1) for n in (12, 11, 10, 9, 5, 4, 1)]
    _write(db, sid, talks)
    db.execute("DELETE FROM mate_relation WHERE mate_id = ?", (m["id"],))  # (seeded from this history)
    store.add_memory(m["id"], "likes green tea", kind="preference")
    j = mates.relation_journal(m["id"], 30)
    assert j["days"] == 30 and len(j["series"]) == 30 and j["series_source"] == "log"
    assert j["relation"]["stats"]["turns"] == 7  # (internal messages never count)
    assert sum(x["talks"] for x in j["series"]) == 7
    assert j["series"][-1]["v"] == j["relation"]["affinity"]
    assert j["stats"]["longest_streak"] == 4 and j["stats"]["memories_active"] == 1
    assert j["stats"]["first_talk_at"] < j["stats"]["last_talk_at"]
    assert j["memories"][0]["text"] == "likes green tea"
    assert j["requirements"]["stage"] in A.STAGES and j["anniversaries"][0]["reached"] is True
    assert j["changes"][0]["at"] >= j["changes"][-1]["at"]
    assert {"gain", "manual"} <= {c["kind"] for c in j["changes"]}
    # days are clamped
    assert mates.relation_journal(m["id"], 1)["days"] == 7 and len(mates.relation_journal(m["id"], 999)["series"]) == 90


def test_journal_fills_days_the_log_lost_from_the_history(db, monkeypatch):
    svc, store, mates = _svc(db)
    store.update_settings({"timezone": "Asia/Seoul"})
    m = store.create(name="Busy")
    sid = mates.conversation(m["id"])["session_id"]
    now = datetime.now(timezone.utc)
    _write(db, sid, [now - timedelta(days=n, hours=1) for n in (20, 19, 18, 17, 16, 12, 11, 10, 9, 5, 4, 1)])
    db.execute("DELETE FROM mate_relation WHERE mate_id = ?", (m["id"],))
    monkeypatch.setattr(A, "LOG_MAX", 12)  # (the log keeps only its last 12 changes: it starts days after the first talk)
    j = mates.relation_journal(m["id"], 30)
    tz = ZoneInfo("Asia/Seoul")
    doc = store.relation_doc(m["id"])
    assert len(doc["log"]) == 12 and A.log_day(doc["log"][0], tz) > (now - timedelta(days=20)).astimezone(tz).date()
    assert j["series_source"] == "log+replay"
    trace: list = []
    A.replay(mates._history_events(store.get(m["id"])), now, tz, trace=trace)
    full = A.daily(trace, now.astimezone(tz).date(), tz, 30)
    assert [x["v"] for x in j["series"]] == [x["v"] for x in full]  # every day, as if the log had kept them all
    assert sum(1 for x in j["series"] if x["v"] is not None) == 21


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


def test_journal_route(client):
    m = client.post("/api/mates", json={"name": "Jo"}).json()
    j = client.get(f"/api/mates/{m['id']}/relation/journal?days=14").json()
    assert j["days"] == 14 and len(j["series"]) == 14 and all(x["v"] is None for x in j["series"][:-1])
    assert j["series"][-1]["v"] == 0.0
    assert j["relation"]["stage"] == "new" and j["requirements"]["stage"] == "familiar"
    assert j["anniversaries"] == [] and j["memories"] == [] and j["stats"]["last_talk_at"] is None
    client.patch(f"/api/mates/{m['id']}/relation", json={"affinity": 40})
    j = client.get(f"/api/mates/{m['id']}/relation/journal").json()
    assert j["days"] == 30 and j["series"][-1]["v"] == 40.0 and j["changes"][0]["kind"] == "manual"
    assert client.get("/api/mates/mate_nope/relation/journal").status_code == 404
    assert client.get(f"/api/mates/{m['id']}/relation/journal?days=x").status_code == 422
