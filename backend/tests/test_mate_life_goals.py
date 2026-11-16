"""What she wants for herself (docs/mate-life.md, Her goals): her own day moves it, reaching it is a moment of hers and lifts her,
a setback lowers her a little, another comes after a while, and she is told it in words only when it changed or now and then."""

from __future__ import annotations

import copy
import re
from datetime import datetime, timedelta, timezone

import pytest

from app.mate.life import profile as P
from app.mate.life import sim

KST = timezone(timedelta(hours=9))
MONDAY = datetime(2026, 11, 2, 19, 0, tzinfo=KST)


@pytest.fixture
def world():
    return P.load("chaerin")


def _doc(world, at=MONDAY, *wants, seed="m"):
    """Her day with just these goals (none: whatever her pool gave her), resting at home (nothing she does colours her mood)."""
    doc = sim.new(world, at, KST, seed)
    doc.update(place="home", activity="rest")
    if wants:
        doc["goals"] = [_goal(doc, key, at) for key in wants]
    return doc


def _goal(doc, key, at):
    return {"id": key, "since": sim.A._iso(at), "points": 0.0, "from": doc["money"], "step": 0, "moved": None, "setback": None}


def _only(world, event_id):
    """Her world where this one event happens, now."""
    event = next(e for e in world["events"] if e["id"] == event_id)
    return {**world, "events": [{**event, "chance": 100.0, "when": {}}]}


def _goals_line(text):
    """What she is told of her goals (they come last in her day)."""
    return text[text.find("What you want for yourself"):] if "What you want for yourself" in text else ""


@pytest.fixture
def clear(monkeypatch):
    """A clear sky every day: nothing but her goals leans her mood."""
    monkeypatch.setattr(sim, "weather", lambda doc, local: "clear")


def test_the_bundled_goals_are_sound():
    for key in ("chaerin", "seoa", "default"):
        goals = P.load(key)["goals"]
        assert 2 <= len(goals) <= 4 and len({g["id"] for g in goals}) == len(goals)
        for g in goals:
            assert g["names"]["ko"] and g["names"]["en"] and g["about"] and g["reached"]["says"]
            assert not re.search(r"\d", g["about"])  # (what she is told of it has no numbers in it)
    assert {"nest_clear", "gpu_fund"} <= {g["id"] for g in P.load("chaerin")["goals"]}
    assert {"subs_50k", "mic_fund"} <= {g["id"] for g in P.load("seoa")["goals"]}


@pytest.mark.parametrize("wrong", [
    {"hours": {"flying": 1}},
    {"events": {"no_such_event": 2}},
    {"events": {"raid_wipe": -2}},  # (a setback, and nothing saying what one means to her)
    {"target": 0},
    {"reached": {}},
    {"reached": {"says": "x", "feel": {"happy": "a lot"}}},
])
def test_a_goal_with_a_mistake_in_it_fails_loudly(world, wrong):
    doc = copy.deepcopy(world)
    doc["goals"] = [{"id": "g", "names": {"ko": "가", "en": "G"}, "about": "a thing", "target": 5, "reached": {"says": "done"}, **wrong}]
    with pytest.raises(ValueError):
        P.check(doc)
    doc["goals"] = [{**doc["goals"][0], **{"hours": {}, "events": {}, "target": 5, "reached": {"says": "done"}}}]
    P.check(doc)


def test_she_begins_with_a_few_of_her_own_and_the_same_whoever_asks(world):
    a, b = sim.new(world, MONDAY, KST, "m"), sim.new(world, MONDAY, KST, "m")
    assert len(a["goals"]) == sim.GOALS_AT_ONCE and a["goals"] == b["goals"]
    assert {g["id"] for g in a["goals"]} <= {g["id"] for g in world["goals"]}
    cleared = sim.new(world, MONDAY, KST, "m")
    cleared.update(goals=[], flags=["nest_cleared"])
    assert "nest_clear" not in sim._wanted(cleared, world, sim._goal_specs(world), MONDAY)  # (what is done is done)
    cleared.update(flags=[], fired={"raid_clear": sim.A._iso(MONDAY)})
    assert "nest_clear" not in sim._wanted(cleared, world, sim._goal_specs(world), MONDAY)  # (its last step happened, once)


def test_the_hours_she_gives_it_move_it(world):
    doc = _doc(world, MONDAY, "automation")
    sim.decide(doc, world, "study", MONDAY, KST, minutes=240, why="자동화 공부")
    sim.advance(doc, world, MONDAY + timedelta(hours=3), KST)
    goal = doc["goals"][0]
    assert goal["points"] == pytest.approx(3.0, abs=0.01)
    spec = sim._goal_specs(world)["automation"]
    assert sim.goal_progress(doc, spec, goal) == pytest.approx(3.0 / spec["target"], abs=0.001) and goal["step"] == 0
    goal["points"] = spec["target"] * sim.GOAL_STEPS[0] - 0.5
    sim.advance(doc, world, MONDAY + timedelta(hours=3, minutes=40), KST)
    assert goal["step"] == 1 and goal["moved"]  # (a step further: it shows, and lifts her a little)
    assert "getting there" in _goals_line(sim.line(doc, world, MONDAY + timedelta(hours=4), KST))


def test_what_she_saves_moves_it_and_a_last_step_waits_for_its_event(world):
    doc = _doc(world, MONDAY, "gpu_fund")
    spec = sim._goal_specs(world)["gpu_fund"]
    doc["money"] += spec["save"] // 2
    assert sim.goal_progress(doc, spec, doc["goals"][0]) == pytest.approx(0.5)
    doc["money"] += spec["save"] * 3
    assert sim.goal_progress(doc, spec, doc["goals"][0]) == sim.GOAL_CLOSE  # (saved up, but not bought yet)
    out = []
    sim._goals(doc, world, MONDAY, out)
    assert doc["goals"] and not out
    sim._events(doc, _only(world, "new_gpu"), MONDAY + timedelta(minutes=5), KST, "new", out)
    sim._goals(doc, world, MONDAY + timedelta(minutes=5), out)
    assert [e["id"] for e in out if e["type"] == "goal"] == ["gpu_fund"]


def test_reaching_it_is_a_moment_and_lifts_her(world, clear):
    doc = _doc(world, MONDAY, "nest_clear", "dessert_tour")
    t = MONDAY + timedelta(days=2, hours=2)
    out = []
    sim._events(doc, _only(world, "raid_clear"), t, KST, "new", out)
    sim._goals(doc, world, t, out)
    reached = [e for e in out if e["type"] == "goal"]
    assert len(reached) == 1 and reached[0]["id"] == "nest_clear" and reached[0]["share"]
    assert reached[0]["feel"] == {"happy": "moderate"} and reached[0]["title"]["ko"].endswith("하늘고래의 둥지 첫 클리어")
    assert [g["id"] for g in doc["goals"]] == ["dessert_tour"]
    assert doc["goals_done"][-1] == {"id": "nest_clear", "how": "reached", "since": sim.A._iso(MONDAY), "at": sim.A._iso(t)}
    assert [m for m in doc["moments"] if m["kind"] == "goal"] == [{"kind": "goal", "id": "nest_clear", "at": sim.A._iso(t)}]
    assert any("wanted all month" in n["text"] for n in doc["notes"])  # (what it means to her, with their next message)
    life = sim.for_state(doc, world, t + timedelta(hours=1), KST)
    assert life["feel"]["happy"] >= sim.MOODS["goal_reached"]["happy"] and "Skywhale's Nest" in life["doing"]
    assert sim.for_state(doc, world, t + sim.GOAL_FELT + timedelta(hours=1), KST)["feel"].get("happy", 0) < sim.MOODS["goal_reached"]["happy"]
    text = sim.line(doc, world, t + timedelta(hours=1), KST)
    assert "Lately you reached something you had wanted for yourself: Dalmuri's first clear" in text
    moment = next(m for m in sim.view(doc, world, t, KST)["moments"] if m["kind"] == "goal")
    assert moment["title"] == world["goals"][0]["names"]


def test_a_setback_sets_it_back_and_lowers_her_a_little(world, clear):
    doc = _doc(world, MONDAY, "nest_clear")
    doc["goals"][0]["points"] = 10.0
    t = MONDAY + timedelta(days=1, hours=2)
    sim._events(doc, _only(world, "raid_wipe"), t, KST, "new", [])
    goal = doc["goals"][0]
    assert goal["points"] == 7.0 and goal["setback"] == sim.A._iso(t)
    assert any("sets the first clear of Skywhale's Nest back" in n["text"] for n in doc["notes"])
    life = sim.for_state(doc, world, t + timedelta(hours=2), KST)
    assert life["feel"]["sad"] == sim.MOODS["goal_setback"]["sad"] <= sim.MOOD_MAX and "set back" in life["doing"]
    assert "after a setback lately" in _goals_line(sim.line(doc, world, t + timedelta(hours=2), KST))
    assert sim.view(doc, world, t, KST)["goals"][0]["setback"]


def test_a_finished_one_is_followed_by_another_after_a_while(world):
    doc = _doc(world, MONDAY, "nest_clear", "dessert_tour")
    doc["goals"][0]["finished"] = True
    sim._goals(doc, world, MONDAY, [])
    due = sim.A._t(doc["goals_due"][0])
    assert timedelta(days=sim.GOAL_REST[0]) <= due - MONDAY <= timedelta(days=sim.GOAL_REST[1])
    sim._goals(doc, world, due - timedelta(minutes=5), [])
    assert [g["id"] for g in doc["goals"]] == ["dessert_tour"]  # (not a treadmill)
    sim._goals(doc, world, due, [])
    assert len(doc["goals"]) == 2 and doc["goals"][1]["id"] in ("gpu_fund", "automation") and not doc["goals_due"]
    doc["goals"][1]["finished"] = True  # (and the next one, after a while of its own)
    sim._goals(doc, world, due + timedelta(days=1), [])
    assert len(doc["goals"]) == 1 and len(doc["goals_due"]) == 1


def test_one_she_reached_comes_back_only_after_its_days(world):
    doc = _doc(world, MONDAY, "dessert_tour")
    doc["goals"][0]["finished"] = True
    sim._goals(doc, world, MONDAY, [])
    specs = sim._goal_specs(world)
    doc["goals"] = []
    assert "dessert_tour" not in sim._wanted(doc, world, specs, MONDAY + timedelta(days=30))
    assert "dessert_tour" in sim._wanted(doc, world, specs, MONDAY + timedelta(days=specs["dessert_tour"]["repeat_days"]))


def test_what_did_not_come_together_she_lets_go_of_quietly(world):
    doc = _doc(world, MONDAY, "automation")
    days = sim._goal_specs(world)["automation"]["days"]
    out = []
    sim._goals(doc, world, MONDAY + timedelta(days=days), out)
    assert doc["goals_done"][-1]["how"] == "let_go" and not out and not [m for m in doc["moments"] if m["kind"] == "goal"]
    assert any("let go of learning test automation" in n["text"] for n in doc["notes"])
    assert "automation" not in sim._wanted(doc, world, sim._goal_specs(world), MONDAY + timedelta(days=days + 10))


def test_she_works_towards_it_in_her_free_time_unless_hungry_or_tired(world):
    doc = _doc(world, MONDAY, "automation")
    plain = _doc(world, MONDAY)
    plain["goals"] = []
    study = world["activities"]["study"]
    for d in (doc, plain):
        d["needs"].update(hunger=0.2, sleep=0.2)
    lean = sim._score(doc, world, "study", study, MONDAY, KST) - sim._score(plain, world, "study", study, MONDAY, KST)
    assert lean == pytest.approx(sim.GOAL_LEAN)
    doc["needs"]["hunger"] = plain["needs"]["hunger"] = 0.6
    assert sim._score(doc, world, "study", study, MONDAY, KST) == pytest.approx(sim._score(plain, world, "study", study, MONDAY, KST))


def test_she_is_told_only_when_it_changed_or_now_and_then(world, monkeypatch):
    monkeypatch.setattr(sim, "GOAL_NOW_AND_THEN", 0.0)
    doc = _doc(world, MONDAY, "automation", "dessert_tour")
    first = _goals_line(sim.line(doc, world, MONDAY, KST))
    assert "learning test automation" in first and "just begun" in first and "never list these goals" in first
    assert not re.search(r"\d", first)  # (words, never numbers)
    later = MONDAY + timedelta(days=3)
    before = sim.signature(doc)
    assert _goals_line(sim.line(doc, world, later, KST)) == ""
    doc["goals"][1]["points"] = sim._goal_specs(world)["dessert_tour"]["target"] * 0.65
    sim._goals(doc, world, later, [])
    assert sim.signature(doc) != before  # (she is told again)
    assert "well along" in _goals_line(sim.line(doc, world, later + timedelta(hours=1), KST))
    assert _goals_line(sim.line(doc, world, later + sim.GOAL_TOLD + timedelta(hours=1), KST)) == ""
    monkeypatch.setattr(sim, "GOAL_NOW_AND_THEN", 1.0)
    assert _goals_line(sim.line(doc, world, later + timedelta(days=5), KST))  # (and now and then besides)
    monkeypatch.setattr(sim, "GOAL_NOW_AND_THEN", 0.2)
    told = [sim.goals_told(doc, later + timedelta(days=d), KST) for d in range(2, 62)]
    assert 0 < sum(told) < len(told) / 2


def test_a_day_with_goals_is_the_same_day_however_often_it_is_looked_at(world):
    every_hour = sim.new(world, MONDAY, KST, "m")
    for h in range(1, 10 * 24 + 1):
        sim.advance(every_hour, world, MONDAY + timedelta(hours=h), KST)
    at_once = sim.new(world, MONDAY, KST, "m")
    sim.advance(at_once, world, MONDAY + timedelta(days=10), KST)
    assert [(g["id"], g["step"], g["since"]) for g in every_hour["goals"]] == [(g["id"], g["step"], g["since"]) for g in at_once["goals"]]
    for a, b in zip(every_hour["goals"], at_once["goals"]):
        assert a["points"] == pytest.approx(b["points"], abs=1e-9)
    assert every_hour["goals_done"] == at_once["goals_done"] and every_hour["goals_due"] == at_once["goals_due"]
    assert any(g["points"] > 0 or g["id"] == "gpu_fund" for g in at_once["goals"])


def test_a_stored_document_keeps_her_goals_sound(world):
    doc = _doc(world, MONDAY, "automation")
    doc["goals"].append({"id": "moonwalk", "since": sim.A._iso(MONDAY)})
    doc["goals_due"] = [None, 3]
    doc = sim.normalized(doc, world)
    assert [g["id"] for g in doc["goals"]] == ["automation"] and doc["goals_due"] == []
    old = sim.new(world, MONDAY, KST, "m")
    for key in ("goals", "goals_done", "goals_due"):
        old.pop(key)
    old = sim.normalized(old, world)
    sim.advance(old, world, MONDAY + timedelta(minutes=10), KST)
    assert len(old["goals"]) == sim.GOALS_AT_ONCE  # (a day from before goals has her first ones at once)


def test_the_view_has_a_bar_for_each(world):
    doc = _doc(world, MONDAY, "automation", "gpu_fund")
    doc["goals"][0]["points"] = 12.0
    v = sim.view(doc, world, MONDAY, KST)["goals"]
    assert [g["id"] for g in v] == ["automation", "gpu_fund"]
    assert v[0]["name"]["ko"] == "테스트 자동화 익히기" and v[0]["progress"] == pytest.approx(0.4) and v[1]["progress"] == 0.0
    assert {"step", "since", "setback"} <= set(v[0])


def test_the_clock_passes_a_goal_she_reached_on(db, monkeypatch):
    from app.mate.life.runtime import LifeRuntime
    from app.mate.store import MateStore
    from app.vault import SecretVault

    store = MateStore(db, SecretVault(db))
    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    mate = store.create(name="채린", persona={"description": "x"})
    store._db.execute("UPDATE mates SET builtin = ? WHERE id = ?", ("chaerin", mate["id"]))
    store.update(mate["id"], {"prefs": {"life": "auto"}})
    heard = []
    life = LifeRuntime(store, on_events=lambda mate_id, events: heard.append(events))
    doc, profile = life.advance(mate["id"])
    doc["goals"][0]["finished"] = True
    doc["at"] = sim.A._iso(sim.A._t(doc["at"]) - timedelta(minutes=10))
    store.save_life(mate["id"], doc)
    life.advance(mate["id"])
    goal = next(e for batch in heard for e in batch if e["type"] == "goal")
    assert goal["id"] == doc["goals"][0]["id"] and goal["share"] and goal["feel"]
