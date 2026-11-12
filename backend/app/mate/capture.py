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

All screens (desktop app ≥ :data:`MULTI_BRIDGE`, the user chose "All screens"): a request that may take them
(``multi``) gets one picture per screen — each uploaded with the request's proof, answered as ``attachments:
[{id, role: main | sub, source}]``, the screen in use (``main``) first. The other side's version decides: an older
app answers one ``attachment_id``, and an older server's request has no ``multi`` (the app then sends the main one).
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable

CAPTURE_BRIDGE = 1        # the desktop capture bridge this server speaks (hrhNative.capture.version)
MULTI_BRIDGE = 4          # … and from which one it sends every screen of an all-screens share, the main one first
MAX_PICTURES = 6          # pictures per capture (screens; the desktop app takes at most as many: MAX_SCREENS)
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
    "not_shared": "Screen sharing is not enabled for this session on the device you are talking from. Ask the user to open Screen capture in the attachment menu and enable sharing.",
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
    shares: dict[str, str] = field(default_factory=dict)
    screen_policy: dict[str, Any] = field(default_factory=dict)
    user_busy: bool = False
    busy_at: float = 0.0


@dataclass
class Pending:
    id: str
    mate_id: str
    session_id: str
    conn: str
    future: asyncio.Future
    uploads: set[str] = field(default_factory=set)
    revoked: bool = False
    revoked_code: str = ""
    shared: bool = False
    multi: bool = False   # every screen of an all-screens share may come back (the window can send them)
    proof: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    created_at: float = field(default_factory=time.monotonic)


def _str(v: Any, limit: int) -> str:
    return v[:limit] if isinstance(v, str) else ""


def _source(v: Any) -> dict[str, str]:
    s = v if isinstance(v, dict) else {}
    return {"name": " ".join(_str(s.get("name"), 200).split()), "kind": "window" if s.get("kind") == "window" else "screen"}


def pictures(body: dict[str, Any]) -> list[dict[str, Any]]:
    """The pictures of a window's answer, main first — ``[{id, role: main | sub, source: {name, kind}}]``:
    ``attachments`` (a desktop app sharing all screens) or the one ``attachment_id`` (one screen or window, older
    apps). At most :data:`MAX_PICTURES`, each once; exactly one ``main``: the first one marked so, else the first."""
    rows = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    if not rows and body.get("attachment_id"):
        rows = [{"id": body.get("attachment_id"), "role": "main", "source": body.get("source")}]
    out: list[dict[str, Any]] = []
    for it in rows:
        aid = _str(it.get("id"), 80) if isinstance(it, dict) else ""
        if aid and aid not in {p["id"] for p in out}:
            out.append({"id": aid, "role": "main" if it.get("role") == "main" else "sub", "source": _source(it.get("source"))})
    main = next((i for i, p in enumerate(out) if p["role"] == "main"), 0)
    out = (out[main:main + 1] + out[:main] + out[main + 1:])[:MAX_PICTURES]
    for i, p in enumerate(out):
        p["role"] = "sub" if i else "main"
    return out


def screen_labels(n: int) -> list[str]:
    """What each of ``n`` pictures of one capture is, in order — the screen in use first; one picture: no label
    (the roles only: nothing looks at the pictures to name them)."""
    return [""] * n if n <= 1 else ["main screen (the one in use)"] + [f"other screen {k}" for k in range(1, n)]


class CaptureBroker:
    def __init__(self, *, ask_timeout: float = ASK_TIMEOUT_S, grab_timeout: float = GRAB_TIMEOUT_S) -> None:
        self.ask_timeout = ask_timeout
        self.grab_timeout = grab_timeout
        self._clients: dict[str, Client] = {}
        self._pending: dict[str, Pending] = {}
        self.discard_upload = lambda aid: None
        self.on_consent_change = lambda: None

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
        shares = msg.get("shares")
        c.shares = {str(k)[:100]: v for k, v in list(shares.items())[:20]
                    if isinstance(k, str) and v in ("ask", "on_turn", "observe")} if isinstance(shares, dict) else {}
        policy = msg.get("screen_policy")
        c.screen_policy = ({"enabled": policy["enabled"], "interval": max(60,min(600,policy.get("interval",180)))}
                           if isinstance(policy,dict) and isinstance(policy.get("enabled"),bool)
                           and isinstance(policy.get("interval",180),(int,float)) else {})
        if c.screen_policy:
            c.screen_policy['mate_id']=_str(policy.get('mate_id'),100)
            c.screen_policy['fixed']=policy.get('fixed') is True
        c.user_busy=msg.get('user_busy') is True
        c.busy_at=time.monotonic()
        for p in list(self._pending.values()):
            if p.conn == conn and p.shared and p.session_id not in c.shares:
                self._revoke(p,"stopped")
        self.on_consent_change()
        if msg.get("active"):
            c.active_at = time.monotonic()

    def disconnect(self, conn: str) -> None:
        self._clients.pop(conn, None)
        for p in list(self._pending.values()):
            if p.conn == conn:
                self._revoke(p,"gone")

        self.on_consent_change()

    def clients(self) -> list[Client]:
        return list(self._clients.values())

    # ---- where to ask ----

    def pick(self, device: str | None) -> tuple[Client | None, str]:
        """(the window to ask, "") or (None, why: no_app | outdated). The device the user talks from first;
        within it (or overall) the most recently used window, mate chat / console over the quick card over
        the avatar window."""
        able = [c for c in self._clients.values() if c.desktop and c.capture >= CAPTURE_BRIDGE]
        if not able:
            old = any(c.desktop for c in self._clients.values())
            return None, "outdated" if old else "no_app"
        here = [c for c in able if device and c.device == device]
        if device and not here:
            return None, "no_app"
        if not device and len({c.device for c in able}) > 1:
            return None, "not_shared"
        pool = here or able
        best = max(pool, key=lambda c: (c.active_at, SURFACE_RANK.get(c.surface, 0), c.connected_at))
        # (one device: every window shares the device's last use — prefer the window the user works in)
        same = [c for c in pool if c.device == best.device]
        best = max(same, key=lambda c: (SURFACE_RANK.get(c.surface, 0), c.active_at))
        return best, ""

    def shared_client(self, sid: str, device: str | None) -> Client | None:
        # Session consent belongs to one connection and device. Never guess a different computer.
        if not device:
            return None
        pool = [c for c in self._clients.values() if c.device == device and sid in c.shares and c.capture >= CAPTURE_BRIDGE]
        return max(pool, key=lambda c: c.active_at) if pool else None

    # ---- one capture ----

    def busy(self, mate_id: str) -> bool:
        return any(p.mate_id == mate_id and not p.future.done() for p in self._pending.values())

    async def request(self, *, mate: dict[str, Any], session_id: str, device: str | None,
                      reason: str = "", shared_only: bool = False, automatic: bool = False,
                      multi: bool = False) -> dict[str, Any]:
        """Ask a desktop app window for one capture. -> the window's answer: ``{"ok": True, "attachment_id",
        "attachments": pictures(), "source"?, "client": Client}``; raises :class:`CaptureError` otherwise.
        ``multi``: every screen may come back (when the window can send them; otherwise only the main one)."""
        if self.busy(mate["id"]) or any(p.session_id == session_id and not p.future.done() for p in self._pending.values()):
            raise CaptureError("busy")
        shared = self.shared_client(session_id, device)
        client, why = (shared, "") if shared else (None, "not_shared") if shared_only else self.pick(device)
        if client is None:
            raise CaptureError(why)
        screen = mate.get("screen") or {}
        ask = client.shares.get(session_id) == "ask" if shared else screen.get("approval") != "allow"
        if automatic:
            ask = False
        rid = "cap_" + secrets.token_urlsafe(12)
        loop = asyncio.get_running_loop()
        p = Pending(id=rid, mate_id=mate["id"], session_id=session_id, conn=client.conn, future=loop.create_future(),
                    shared=bool(shared), multi=bool(multi) and client.capture >= MULTI_BRIDGE)
        self._pending[rid] = p
        try:
            client.send({"type": "capture.request", "data": {
                "scope": "session" if shared else "mate", "proof": p.proof,
                "id": rid, "mate_id": mate["id"], "mate_name": mate.get("name") or "", "session_id": session_id,
                "source_key": f"session:{session_id}" if shared else mate["id"],
                "automatic": automatic, "ask": ask, "hide_avatar": screen.get("hide_avatar") is not False,
                "max_edge": int(screen.get("max_edge") or 0), "format": "png", "timeout_ms": int(self.ask_timeout * 1000),
                "reason": _str(reason, 300), "same_device": bool(device and client.device == device),
                "multi": p.multi, "max_pictures": MAX_PICTURES if p.multi else 1,
            }})
        except Exception as exc:  # noqa: BLE001 - the socket just went away
            self._pending.pop(rid, None)
            raise CaptureError("gone") from exc
        wait = (self.ask_timeout if not automatic else 0) + self.grab_timeout + min(5.0, self.grab_timeout)
        accepted = False
        try:
            res = await asyncio.wait_for(asyncio.shield(p.future), timeout=wait)
            accepted = bool(res.get("ok")) and not p.revoked
        except asyncio.TimeoutError:
            res = {"ok": False, "code": "timeout"}
        except asyncio.CancelledError:
            self._cancel_on(client, rid)
            raise
        finally:
            self._pending.pop(rid, None)
            if not accepted:
                for aid in p.uploads: self.discard_upload(aid)
        if p.revoked: res = {"ok": False,"code":p.revoked_code or "stopped"}
        if not res.get("ok"):
            if res.get("code") in ("timeout", "stopped", "gone"):
                self._cancel_on(client, rid)
            code = str(res.get("code") or "error")
            raise CaptureError(code if code in ERRORS else "error", _str(res.get("message"), 400))
        # (one picture unless more were asked for; an upload of this request that is not in the answer is dropped)
        every = pictures(res)
        pics = every[:MAX_PICTURES if p.multi else 1]
        keep = {x["id"] for x in pics}
        for aid in (p.uploads | {x["id"] for x in every}) - keep:
            self.discard_upload(aid)
        if not pics:
            raise CaptureError("error", "The capture did not arrive as a picture.")
        return {**res, "attachment_id": pics[0]["id"], "attachments": pics, "source": pics[0]["source"],
                "id": rid, "client": client}

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

    def register_upload(self, sid: str, rid: str, proof: str, aid: str | None = None) -> bool:
        p = self._pending.get(rid)
        if not p or p.session_id != sid or p.revoked or p.future.done() or not secrets.compare_digest(p.proof, proof):
            return False
        if len(p.uploads - {aid}) >= MAX_PICTURES:
            return False  # (one picture per screen, no more)
        if aid: p.uploads.add(aid)
        return True

    def _revoke(self, p: Pending, code: str) -> None:
        if p.revoked: return
        p.revoked = True
        p.revoked_code = code
        for aid in p.uploads: self.discard_upload(aid)
        if not p.future.done(): p.future.set_result({"ok":False,"code":code})
        client=self._clients.get(p.conn)
        if client: self._cancel_on(client,p.id)

    def cancel_session(self, session_id: str) -> None:
        """The mate's turn ended (stopped, failed): a capture still waiting for it is over."""
        for p in list(self._pending.values()):
            if p.session_id == session_id:
                self._revoke(p,"stopped")
