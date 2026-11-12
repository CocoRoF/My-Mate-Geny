"""서아's day (docs/mate-life.md): a streamer's week — late mornings, evening streams, a market-open show on some weekday
mornings, Wednesday off — that looks after itself, and the things that happen to her."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone

import pytest

from app.mate import state as S
from app.mate.life import profile as P
from app.mate.life import sim
from app.mate.life.runtime import LifeRuntime

KST = timezone(timedelta(hours=9))
MONDAY = datetime(2026, 11, 2, 6, 0, tzinfo=KST)
STREAM_DAYS = (0, 1, 3, 4)  # Monday, Tuesday, Thursday, Friday


@pytest.fixture
def world():
    return P.load("seoa")


def week(world, *, seed="m", days=7, every=15, start=MONDAY):
    doc = sim.new(world, start, KST, seed)
    rows = []
    for i in range(int(days * 24 * 60 / every) + 1):
        now = start + timedelta(minutes=every * i)
        sim.advance(doc, world, now, KST)
        rows.append((now, doc["activity"], doc["place"], dict(doc["needs"]), doc["money"]))
    return doc, rows


def at(rows, day, hour, minute=0):
    return next(r for r in rows if (r[0] - MONDAY).days == day and r[0].hour == hour and r[0].minute == minute)


def test_her_world_is_sound(world):
    assert "rest" in world["activities"] and world["routine"] and len(world["places"]) == 10
    for key, place in world["places"].items():
        assert place["names"]["ko"] and place["names"]["en"] and place["about"], key
        assert key == "street" or (0 <= place["x"] <= 100 and 0 <= place["y"] <= 100), key
    for act in world["activities"].values():
        assert act["names"]["ko"] and act["names"]["en"]
    assert world["job"]["names"] == {"ko": "인터넷 방송인 (스트리머)", "en": "Internet streamer"}
    assert len(world["shop"]) >= 10 and len(world["gifts_to_user"]) >= 10
    assert any(i["id"] == "tteokbokki" for i in world["shop"]) and any(i["id"] == "malatang" for i in world["shop"])


def test_a_streamers_week(world):
    _, rows = week(world)
    for day in STREAM_DAYS:
        assert at(rows, day, 21)[1:3] == ("stream", "home") and at(rows, day, 23, 30)[1] == "stream"
        assert at(rows, day, 19, 30)[1] == "ready_live" and at(rows, day, 19)[1] == "dinner"
    assert at(rows, 5, 21)[1] in ("stream", "collab")  # (Saturday: a longer stream, now and then a collab instead)
    assert at(rows, 2, 21)[1] not in ("stream", "ready_live", "collab")  # (Wednesday: her day off)
    for day in range(7):
        assert at(rows, day, 5)[1] == "sleep"  # (she sleeps late, and long)
    assert at(rows, 0, 0, 30)[1] != "sleep" or at(rows, 1, 0, 30)[1] != "sleep"  # (after a stream she is still up a while)


def test_the_market_show_is_on_some_weekday_mornings_only(world):
    _, rows = week(world, days=28)
    shows = {r[0].date() for r in rows if r[1] == "market_show"}
    assert 3 <= len(shows) <= 17
    assert all(d.weekday() < 5 for d in shows)
    for r in rows:
        if r[1] == "market_show":
            assert (8, 45) <= (r[0].hour, r[0].minute) <= (10, 15)


@pytest.mark.parametrize("seed", ["a", "b", "c", "d"])
def test_she_goes_on_and_looks_after_herself(world, seed):
    doc, rows = week(world, seed=seed, days=28)
    month = Counter(r[1] for r in rows)
    assert month["stream"] > 250 and month["sleep"] > 800
    routine = {"commute", "sleep", "stream", "ready_live", "dinner", "market_show", "collab", "rest"}
    assert len([k for k in month if k not in routine]) >= 8  # (a varied life)
    assert sum(1 for r in rows if r[3]["hunger"] >= 0.9) < len(rows) * 0.01
    assert sum(1 for r in rows if r[3]["sleep"] >= 0.92) < len(rows) * 0.02
    assert doc["money"] > 0 and doc["stats"]["work"] > 55


def test_she_is_never_anywhere_closed(world):
    _, rows = week(world, days=14, every=5)
    for now, activity, place, _needs, _money in rows:
        if activity in ("commute", "rest"):
            continue
        spec = world["places"][place]
        if spec.get("open"):
            assert sim.place_open(spec, now - timedelta(minutes=5)) or sim.place_open(spec, now), (now, activity, place)


def test_her_job_and_her_hours_are_said_plainly(world):
    t = datetime(2026, 11, 4, 15, tzinfo=KST)
    doc = sim.new(world, t, KST, "m")
    text = sim.line(doc, world, t, KST)
    assert "Your job: an internet streamer on LumiTV" in text and "Wednesday is your day off" in text
    assert "on working days" not in text


def test_her_events_are_sound_and_many(world):
    events = world["events"]
    assert len(events) >= 30 and len({e["id"] for e in events}) == len(events)
    for e in events:
        for emotion, strength in (e.get("effects") or {}).get("feel", {}).items():
            assert emotion in S.EMOTIONS and strength in S.STRENGTHS, e["id"]
        assert not any(ch.isdigit() for ch in e["says"]), e["id"]  # (words, never numbers)
    kinds = {(e.get("when") or {}).get("activity") for e in events}
    assert {"stream", "market_show", "collab", "prep"} <= kinds


@pytest.mark.parametrize("event, when, hour", [("stock_jump", 1, 9), ("sub_milestone", 0, 21)])
def test_what_happens_on_stream_happens_there(world, event, when, hour):
    e = next(x for x in world["events"] if x["id"] == event)
    one = {**world, "events": [{**e, "chance": 100.0}]}
    t = datetime(2026, 11, 2 + when, hour, 30, tzinfo=KST)
    doc = sim.new(one, t - timedelta(hours=2), KST, "m")
    doc["born"] = (t - timedelta(days=30)).isoformat()
    doc["stats"]["work"] = 70
    if event == "stock_jump":
        doc["seed"] = next(s for s in map(str, range(200)) if any(
            b["activity"] == "market_show" for b in sim._blocks({**doc, "seed": s}, one, sim._midnight(t))))
    sim.advance(doc, one, t, KST)
    assert doc["fired"].get(event) and doc["activity"] in ("market_show", "stream")


def test_she_dresses_for_the_stream_and_for_bed(monkeypatch):
    world = P.load("seoa")
    worn, calls = {"outfit": "default"}, []

    def wear(mate_id, oid, reason=None):
        calls.append((oid, reason))
        worn["outfit"] = oid

    class Store:
        def get(self, mate_id):
            return {"outfits": {"worn": worn["outfit"]}}

    life = LifeRuntime(Store(), None, None, wear)
    doc: dict = {}
    for key in ("ready_live", "stream", "late_snack", "sleep", "brunch", "market_show", "sleep", "brunch"):
        life._dress("m", doc, world, [{"type": "started", "activity": key}], {})
    assert calls == [("builtin-stream-hoodie", "it's time to go live"), ("default", "the stream is over"),
                     ("builtin-pajamas", "it's time for bed"), ("default", "the day has started"),
                     ("builtin-stream-hoodie", "it's time for the market show"), ("builtin-pajamas", "it's time for bed"),
                     ("default", "the day has started")]
    # straight from one into the other: what she comes back to is what she had on before
    calls.clear()
    for key in ("stream", "sleep", "brunch"):
        life._dress("m", doc, world, [{"type": "started", "activity": key}], {})
    assert [c[0] for c in calls] == ["builtin-stream-hoodie", "builtin-pajamas", "default"]
