"""Seeing the user's screen (docs/mate.md §4 "Seeing the screen") — the server half.

The mate runs here (its engine is a CLI process on the server); the screen belongs to the computer the user
talks from. So a ``see_screen`` tool call becomes a request to one of the user's **desktop app** windows, over
the session-list feed every window keeps open (``/ws/sessions``):

* each window says who it is on that socket — ``{"type": "client", "device", "surface", "desktop", "capture",
  "active"}`` (``device`` = the browser profile's id, the one in ``client_msg_id``; ``desktop`` = the desktop
  app's version or null; ``capture`` = its capture bridge version, 0 = none; ``active`` = it was just focused);
* :meth:`CaptureBroker.pick` chooses where to ask: a capture-capable window of the device the user's latest
  message came from, else the most recently active capture-capable window (another computer of theirs);
* the window gets ``{"type": "capture.request", "data": {...}}``; the desktop app asks the user (unless the mate
  may look without asking), captures, the page uploads the picture as a normal attachment of the mate's
  conversation and answers ``POST /api/mates/{id}/capture/{request id}`` (:meth:`resolve`);
* every request ends: an answer, a timeout (``capture.cancel`` is sent so the prompt goes away), the window
  closing, or the mate's turn ending. Nothing here ever holds image data.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable

CAPTURE_BRIDGE = 1        # the desktop capture bridge this server speaks (hrhNative.capture.version)
ASK_TIMEOUT_S = 45        # the desktop app's "may she look?" prompt: no answer → no
GRAB_TIMEOUT_S = 30       # capture + upload, once allowed
SURFACE_RANK = {"mate-chat": 3, "console": 3, "mate-quick": 2, "mate-overlay": 1}

ERRORS = {
    "denied": "The user said no: they did not share their screen. Don't ask again right away; ask them to "
              "describe what they see, or to share it themselves (Share screen in the + menu).",
    "timeout": "Nobody answered the screen-sharing prompt in time (counted as no). The user may be away from "
               "that computer.",
    "no_app": "No desktop app is connected: looking at the screen only works while the user has the My Mate Geny "
              "desktop app (Windows, macOS, Linux) open and signed in. In a browser or on a phone they can share "
              "a screenshot themselves (the + menu).",
    "outdated": "The user's desktop app is too old for screen capture: ask them to update it (Settings → Updates "
                "& Download in the app) and try again.",
    "busy": "Another screen capture is still waiting for the user's answer.",
    "gone": "The desktop app window that was asked closed before answering.",
    "stopped": "The capture was cancelled (the turn ended).",
    "permission": "The computer did not allow the capture. On macOS the app needs Screen Recording permission "
                  "(System Settings → Privacy & Security → Screen Recording → My Mate Geny, then restart the app).",
    "empty": "The capture came back empty. On Linux with Wayland the system's share dialog must be allowed; on "
             "macOS the app needs Screen Recording permission.",
    "source_gone": "The window chosen for you to see is not open any more, so nothing was captured. The user "
                   "can pick another one in your settings (Mate settings → Screen).",
    "error": "The screen capture failed on the user's computer.",
}


class CaptureError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or ERRORS.get(code, ERRORS["error"]))
        self.code = code if code in ERRORS else "error"
        self.detail = detail


@dataclass
class Client:
    conn: str
    send: Callable[[dict[str, Any]], None]
    connected_at: float
    device: str = ""
    surface: str = ""
    desktop: str | None = None   # the desktop app's version (None: a browser / the Android app)
    capture: int = 0             # capture bridge version (0: none)
    active_at: float = 0.0


@dataclass
class Pending:
    id: str
    mate_id: str
    session_id: str
    conn: str
    future: asyncio.Future
    created_at: float = field(default_factory=time.monotonic)


def _str(v: Any, limit: int) -> str:
    return v[:limit] if isinstance(v, str) else ""


class CaptureBroker:
    def __init__(self, *, ask_timeout: float = ASK_TIMEOUT_S, grab_timeout: float = GRAB_TIMEOUT_S) -> None:
        self.ask_timeout = ask_timeout
        self.grab_timeout = grab_timeout
        self._clients: dict[str, Client] = {}
        self._pending: dict[str, Pending] = {}

    # ---- the windows (one per /ws/sessions socket) ----

    def connect(self, send: Callable[[dict[str, Any]], None]) -> str:
        conn = secrets.token_hex(8)
        now = time.monotonic()
        self._clients[conn] = Client(conn=conn, send=send, connected_at=now, active_at=now)
        return conn

    def hello(self, conn: str, msg: dict[str, Any]) -> None:
        """``{"type": "client", ...}`` from a window: who it is, and (``active``) that it was just used."""
        c = self._clients.get(conn)
        if c is None:
            return
        c.device = _str(msg.get("device"), 80) or c.device
        c.surface = _str(msg.get("surface"), 40) or c.surface
        d = msg.get("desktop")
        c.desktop = _str(d, 40) or None
        cap = msg.get("capture")
        c.capture = cap if isinstance(cap, int) and not isinstance(cap, bool) and 0 <= cap < 1000 else 0
        if msg.get("active"):
            c.active_at = time.monotonic()

    def disconnect(self, conn: str) -> None:
        self._clients.pop(conn, None)
        for p in list(self._pending.values()):
            if p.conn == conn and not p.future.done():
                p.future.set_result({"ok": False, "code": "gone"})

    def clients(self) -> list[Client]:
        return list(self._clients.values())

    # ---- where to ask ----

    def pick(self, device: str | None) -> tuple[Client | None, str]:
        """(the window to ask, "") or (None, why: no_app | outdated). The device the user talks from first;
        within it (or overall) the most recently used window, mate chat / console over the quick card over
        the avatar window."""
        able = [c for c in self._clients.values() if c.capture >= CAPTURE_BRIDGE]
        if not able:
            old = any(c.desktop for c in self._clients.values())
            return None, "outdated" if old else "no_app"
        here = [c for c in able if device and c.device == device]
        pool = here or able
        best = max(pool, key=lambda c: (c.active_at, SURFACE_RANK.get(c.surface, 0), c.connected_at))
        # (one device: every window shares the device's last use — prefer the window the user works in)
        same = [c for c in pool if c.device == best.device]
        best = max(same, key=lambda c: (SURFACE_RANK.get(c.surface, 0), c.active_at))
        return best, ""

    # ---- one capture ----

    def busy(self, mate_id: str) -> bool:
        return any(p.mate_id == mate_id and not p.future.done() for p in self._pending.values())

    async def request(self, *, mate: dict[str, Any], session_id: str, device: str | None,
                      reason: str = "") -> dict[str, Any]:
        """Ask a desktop app window for one capture. -> the window's answer: ``{"ok": True, "attachment_id",
        "source"?, "width"?, "height"?, "client": Client}``; raises :class:`CaptureError` otherwise."""
        if self.busy(mate["id"]):
            raise CaptureError("busy")
        client, why = self.pick(device)
        if client is None:
            raise CaptureError(why)
        screen = mate.get("screen") or {}
        ask = screen.get("approval") != "allow"
        rid = "cap_" + secrets.token_urlsafe(12)
        loop = asyncio.get_running_loop()
        p = Pending(id=rid, mate_id=mate["id"], session_id=session_id, conn=client.conn, future=loop.create_future())
        self._pending[rid] = p
        try:
            client.send({"type": "capture.request", "data": {
                "id": rid, "mate_id": mate["id"], "mate_name": mate.get("name") or "", "session_id": session_id,
                "ask": ask, "hide_avatar": screen.get("hide_avatar") is not False,
                "max_edge": int(screen.get("max_edge") or 0), "format": screen.get("format") or "png",
                "quality": int(screen.get("quality") or 85), "timeout_ms": int(self.ask_timeout * 1000),
                "reason": _str(reason, 300), "same_device": bool(device and client.device == device),
            }})
        except Exception as exc:  # noqa: BLE001 - the socket just went away
            self._pending.pop(rid, None)
            raise CaptureError("gone") from exc
        wait = (self.ask_timeout if ask else 0) + self.grab_timeout + min(5.0, self.grab_timeout)
        try:
            res = await asyncio.wait_for(asyncio.shield(p.future), timeout=wait)
        except asyncio.TimeoutError:
            res = {"ok": False, "code": "timeout"}
        finally:
            self._pending.pop(rid, None)
        if not res.get("ok"):
            if res.get("code") in ("timeout", "stopped", "gone"):
                self._cancel_on(client, rid)
            code = str(res.get("code") or "error")
            raise CaptureError(code if code in ERRORS else "error", _str(res.get("message"), 400))
        return {**res, "id": rid, "client": client}

    def _cancel_on(self, client: Client, rid: str) -> None:
        try:
            client.send({"type": "capture.cancel", "data": {"id": rid}})
        except Exception:  # noqa: BLE001
            pass

    def resolve(self, rid: str, mate_id: str, payload: dict[str, Any]) -> bool:
        """The window's answer (``POST /api/mates/{id}/capture/{rid}``). False: no such request (answered, timed
        out, another mate's)."""
        p = self._pending.get(rid)
        if p is None or p.mate_id != mate_id or p.future.done():
            return False
        p.future.set_result(payload)
        return True

    def pending_session(self, rid: str) -> str | None:
        p = self._pending.get(rid)
        return p.session_id if p is not None else None

    def cancel_session(self, session_id: str) -> None:
        """The mate's turn ended (stopped, failed): a capture still waiting for it is over."""
        for p in list(self._pending.values()):
            if p.session_id == session_id and not p.future.done():
                p.future.set_result({"ok": False, "code": "stopped"})
