"""What they are to each other, in her own view (app/mate/gss/ties.py, ties_runtime.py; docs/geny-state-system.md §12): a label
she holds for the user and for each other mate she knows, hers to decide. Close isn't lovers and hurt isn't hate. Once set it
holds: one slip doesn't bring it up, what builds up does, decisive things do. She thinks it over at night, in her own engine, or
says so at the moment (her tool). With another mate the user comes first, and nothing goes further than 썸."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from app.main import app
from app.mate import affinity as A
from app.mate import oneshot
from app.mate.gss import ties as T
from app.mate.social import bonds as B
from test_mate_affinity import _engine, _svc

KST = ZoneInfo("Asia/Seoul")
NOW = datetime(2026, 11, 20, 12, 0, tzinfo=KST)


def _rel(log=(), bonds=()):
    """A relationship whose change log is ``log`` [(when, why, d)] and ``bonds`` [(when, bond, why, d, v)]."""
    r = A.new()
    r["started_at"] = A._iso(NOW - timedelta(days=60))
    r["log"] = [{"at": A._iso(at), "d": d, "why": why, "v": 0.0} for at, why, d in log]
    r["bonds_log"] = [{"at": A._iso(at), "bond": b, "d": d, "why": why, "v": v} for at, b, why, d, v in bonds]
    return r


def _tie(label, days_ago=10, reviewed_days_ago=None):
    t = T.tie_new(NOW - timedelta(days=days_ago), label, "그냥 그래", "night")
    if reviewed_days_ago is not None:
        t["reviewed_at"] = A._iso(NOW - timedelta(days=reviewed_days_ago))
    return t


def _ago(days, hour=15):
    return (NOW - timedelta(days=days)).replace(hour=hour)


def _talk(days, *more):
    """A day of talk: the day's first message, and whatever else happened."""
    return [(_ago(days), "talk", 0.8), *[(_ago(days, 16), why, d) for why, d in more]]


# ---- the label holds ----

def test_one_slip_doesnt_bring_lovers_up_but_what_builds_up_does():
    t = _tie("lovers")
    today = T.her_day(NOW, KST) - timedelta(days=1)
    one = T.days(_rel(_talk(1, ("rude", -1.5), ("warm", 0.25))), KST)
    assert T.due(t, one, today, NOW, KST) is None  # (a rude word on a day of talk: lovers still)
    assert T.pressure(t, one, today, KST) < T.REVIEW_AT
    many = T.days(_rel([x for d in range(1, 8) for x in _talk(d, ("rude", -1.5), ("dismissed", -0.8), ("ignored", -1.0))]), KST)
    assert T.pressure(t, many, today, KST) >= T.REVIEW_AT  # (a week of it, day after day)
    assert T.due(t, many, today, NOW, KST) == "built_up"


def test_what_happened_long_ago_fades_and_warm_days_hold_lovers_up():
    t = _tie("lovers", days_ago=60)
    today = T.her_day(NOW, KST) - timedelta(days=1)
    old = T.days(_rel([x for d in range(40, 47) for x in _talk(d, ("rude", -1.5), ("dismissed", -0.8), ("ignored", -1.0))]), KST)
    recent = T.days(_rel([x for d in range(1, 8) for x in _talk(d, ("rude", -1.5), ("dismissed", -0.8), ("ignored", -1.0))]), KST)
    assert T.pressure(t, old, today, KST) < T.pressure(t, recent, today, KST) / 5
    held = T.days(_rel([x for d in range(1, 8) for x in _talk(d, ("rude", -1.5), ("warm", 0.75), ("smiled", 0.75), ("lively", 0.8))],
                       [(_ago(d, 17), "romance", "romantic", 1.6, 60.0) for d in range(1, 8)]), KST)
    assert T.pressure(t, held, today, KST) < T.pressure(t, recent, today, KST)


def test_something_done_to_her_is_decisive_but_not_for_one_who_already_loathes_them():
    today = T.her_day(NOW, KST) - timedelta(days=1)
    hit = T.days(_rel(_talk(1, ("hostile_violence", -6.0))), KST)
    assert T.due(_tie("lovers"), hit, today, NOW, KST) == "decisive"
    assert T.due(_tie("friend"), hit, today, NOW, KST) == "decisive"
    assert T.due(_tie("loathing"), hit, today, NOW, KST) is None  # (it is what she thinks of them already)


def test_romance_turning_mutual_and_trust_breaking_are_decisive():
    today = T.her_day(NOW, KST) - timedelta(days=1)
    mutual = T.days(_rel(_talk(1), [(_ago(1, 17), "romance", "romantic", 1.6, 56.0)]), KST)
    assert T.due(_tie("close_friend"), mutual, today, NOW, KST) == "decisive"
    broke = T.days(_rel(_talk(1), [(_ago(1, 17), "trust", "promise_broken", -3.0, 23.0)]), KST)
    assert T.due(_tie("lovers"), broke, today, NOW, KST) == "decisive"


def test_good_days_bring_acquaintances_up_to_think_it_over_in_time():
    t = _tie("acquaintance")
    today = T.her_day(NOW, KST) - timedelta(days=1)
    good = lambda n: T.days(_rel([x for d in range(1, n + 1) for x in _talk(d, ("lively", 0.8), ("warm", 0.75), ("smiled", 0.75))]), KST)  # noqa: E731
    assert T.due(t, good(2), today, NOW, KST) is None
    assert T.due(t, good(6), today, NOW, KST) == "built_up"


def test_what_she_already_weighed_counts_for_less_after_a_night_she_kept_it():
    today = T.her_day(NOW, KST) - timedelta(days=1)
    week = T.days(_rel([x for d in range(1, 8) for x in _talk(d, ("rude", -1.5), ("dismissed", -0.8), ("ignored", -1.0))]), KST)
    fresh, weighed = _tie("lovers"), _tie("lovers", reviewed_days_ago=1)
    assert T.pressure(weighed, week, today, KST) < T.pressure(fresh, week, today, KST) * 0.5
    assert T.due(weighed, week, today, NOW, KST) is None


def test_the_day_she_settled_it_is_what_she_decided_on_and_quiet_days_are_nothing():
    today = T.her_day(NOW, KST) - timedelta(days=1)
    t = T.tie_new(_ago(1, 16), "ex", "끝났어", "moment")
    fight = T.days(_rel(_talk(1, ("hostile_threat", -6.0), ("rude", -4.5))), KST)
    assert T.due(t, fight, today, NOW, KST) is None  # (she broke up with them that day, over that)
    assert T.due(_tie("friend"), {}, today, NOW, KST) is None  # (nothing passed between them: nothing to think over)


def test_a_first_impression_once_they_have_met_and_a_while_now_and_then():
    today = T.her_day(NOW, KST) - timedelta(days=1)
    met = T.days(_rel(_talk(1)), KST)
    assert T.due(None, met, today, NOW, KST) == "first"
    assert T.due(None, {}, today, NOW, KST) is None
    assert T.due(T.tie_new(NOW - timedelta(days=3)), met, today, NOW, KST) == "first"  # (still no view of them)
    assert T.due(_tie("friend", days_ago=30), met, today, NOW, KST) == "a_while"
    assert T.due(_tie("friend", days_ago=30, reviewed_days_ago=5), met, today, NOW, KST) is None


def test_her_day_starts_at_four_in_the_morning():
    assert T.her_day(datetime(2026, 11, 20, 1, 30, tzinfo=KST), KST).isoformat() == "2026-11-19"
    assert T.her_day(datetime(2026, 11, 20, 4, 0, tzinfo=KST), KST).isoformat() == "2026-11-20"
    late = T.days(_rel([(datetime(2026, 11, 20, 1, 0, tzinfo=KST), "talk", 0.8)]), KST)
    assert list(late) == [datetime(2026, 11, 19).date()]


# ---- what she can see them as ----

def test_with_another_mate_the_user_comes_first_and_nothing_goes_further_than_a_spark():
    user = T.allowed(with_user=True, romance=True)
    assert set(user) == set(T.LABELS)
    mate = T.allowed(with_user=False, romance=True, user_label="lovers")
    assert "lovers" not in mate and "ex" not in mate and {"crush", "flirting", "close_friend"} <= set(mate)
    plain = T.allowed(with_user=False, romance=False, user_label="lovers")
    assert not set(plain) & set(T.ROMANTIC)
    near = T.allowed(with_user=False, romance=True, user_label="acquaintance")
    assert "friend" not in near and "acquaintance" in near and "rivals" in near  # (never closer than with the user)
    new = T.allowed(with_user=False, romance=True, user_label=None)
    assert "acquaintance" in new  # (acquaintances at least)
    assert "friend" in T.allowed(with_user=False, romance=False, user_label="acquaintance", current="friend")  # (where she is)


def test_her_answer_is_read_and_held_to_what_she_can_choose():
    labels = T.allowed(with_user=True, romance=True)
    got = T.parse('생각해 봤어 {"label": "Best friend", "why": "제일 편한 사람이야.", "thought": ""}', labels)
    assert got == {"label": "close_friend", "why": "제일 편한 사람이야.", "thought": ""}
    assert T.parse('{"label": "lovers"}', T.allowed(with_user=False, romance=True, user_label="lovers")) is None
    assert T.parse("no json", labels) is None and T.parse('{"label": "soulmate"}', labels) is None


def test_what_she_is_told_says_what_they_are_its_way_and_that_it_holds():
    assert T.line(None, NOW, KST) == "" and T.line(T.tie_new(NOW), NOW, KST) == ""
    t = _tie("rivals", days_ago=12)
    line = T.line(t, NOW, KST)
    assert "rivals (앙숙)" in line and "for 12 days" in line and "“그냥 그래”" in line and "needle each other" in line
    assert "settled" in line and "0." not in line  # (never a number of it)
    T.set_label(t, "love_hate", "밉다가도 좋아.", NOW - timedelta(hours=3), "night")
    assert "before, it was rivals" in T.line(t, NOW, KST) and "since today" in T.line(t, NOW, KST)
    T.kept(t, "요즘은 좀 지쳐.", NOW)
    assert "요즘은 좀 지쳐." in T.thought_line(t, NOW) and T.thought_line(t, NOW + timedelta(days=5)) == ""


def test_the_night_request_has_her_view_what_happened_and_today():
    me = {"name": "채린", "persona": {"language": "ko", "description": "Chaerin.", "personality": "Sharp."}}
    t = _tie("friend", days_ago=10)
    rel = _rel([x for d in range(1, 4) for x in _talk(d, ("rude", -1.5))], [(_ago(2, 17), "trust", "promise_broken", -3.0, 40.0)])
    by_day = T.days(rel, KST)
    system, content = T.request(me, t, "built_up", them="the user", with_user=True, labels=T.allowed(with_user=True, romance=True),
                                how="familiar; trust steady", happened=T.story(by_day, T.her_day(NOW, KST)),
                                today=["They: 야", "You: 왜"], now=NOW, tz=KST, diary="오늘은 별로였다.")
    c = json.loads(content)
    assert "Korean" in system and "Chaerin." in system and "- lovers (연인)" in system and "one mistake" in system
    assert c["what_you_two_are_now"]["label"] == "friend" and c["what_you_two_are_now"]["for_days"] == 10
    assert any("they broke a promise" in x for x in c["what_happened_between_you_lately"])
    assert any("they were rude to you" in x for x in c["what_happened_between_you_lately"])
    assert c["today_between_you"] == ["They: 야", "You: 왜"] and c["your_diary_tonight"] == "오늘은 별로였다."


# ---- at work ----

def _answer(monkeypatch, text, seen=None):
    async def ask(mates, mate, system, content, folder, *, timeout_s=90):
        if seen is not None:
            seen.append((mate["id"], system, json.loads(content), folder))
        return text
    monkeypatch.setattr(oneshot, "ask", ask)


def test_her_word_at_the_moment_stands_and_she_is_told_it_and_remembers_it(db):
    svc, store, mates = _svc(db)
    m = store.create(name="Rin", persona={"language": "ko"}, prefs={"user_name": "하렴"})
    sid = mates.conversation(m["id"])["session_id"]
    mates._relation_turn(m["id"], {"input": "안녕", "text": "", "meta": None})
    got = asyncio.run(mates.call_tool({"mate_id": m["id"], "session_id": sid}, "what_we_are",
                                      {"label": "lovers", "reason": "서로 좋아한다고 말했어."}))
    assert got[1] is False and "lovers" in got[0]
    assert mates.ties.label(m["id"]) == "lovers"
    again = asyncio.run(mates.call_tool({"mate_id": m["id"], "session_id": sid}, "what_we_are", {"label": "lovers", "reason": "응"}))
    assert again[0].startswith("Already")
    tie = mates.ties.tie(m["id"], "user")
    assert tie["by"] == "moment" and tie["history"][-1]["from"] == "stranger"
    entries = mates.gss.journal.recent(m["id"], layers=["tie"])
    assert entries and entries[0]["kind"] == "changed" and entries[0]["data"]["to"] == "lovers"
    mems = [x for x in store.memories(m["id"]) if x.get("source") == "gss"]
    assert any("[우리 사이]" in x["text"] and "연인이 되었다" in x["text"] for x in mems)
    req, _ = _engine(mates, m["id"], "오늘 뭐 해?")
    told = mates.gss.journal.recent(m["id"], layers=["told"])[0]["data"]["block"]
    assert "What the two of you are, as you see it: lovers (연인)" in told and "It isn't romantic between you (yet)" not in told
    bad = asyncio.run(mates.call_tool({"mate_id": m["id"], "session_id": sid}, "what_we_are", {"label": "soulmate", "reason": "x"}))
    assert bad[1] is True


def test_at_night_she_thinks_it_over_in_her_own_engine_and_keeps_it_with_her_doubt(db, monkeypatch):
    svc, store, mates = _svc(db)
    m = store.create(name="Rin", persona={"language": "ko"})
    sid = mates.conversation(m["id"])["session_id"]
    mates._relation_turn(m["id"], {"input": "안녕", "text": "", "meta": None})
    seen: list = []
    _answer(monkeypatch, '{"label": "friend", "why": "편하게 얘기하는 사이야.", "thought": ""}', seen)
    day = T.her_day(datetime.now(timezone.utc), store.tz()).isoformat()
    db.execute("INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('msg_t1', ?, 'user', '오늘 고마웠어', ?)",
               (sid, datetime.now(timezone.utc).isoformat()))
    t = asyncio.run(mates.ties.think(m["id"], "user", "first", day))
    assert t["label"] == "friend" and t["by"] == "first" and t["why"] == "편하게 얘기하는 사이야."
    assert seen[0][3] == ".ties" and "They: 오늘 고마웠어" in seen[0][2]["today_between_you"]
    _answer(monkeypatch, '{"label": "friend", "why": "그래도 친구야.", "thought": "요즘 좀 서운해."}')
    t = asyncio.run(mates.ties.think(m["id"], "user", "built_up", day))
    assert t["label"] == "friend" and t["thought"] == "요즘 좀 서운해." and t["why"] == "편하게 얘기하는 사이야."
    assert [e["kind"] for e in mates.gss.journal.recent(m["id"], layers=["tie"])] == ["kept", "changed"]
    _answer(monkeypatch, "글쎄… 잘 모르겠어")  # (no answer she can be held to: it stays)
    assert asyncio.run(mates.ties.think(m["id"], "user", "built_up", day))["label"] == "friend"


def test_her_word_at_the_moment_wins_over_a_night_that_was_still_thinking(db, monkeypatch):
    svc, store, mates = _svc(db)
    m = store.create(name="Rin", persona={"language": "ko"})
    sid = mates.conversation(m["id"])["session_id"]
    day = T.her_day(datetime.now(timezone.utc), store.tz()).isoformat()

    async def slow(mates_, mate, system, content, folder, *, timeout_s=90):
        await mates.call_tool({"mate_id": m["id"], "session_id": sid}, "what_we_are", {"label": "rivals", "reason": "얄미워."})
        return '{"label": "friend", "why": "x", "thought": ""}'
    monkeypatch.setattr(oneshot, "ask", slow)
    t = asyncio.run(mates.ties.think(m["id"], "user", "first", day))
    assert t["label"] == "rivals" and mates.ties.label(m["id"]) == "rivals"


def test_the_clock_seeds_those_she_knew_and_brings_her_night_once_her_day_has_ended(db, monkeypatch):
    svc, store, mates = _svc(db)
    store.update_settings({"timezone": "Asia/Seoul"})
    m = store.create(name="Rin", persona={"language": "ko"})
    mates.conversation(m["id"])
    mates._relation_turn(m["id"], {"input": "안녕", "text": "", "meta": None})
    queued: list = []
    monkeypatch.setattr(mates.ties, "_kick", lambda: queued.extend(mates.ties._queue))
    now = datetime.now(timezone.utc)
    mates.ties.tick(now)
    assert mates.ties.tie(m["id"], "user")["pending"] and queued[0][:3] == (m["id"], "user", "asked")  # (she knew them already)
    mates.ties._queue.clear()
    doc = mates.ties.doc()
    doc["checked"][m["id"]] = (T.her_day(now, KST) - timedelta(days=2)).isoformat()  # (her last night was the night before)
    doc["ties"][m["id"]]["user"]["pending"] = None
    mates.ties._save(doc)
    rel = store.relation_doc(m["id"])
    rel["log"] = [*rel["log"], *[{"at": A._iso(now - timedelta(days=1, hours=d)), "d": -6.0, "why": "hostile_violence", "v": 0}
                                 for d in (0,)]]
    rel["last_active_day"] = (now.astimezone(KST) - timedelta(days=1)).date().isoformat()
    store.save_relation(m["id"], rel)
    doc = mates.ties.doc()
    doc["ties"][m["id"]]["user"].update({"label": "friend", "since": A._iso(now - timedelta(days=20))})
    mates.ties._save(doc)
    queued.clear()
    mates.ties.tick(now)
    assert [q[2] for q in mates.ties._queue] == ["decisive"]
    assert mates.ties.doc()["checked"][m["id"]] == (T.her_day(now, KST) - timedelta(days=1)).isoformat()
    mates.ties._queue.clear()
    mates.ties.tick(now)  # (once a night)
    assert mates.ties._queue == []
    doc = mates.ties.doc()
    doc["ties"][m["id"]]["user"]["pending"] = A._iso(now)
    mates.ties._save(doc)
    mates.ties._doing.add((m["id"], "user"))
    mates.ties.tick(now)  # (she is thinking it over right now: not again on top of it)
    assert mates.ties._queue == []


def test_a_fresh_start_and_a_wiped_memory_leave_no_view_of_them(db):
    svc, store, mates = _svc(db)
    m = store.create(name="Rin", persona={"language": "ko"})
    sid = mates.conversation(m["id"])["session_id"]
    asyncio.run(mates.call_tool({"mate_id": m["id"], "session_id": sid}, "what_we_are", {"label": "close_friend", "reason": "최고야"}))
    assert mates.ties.label(m["id"]) == "close_friend"
    mates.relation_reset(m["id"], "recompute")
    assert mates.ties.label(m["id"]) == "close_friend"  # (a recount isn't a fresh start)
    mates.relation_reset(m["id"], "zero")
    assert mates.ties.label(m["id"]) is None
    asyncio.run(mates.call_tool({"mate_id": m["id"], "session_id": sid}, "what_we_are", {"label": "friend", "reason": "응"}))
    mates.ties.forget(m["id"])
    assert mates.ties.label(m["id"]) is None


def test_with_another_mate_her_view_is_hers_and_goes_into_what_she_is_told_of_her(db):
    svc, store, mates = _svc(db)
    a = store.create(name="채린", persona={"language": "ko", "gender": "female"})
    b = store.create(name="서준", persona={"language": "ko", "gender": "male"})
    sid = mates.conversation(a["id"])["session_id"]
    ctx = {"mate_id": a["id"], "session_id": sid}
    nobody = asyncio.run(mates.call_tool(ctx, "what_we_are", {"label": "rivals", "reason": "x", "with": "누구"}))
    assert nobody[1] is True
    unknown = asyncio.run(mates.call_tool(ctx, "what_we_are", {"label": "rivals", "reason": "x", "with": "서준"}))
    assert unknown[1] is True and "don't know" in unknown[0]
    doc = mates.social.doc()
    B.know(doc, a["id"], b["id"], "talked", datetime.now(timezone.utc))
    B.know(doc, b["id"], a["id"], "talked", datetime.now(timezone.utc))
    mates.social._save(doc)
    asyncio.run(mates.call_tool(ctx, "what_we_are", {"label": "lovers", "reason": "x"}))  # (with the user)
    lovers = asyncio.run(mates.call_tool(ctx, "what_we_are", {"label": "lovers", "reason": "x", "with": "서준"}))
    assert lovers[1] is True and "썸" in lovers[0]
    ok = asyncio.run(mates.call_tool(ctx, "what_we_are", {"label": "rivals", "reason": "만나면 싸워.", "with": "서준"}))
    assert ok[1] is False and mates.ties.label(a["id"], b["id"]) == "rivals"
    assert "what you two are, as you see it: rivals (앙숙)" in mates.social.prompt(a["id"])
    view = mates.social.view(a["id"])["mates"][0]
    assert view["tie"]["label"] == "rivals" and view["tie_back"] is None
    assert mates.social.view(b["id"])["mates"][0]["tie_back"]["label"] == "rivals"
    mates.ties.forget(b["id"])
    assert mates.ties.label(a["id"], b["id"]) is None


def test_the_status_window_reads_it_over_http():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        m = c.post("/api/mates", json={"name": "Ties"}).json()
        got = c.get(f"/api/mates/{m['id']}/ties").json()
        assert got["tie"] is None and "lovers" in got["labels"]
        assert "tie" in c.get(f"/api/mates/{m['id']}/gss").json()
        assert c.get("/api/mates/mate_nobody/ties").status_code == 404
