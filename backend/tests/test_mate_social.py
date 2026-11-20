"""The user's mates among themselves (app/mate/social, docs/mate-social.md): strangers at first; each knows the user talks with
other mates too; one knows of another when the user tells her, and they get to know each other by messaging — when the user asks,
or on their own when they may reach out. How each feels about the other is the same kind of relationship as with the user, never
warmer than that. The user can read their conversations, and both know when they did. Friends go out together."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.mate import affinity as A
from app.mate.life import profile as P
from app.mate.life import sim
from app.mate.life.runtime import LifeRuntime
from app.mate.social import bonds as B
from app.mate.social import outings as O
from app.mate.social import talk as K
from app.mate.social.runtime import SocialRuntime
from app.mate.store import MateStore
from app.vault import SecretVault

KST = ZoneInfo("Asia/Seoul")


@pytest.fixture
def store(db):
    return MateStore(db, SecretVault(db))


def _mate(store, name, builtin=None, gender="", proactive=False):
    mate = store.create(name=name, persona={"description": f"{name}.", **({"gender": gender} if gender else {})})
    store._db.execute("UPDATE mates SET builtin = ? WHERE id = ?", (builtin, mate["id"]))
    if proactive:
        store.update(mate["id"], {"prefs": {"proactive": {"enabled": True}}})
    return store.get(mate["id"])


def _world(store, monkeypatch):
    monkeypatch.setattr(P, "own", lambda key: key in ("chaerin", "seoa"))
    store.update_settings({"timezone": "Asia/Seoul"})  # (the user's clock, whatever the machine's)
    life = LifeRuntime(store)
    return life, SocialRuntime(store, life)


def _close_to_user(store, mate_id, affinity=60.0):
    r = A.new()
    r["started_at"] = A._iso(datetime.now(timezone.utc) - timedelta(days=30))
    A.set_value(r, affinity, datetime.now(timezone.utc), KST)
    r["trust"], r["romance"] = 70.0, 40.0
    store.save_relation(mate_id, r)


def test_they_start_as_strangers_and_nothing_is_set_up(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    social.tick()
    doc = social.doc()
    assert doc["known"] == {} and doc["rel"] == {} and doc["threads"] == []
    assert social.view(a["id"])["mates"] == []
    prompt = social.prompt(a["id"])
    assert "## Other mates" in prompt and "You don't know any of them yet." in prompt and "서아" not in prompt
    assert "one you only know exists, only when the user asks you to" in prompt


def test_an_old_document_starts_over(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    store._put_setting("social", json.dumps({"v": 1, "at": A._iso(datetime.now(timezone.utc)), "ties": {f"{a['id']}|{b['id']}": {}}}))
    assert social.doc()["known"] == {} and social.doc()["v"] == B.VERSION


def test_she_knows_the_user_talks_with_other_mates(store, monkeypatch, db):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    sid = "sess_seoa"
    db.execute("INSERT INTO sessions (id, title, kind, provider, workspace_path, created_at, updated_at) "
               "VALUES (?, '서아', 'mate', 'claude', '/tmp', ?, ?)", (sid, A._iso(datetime.now(timezone.utc)), A._iso(datetime.now(timezone.utc))))
    store.set_session(b["id"], sid)
    db.execute("INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m1', ?, 'user', '안녕 서아', ?)",
               (sid, A._iso(datetime.now(timezone.utc) - timedelta(hours=2))))
    assert set(social.user_talks_with()[a["id"]]) == {b["id"]}
    lines, ack = social.lines(a["id"])
    assert any("The user also talks with other mates like you lately: 서아" in x for x in lines)
    ack()
    assert not any("also talks with" in x for x in social.lines(a["id"])[0]), "once a day"


def test_the_user_tells_one_about_another(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    assert social.introduce(a["id"], "서아", "방송하는 친구야") == {"code": "ok", "name": "서아"}
    assert social.introduce(a["id"], "없는사람")["code"] == "unknown"
    doc = social.doc()
    assert B.knows(doc, a["id"], b["id"])["how"] == "told" and B.knows(doc, b["id"], a["id"]) is None, "only she knows of her"
    assert "서아: you know of them from the user (“방송하는 친구야”)" in social.prompt(a["id"])
    assert "채린" not in social.prompt(b["id"])
    view = social.view(a["id"])["mates"]
    assert [m["name"] for m in view] == ["서아"] and view[0]["feels"] is None and view[0]["how"] == "told"


async def test_they_get_to_know_each_other_by_talking(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    _close_to_user(store, a["id"])
    _close_to_user(store, b["id"])
    said = iter(["안녕! 채린 언니 맞지? 반가워 ㅎㅎ", "응, 반가워. 다음에 또 얘기하자 [END]"])
    seen_prompts = []

    async def speak(mate, system, content):
        seen_prompts.append((mate["name"], system, json.loads(content)))
        return next(said)

    social.speak = speak
    finals = []
    social.on_event = lambda e, mates: finals.append(e)
    out = social.talk_to(a["id"], "서아", "안녕, 나 채린이야. 그 사람이 너 얘기를 하더라", asked="서아한테 인사해 봐")
    assert out["code"] == "ok"
    assert social.talk_to(a["id"], "서아", "또 안녕")["code"] == "busy"
    await social.converse(out["thread"])
    doc = social.doc()
    t = doc["threads"][-1]
    assert t["status"] == "done" and [m["by"] for m in t["messages"]] == [a["id"], b["id"], a["id"]]
    assert t["messages"][-1]["text"] == "응, 반가워. 다음에 또 얘기하자"
    assert B.knows(doc, a["id"], b["id"])["how"] == "talked" and B.knows(doc, b["id"], a["id"])["how"] == "talked"
    ra, rb = B.rel_of(doc, a["id"], b["id"]), B.rel_of(doc, b["id"], a["id"])
    assert ra and rb and ra["affinity"] > 0 and rb["affinity"] > 0
    # (each wrote as herself, about the other — no "the user comes first": it is theirs)
    name, system, content = seen_prompts[0]
    assert name == "서아" and "You are messaging 채린" in system and "comes first" not in system and "Korean" in system
    assert content["conversation"][0] == {"from": "채린", "text": "안녕, 나 채린이야. 그 사람이 너 얘기를 하더라"}
    assert finals and finals[-1]["type"] == "talk" and finals[-1]["why"] == "asked"
    # (what was said reaches each of them, once)
    lines_b, ack_b = social.lines(b["id"])
    assert any("채린 messaged you" in x and "다음에 또 얘기하자" in x for x in lines_b)
    ack_b()
    assert not any("messaged you" in x for x in social.lines(b["id"])[0])
    lines_a, _ = social.lines(a["id"])
    assert any("you messaged 서아 (the user had asked you to)" in x and "반가워 ㅎㅎ" in x for x in lines_a)
    assert any("채린: you have talked" in x for x in social.prompt(b["id"]).splitlines())


async def test_no_ceiling_between_mates_and_romance_where_it_is_on(store, monkeypatch):
    """Since 2026-11-20 what two mates feel for each other has no ceiling ("the user comes first" is gone), and romance
    between them is a matter of the setting alone — who they are decides the rest."""
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin", gender="female"), _mate(store, "유나", gender="female")
    _close_to_user(store, a["id"], affinity=8.0)
    doc = social.doc()
    now = datetime.now(timezone.utc)
    r = B.heard(doc, a["id"], b["id"], "고마워 정말 최고야 ㅎㅎ", "[smile] 나도", now, KST, name="채린")
    r["affinity"], r["trust"], r["romance"] = 80.0, 80.0, 30.0
    B.fits(r, now, KST)
    assert r["affinity"] == 80.0 and r["trust"] == 80.0 and r["romance"] == 30.0 and r["stage"] == "companion"
    B.drift(doc, now + timedelta(days=1), KST)
    assert B.rel_of(doc, a["id"], b["id"])["affinity"] == 80.0  # (no user to stay below)
    mates = social.mates()
    assert social.romance_fits(mates[a["id"]], mates[b["id"]])  # (two women: their personas decide, not a rule)
    store.update_settings({"social_romance": False})
    assert not social.romance_fits(mates[a["id"]], mates[b["id"]])
    B.fits(r, now, KST, romance=social.store.social_romance())
    assert r["romance"] == 0.0


def test_the_user_reading_it_is_something_both_know(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    now = datetime.now(timezone.utc)
    doc = social.doc()
    t = social._thread(doc, a["id"], b["id"], "own", now)
    t["messages"] = [{"by": a["id"], "text": "서아야 뭐 해?", "at": A._iso(now)}, {"by": b["id"], "text": "방송 준비 중!", "at": A._iso(now)}]
    t["status"] = "done"
    social._save(doc)
    finals = []
    social.on_event = lambda e, mates: finals.append(e)
    view = social.view(a["id"])["mates"][0]
    assert view["threads"][0]["unseen"] == 2
    got = social.seen(a["id"], t["id"])
    assert [m["text"] for m in got["messages"]] == ["서아야 뭐 해?", "방송 준비 중!"]
    assert finals[-1]["type"] == "peeked" and set(finals[-1]["who"]) == {a["id"], b["id"]}
    for m, other in ((a, "서아"), (b, "채린")):
        assert any(f"the user read your conversation with {other}" in x for x in social.lines(m["id"])[0])
    social.seen(b["id"], t["id"])
    assert len([e for e in social.doc()["events"] if e["type"] == "peeked"]) == 1, "only what is new"
    with pytest.raises(KeyError):
        social.seen(_mate(store, "민지")["id"], t["id"])


def test_strangers_only_know_each_other_exist_until_the_user_brings_them_together(store, monkeypatch):
    """Nobody reaches out to a mate she only knows exists; one the user introduced she may greet; once they have talked, they
    write to each other on their own — whatever her 스스로 말 걸기 is — and the closer, the more often."""
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    c = _mate(store, "민지")
    social.speak = lambda *x: None  # (a writer: a conversation can be queued)
    monkeypatch.setattr("app.mate.social.runtime.OWN_HOUR", 1.0)
    monkeypatch.setattr(SocialRuntime, "_someone_talks_to", lambda self, m, now: True)
    monkeypatch.setattr(sim, "asleep", lambda *x: False)
    social.tick(datetime(2026, 11, 21, 14, 5, tzinfo=KST).astimezone(timezone.utc))
    assert social.doc()["threads"] == [], "strangers: they only know the others exist"
    social.introduce(a["id"], "서아")
    social.tick(datetime(2026, 11, 21, 15, 5, tzinfo=KST).astimezone(timezone.utc))
    threads = social.doc()["threads"]
    assert len(threads) == 1 and threads[0]["by"] == a["id"] and threads[0]["why"] == "own" and threads[0]["who"][1] == b["id"]
    assert not any(c["id"] in t["who"] for t in threads), "민지 knows nobody"
    assert "only when the user asks you to" in social.prompt(a["id"]) and "comes first" not in social.prompt(a["id"])
    doc = social.doc()
    doc["threads"] = []
    now = datetime.now(timezone.utc)
    for me, other, aff in ((a["id"], b["id"], 60.0), (b["id"], a["id"], 60.0)):
        B.know(doc, me, other, "talked", now)
        A.set_value(B._rel(doc, me, other, now), aff, now, KST)
    social._save(doc)
    assert social._reach(doc, a["id"], b["id"]) > social._reach(doc, a["id"], c["id"]) == 0
    social.tick(datetime(2026, 11, 22, 15, 5, tzinfo=KST).astimezone(timezone.utc))
    assert any(t["why"] == "own" for t in social.doc()["threads"]), "close: they write to each other on their own"
    A.set_value(B.rel_of(doc, a["id"], b["id"]), -30.0, now, KST)
    assert social._reach(doc, a["id"], b["id"]) == 0.0  # (she dislikes her: not on her own)


def test_friends_make_plans_and_go_out_each_in_her_own_day(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    for m in (a, b):
        _close_to_user(store, m["id"])
    now = datetime(2026, 11, 21, 9, 5, tzinfo=KST).astimezone(timezone.utc)
    doc = social.doc()
    for x, y in ((a, b), (b, a)):
        r = B._rel(doc, x["id"], y["id"], now)
        r["affinity"] = 50.0
        B.know(doc, x["id"], y["id"], "talked", now)
    social._save(doc)
    monkeypatch.setattr(O, "plan_chance", lambda fond: 1.0)
    social.tick(now)
    plans = social.doc()["plans"]
    assert len(plans) == 1
    start, end = A._t(plans[0]["at"]), A._t(plans[0]["until"])
    for m in (a, b):
        d, world = life.advance(m["id"])
        assert sim.free_between(d, world, start, end, store.tz())
    assert any(x.startswith("Plans:") and "서아" in x for x in social.lines(a["id"])[0])
    # (their time comes, they go, it ends)
    monkeypatch.setattr(sim, "asleep", lambda *x: False)
    real = datetime.now(timezone.utc)
    doc = social.doc()
    doc["plans"][0].update(kind="cafe", at=A._iso(real - timedelta(minutes=1)), until=A._iso(real + timedelta(minutes=90)))
    social._save(doc)
    social.tick()
    assert social.doc()["plans"][0]["status"] == "on"
    assert store.get(a["id"])["life"]["with_mate"]["name"] == "서아"
    doc = social.doc()
    doc["plans"][0]["until"] = A._iso(real - timedelta(seconds=1))
    social._save(doc)
    before = B.rel_of(social.doc(), a["id"], b["id"])["affinity"]
    social.tick()
    doc = social.doc()
    e = doc["events"][-1]
    assert e["type"] == "outing" and e["mood"] in O.MOODS and not doc["plans"]
    assert B.rel_of(doc, a["id"], b["id"])["affinity"] != before
    mine = e["own"][a["id"]]["en"]
    assert any(mine in x for x in social.lines(a["id"])[0])
    other = social.view(a["id"])["mates"][0]
    assert other["events"][0]["kind"] == "cafe" and other["feels"]["stage"] in A.STAGES


def test_strangers_and_acquaintances_dont_go_out():
    doc = B.new(datetime.now(timezone.utc))
    assert not B.friends(doc, "a", "b")
    now = datetime.now(timezone.utc)
    B._rel(doc, "a", "b", now)["affinity"] = 40.0
    B._rel(doc, "b", "a", now)["affinity"] = 10.0
    assert not B.friends(doc, "a", "b") and B.friends(doc, "a", "b", at_least=10)


def test_what_comes_back_from_her_engine_is_cleaned():
    assert K.clean("서아: 안녕!! [END]", "서아") == ("안녕!!", True)
    assert K.clean("“응 좋아”") == ("응 좋아", False)
    assert K.clean("[END]") == ("", True)
    assert len(K.clean("가" * 900)[0]) == K.MAX_CHARS


def test_a_mate_gone_leaves_nothing(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    social.introduce(a["id"], "서아")
    store.delete(b["id"])
    social.tick()
    assert social.doc()["known"].get(a["id"], {}) == {}


def test_switched_off_there_is_nothing(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    store.update_settings({"social_on": False})
    assert social.prompt(a["id"]) == "" and social.lines(a["id"])[0] == [] and social.view(a["id"])["enabled"] is False
    assert social.introduce(a["id"], "서아")["code"] == "off" and social.talk_to(a["id"], "서아", "hi")["code"] == "off"


def test_free_time_leaves_out_work_and_sleep():
    world = P.load("chaerin")
    monday = datetime(2026, 11, 16, 12, tzinfo=KST)
    doc = sim.new(world, monday, KST, "mate_t")
    assert not sim.free_between(doc, world, monday.replace(hour=14), monday.replace(hour=15), KST), "at work"
    assert sim.free_between(doc, world, monday.replace(hour=20), monday.replace(hour=21), KST)
    tuesday = monday + timedelta(days=1)
    assert not sim.free_between(doc, world, tuesday.replace(hour=1), tuesday.replace(hour=2), KST), "asleep"
    assert not sim.free_between(doc, world, tuesday.replace(hour=21, minute=30), tuesday.replace(hour=22, minute=30), KST), "raid night"


def test_out_at_the_friends_place_shows_her_picture_of_it():
    chaerin, seoa = P.load("chaerin"), P.load("seoa")
    now = datetime(2026, 11, 21, 15, tzinfo=KST)
    doc = sim.new(chaerin, now, KST, "mate_t")
    art = {s: sim.art(seoa, "noraebang", s) for s in ("morning", "day", "evening", "night")}
    out = sim.meet(doc, chaerin, sim.OUTING, now + timedelta(hours=2), now, KST,
                   friend={"id": "m2", "name": "서아", "kind": "karaoke", "names": {"ko": "노래방", "en": "Karaoke"},
                           "place_names": seoa["places"]["noraebang"]["names"], "art": art, "body": "sing"})
    assert out["code"] == "ok"
    sim.advance(doc, chaerin, now + timedelta(minutes=40), KST)
    summary = sim.summary(doc, chaerin, now + timedelta(minutes=40), KST)
    assert doc["place"] == sim.OUT and summary["art"] == art[sim.slot((now + timedelta(minutes=40)).astimezone(KST))]
    assert summary["with_mate"] == {"id": "m2", "name": "서아", "kind": "karaoke"}
    assert all(p["key"] != sim.OUT for p in sim.view(doc, chaerin, now + timedelta(minutes=40), KST)["places"])
    sim.advance(doc, chaerin, now + timedelta(hours=3), KST)
    assert doc["with_mate"] is None and doc["place"] != sim.OUT


def test_what_they_do_is_in_each_ones_own_day_or_at_the_friends():
    chaerin, seoa = P.load("chaerin"), P.load("seoa")
    k = O.kinds()
    assert O.activity_for(k["cafe"], chaerin) == "dessert" and O.activity_for(k["cafe"], seoa) == "cafe"
    assert O.activity_for(k["karaoke"], chaerin) is None and O.possible(k["karaoke"], [chaerin, seoa], "clear")
    assert not O.possible(k["walk"], [chaerin, seoa], "rain")
    assert O.fill("{a:과} {b:은} 만났다", "채린", "서아") == "채린과 서아는 만났다"


def test_the_light_follows_the_sun_where_the_user_is():
    try:
        sim.REAL["where"] = (37.57, 126.98)  # (Seoul)
        june, december = datetime(2026, 6, 21, tzinfo=KST), datetime(2026, 12, 21, tzinfo=KST)
        assert sim.slot(june.replace(hour=19, minute=30)) == "evening", "a summer evening is still light"
        assert sim.slot(december.replace(hour=18, minute=30)) == "night", "dark by half past six in winter"
        assert sim.season(june) == "summer" and sim.season(december) == "winter"
    finally:
        sim.REAL["where"] = None


async def test_through_the_service_a_peek_touches_how_both_feel(db, tmp_path, monkeypatch):
    from tests.test_mate_life_service import _service

    _, store, mates = _service(db, monkeypatch, tmp_path)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    social = mates.social
    now = datetime.now(timezone.utc)
    doc = social.doc()
    t = social._thread(doc, a["id"], b["id"], "own", now)
    t["messages"] = [{"by": a["id"], "text": "안녕", "at": A._iso(now)}]
    t["status"] = "done"
    social._save(doc)
    social.seen(b["id"], t["id"])
    for m, other in ((a, "서아"), (b, "채린")):
        top = store.get(m["id"])["state"]["top"]
        assert any(x["emotion"] == "shy" and other in str((x.get("why") or {}).get("text") or "") for x in top), top
    assert mates.social.prompt(a["id"]).startswith("## Other mates")


def test_her_bridge_offers_the_mate_tools_when_it_is_on(monkeypatch):
    from app.mate import mcp_bridge

    monkeypatch.setenv("HRH_MATE_SOCIAL", "1")
    names = {t["name"] for t in mcp_bridge.tools()}
    assert {"introduce_friend", "talk_to_mate"} <= names
    monkeypatch.delenv("HRH_MATE_SOCIAL")
    assert "talk_to_mate" not in {t["name"] for t in mcp_bridge.tools()}
