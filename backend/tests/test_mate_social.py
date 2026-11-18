"""The user's mates among themselves (app/mate/social, docs/mate-social.md): the built-in ones know each other, anyone else meets
them over time or is introduced; they make plans in time both have free, go out (each in her own day), and afterwards both
remember it, each with a part only she knows; how it went moves the tie; a spark only where it fits."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.mate import affinity as A
from app.mate.life import profile as P
from app.mate.life import sim
from app.mate.life.runtime import LifeRuntime
from app.mate.social import outings as O
from app.mate.social import ties as T
from app.mate.social.runtime import SocialRuntime
from app.mate.store import MateStore
from app.vault import SecretVault

KST = ZoneInfo("Asia/Seoul")


@pytest.fixture
def store(db):
    return MateStore(db, SecretVault(db))


def _mate(store, name, builtin=None, gender=""):
    mate = store.create(name=name, persona={"description": f"{name}.", **({"gender": gender} if gender else {})})
    store._db.execute("UPDATE mates SET builtin = ? WHERE id = ?", (builtin, mate["id"]))
    return store.get(mate["id"])


def _world(store, monkeypatch):
    monkeypatch.setattr(P, "own", lambda key: key in ("chaerin", "seoa"))
    life = LifeRuntime(store)
    return life, SocialRuntime(store, life)


def test_the_built_in_mates_know_each_other_from_the_start(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    chaerin, seoa, other = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa"), _mate(store, "민지")
    social.tick()
    doc = social.doc()
    tie = T.tie_of(doc, chaerin["id"], seoa["id"])
    assert tie and tie["how"] == "builtin" and T.stage(tie) == "close"
    assert "달무리" in tie["story"]["ko"] and tie["fond"][seoa["id"]] > tie["fond"][chaerin["id"]]
    assert T.tie_of(doc, chaerin["id"], other["id"]) is None, "someone new knows nobody yet"
    view = social.view(chaerin["id"])
    assert [t["name"] for t in view["ties"]] == ["서아"] and view["ties"][0]["stage"] == "close"
    prompt = social.prompt(chaerin["id"])
    assert "## People in your life" in prompt and "서아: a close friend of yours" in prompt and "introduce_friend" in prompt
    assert social.prompt(other["id"]) == ""


def test_someone_new_meets_them_over_time(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "민지")
    social.tick()
    doc = social.doc()
    doc["seen"] = {m: A._iso(datetime.now(timezone.utc) - timedelta(days=5)) for m in doc["seen"]}
    doc["checked"] = {}
    social._save(doc)
    monkeypatch.setattr(O, "MEET_DAY", 1.0)
    monkeypatch.setattr("app.mate.social.runtime.DAILY_HOURS", (0, 0))
    social.tick()
    tie = T.tie_of(social.doc(), a["id"], b["id"])
    assert tie and tie["how"] == "met" and T.stage(tie) == "acquainted"
    lines, told = social.lines(b["id"])
    assert any("you got to know 채린" in x for x in lines)
    told()
    assert not any("got to know" in x for x in social.lines(b["id"])[0]), "news is told once"


def test_the_user_introduces_one_to_another(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "민지")
    out = social.introduce(a["id"], "민지", "둘이 잘 맞을 것 같아")
    assert out == {"code": "ok", "name": "민지", "stage": "acquainted"}
    assert social.introduce(a["id"], "민지")["code"] == "known"
    assert social.introduce(a["id"], "없는사람")["code"] == "unknown"
    tie = T.tie_of(social.doc(), a["id"], b["id"])
    assert tie["how"] == "introduced" and T.boosted(tie, datetime.now(timezone.utc))
    theirs = " ".join(social.lines(b["id"])[0])
    assert "the user told 채린 about you" in theirs and "둘이 잘 맞을 것 같아" in theirs
    assert not social.lines(a["id"])[0], "she was there: nothing to tell her"
    assert "The user introduced you." in social.prompt(b["id"])


def _plan(social, a, b, kind, start, end):
    doc = social.doc()
    doc["plans"] = [{"id": "sp_t", "who": [a, b], "kind": kind, "at": A._iso(start), "until": A._iso(end), "status": "planned",
                     "made": A._iso(start), "postponed": 0, "by": a}]
    social._save(doc)


def test_an_outing_moves_both_days_and_both_remember_it_each_their_own_way(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    social.tick()
    for m in (a, b):  # (both up and about)
        doc, world = life.advance(m["id"])
        doc["activity"], doc["place"] = "rest", "home"
        store.save_life(m["id"], doc)
    monkeypatch.setattr(sim, "asleep", lambda *x: False)
    now = datetime.now(timezone.utc)
    _plan(social, a["id"], b["id"], "cafe", now - timedelta(minutes=1), now + timedelta(minutes=90))
    social.tick()
    assert social.doc()["plans"][0]["status"] == "on"
    for m, place in ((a, "cafe"), (b, "cafe")):
        doc = store.life_doc(m["id"], P.load(m["builtin"]))
        assert doc["with_mate"]["id"] == (b if m is a else a)["id"]
        summary = store.get(m["id"])["life"]
        assert summary["with_mate"]["name"] == ("서아" if m is a else "채린")
        assert "right now" in sim.line(doc, P.load(m["builtin"]), now, KST)
    doc = social.doc()
    doc["plans"][0]["until"] = A._iso(now - timedelta(seconds=1))
    social._save(doc)
    social.tick()
    doc = social.doc()
    assert not doc["plans"]
    e = doc["events"][-1]
    assert e["type"] == "outing" and e["ready"] and e["mood"] in O.MOODS
    mine, hers = e["own"][a["id"]]["en"], e["own"][b["id"]]["en"]
    said_a = " ".join(social.lines(a["id"])[0])
    said_b = " ".join(social.lines(b["id"])[0])
    assert e["text"]["en"] in said_a and e["text"]["en"] in said_b, "what they did they both know"
    assert mine in said_a and (mine == hers or mine not in said_b), "her own part is hers"
    tie = T.tie_of(doc, a["id"], b["id"])
    assert tie["together"] == 1 and tie["last"] and tie["log"][-1]["why"].startswith("outing:")
    view = social.view(a["id"])
    assert view["events"][0]["kind"] == "cafe" and view["events"][0]["own"]["ko"]


def test_a_mate_asleep_at_the_time_misses_it(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    social.tick()
    monkeypatch.setattr(sim, "asleep", lambda doc, profile, now: doc.get("seed") == a["id"])
    now = datetime.now(timezone.utc)
    _plan(social, a["id"], b["id"], "cafe", now - timedelta(minutes=1), now + timedelta(minutes=90))
    social.tick()
    doc = social.doc()
    assert not doc["plans"] and doc["events"][-1]["type"] == "called_off" and doc["events"][-1]["by"] == a["id"]
    assert any("you overslept" in x for x in social.lines(a["id"])[0])
    assert any("couldn't make your plans" in x for x in social.lines(b["id"])[0])


def test_friends_make_plans_in_time_both_have_free(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    social.tick()
    monkeypatch.setattr(O, "plan_chance", lambda tie, now: 1.0)
    doc = social.doc()
    doc["checked"] = {}
    social._save(doc)
    now = datetime(2026, 11, 21, 9, 5, tzinfo=KST).astimezone(timezone.utc)  # (a Saturday morning: both are free later on)
    social.tick(now)
    plans = social.doc()["plans"]
    assert len(plans) == 1 and plans[0]["status"] == "planned"
    start, end = A._t(plans[0]["at"]), A._t(plans[0]["until"])
    assert now + O.AHEAD_MIN - timedelta(minutes=1) <= start <= now + O.AHEAD_MAX + timedelta(minutes=30)
    for m in (a, b):
        doc, world = life.advance(m["id"])
        assert sim.free_between(doc, world, start, end, store.tz())
    assert any(x.startswith("Plans:") and "서아" in x for x in social.lines(a["id"])[0])


def test_free_time_leaves_out_work_and_sleep():
    world = P.load("chaerin")
    monday = datetime(2026, 11, 16, 12, tzinfo=KST)
    doc = sim.new(world, monday, KST, "mate_t")
    assert not sim.free_between(doc, world, monday.replace(hour=14), monday.replace(hour=15), KST), "at work"
    assert sim.free_between(doc, world, monday.replace(hour=20), monday.replace(hour=21), KST)
    tuesday = monday + timedelta(days=1)
    assert not sim.free_between(doc, world, tuesday.replace(hour=1), tuesday.replace(hour=2), KST), "asleep"
    assert not sim.free_between(doc, world, tuesday.replace(hour=21, minute=30), tuesday.replace(hour=22, minute=30), KST), "raid night"
    assert not sim.free_between(doc, world, monday.replace(hour=23, minute=50), tuesday.replace(hour=0, minute=50), KST), "past bedtime"
    saturday = datetime(2026, 11, 21, 14, tzinfo=KST)
    assert sim.free_between(doc, world, saturday, saturday + timedelta(hours=2), KST) or any(
        b["activity"] == "overtime" for b in sim._blocks(doc, world, saturday))


def test_what_they_do_is_in_each_ones_own_day_or_at_the_friends():
    chaerin, seoa = P.load("chaerin"), P.load("seoa")
    k = O.kinds()
    assert O.activity_for(k["cafe"], chaerin) == "dessert" and O.activity_for(k["cafe"], seoa) == "cafe"
    assert O.activity_for(k["karaoke"], chaerin) is None and O.activity_for(k["karaoke"], seoa) == "karaoke"
    assert O.activity_for(k["call"], seoa) == "rest"
    assert O.possible(k["karaoke"], [chaerin, seoa], "clear"), "out at hers"
    assert not O.possible(k["walk"], [chaerin, seoa], "rain"), "not out of doors in the rain"
    assert O.possible(k["online"], [chaerin, None], "clear")
    for profile in (chaerin, seoa):
        assert sim.OUT in profile["places"] and profile["places"][sim.OUT]["hidden"] and sim.OUTING in profile["activities"]


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
    assert summary["place_name"] == seoa["places"]["noraebang"]["names"] and summary["body"] == "sing"
    assert summary["with_mate"] == {"id": "m2", "name": "서아", "kind": "karaoke"}
    assert all(p["key"] != sim.OUT for p in sim.view(doc, chaerin, now + timedelta(minutes=40), KST)["places"]), "never on her map"
    sim.advance(doc, chaerin, now + timedelta(hours=3), KST)
    assert doc["with_mate"] is None and doc["place"] != sim.OUT


def test_a_spark_only_between_a_man_and_a_woman_and_only_when_it_is_on(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b, c = _mate(store, "채린", gender="female"), _mate(store, "준호", gender="male"), _mate(store, "서아", gender="female")
    mates = social.mates()
    assert social.romance_fits(mates[a["id"]], mates[b["id"]]) and not social.romance_fits(mates[a["id"]], mates[c["id"]])
    store.update_settings({"social_romance": False})
    assert not social.romance_fits(mates[a["id"]], mates[b["id"]])
    store.update_settings({"social_romance": True})
    social.introduce(a["id"], "준호")
    doc = social.doc()
    tie = T.tie_of(doc, a["id"], b["id"])
    tie["spark"][a["id"]] = 50.0
    social._save(doc)
    assert "quiet crush on 준호" in social.prompt(a["id"]) and "crush" not in social.prompt(b["id"])
    assert social.view(a["id"])["ties"][0]["spark"] == "crush" and social.view(b["id"])["ties"][0]["spark"] == "theirs"
    store.update_settings({"social_romance": False})
    assert "crush" not in social.prompt(a["id"]) and social.view(a["id"])["ties"][0]["spark"] == "none"


def test_switched_off_there_is_nothing(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    social.tick()
    store.update_settings({"social_on": False})
    assert store.settings()["social_on"] is False
    assert social.prompt(a["id"]) == "" and social.lines(a["id"])[0] == [] and social.view(a["id"])["enabled"] is False
    assert social.introduce(a["id"], "서아")["code"] == "off"


def test_time_apart_cools_them_a_little_and_a_mate_gone_leaves_nothing(store, monkeypatch):
    life, social = _world(store, monkeypatch)
    a, b = _mate(store, "채린", "chaerin"), _mate(store, "서아", "seoa")
    social.tick()
    doc = social.doc()
    tie = T.tie_of(doc, a["id"], b["id"])
    tie["last"] = A._iso(datetime.now(timezone.utc) - timedelta(days=40))
    doc["drift_day"] = (datetime.now(KST) - timedelta(days=30)).strftime("%Y-%m-%d")
    before = tie["close"]
    T.drift(doc, datetime.now(timezone.utc), KST)
    assert T.CLOSE_FLOOR["builtin"] <= tie["close"] < before
    store.delete(b["id"])
    social.tick()
    assert social.doc()["ties"] == {}


def test_a_message_line_puts_the_right_particles():
    assert O.fill("{a:과} {b:은} 만났다", "채린", "서아") == "채린과 서아는 만났다"
    assert O.fill("{a:이} {b}에게", "서아", "민준") == "서아가 민준에게"
    for kind in O.kinds().values():
        assert kind["names"]["ko"] and kind["names"]["en"]
    for pair in O.builtin_pairs():
        assert pair["story"]["ko"] and pair["story"]["en"] and set(pair["fond"]) == set(pair["mates"])


def test_the_light_follows_the_sun_where_the_user_is():
    try:
        sim.REAL["where"] = (37.57, 126.98)  # (Seoul)
        june, december = datetime(2026, 6, 21, tzinfo=KST), datetime(2026, 12, 21, tzinfo=KST)
        assert sim.slot(june.replace(hour=19, minute=30)) == "evening", "a summer evening is still light"
        assert sim.slot(june.replace(hour=18)) == "day"
        assert sim.slot(december.replace(hour=18, minute=30)) == "night", "dark by half past six in winter"
        assert sim.slot(december.replace(hour=16, minute=30)) == "evening"
        assert sim.slot(december.replace(hour=7)) == "night" and sim.slot(december.replace(hour=8)) == "morning"
        assert sim.season(june) == "summer" and sim.season(december) == "winter"
    finally:
        sim.REAL["where"] = None
    assert sim.slot(datetime(2026, 12, 21, 18, 30, tzinfo=KST)) == "evening", "without a place: by the clock"
