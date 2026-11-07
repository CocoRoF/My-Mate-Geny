"""Her own day (docs/mate-life.md): the world goes on, she looks after herself, and it reaches how she feels and what she is told."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone

import pytest

from app.mate import state as S
from app.mate.life import profile as P
from app.mate.life import sim

KST = timezone(timedelta(hours=9))
MONDAY = datetime(2026, 11, 2, 6, 0, tzinfo=KST)


@pytest.fixture
def world():
    return P.load("chaerin")


def week(world, *, seed="m", days=7, every=15, start=MONDAY):
    doc = sim.new(world, start, KST, seed)
    rows = []
    for i in range(int(days * 24 * 60 / every) + 1):
        now = start + timedelta(minutes=every * i)
        sim.advance(doc, world, now, KST)
        rows.append((now, doc["activity"], doc["place"], dict(doc["needs"]), doc["money"]))
    return doc, rows


def at(rows, weekday, hour, minute=0):
    return next(r for r in rows if r[0].weekday() == weekday and r[0].hour == hour and r[0].minute == minute)


def test_the_bundled_worlds_are_sound():
    for key in ("chaerin", "default"):
        world = P.load(key)
        assert "rest" in world["activities"] and world["routine"]
        for act in world["activities"].values():
            assert act["names"]["ko"] and act["names"]["en"]
        for place in world["places"].values():
            assert place["names"]["ko"] and place["names"]["en"] and place["about"]


def test_a_world_with_a_mistake_in_it_fails_loudly():
    with pytest.raises(ValueError):
        P.check({"places": {"home": {}}, "activities": {"rest": {"place": "nowhere"}}})
    with pytest.raises(ValueError):
        P.check({"places": {"home": {}}, "activities": {"rest": {"place": "home", "needs": {"thirst": 1}}}})
    with pytest.raises(ValueError):
        P.check({"places": {"home": {}}, "activities": {"nap": {"place": "home"}}})


def test_only_a_mate_with_her_own_world_has_a_day_by_default(monkeypatch, world):
    from app.mate.store import MateStore

    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    assert MateStore.life_profile("chaerin", {"life": "auto"}) is world
    assert MateStore.life_profile("chaerin", {"life": "off"}) is None
    assert MateStore.life_profile("mao", {"life": "auto"}) is None
    assert MateStore.life_profile(None, {"life": "on"}) is P.load("default")


def test_a_day_is_the_same_day_however_often_it_is_looked_at(world):
    a, _ = week(world, days=3, every=1)
    b, _ = week(world, days=3, every=60)
    c = sim.new(world, MONDAY, KST, "m")
    sim.advance(c, world, MONDAY + timedelta(days=3), KST)
    assert [e["activity"] for e in c["timeline"]] == [e["activity"] for e in b["timeline"]]
    assert c["activity"] == b["activity"] and c["money"] == b["money"]
    for need in sim.NEEDS:
        assert c["needs"][need] == pytest.approx(b["needs"][need], abs=1e-9)
    assert a["place"] == c["place"]


def test_a_workday_and_a_weekend_are_different_days(world):
    _, rows = week(world)
    for day in range(5):
        assert at(rows, day, 11)[1] == "work" and at(rows, day, 11)[2] == "office"
        assert at(rows, day, 12, 45)[1] == "lunch" and at(rows, day, 12, 45)[2] == "convenience"
        assert at(rows, day, 16)[1] == "work"
    for day in (5, 6):
        for hour in range(10, 18):
            assert at(rows, day, hour)[1] != "work"
    assert at(rows, 1, 22)[1] == "raid" and at(rows, 3, 22)[1] == "raid"
    assert at(rows, 1, 4)[1] == "sleep" and at(rows, 5, 8)[1] == "sleep"


@pytest.mark.parametrize("seed", ["a", "b", "c", "d"])
def test_she_goes_on_and_looks_after_herself(world, seed):
    doc, rows = week(world, seed=seed, days=28)
    months = Counter(r[1] for r in rows)
    assert months["work"] > 300 and months["sleep"] > 500
    assert len([k for k in months if k not in ("commute", "sleep", "work", "lunch", "ready", "rest")]) >= 5  # (a varied life)
    starving = sum(1 for r in rows if r[3]["hunger"] >= 0.9)
    assert starving < len(rows) * 0.01
    assert sum(1 for r in rows if r[3]["sleep"] >= 0.92) < len(rows) * 0.02
    assert doc["money"] > 0
    assert doc["stats"]["work"] > 45


def test_she_is_never_anywhere_closed(world):
    _, rows = week(world, days=14, every=5)
    for now, activity, place, _needs, _money in rows:
        if activity in ("commute", "rest"):
            continue
        spec = world["places"][place]
        window = spec.get("open")
        if window:
            assert sim.place_open(spec, now - timedelta(minutes=5)) or sim.place_open(spec, now), (now, activity, place)


def test_nothing_gets_worse_than_its_ceiling_however_long_she_is_left(world):
    doc = sim.new(world, MONDAY, KST, "m")
    sim.advance(doc, world, MONDAY + timedelta(days=200), KST)
    for need, value in doc["needs"].items():
        assert 0 <= value <= sim.CEILING[need]
    assert len(doc["timeline"]) <= sim.TIMELINE_MAX
    assert doc["at"] == (MONDAY + timedelta(days=200)).astimezone(timezone.utc).isoformat(timespec="seconds")


def test_when_she_has_nothing_left_she_still_eats(world):
    doc = sim.new(world, MONDAY, KST, "m")
    doc["money"] = 0
    world = {**world, "daily_cost": 100000}
    rows = []
    for i in range(1, 24 * 4 * 3):
        now = MONDAY + timedelta(minutes=15 * i)
        sim.advance(doc, world, now, KST)
        doc["money"] = min(doc["money"], 0)
        rows.append(doc["activity"])
    assert "ramen" in rows


def test_a_message_warms_her_and_wakes_her(world):
    night = datetime(2026, 11, 4, 4, 0, tzinfo=KST)
    doc = sim.new(world, night, KST, "m")
    assert doc["activity"] == "sleep" and sim.asleep(doc, world, night)
    doc["needs"]["affection"] = 0.6
    assert sim.heard(doc, world, "m1", night, warm=True) is True
    assert doc["needs"]["affection"] == pytest.approx(0.6 - sim.HEARD_WARM)
    assert not sim.asleep(doc, world, night)
    assert "woke you" in sim.line(doc, world, night, KST, woke=True)
    assert sim.heard(doc, world, "m1", night) is False  # (once)
    assert doc["needs"]["affection"] == pytest.approx(0.6 - sim.HEARD_WARM)
    assert sim.heard(doc, world, "m2", night + timedelta(minutes=5)) is False  # (already up)
    assert sim.asleep(doc, world, night + timedelta(minutes=30))


def test_no_sleep_goes_on_while_she_is_up(world):
    night = datetime(2026, 11, 4, 2, 0, tzinfo=KST)
    doc = sim.new(world, night, KST, "m")
    doc["needs"]["sleep"] = 0.6
    sim.heard(doc, world, "m1", night)
    sim.advance(doc, world, night + timedelta(minutes=20), KST)
    assert doc["needs"]["sleep"] > 0.6
    sim.advance(doc, world, night + timedelta(hours=1), KST)
    assert doc["needs"]["sleep"] < 0.6


def lived(needs=None, feel=None, doing="", asleep=False):
    base = {n: 0.0 for n in sim.NEEDS}
    return {"needs": {**base, **(needs or {})}, "feel": feel or {}, "doing": doing, "asleep": asleep}


def feelings(life, **kw):
    w = S.who(builtin=None, life=life, **kw)
    return S.levels(S.new(), w, datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc), KST)


def test_her_body_comes_out_as_feeling_with_its_reason():
    lv = feelings(lived({"sleep": 0.85}))
    assert lv["sleepy"]["v"] > 0.6 and lv["sleepy"]["why"]["code"] == "tired"
    lv = feelings(lived({"hunger": 0.95}))
    assert 0.25 < lv["angry"]["v"] < 0.4 and lv["angry"]["why"]["code"] == "hungry"
    lv = feelings(lived({"stress": 0.9}))
    assert lv["worried"]["v"] > 0.5 and lv["worried"]["why"]["code"] == "stressed"
    assert lv["angry"]["why"]["code"] == "stressed"
    lv = feelings(lived({"fun": 0.9}))
    assert lv["sad"]["why"]["code"] == "bored"
    lv = feelings(lived({"affection": 0.8}))
    assert lv["lonely"]["v"] == pytest.approx(0.45) and lv["lonely"]["why"]["code"] == "wants_affection"


def test_wanting_warmth_means_nothing_while_the_relationship_is_paused():
    assert feelings(lived({"affection": 0.8}), away=True)["lonely"]["v"] < 0.1


def test_asleep_she_is_sleepy_and_what_she_is_doing_shows():
    assert feelings(lived(asleep=True))["sleepy"]["why"]["code"] == "asleep"
    lv = feelings(lived(feel={"excited": 0.55}, doing="leading the raid"))
    assert lv["excited"]["v"] == 0.55
    assert S.why_for_her(lv["excited"]["why"]) == "you are leading the raid"


def test_a_well_rested_her_is_not_sleepy_late_at_night(monkeypatch):
    monkeypatch.setattr(S, "_late", lambda now, tz: 0.8)
    assert feelings(lived({"sleep": 0.1}))["sleepy"]["v"] < 0.1
    assert feelings(None)["sleepy"]["v"] == 0.8  # (without a day of her own, the hour still counts)


def test_every_reason_has_words_for_her():
    for rules in S.FROM_NEEDS.values():
        for _need, _start, _rate, code in rules:
            assert S.why_for_her({"code": code})
    assert S.why_for_her({"code": "asleep"})


def test_what_she_is_told_is_words_never_numbers(world):
    doc, _ = week(world, days=2)
    doc["needs"].update(hunger=0.8, sleep=0.55, fun=0.32)
    now = MONDAY + timedelta(days=2)
    text = sim.line(doc, world, now, KST)
    assert "badly hungry" in text and "quite tired" in text and "a little bored" in text
    for need in doc["needs"].values():
        assert f"{need:.2f}" not in text and "0." not in text


def test_on_the_way_she_is_on_the_way(world):
    t = datetime(2026, 11, 3, 9, 15, tzinfo=KST)
    doc = sim.new(world, t - timedelta(minutes=30), KST, "m")
    doc.update(activity="commute", place="street", going={"activity": "work", "until": None, "room": None}, until=(t + timedelta(minutes=5)).isoformat())
    assert "on your way to" in sim.line(doc, world, t, KST)
    sim.advance(doc, world, t + timedelta(minutes=10), KST)
    assert doc["place"] == "office" and doc["activity"] == "work"


def test_a_stored_document_survives_a_world_that_changed(world):
    doc = sim.new(world, MONDAY, KST, "m")
    doc["place"], doc["activity"] = "moon", "dancing"
    doc["needs"] = {"hunger": 5}
    doc = sim.normalized(doc, world)
    assert doc["place"] in world["places"] and doc["activity"] is None
    assert doc["needs"]["hunger"] == sim.CEILING["hunger"] and set(doc["needs"]) == set(sim.NEEDS)
    sim.advance(doc, world, MONDAY + timedelta(hours=1), KST)
    assert doc["activity"] in world["activities"]
    assert sim.normalized({"nope": 1}, world) is None


def test_the_view_has_what_the_panel_needs(world):
    doc, _ = week(world, days=1, every=5)
    now = MONDAY + timedelta(days=1)
    sim.advance(doc, world, now + timedelta(hours=2), KST)
    now += timedelta(hours=2)
    v = sim.view(doc, world, now, KST)
    assert v["enabled"] and v["place_name"]["ko"] and v["activity_name"]["ko"] and v["slot"] == "morning"
    assert {p["key"] for p in v["places"]} == set(world["places"])
    assert any(p["here"] for p in v["places"])
    assert v["next"]["activity"] and v["today"]
    assert not next(p for p in v["places"] if p["key"] == "cafe")["open"]  # (08:00)


def test_the_slots_of_a_day():
    assert [sim.slot(datetime(2026, 1, 1, h, 0)) for h in (4, 5, 10, 11, 16, 17, 19, 20, 23)] == [
        "night", "morning", "morning", "day", "day", "evening", "evening", "night", "night"]


def test_the_prompt_has_the_rules_only_with_a_day():
    from app.mate.prompt import base_prompt, context_block, prompt_key

    persona = {"description": "x"}
    assert "## Your day" in base_prompt("A", persona, {}, life=True)
    assert "## Your day" not in base_prompt("A", persona, {})
    assert "never sexual" in base_prompt("A", persona, {}, life=True)
    assert prompt_key("A", persona, 0, {}, life=True) != prompt_key("A", persona, 0, {})
    assert "Your day: here." in context_block(datetime(2026, 1, 1), "UTC", life="Your day: here.")
