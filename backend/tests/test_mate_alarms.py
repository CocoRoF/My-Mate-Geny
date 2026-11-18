"""Her calls they asked for (app/mate/alarms.py, app/services/done_notify.py, docs/mate-calls.md "Alarms"): an alarm set
with her rings at its time on the device they are on — again on every device when it rang out, a message when it never
was answered —, a chat's "tell me when it's done" becomes her call with what it did, and none of it is her feelings'
business. The call's engine is the stand-in of test_mate_calls; the clock is the test's."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.mate import alarms as alarms_mod
from app.mate.alarms import parse_when
from app.services.done_notify import DoneNotify
from tests.test_mate_calls import _stack, _wait

SEOUL = ZoneInfo("Asia/Seoul")


class Clock:
    def __init__(self, at: datetime) -> None:
        self.t = at.timestamp()

    def __call__(self) -> float:
        return self.t

    def move(self, seconds: float) -> None:
        self.t += seconds


def _window(mates, device: str, native: str, *, surface: str = "console", calls: int = 1, active: bool = True):
    out: list = []
    broker = mates.capture
    conn = broker.connect(out.append)
    broker.hello(conn, {"type": "client", "device": device, "native": native, "calls": calls, "surface": surface,
                        "active": active, "screen_policy": {"enabled": False}})
    return out


def _rings(out):
    return [m["data"] for m in out if m.get("type") == "call.ring"]


def test_when_an_alarm_is_for():
    now = datetime(2026, 11, 18, 1, 30, tzinfo=timezone.utc)  # 10:30 in Seoul
    # (HH:MM: the next time it is that — 09:00 has passed today, so tomorrow's; 23:00 is tonight)
    assert parse_when("09:00", now, SEOUL) == datetime(2026, 11, 19, 0, 0, tzinfo=timezone.utc)
    assert parse_when("23:00", now, SEOUL) == datetime(2026, 11, 18, 14, 0, tzinfo=timezone.utc)
    assert parse_when("+30", now, SEOUL) == now + timedelta(minutes=30)
    assert parse_when("+2h", now, SEOUL) == now + timedelta(hours=2)
    assert parse_when("2026-11-20 07:15", now, SEOUL) == datetime(2026, 11, 19, 22, 15, tzinfo=timezone.utc)
    for bad, says in (("2026-11-17 09:00", "already passed"), ("+50000", "30 days"), ("soon", "can't read"), ("", "say when")):
        with pytest.raises(ValueError) as e:
            parse_when(bad, now, SEOUL)
        assert says in str(e.value), (bad, str(e.value))


async def test_an_alarm_rings_where_they_are_then_everywhere_then_she_leaves_a_message(db, tmp_path, monkeypatch):
    clock = Clock(datetime(2026, 11, 18, 0, 0, tzinfo=timezone.utc))  # 09:00 in Seoul
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch, clock=clock)
    mate = store.create(name="Haru", persona={"language": "ko"}, llm={"model": "m1"})
    mates.conversation(mate["id"])
    started: list = []
    monkeypatch.setattr(svc, "start_turn", lambda sid, text, **kw: started.append((sid, text, kw.get("meta"))))
    try:
        # her tool: at once (+0), "wake me up"
        out = await mates._tool_set_alarm(mate, "", {"at": "+0", "about": "일어나기"})
        assert "set for 2026-11-18 09:00" in out and "Nothing that can take your call" in out
        # nowhere to ring: looked at again soon (a phone may be waking for it)
        await calls.alarms.tick()
        a = calls.alarms.book.upcoming()[0]
        assert a["status"] == "pending" and a["attempts"] == 0 and a["at"] > a["due"]
        # a phone and a computer; they are on the computer: it rings there, the phone stays quiet
        phone = _window(mates, "phone-1", "android", active=False)
        desk = _window(mates, "desk-1", "desktop-linux")
        clock.move(31)
        await calls.alarms.tick()
        call = calls.active()
        assert call is not None and call.reason == "alarm" and call.about == "일어나기"
        assert [r["device"] for r in _rings(desk)] == ["desk-1"] and _rings(phone) == []
        assert calls.alarms.book.get(a["id"])["status"] == "ringing"
        # it rings out: again two minutes later — this time on every device that can take it
        await calls.end(call, "missed")
        await _wait(lambda: calls.alarms.book.get(a["id"])["status"] == "pending")
        assert calls.alarms.book.get(a["id"])["attempts"] == 1
        clock.move(alarms_mod.RETRY_S + 1)
        await calls.alarms.tick()
        again = calls.active()
        assert again is not None and len(_rings(phone)) == 1 and len(_rings(desk)) == 2
        await calls.end(again, "missed")
        await _wait(lambda: calls.alarms.book.get(a["id"])["status"] == "pending")
        clock.move(alarms_mod.RETRY_S + 1)
        await calls.alarms.tick()
        third = calls.active()
        await calls.end(third, "missed")
        # three times unanswered: she leaves them a message instead
        await _wait(lambda: calls.alarms.book.get(a["id"])["status"] == "missed")
        await _wait(lambda: bool(started))
        sid, text, meta = started[-1]
        assert sid == mate["session_id"] if mate.get("session_id") else True
        assert "called 3 times" in text and "일어나기" in text and meta["kind"] == "alarm" and meta["internal"]
        # none of it was her heart's business: no hurt, no cooldown for her own calls
        assert calls.unanswered_in_a_row(mate["id"]) == 0
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_picked_up_it_is_done_and_her_hello_knows_why(db, tmp_path, monkeypatch):
    clock = Clock(datetime(2026, 11, 18, 0, 0, tzinfo=timezone.utc))
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch, clock=clock)
    mate = store.create(name="Haru", persona={"language": "ko"}, llm={"model": "m1"})
    mates.conversation(mate["id"])
    # (her turn after the call is recorded, not run: a real one starts an engine that outlives the test — on CI its
    # process was still there at teardown, which then hung)
    turns: list = []
    monkeypatch.setattr(svc, "start_turn", lambda sid, text, **kw: turns.append(kw.get("meta")))
    try:
        _window(mates, "phone-1", "android")
        a = calls.alarms.book.add(mate["id"], calls.alarms.book.now(), "회의 준비")
        await calls.alarms.tick()
        call = calls.active()
        await calls.accept(call.id, "phone-1")
        sent: list = []
        calls.attach(call, sent.append)
        await _wait(lambda: bool(line.prompts))
        assert "alarm they set with you" in line.prompts[0] and "회의 준비" in line.prompts[0]
        await calls.receive(call, {"type": "hangup"})
        await _wait(lambda: calls.alarms.book.get(a["id"])["status"] == "done")
        await _wait(lambda: bool(turns))  # (and she takes the call in as a turn of her own, its card the message)
        assert turns[0]["kind"] == "call"
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_due_while_the_server_was_down(db, tmp_path, monkeypatch):
    clock = Clock(datetime(2026, 11, 18, 0, 0, tzinfo=timezone.utc))
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch, clock=clock)
    mate = store.create(name="Haru", persona={"language": "ko"}, llm={"model": "m1"})
    mates.conversation(mate["id"])
    started: list = []
    monkeypatch.setattr(svc, "start_turn", lambda sid, text, **kw: started.append(text))
    try:
        _window(mates, "phone-1", "android")
        book = calls.alarms.book
        late = book.add(mate["id"], book.now() - timedelta(hours=2), "약 먹기")
        soon = book.add(mate["id"], book.now() - timedelta(minutes=10), "출발")
        await calls.alarms.tick()
        # two hours late: a message instead of a ring; ten minutes late: still rung
        assert book.get(late["id"])["status"] == "missed"
        assert book.get(soon["id"])["status"] == "ringing"
        await _wait(lambda: bool(started))
        assert "came while you couldn't call" in started[0] and "약 먹기" in started[0]
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_her_alarm_tools_and_the_list(db, tmp_path, monkeypatch):
    clock = Clock(datetime(2026, 11, 18, 1, 30, tzinfo=timezone.utc))
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch, clock=clock)
    mate = store.create(name="Haru", persona={"language": "ko"}, llm={"model": "m1"})
    other = store.create(name="Mio", persona={"language": "ko"}, llm={"model": "m1"})
    try:
        await mates._tool_set_alarm(mate, "", {"at": "21:00", "about": "운동"})
        rows = await mates._tool_list_alarms(mate, "", {})
        assert rows == [{"alarm_id": rows[0]["alarm_id"], "when": "2026-11-18 21:00", "about": "운동", "kind": "alarm"}]
        assert await mates._tool_list_alarms(other, "", {}) == "No alarms of yours are waiting."
        # another mate can't call off hers
        from app.mate.store import MateError

        with pytest.raises(MateError):
            await mates._tool_cancel_alarm(other, "", {"alarm_id": rows[0]["alarm_id"]})
        assert "called off" in await mates._tool_cancel_alarm(mate, "", {"alarm_id": rows[0]["alarm_id"]})
        assert calls.alarms.book.upcoming() == []
        with pytest.raises(ValueError):
            await mates._tool_set_alarm(mate, "", {"at": "2026-11-18 08:00"})
        # a phone woken for it: a little before, the next day's
        await mates._tool_set_alarm(mate, "", {"at": "+60"})
        assert calls.alarms.wakes() == [(clock_at := datetime.fromtimestamp(clock(), timezone.utc)
                                         + timedelta(minutes=60) - timedelta(seconds=alarms_mod.WAKE_AHEAD_S)).isoformat(timespec="seconds")]
        heard: list = []
        calls.link("phone-9", heard.append)
        assert heard[0]["wakes"] == calls.alarms.wakes()
        del clock_at
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_the_device_they_are_on(db, tmp_path, monkeypatch):
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", persona={"language": "ko"}, llm={"model": "m1"})
    try:
        # only windows with the call screen count: not the overlay, the quick card, the hidden runtime
        _window(mates, "desk-1", "desktop-linux", surface="mate-overlay", calls=0)
        _window(mates, "desk-1", "desktop-linux", surface="device-runtime")
        assert calls.callee(mate, asked=True) is None
        _window(mates, "desk-1", "desktop-linux", active=False)
        assert calls.callee(mate, asked=True) == "desk-1"
        # a phone used just now beats a computer left alone
        _window(mates, "phone-1", "android")
        assert calls.callee(mate, asked=True) == "phone-1"
        # her own calls: only while a phone of theirs lets her call — then still where they are
        assert calls.callee(mate, asked=False) is None
        _window(mates, "desk-1", "desktop-linux")  # (they are on the computer now)
        assert calls.callee(mate, asked=True) == "desk-1"
        out: list = []
        conn = mates.capture.connect(out.append)
        mates.capture.hello(conn, {"type": "client", "device": "phone-1", "native": "android", "calls": 1, "surface": "console",
                                   "screen_policy": {"enabled": True, "mate_id": mate["id"]}})
        assert calls.callee(mate, asked=False) == "phone-1"  # (its page just opened: they are on it)
        _window(mates, "desk-1", "desktop-linux")  # (and now on the computer again: she calls them there)
        assert calls.callee(mate, asked=False) == "desk-1"
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_a_chat_that_was_asked_to_tell_them_when_done(db, tmp_path, monkeypatch):
    clock = Clock(datetime(2026, 11, 18, 3, 0, tzinfo=timezone.utc))
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch, clock=clock)
    notify = DoneNotify(svc, mates)
    try:
        chat = svc.create(workspace_path=str(tmp_path), title="빌드 정리", provider="claude")
        # no mate who can call them: nothing to arm, and no tool for the chat
        notify.mate_for = lambda: None
        assert notify.state(chat["id"])["available"] is False
        with pytest.raises(ValueError):
            notify.arm(chat["id"])

        class Req:
            mcp_config = None
            mcp_config_file = ""
            system_append = ""

        req = Req()
        notify.configure(chat["id"], req)
        assert req.mcp_config is None
        mate = store.create(name="Haru", persona={"language": "ko"}, llm={"model": "m1"})
        mates.conversation(mate["id"])
        notify.mate_for = lambda: store.get(mate["id"])
        notify.configure(chat["id"], req)
        assert "geny_notify" in req.mcp_config["mcpServers"] and "notify_when_done" in req.system_append
        # the chat's agent heard "끝나면 알려 줘": armed (the chat's chip says so)
        q = svc.subscribe(chat["id"])
        out = await notify.tool(chat["id"], {"note": "빌드 끝나면"})
        assert not out["is_error"] and "Haru phones them" in out["text"]
        assert notify.state(chat["id"]) == {"armed": True, "mate_id": mate["id"], "mate_name": "Haru", "available": True}
        seen = await asyncio.wait_for(q.get(), 2)
        assert seen["type"] == "session.notify" and seen["data"]["armed"] is True
        # its turn ends: a "done" for her, due now, with what it did — then her call, on the device they are on
        _window(mates, "desk-1", "desktop-win32")
        svc._turn_ended(chat["id"], {"status": "ok", "text": "빌드 캐시 3GB 정리했고 릴리즈는 그대로 둠."})
        assert notify.state(chat["id"])["armed"] is False
        [a] = calls.alarms.book.upcoming()
        assert a["kind"] == "done" and "빌드 정리" in a["about"] and "3GB" in a["about"] and "빌드 끝나면" in a["about"]
        await calls.alarms.tick()
        call = calls.active()
        assert call is not None and call.reason == "done" and call.device == "desk-1"
        # a turn's end with nothing armed: nothing
        await calls.end(call, "declined")
        await _wait(lambda: calls.alarms.book.get(a["id"])["status"] == "done")
        svc._turn_ended(chat["id"], {"status": "ok", "text": "again"})
        assert calls.alarms.book.upcoming() == []
    finally:
        await calls.stop()
        await svc.shutdown()
