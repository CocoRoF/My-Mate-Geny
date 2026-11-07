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
