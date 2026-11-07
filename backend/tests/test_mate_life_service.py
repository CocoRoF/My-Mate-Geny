"""Her day on the real road: kept in the database, on the mate document, told to her, reset with her memory."""

from __future__ import annotations

import pytest

from app.mate.life import profile as P
from app.mate.life import sim
from app.mate.life.runtime import LifeRuntime
from app.mate.store import MateStore
from app.vault import SecretVault


@pytest.fixture
def store(db):
    return MateStore(db, SecretVault(db))


def _mate(store, builtin=None, life="auto"):
    mate = store.create(name="채린", persona={"description": "x"})
    store._db.execute("UPDATE mates SET builtin = ? WHERE id = ?", (builtin, mate["id"]))
    store.update(mate["id"], {"prefs": {"life": life}})
    return store.get(mate["id"])


def test_she_has_a_day_once_the_clock_has_run(store, monkeypatch):
    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    mate = _mate(store, "chaerin")
    assert mate["life"] == {"enabled": False}  # (reading writes nothing)
    life = LifeRuntime(store)
    seen = []
    store.on_change = lambda reason, mate_id: seen.append((reason, mate_id))
    life.tick()
    assert ("life", mate["id"]) in seen
    mate = store.get(mate["id"])
    assert mate["life"]["enabled"] and mate["life"]["place"] and mate["life"]["activity_name"]["ko"]
    seen.clear()
    life.tick()
    assert seen == []  # (nothing showed: nobody needs to refetch)


def test_a_mate_without_a_world_has_no_day_until_asked(store, monkeypatch):
    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    mate = _mate(store, None)
    life = LifeRuntime(store)
    life.tick()
    assert store.get(mate["id"])["life"] == {"enabled": False}
    assert life.view(mate["id"]) == {"enabled": False}
    assert life.hear(mate["id"], {"id": "m", "content": "hi"}) is None
    store.update(mate["id"], {"prefs": {"life": "on"}})
    assert life.view(mate["id"])["enabled"]
    store.update(mate["id"], {"prefs": {"life": "off"}})
    assert store.get(mate["id"])["life"] == {"enabled": False}
    assert life.view(mate["id"]) == {"enabled": False}


def test_a_message_reaches_her_once_and_warms_her(store, monkeypatch):
    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    mate = _mate(store, "chaerin")
    life = LifeRuntime(store)
    doc, world = life.advance(mate["id"])
    doc["needs"]["affection"] = 0.6
    store.save_life(mate["id"], doc)
    doc, _, _ = life.hear(mate["id"], {"id": "m1", "content": "고마워, 정말 좋아"})
    first = doc["needs"]["affection"]
    assert first < 0.6
    doc, _, _ = life.hear(mate["id"], {"id": "m1", "content": "고마워, 정말 좋아"})
    assert doc["needs"]["affection"] == pytest.approx(first, abs=1e-3)
    assert store.life_doc(mate["id"], world)["heard"] == "m1"


def test_her_needs_reach_the_state_on_the_mate_document(store, monkeypatch):
    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    mate = _mate(store, "chaerin")
    life = LifeRuntime(store)
    doc, world = life.advance(mate["id"])
    doc["needs"].update(hunger=0.95, sleep=0.9)
    store.save_life(mate["id"], doc)
    top = {t["emotion"]: t["why"]["code"] for t in store.get(mate["id"])["state"]["top"]}
    assert top.get("sleepy") == "tired" or doc["activity"] == "sleep"
    assert top.get("angry") == "hungry"
    assert store.state_who(mate["id"])["life"]["needs"]["hunger"] == 0.95


def test_a_memory_wipe_and_a_delete_take_her_day_with_them(store, monkeypatch):
    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    mate = _mate(store, "chaerin")
    life = LifeRuntime(store)
    _, world = life.advance(mate["id"])
    store.wipe_memory(mate["id"])
    assert store.life_doc(mate["id"], world) is None
    life.advance(mate["id"])
    assert store.life_doc(mate["id"], world) is not None
    store.delete(mate["id"])
    assert store._db.query_one("SELECT 1 FROM mate_life WHERE mate_id = ?", (mate["id"],)) is None


def test_one_bad_document_never_stops_the_clock(store, monkeypatch):
    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    a, b = _mate(store, "chaerin"), _mate(store, "chaerin")
    store.save_life(a["id"], {"at": "2026-11-01T00:00:00+00:00", "needs": "nope"})
    logged = []
    LifeRuntime(store, lambda level, message: logged.append(message)).tick()
    assert logged and a["id"] in logged[0]
    assert store.get(b["id"])["life"]["enabled"]


def test_she_is_told_about_her_day_when_it_changed(store, monkeypatch):
    from datetime import datetime, timezone

    from app.mate.service import MateService

    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    mate = _mate(store, "chaerin")

    class Fake:
        life = LifeRuntime(store)
        _users_latest = staticmethod(lambda sid: {"id": "m1", "content": "안녕"})

    st = {}
    now = datetime.now(timezone.utc)
    first = MateService._life_lines(Fake, mate, st, 1, now, store.tz())
    assert first.startswith("Your day: you are ")
    assert MateService._life_lines(Fake, mate, st, 2, now, store.tz()) == ""
    assert MateService._life_lines(Fake, mate, st, 11, now, store.tz()).startswith("Your day")
    mao = _mate(store, None)
    assert MateService._life_lines(Fake, mao, {}, 1, now, store.tz()) == ""
    assert sim.NEEDS


def _service(db, monkeypatch, tmp_path):
    from tests.test_mate_delegation import _setup

    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    return svc, store, mates


async def test_the_tool_holds_only_what_is_not_up_to_her(db, tmp_path, monkeypatch):
    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate = _mate(store, "chaerin")
    mate = store.get(mate["id"])
    tool = mates._tool_do_activity
    with pytest.raises(Exception, match="reason"):
        await tool(mate, "sid", {"activity": "rest"})
    with pytest.raises(Exception, match="no activity"):
        await tool(mate, "sid", {"activity": "fly", "reason": "왜"})
    text = await tool(mate, "sid", {"activity": "rest", "reason": "쉬고 싶어서"})
    assert text.startswith(("Going", "Already"))
    assert store.life_doc(mate["id"], P.load("chaerin"))["plan"]["why"] == "쉬고 싶어서"
    off = _mate(store, None)
    with pytest.raises(Exception, match="switched on"):
        await tool(store.get(off["id"]), "sid", {"activity": "rest", "reason": "왜"})


async def test_she_cannot_bring_them_along_on_a_turn_of_her_own(db, tmp_path, monkeypatch):
    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate = store.get(_mate(store, "chaerin")["id"])
    monkeypatch.setattr(mates, "_users_latest", lambda sid: None)
    await mates._tool_do_activity(mate, "sid", {"activity": "rest", "with_user": True, "reason": "같이"})
    assert not store.life_doc(mate["id"], P.load("chaerin"))["with_user"]


async def test_a_gift_reaches_her_or_waits_for_her(db, tmp_path, monkeypatch):
    svc, store, mates = _service(db, monkeypatch, tmp_path)
    mate = store.get(_mate(store, "chaerin")["id"])
    calls = []
    monkeypatch.setattr(mates._svc, "start_turn", lambda sid, prompt, **kw: calls.append((sid, prompt, kw)))
    store._db.execute("UPDATE mates SET session_id = 'S' WHERE id = ?", (mate["id"],))
    world = P.load("chaerin")
    monkeypatch.setattr(sim, "asleep", lambda *a: False)
    v = mates.life_gift(mate["id"], "letter")
    assert v["coins"] == 450 and calls and "delivery" in calls[0][1] and calls[0][2]["meta"]["internal"]
    assert store.state_doc(mate["id"])["feelings"]["happy"]["why"]["code"] == "gift"
    # busy: she hears with their next message
    from app.services.session_service import TurnBusyError

    def busy(*a, **k):
        raise TurnBusyError("x")

    monkeypatch.setattr(mates._svc, "start_turn", busy)
    mates.life_gift(mate["id"], "coffee")
    assert store.life_doc(mate["id"], world)["notes"]
    # asleep: she doesn't get woken for it
    monkeypatch.setattr(sim, "asleep", lambda *a: True)
    calls.clear()
    monkeypatch.setattr(mates._svc, "start_turn", lambda sid, prompt, **kw: calls.append(prompt))
    mates.life_gift(mate["id"], "coffee")
    assert not calls and len(store.life_doc(mate["id"], world)["notes"]) == 2
    with pytest.raises(Exception, match="no such gift"):
        mates.life_gift(mate["id"], "nope")


def test_what_happens_to_her_moves_how_she_feels(db, tmp_path, monkeypatch):
    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate = store.get(_mate(store, "chaerin")["id"])
    mates._life_happened(mate["id"], [{"id": "x", "title": {"ko": "첫눈이 왔다", "en": "First snow"}, "feel": {"happy": "moderate"}}])
    assert store.state_doc(mate["id"])["feelings"]["happy"]["why"] == {"text": "첫눈이 왔다"}


def test_the_clock_passes_what_happened_on(db, tmp_path, monkeypatch):
    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate = store.get(_mate(store, "chaerin")["id"])
    heard = []
    mates.life.on_events = lambda mate_id, events: heard.append(events)
    world = P.load("chaerin")
    only = {**world, "events": [{"id": "x", "titles": {"ko": "a", "en": "b"}, "says": "s", "chance": 100.0, "when": {}}]}
    monkeypatch.setattr(P, "load", lambda key: only)
    mates.life.advance(mate["id"])
    doc = store.life_doc(mate["id"], only)
    doc["at"] = "2020-01-01T00:00:00+00:00"
    store.save_life(mate["id"], doc)
    mates.life.advance(mate["id"])
    assert heard and heard[0][0]["id"] == "x"
    mates.life.on_events = lambda *a: (_ for _ in ()).throw(RuntimeError("no"))
    doc = store.life_doc(mate["id"], only)
    doc.update(at="2020-01-01T00:00:00+00:00", fired={}, last_event=None)
    store.save_life(mate["id"], doc)
    assert mates.life.advance(mate["id"])  # (what happened stands, whoever hears about it)


def test_a_plan_is_kept(db, tmp_path, monkeypatch):
    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate = store.get(_mate(store, "chaerin")["id"])
    v = mates.life.set_plan(mate["id"], "sat_day", "walk")
    assert v["plan"]["week"] == {"sat_day": "walk"}
    assert store.life_doc(mate["id"], P.load("chaerin"))["week"] == {"sat_day": "walk"}
    with pytest.raises(ValueError):
        mates.life.set_plan(mate["id"], "nope", "walk")


def test_she_changes_for_bed_and_back_unless_someone_changed_her(store, monkeypatch):
    monkeypatch.setattr(P, "own", lambda key: key == "chaerin")
    mate = _mate(store, "chaerin")
    worn = {"outfit": "default"}
    calls = []

    def wear(mate_id, oid, reason=None):
        calls.append(oid)
        worn["outfit"] = oid

    monkeypatch.setattr(store, "get", lambda mate_id: {"outfits": {"worn": worn["outfit"]}})
    life = LifeRuntime(store, None, None, wear)
    world = {"activities": {"sleep": {"wear": "pj"}, "work": {}, "rest": {}}}
    doc = {}
    life._dress("m", doc, world, [{"type": "started", "activity": "sleep"}], {})
    assert calls == ["pj"] and doc["dressed_from"] == {"outfit": "default", "into": "pj"}
    life._dress("m", doc, world, [{"type": "started", "activity": "sleep"}], {})  # (already)
    assert calls == ["pj"]
    life._dress("m", doc, world, [{"type": "moved", "place": "x"}], {})  # (nothing started)
    assert calls == ["pj"]
    life._dress("m", doc, world, [{"type": "started", "activity": "work"}], {})
    assert calls == ["pj", "default"] and not doc["dressed_from"]
    # someone changed her meanwhile: that stays
    calls.clear()
    life._dress("m", doc, world, [{"type": "started", "activity": "sleep"}], {})
    worn["outfit"] = "dress"
    life._dress("m", doc, world, [{"type": "started", "activity": "work"}], {})
    assert calls == ["pj"] and worn["outfit"] == "dress" and not doc["dressed_from"]
    # she doesn't change herself, or they are with her
    calls.clear()
    life._dress("m", {}, world, [{"type": "started", "activity": "sleep"}], {"self_outfit": "off"})
    life._dress("m", {"with_user": "x"}, world, [{"type": "started", "activity": "sleep"}], {})
    assert calls == []


def test_a_wardrobe_problem_never_stops_her_day(store, monkeypatch):
    def wear(*a, **k):
        raise RuntimeError("no such outfit")

    logged = []
    monkeypatch.setattr(store, "get", lambda mate_id: {"outfits": {"worn": "default"}})
    life = LifeRuntime(store, lambda level, m: logged.append(m), None, wear)
    life._dress("m", {}, {"activities": {"sleep": {"wear": "pj"}}}, [{"type": "started", "activity": "sleep"}], {})
    assert logged


# ---- reaching out, her diary ----

def _news(mates, mate, **kw):
    from datetime import datetime, timezone

    return {"type": "event", "id": "x", "at": kw.pop("at", datetime.now(timezone.utc).isoformat()), "title": {"ko": "a", "en": "a"}, "share": kw.pop("share", True), "feel": {}, **kw}


def _reaching(store, mates, monkeypatch, *, enabled=True, asleep=False, running=False):
    mate = store.get(_mate(store, "chaerin")["id"])
    store._db.execute("UPDATE mates SET session_id = 'S' WHERE id = ?", (mate["id"],))
    store.update(mate["id"], {"prefs": {"proactive": {"enabled": enabled}}})
    mates.life.advance(mate["id"])
    monkeypatch.setattr(sim, "asleep", lambda *a: asleep)
    monkeypatch.setattr(mates._svc, "is_running", lambda sid: running)
    calls = []
    monkeypatch.setattr(mates._svc, "start_turn", lambda sid, prompt, **kw: calls.append((prompt, kw)))
    return mate, calls


def test_she_writes_first_about_news_if_she_may(db, tmp_path, monkeypatch):
    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate, calls = _reaching(store, mates, monkeypatch)
    mates._life_reach_out(mate["id"], [_news(mates, mate, share=False)])
    assert calls == []
    mates._life_reach_out(mate["id"], [_news(mates, mate)])
    assert len(calls) == 1 and "[SILENT]" in calls[0][0] and calls[0][1]["meta"] == {"internal": True, "kind": "life_event"}


@pytest.mark.parametrize("kw", [{"enabled": False}, {"asleep": True}, {"running": True}])
def test_she_keeps_it_for_later_when_she_may_not(db, tmp_path, monkeypatch, kw):
    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate, calls = _reaching(store, mates, monkeypatch, **kw)
    mates._life_reach_out(mate["id"], [_news(mates, mate)])
    assert calls == []


def test_old_news_is_not_news(db, tmp_path, monkeypatch):
    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate, calls = _reaching(store, mates, monkeypatch)
    mates._life_reach_out(mate["id"], [_news(mates, mate, at="2020-01-01T00:00:00+00:00")])
    assert calls == []


def test_a_diary_only_for_someone_who_still_talks_to_her():
    from datetime import datetime, timedelta, timezone

    from app.mate.life import diary

    now = datetime(2026, 11, 7, 12, 0, tzinfo=timezone.utc)
    day = {"day": "2026-11-06", "hours": {"work": 8}, "events": []}
    assert diary.due({"days": [day], "heard_at": None}, now) is None
    assert diary.due({"days": [day], "heard_at": (now - timedelta(days=9)).isoformat()}, now) is None
    assert diary.due({"days": [], "heard_at": now.isoformat()}, now) is None
    assert diary.due({"days": [day], "heard_at": now.isoformat()}, now) is day
    assert diary.due({"days": [{**day, "diary": ""}], "heard_at": now.isoformat()}, now) is None  # (tried: once a day is enough)


def test_what_goes_into_her_diary_is_words():
    from app.mate.life import diary

    world = P.load("chaerin")
    got = diary.facts({"hours": {"work": 8.2, "commute": 1, "raid": 2}, "events": ["raid_clear"]}, world, True)
    assert "testing builds" in got["did"][0] and len(got["did"]) == 2
    assert "Skywhale" in got["what_happened"][0] and got["talked_with_the_user_today"] is True
    assert "8.2" not in str(got)


async def test_she_writes_her_diary_and_a_failure_costs_only_that_day(db, tmp_path, monkeypatch):
    from app.mate.life import diary

    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate = store.get(_mate(store, "chaerin")["id"])
    mates.life.advance(mate["id"])
    world = P.load("chaerin")
    doc = store.life_doc(mate["id"], world)
    doc["days"] = [{"day": "2026-11-05", "hours": {"work": 8}, "events": []}, {"day": "2026-11-06", "hours": {"game": 3}, "events": []}]
    store.save_life(mate["id"], doc)

    async def good(*a):
        return "오늘도... 버그 잡았어요."

    monkeypatch.setattr(diary, "write", good)
    await mates._write_diary(mate, doc["days"][-1], world, True)
    assert store.life_doc(mate["id"], world)["days"][-1]["diary"] == "오늘도... 버그 잡았어요."
    assert "diary" not in store.life_doc(mate["id"], world)["days"][0]

    async def bad(*a):
        raise RuntimeError("no login")

    monkeypatch.setattr(diary, "write", bad)
    await mates._write_diary(mate, doc["days"][0], world, True)
    assert store.life_doc(mate["id"], world)["days"][0]["diary"] == ""
    assert mate["id"] not in mates._diaries


def test_new_clips_of_a_bundle_join_a_set_the_user_edited():
    from app.mate.store import with_new_clips

    clip = lambda i, **kw: {"id": i, "kind": "idle", "src": f"asset:x/{i}.mp4", **kw}  # noqa: E731
    old = {"kind": "video", "rig": {"home": "asset:x/n.webp", "clips": [clip("a"), clip("b"), clip("gone")], "stills": {"neutral": "n"}}}
    new = {"kind": "video", "rig": {"home": "asset:x/n.webp", "clips": [clip("a"), clip("b"), clip("gone"), clip("life_eat", kind="life", doing="eat")],
                                    "stills": {"neutral": "n", "sleepy": "s"}}}
    mine = {"kind": "video", "rig": {"home": "asset:x/n.webp", "clips": [clip("a", disabled=True), clip("b")], "stills": {"neutral": "n"}}}
    got = with_new_clips(mine, old, new)
    assert [c["id"] for c in got["rig"]["clips"]] == ["a", "b", "life_eat"]  # (what they took out stays out)
    assert got["rig"]["clips"][0]["disabled"] and got["rig"]["clips"][2]["doing"] == "eat"
    assert got["rig"]["stills"] == {"neutral": "n", "sleepy": "s"}
    assert with_new_clips(got, new, new) == got  # (nothing new: nothing changes)
