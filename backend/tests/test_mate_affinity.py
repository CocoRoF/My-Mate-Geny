"""The relationship engine (app/mate/affinity.py, docs/mate-memory-affinity.md §5) under simulated time — grace
days then accelerating decay with a cap and a floor, daily caps, lively days, streaks, warmth and rudeness
(sadness never costs), pause, sensitivity, hysteresis, earned × warmth — and the same engine for real time
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
    assert [A.decay_for(n) for n in range(1, 10)] == [0, 0, 2.0, 2.8, 3.92, 5.49, 7.68, 8.0, 8.0]
    r = A.new()
    talk(r, day(0))
    A.set_value(r, 80, day(0), TZ)
    A.advance(r, day(9), TZ)  # days 1–2 free, 3..8 cost
    losses = [(e["why"], e["d"]) for e in r["log"] if e["why"].startswith("quiet")]
    assert losses == [("quiet_3", -2.0), ("quiet_4", -2.8), ("quiet_5", -3.92), ("quiet_6", -5.49), ("quiet_7", -7.68),
                      ("quiet_8", -8.0)]
    assert r["affinity"] == pytest.approx(80 - 29.89)
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
    assert whys(r) == ["talk"] and r["affinity"] == A.TALK


def test_showing_up_is_worth_little_and_what_happens_between_them_more():
    """A hello a day barely moves it; a conversation that keeps going, her laughing with them, a gift do."""
    hello = A.new()
    talk(hello, day(0))
    for i in range(3):
        talk(hello, day(0, 13, i), "ok")
    assert hello["affinity"] == A.TALK == 0.8  # (the turns after the first: nothing)
    r = A.new()
    for i in range(26):
        talk(r, day(0, 9, i), "고마워!" if i < 6 else "ok", "[laugh] 하하" if i < 3 else "")
    assert whys(r).count("talk") == 1 and whys(r).count("lively") == 2  # (the 10th and the 25th turn)
    assert sum(e["d"] for e in r["log"] if e["why"] == "warm") == A.WARM_CAP  # six warm turns, capped
    assert sum(e["d"] for e in r["log"] if e["why"] == "smiled") == 3 * A.SMILED  # she laughed three times
    # (all of it would be more than a day can give: the day's cap)
    assert r["affinity"] == pytest.approx(min(A.GAIN_CAP, A.TALK + 2 * A.LIVELY + A.WARM_CAP + 3 * A.SMILED)) == A.GAIN_CAP
    s = A.new()
    for n in range(7):
        talk(s, day(n))
    assert s["streak_days"] == 7 and whys(s).count("streak") == 6 and whys(s).count("streak_week") == 1
    assert whys(s).count("anniversary_7") == 1  # (talking on their 7th day together)
    assert s["affinity"] == pytest.approx(A.TALK + 5 * (A.TALK + A.STREAK)
                                          + min(A.GAIN_CAP, A.TALK + A.STREAK + A.STREAK_WEEK + A.ANNIVERSARY))
    talk(s, day(9))  # a gap: the streak starts over
    assert s["streak_days"] == 1


def test_her_smiles_count_only_up_to_a_point_and_never_after_something_done_to_her():
    r = A.new()
    for i in range(8):
        talk(r, day(0, 9, i), "응", "[smile] 그렇구나")
    assert sum(e["d"] for e in r["log"] if e["why"] == "smiled") == A.SMILED_CAP
    s = A.new()
    talk(s, day(0))
    talk(s, day(0, 13), "닥쳐", "[smile] 네?")  # (a rude word: her smile doesn't make it a good turn)
    assert "smiled" not in whys(s)


def test_gifts_count_capped_per_day_and_a_recompute_keeps_them():
    r = A.new()
    talk(r, day(0))
    for i in range(3):
        A.advance(r, day(0, 15, i), TZ)
        A.credit_gift(r, day(0, 15, i), TZ)
    assert sum(e["d"] for e in r["log"] if e["why"] == "gift") == pytest.approx(A.GIFT_CAP) and len(r["gifts"]) == 3
    A.advance(r, day(1, 9), TZ)
    A.credit_gift(r, day(1, 9), TZ)  # (a new day: counted again, before any talk that day)
    assert [e["d"] for e in r["log"] if e["why"] == "gift"][-1] == A.GIFT
    events = [(day(0).astimezone(timezone.utc), "turn", ("hello", ""))]
    events += [(A._t(g), "gift", None) for g in r["gifts"]]
    again = A.replay(events, day(2), TZ)
    assert again["affinity"] == r["affinity"] and again["gifts"] == r["gifts"]
    paused = A.new()
    talk(paused, day(0))
    A.set_switch(paused, "paused", True, day(0, 13), TZ)
    A.credit_gift(paused, day(0, 14), TZ)
    assert "gift" not in whys(paused) and paused["gifts"] == []  # (paused: nothing moves, nothing kept)


def test_anniversaries_count_on_the_day_itself():
    r = A.new()
    talk(r, day(0))
    talk(r, day(29))  # the 30th day together
    talk(r, day(29, 18))
    assert whys(r).count("anniversary_30") == 1 and [e["d"] for e in r["log"] if e["why"] == "anniversary_30"] == [A.ANNIVERSARY]
    late = A.new()
    talk(late, day(0))
    talk(late, day(7))  # the day after the 7th: not the day
    assert not any(w.startswith("anniversary") for w in whys(late))


def test_the_daily_gain_cap():
    r = A.new()
    talk(r, day(0))
    A.set_value(r, 30, day(0), TZ)
    for _ in range(5):
        A.credit_memory(r, day(0, 13), TZ)
    for i in range(26):
        talk(r, day(0, 14, i), "thanks, great!", "[joy] :)")
    gained = sum(e["d"] for e in r["log"] if e["why"] in ("talk", "lively", "warm", "smiled", "memory", "streak"))
    assert gained == pytest.approx(A.GAIN_CAP)  # 0.8 + 0.8 (memories) + 0.75 (warm) + 0.75 (her smiles) + 1.6 (lively) = 4.7 → 3.2


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


def test_the_closer_they_are_the_more_it_takes():
    assert [A.climb(a) for a in (0, 39.9, 40, 70, 100)] == pytest.approx([1.0, 1.0, 1.0, 0.7, 0.4])
    r = A.new()
    talk(r, day(0))
    A.set_value(r, 90, day(0), TZ)
    talk(r, day(1))
    assert [e["d"] for e in r["log"] if e["why"] == "talk"][-1] == pytest.approx(A.TALK * A.climb(90))


def _effort(per_day, days=120):
    """Day by day what someone does (``per_day(n)``: (turns, warm ones, her smiles, memories, gifts) or None) → the day 100 is
    first reached (None: never) and the affinity at the end."""
    r = A.new()
    for n in range(days):
        plan = per_day(n)
        if plan:
            turns, warm, smiles, memories, gifts = plan
            for i in range(turns):
                talk(r, day(n, 9, i), "고마워, 최고야" if i < warm else "응 그렇구나", "[smile] 헤헤" if i < smiles else "그랬구나")
            for i in range(memories):
                A.credit_memory(r, day(n, 11, i), TZ)
            for i in range(gifts):
                A.credit_gift(r, day(n, 12, i), TZ)
        A.advance(r, day(n, 23, 59), TZ)
        if r["affinity"] >= 100:
            return n + 1, r["affinity"]
    return None, r["affinity"]


def test_even_doing_everything_right_100_takes_a_month():
    """Talking every day, at length, warmly, with her laughing, memories and gifts: more than 30 days to 100; a good everyday talk
    takes longer still, and every other day never gets there."""
    best, _ = _effort(lambda n: (30, 5, 5, 3, 2))
    everyday, _ = _effort(lambda n: (15, 2, 2, 1, 0))
    assert best is not None and 30 < best <= 40
    assert everyday is not None and everyday > best
    assert _effort(lambda n: (8, 0, 1, 0, 0) if n % 2 == 0 else None)[0] is None


def test_what_she_minds_costs_too_each_up_to_a_day_and_a_recompute_keeps_it():
    r = A.new()
    talk(r, day(0))
    A.set_value(r, 50, day(0), TZ)
    for i in range(4):
        A.cost(r, "dismissed", day(0, 13, i), TZ)
    each, cap = A.LOSSES["dismissed"]
    assert [e["d"] for e in r["log"] if e["why"] == "dismissed"] == [-each, -each]  # (two of them reach the day's limit)
    assert r["affinity"] == pytest.approx(50 - cap)
    A.cost(r, "ignored", day(0, 14), TZ)
    A.cost(r, "no_such_thing", day(0, 14), TZ)
    assert whys(r)[-1] == "ignored" and len(r["costs"]) == 5  # (only what she minds; the over-limit ones are kept as they were)
    A.advance(r, day(1, 9), TZ)
    A.cost(r, "dismissed", day(1, 9), TZ)  # (a new day: it costs again)
    assert [e["d"] for e in r["log"] if e["why"] == "dismissed"][-1] == -each
    events = [(day(0).astimezone(timezone.utc), "turn", ("hello", ""))]
    events += [(A._t(c["at"]), "cost", c["code"]) for c in r["costs"]]
    again = A.replay(events, day(1, 10), TZ, marks=A.marks_of(r))
    assert again["affinity"] == r["affinity"] and again["costs"] == r["costs"]
    paused = A.new()
    talk(paused, day(0))
    A.set_switch(paused, "paused", True, day(0, 13), TZ)
    A.cost(paused, "dismissed", day(0, 14), TZ)
    assert "dismissed" not in whys(paused) and paused["costs"] == []
    half = A.new()
    half["sensitivity"] = 0.5
    talk(half, day(0))
    A.cost(half, "declined_call", day(0, 13), TZ)
    assert [e["d"] for e in half["log"] if e["why"] == "declined_call"] == [-A.LOSSES["declined_call"][0] / 2]


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
    assert r["affinity"] == pytest.approx(60 + A.TALK * A.climb(60))  # (the days of the pause cost nothing afterwards either)
    off = A.new()
    off["enabled"] = False
    talk(off, day(0))
    assert off["affinity"] == 0 and off["turns"] == 0
    half = A.new()
    half["sensitivity"] = 0.5
    talk(half, day(0))
    A.set_value(half, 80, day(0), TZ)
    A.advance(half, day(5), TZ)
    assert [e["d"] for e in half["log"] if e["why"] == "talk"] == [A.TALK / 2]
    assert [e["d"] for e in half["log"] if e["why"].startswith("quiet")] == [-1.0, -1.4]


def test_hysteresis_and_the_stage_follows_the_affinity():
    assert A.warmth_index(21, 0) == 0 and A.warmth_index(22, 0) == 1  # in only 2 past the floor
    assert A.warmth_index(18, 1) == 1 and A.warmth_index(16.9, 1) == 0  # out only 3 below it
    assert A.warmth_index(90, 0) == 3 and A.warmth_index(5, 3) == 0
    r = A.new()
    talk(r, day(0))
    A.set_value(r, 90, day(0), TZ)
    assert r["stage"] == "companion" and A.earned_stage(r) == "new"  # (what the number says, however new they are)
    assert any(m["key"] == "stage_companion" for m in r["milestones"])
    A.set_value(r, 50, day(0), TZ)
    assert r["stage"] == "trusted"
    A.set_value(r, 10, day(0), TZ)
    assert r["stage"] == "new"  # (the milestone stays: history)
    assert any(m["key"] == "stage_companion" for m in r["milestones"])
    assert A.next_stage(r) == {"stage": "familiar", "ratio": round(10 / 22, 3)}
    A.set_value(r, 90, day(0), TZ)
    assert A.next_stage(r) is None


def test_the_avatar_follows_how_she_feels_unless_told_not_to():
    assert A.new()["avatar_mood"] is True
    assert A.normalized({"avatar_mood": False})["avatar_mood"] is True  # (from when it was off unless asked for)
    assert A.normalized({"avatar_mood": True})["avatar_mood"] is True
    assert A.normalized({"avatar_mood": False, "avatar_v2": True})["avatar_mood"] is False  # (off since: the user's)
    assert "mood" not in A.normalized({"mood": {"valence": 0.2}})


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
    assert v["stats"]["turns"] == 57 and v["stats"]["grace_days"] == 2 and v["next"]["stage"] in A.STAGES
    assert v["log"][0]["why"] == "recomputed" and "mood" not in v
    s = A.summary(r, day(30), TZ)
    assert set(s) == {"enabled", "paused", "stage", "affinity", "show_indicator", "avatar_mood"}
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
    req.on_context_delivered()  # this helper simulates a provider accepting the turn
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
    assert "## Between you and the user" in prompt and "never guilt-trip" in prompt.lower() and "You have only just met" in prompt
    assert "Relationship: new — day" not in req.preamble and "How you feel right now: " in req.preamble  # (no turn yet)
    mates._relation_turn(m["id"], {"input": "고마워!", "text": "[joy] 천만에요", "meta": None})
    mates._relation_turn(m["id"], {"input": "<delegation_result>", "text": "", "meta": {
        "internal": True, "kind": "delegation_result", "delegations": [{"status": "ok"}]}})
    v = mates.relation_view(m["id"])
    assert v["stats"]["turns"] == 1 and v["affinity"] == A.TALK + A.WARM + A.SMILED  # (her [joy]: she smiled)
    store.add_memory(m["id"], "고양이 이름은 나비", kind="fact")
    assert mates.relation_view(m["id"])["stats"]["memories"] == 1
    req2, _ = _engine(mates, m["id"], cli="c1")
    assert "Relationship: new — day 1 together." in req2.preamble
    req3, _ = _engine(mates, m["id"], cli="c1")
    assert "Relationship:" not in req3.preamble and "How you feel" not in req3.preamble  # told already
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


def test_what_she_minds_costs_the_relationship_and_what_she_shows_has_the_last_word(db):
    from app.mate import state as S
    svc, store, mates = _svc(db)
    m = store.create(name="Rin")
    mates._relation_turn(m["id"], {"input": "hi", "text": "", "meta": None})
    mates.relation_update(m["id"], {"affinity": 50})

    def why0():
        return mates.relation_view(m["id"])["log"][0]["why"]

    # no message says so: a call she made that they turned down
    mates._state_event(m["id"], lambda doc, who, now, tz: S.call_unanswered(doc, who, True, 1, now, tz))
    assert why0() == "declined_call"
    assert mates.relation_view(m["id"])["affinity"] == pytest.approx(50 - A.LOSSES["declined_call"][0], abs=0.05)
    # their words brushed her off: it waits for her reply, which shows it landed
    hear = lambda said, mid: (lambda doc, who, now, tz: S.hear(doc, who, said, mid, now, tz))  # noqa: E731
    reply = lambda text, said: (lambda doc, who, now, tz: S.reply(doc, who, text, said, now, tz))  # noqa: E731
    mates._state_event(m["id"], hear("됐어, 관심 없어", "msg_1"))
    assert why0() == "declined_call"
    mates._state_event(m["id"], reply("[sad] ...그래요.", "됐어, 관심 없어"))
    assert why0() == "dismissed"
    # …or that it didn't: she laughed it off, so it costs nothing
    before = mates.relation_view(m["id"])["affinity"]
    mates._state_event(m["id"], hear("됐고 밥이나 먹자", "msg_2"))
    mates._state_event(m["id"], reply("[laugh] 좋아요!", "됐고 밥이나 먹자"))
    assert mates.relation_view(m["id"])["affinity"] == before and why0() == "dismissed"
    assert store.state_doc(m["id"])["owed"] == []


def test_a_gift_she_gets_counts_and_a_recount_keeps_it(db, monkeypatch):
    svc, store, mates = _svc(db)
    m = store.create(name="Gift")
    monkeypatch.setattr(mates.life, "give", lambda mate_id, item: {"code": "ok", "item": {"id": item}, "asleep": True})
    monkeypatch.setattr(mates.life, "note", lambda mate_id, text: None)
    monkeypatch.setattr(mates.life, "view", lambda mate_id: {"enabled": True})
    mates.life_gift(m["id"], "letter")
    v = mates.relation_view(m["id"])
    assert v["log"][0]["why"] == "gift" and v["affinity"] == A.GIFT
    again = mates.relation_reset(m["id"], "recompute")  # (no message says she got it: the relationship kept when)
    assert again["affinity"] == A.GIFT and any(e["why"] == "gift" for e in again["log"])


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
    assert v["enabled"] and v["affinity"] == 0 and v["stats"]["grace_days"] == 2
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
