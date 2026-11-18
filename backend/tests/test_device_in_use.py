"""Where the user is (app/mate/capture.py in_use): the device they did something on last — a touch, a key, a click; on a
computer with the desktop app, anywhere on it — among those with a window on screen. Her voice for a turn goes there
(session.start's voice_device), and her calls ring it (app/mate/calls.py)."""

from __future__ import annotations

import time

from app.mate.capture import CaptureBroker


def _hello(b: CaptureBroker, device: str, *, idle: float | None, visible: bool = True, active: bool = False, native: str = "") -> str:
    conn = b.connect(lambda m: None)
    msg = {"type": "client", "device": device, "surface": "console", "visible": visible, "active": active, "native": native}
    if idle is not None:
        msg["idle"] = idle
    b.hello(conn, msg)
    return conn


def test_the_device_they_touched_last_not_the_one_merely_open():
    b = CaptureBroker()
    # the phone: the app open and on screen, focused, but not touched for ten minutes
    phone = _hello(b, "phone", idle=600, active=True, native="android")
    # the computer: the desktop app's window behind another program — but they typed somewhere on it 3 s ago
    _hello(b, "desk", idle=3, native="desktop-win32")
    assert b.in_use() == "desk"
    # they pick the phone up and touch it
    b.hello(phone, {"type": "client", "device": "phone", "surface": "console", "visible": True, "idle": 0, "native": "android"})
    assert b.in_use() == "phone"


def test_a_message_typed_from_a_device_puts_them_there():
    b = CaptureBroker()
    _hello(b, "desk", idle=1)
    _hello(b, "phone", idle=900)
    assert b.in_use() == "desk"
    b.note_used("phone")  # (a message came from it)
    assert b.in_use() == "phone"


def test_a_device_with_nothing_on_screen_or_long_untouched_is_not_where_they_are():
    b = CaptureBroker()
    _hello(b, "phone", idle=0, visible=False, native="android")  # (the app sent to the background: can't speak)
    _hello(b, "desk", idle=40 * 60, native="desktop-win32")  # (nobody at the computer for 40 minutes)
    assert b.in_use() is None
    # …but asked for wherever they were last (a study's result with the app running): the computer, never the phone
    assert b.in_use(within=float("inf")) == "desk"
    # the desktop app with every window hidden still speaks (its runtime window)
    b3 = CaptureBroker()
    _hello(b3, "desk", idle=5, visible=False, native="desktop-win32")
    assert b3.in_use() == "desk"
    # an older page says nothing of its input: it isn't guessed at
    b2 = CaptureBroker()
    _hello(b2, "old", idle=None, active=True)
    assert b2.in_use() is None and b2.device_used("old") is None


def test_her_voice_goes_where_they_are(db, tmp_path, monkeypatch):
    from app.services.session_service import SessionService

    svc = SessionService.__new__(SessionService)  # (only what user_device needs)
    svc._last_client = {"s1": "m1~phone"}
    b = CaptureBroker()

    class Screen:
        broker = b

    svc.screen = Screen()
    _hello(b, "phone", idle=1200, native="android")
    _hello(b, "desk", idle=2)
    assert svc.user_device("s1") == "desk"
    # a study's result an hour after they left the computer: still read there (the phone is in the background)
    b2 = CaptureBroker()
    _hello(b2, "desk", idle=3600, native="desktop-win32")
    _hello(b2, "phone", idle=30, visible=False, native="android")
    svc.screen = type("S", (), {"broker": b2})()
    assert svc.user_device("s1") == "desk"
    # nothing says where they are: the device the latest message came from
    svc.screen = None
    assert svc.user_device("s1") == "phone"
    assert time.monotonic() > 0
