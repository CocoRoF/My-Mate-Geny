"""The mate looks at the user's screen (docs/mate.md §4 "Seeing the screen"): the Screen setting (validation,
persistence, mates.changed), see_screen offered only while it is on (prompt line, bridge tool list, engine restart,
settings note), routing a request to the right desktop app window, the answers (allowed → the uploaded picture is
the conversation's attachment and goes to the model as an image; denied / no answer / no app / an old app), the
engine's echo of the picture never stored again, and no image data in logs or events."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image
from fastapi.testclient import TestClient
from starlette.datastructures import Headers, UploadFile

from app.mate import mcp_bridge
from app.mate.capture import ERRORS, CaptureBroker
from app.mate.service import MateService
from app.mate.store import MateError, MateStore, normalize_screen
from app.providers.base import ProviderEvent
from app.services.attachment_service import AttachmentService
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from tests.test_mate_delegation import _mate_calls, _prompt, _setup, _turn


class _Logs:
    def __init__(self) -> None:
        self.rows: list[tuple] = []

    def record(self, *a, **kw) -> None:
        self.rows.append((a, kw))


def _png(w=64, h=48, color=(10, 200, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def _services(db):
    vault = SecretVault(db)
    atts = AttachmentService(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)), attachments=atts)
    store = MateStore(db, vault)
    logs = _Logs()
    return svc, atts, store, MateService(svc, store, logs=logs), logs


async def _upload(atts, sid, name, data, mime="image/png"):
    return await atts.save(sid, UploadFile(file=io.BytesIO(data), filename=name, headers=Headers({"content-type": mime})))


class _Window:
    """a desktop app window on /ws/sessions: what the server sends it"""

    def __init__(self, broker: CaptureBroker, **hello) -> None:
        self.sent: list[dict] = []
        self.conn = broker.connect(self.sent.append)
        broker.hello(self.conn, {"type": "client", **hello})

    def requests(self):
        return [m["data"] for m in self.sent if m["type"] == "capture.request"]


async def _wait(pred, timeout=5.0):
    for _ in range(int(timeout / 0.01)):
        if pred():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out")


# ---- the setting ----

def test_screen_setting_defaults_and_validation(db):
    assert normalize_screen(None) == {"enabled": False, "approval": "ask", "hide_avatar": True, "max_edge": 1920,
                                      "format": "png", "quality": 85}
    s = normalize_screen({"enabled": True, "approval": "allow", "max_edge": 0, "format": "jpeg", "quality": 7, "x": 1})
    assert s == {"enabled": True, "approval": "allow", "hide_avatar": True, "max_edge": 0, "format": "jpeg", "quality": 40}
    assert normalize_screen({"hide_avatar": False}, s)["approval"] == "allow"  # merged field by field
    for bad in ({"enabled": "yes"}, {"approval": "never"}, {"max_edge": 1000}, {"max_edge": True}, {"format": "gif"},
                {"quality": "high"}, "on"):
        with pytest.raises(MateError):
            normalize_screen(bad)
    assert normalize_screen(None, {"enabled": 1, "approval": "?", "max_edge": 7, "quality": "x"})["enabled"] is False

    store = MateStore(db, SecretVault(db))
    seen = []
    store.on_change = lambda reason, mid: seen.append((reason, mid))
    m = store.create(name="Geny")
    assert m["screen"]["enabled"] is False
    seen.clear()
    m, changed = store.update(m["id"], {"screen": {"enabled": True}})
    assert m["screen"]["enabled"] is True and changed == {"screen"} and seen == [("updated", m["id"])]
    assert store.get(m["id"])["screen"]["approval"] == "ask"  # persisted, the rest default
    seen.clear()
    store.update(m["id"], {"screen": {"enabled": True}})
    assert seen == []  # (no change, no push)


def test_screen_setting_over_the_api():
    from app.main import app

    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        mid = c.post("/api/mates", json={"name": "Screeny"}).json()["id"]
        r = c.patch(f"/api/mates/{mid}", json={"screen": {"enabled": True, "approval": "allow", "max_edge": 1280}})
        assert r.status_code == 200 and r.json()["screen"]["enabled"] is True and r.json()["screen"]["max_edge"] == 1280
        assert c.patch(f"/api/mates/{mid}", json={"screen": {"max_edge": 999}}).status_code == 400
        assert c.get(f"/api/mates/{mid}").json()["screen"]["approval"] == "allow"
        # an answer for a request nobody is waiting for
        assert c.post(f"/api/mates/{mid}/capture/cap_nope", json={"ok": False, "code": "denied"}).status_code == 404
        # every window says who it is on /ws/sessions; the broker knows it until the socket closes
        broker = app.state.mate_service.capture
        with c.websocket_connect("/ws/sessions") as ws:
            assert ws.receive_json()["type"] == "hello"
            ws.send_text(json.dumps({"type": "client", "device": "dev-1", "surface": "mate-chat", "desktop": "0.4.30",
                                     "capture": 1, "active": True}))
            ws.send_text(json.dumps({"type": "sync"}))
            assert ws.receive_json()["type"] == "pong"
            mine = [x for x in broker.clients() if x.device == "dev-1"]
            assert len(mine) == 1 and mine[0].capture == 1 and mine[0].desktop == "0.4.30"
        assert not [x for x in broker.clients() if x.device == "dev-1"]
        c.delete(f"/api/mates/{mid}")


# ---- offered only while it is on ----

async def test_see_screen_only_when_enabled(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    mate = store.create(name="Geny", llm={"model": "m1"})
    msid = mates.conversation(mate["id"])["session_id"]
    q = svc.subscribe(msid)

    def launch():
        argv = _mate_calls(tmp_path)[-1]["argv"]
        env = json.load(open(argv[argv.index("--mcp-config") + 1]))["mcpServers"]["mate"]["env"]
        return argv, env

    try:
        await _turn(svc, q, msid, "hello")
        argv, env = launch()
        assert "HRH_MATE_SCREEN" not in env and "see_screen" not in _prompt(argv)
        pid = _mate_calls(tmp_path)[-1]["pid"]
        # A legacy per-Mate flag cannot grant device access. Only an actual device share can.
        mates.update(mate["id"], {"screen": {"enabled": True}})
        await _turn(svc, q, msid, "still not sharing")
        assert "HRH_MATE_SCREEN" not in launch()[1]
        mates.update(mate["id"], {"screen": {"enabled": False}})
        svc._last_client[msid] = "m1~dev-a"
        win = _Window(mates.capture, device="dev-a", desktop="0.4.38", capture=1, shares={msid: "ask"})
        seen = await _turn(svc, q, msid, "look")
        argv, env = launch()
        assert env["HRH_MATE_SCREEN"] == "1"
        assert "## Seeing the screen" in _prompt(argv) and "see_screen" in _prompt(argv)
        assert _mate_calls(tmp_path)[-1]["pid"] != pid  # restarted: the bridge's tool list changed
        sent = next(m for m in seen if m["type"] == "user.message")
        assert sent  # (the settings note goes to the engine, not the history)
        mates.capture.disconnect(win.conn)
        await _turn(svc, q, msid, "and now")
        argv, env = launch()
        assert "HRH_MATE_SCREEN" not in env and "see_screen" not in _prompt(argv)
    finally:
        svc.unsubscribe(msid, q)


def test_settings_note_mentions_the_change(db, tmp_path):
    svc, atts, store, mates, _ = _services(db)
    m = store.create(name="Geny")
    assert mates._settings_note(m["id"], m, None, False) == ""  # first run: the prompt says it all
    note = mates._settings_note(m["id"], m, None, True)
    assert "<settings_update>" in note and "see_screen" in note
    assert "no longer" in mates._settings_note(m["id"], m, None, False)
    assert mates._settings_note(m["id"], m, None, False) == ""


class _Backend(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        out = {"text": f"ran {body['name']}", "is_error": False}
        if body["name"] == "see_screen":
            out["images"] = [{"data": base64.b64encode(_png()).decode(), "mime": "image/png"}]
        raw = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


def _bridge(api, screen: bool):
    env = {"PATH": os.environ.get("PATH", ""), "HRH_MATE_API": api, "HRH_MATE_TOKEN": "t"}
    if screen:
        env["HRH_MATE_SCREEN"] = "1"
    return subprocess.Popen([sys.executable, "-I", mcp_bridge.__file__], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            text=True, env=env)


def _rpc(proc, msg):
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())


def test_bridge_lists_see_screen_only_when_on_and_returns_the_image():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Backend)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    api = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        for screen in (False, True):
            proc = _bridge(api, screen)
            try:
                names = [t["name"] for t in _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]]
                assert ("see_screen" in names) is screen and "recall" in names
                if screen:
                    r = _rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                    "params": {"name": "see_screen", "arguments": {"reason": "the error"}}})["result"]
                    assert r["isError"] is False and r["content"][0] == {"type": "text", "text": "ran see_screen"}
                    img = r["content"][1]
                    assert img["type"] == "image" and img["mimeType"] == "image/png"
                    assert base64.b64decode(img["data"]).startswith(b"\x89PNG")
            finally:
                proc.stdin.close()
                proc.wait(timeout=5)
    finally:
        srv.shutdown()


# ---- where to ask ----

def test_routing_to_the_device_the_user_talks_from():
    b = CaptureBroker()
    assert b.pick("dev-a") == (None, "no_app")
    _Window(b, device="dev-p", surface="console", desktop=None, capture=0)  # a phone / browser
    assert b.pick("dev-p") == (None, "no_app")
    old = _Window(b, device="dev-o", surface="console", desktop="0.4.10", capture=0)  # a desktop app without capture
    assert b.pick("dev-p") == (None, "outdated")
    a_overlay = _Window(b, device="dev-a", surface="mate-overlay", desktop="0.4.30", capture=1)
    a_chat = _Window(b, device="dev-a", surface="mate-chat", desktop="0.4.30", capture=1)
    c_console = _Window(b, device="dev-c", surface="console", desktop="0.4.30", capture=1, active=True)
    # the device of the user's last message wins, its chat window over its avatar window
    assert b.pick("dev-a")[0].conn == a_chat.conn
    # Unknown devices and ambiguous multi-device callers never fall back to another computer.
    assert b.pick("dev-p") == (None, "no_app")
    assert b.pick(None) == (None, "not_shared")
    b.hello(a_overlay.conn, {"type": "client", "device": "dev-a", "surface": "mate-overlay", "capture": 1, "active": True})
    assert b.pick(None) == (None, "not_shared")
    b.disconnect(a_chat.conn)
    b.disconnect(a_overlay.conn)
    assert b.pick("dev-a") == (None, "no_app")
    assert old.conn in {c.conn for c in b.clients()}


# ---- the whole request ----

async def _start(db, tmp_path, *, approval="ask", enabled=True):
    svc, atts, store, mates, logs = _services(db)
    m = store.create(name="Estelle")
    store.update(m["id"], {"screen": {"enabled": enabled, "approval": approval}})
    msid = mates.conversation(m["id"])["session_id"]
    ctx = mates.token_info(mates._token(m["id"], msid))
    svc._last_client[msid] = "m1abc~dev-a"
    return svc, atts, store, mates, logs, m, msid, ctx


async def test_allowed_capture_reaches_the_model_and_the_conversation(db, tmp_path):
    svc, atts, store, mates, logs, m, msid, ctx = await _start(db, tmp_path, enabled=False)
    win = _Window(mates.capture, device="dev-a", surface="mate-chat", desktop="0.4.30", capture=1, shares={msid:"ask"})
    _Window(mates.capture, device="dev-b", surface="console", desktop="0.4.30", capture=1, active=True)
    task = asyncio.create_task(mates.call_tool_full(ctx, "see_screen", {"reason": "the red error"}))
    await _wait(lambda: win.requests())
    req = win.requests()[0]
    assert req["mate_id"] == m["id"] and req["mate_name"] == "Estelle" and req["session_id"] == msid
    assert req["ask"] is True and req["hide_avatar"] is True and req["max_edge"] == 1920 and req["format"] == "png"
    assert req["reason"] == "the red error" and req["timeout_ms"] == 45000
    # the page uploads the picture to the conversation, then answers
    big = _png(2400, 1500)
    att = await _upload(atts, msid, "screen-20261102-101010.png", big)
    assert mates.capture_result(m["id"], req["id"], {"ok": True, "attachment_id": att["id"],
                                                     "source": {"name": "Screen 1", "kind": "screen"}})
    text, is_error, images = await asyncio.wait_for(task, 5)
    assert is_error is False and f"[{att['id']}]" in text and "“Screen 1”" in text and "2400×1500" in text
    assert len(images) == 1 and images[0]["mime"] == "image/jpeg"  # the model-sized variant (≤ 1568 px)
    sent = Image.open(io.BytesIO(base64.b64decode(images[0]["data"])))
    assert max(sent.size) == 1568 and sent.getpixel((10, 10))[1] > 150  # the green picture, downscaled
    row = atts.get(att["id"])
    assert row["message_id"] == f"artifact:capture:{req['id']}"  # the conversation's, never a pending upload
    assert atts.pending(msid, []) == [] and att["id"] not in json.dumps(atts.by_message(msid))
    # answered once: a second answer for the same request is refused
    assert mates.capture_result(m["id"], req["id"], {"ok": True, "attachment_id": att["id"]}) is False
    # nothing about the picture in the logs
    assert not [r for r in logs.rows if "see_screen" in json.dumps(r, default=str)]


async def test_denied_timeout_disabled_no_app_and_bad_answers(db, tmp_path):
    svc, atts, store, mates, logs, m, msid, ctx = await _start(db, tmp_path)
    # no desktop app at all
    text, err, imgs = await mates.call_tool_full(ctx, "see_screen", {})
    assert err and text == ERRORS["not_shared"] and imgs == []
    old = _Window(mates.capture, device="dev-a", surface="console", desktop="0.4.10", capture=0)
    text, err, _ = await mates.call_tool_full(ctx, "see_screen", {})
    assert err and text == ERRORS["not_shared"]
    mates.capture.disconnect(old.conn)
    win = _Window(mates.capture, device="dev-a", surface="mate-chat", desktop="0.4.30", capture=1, shares={msid:"ask"})

    # denied
    task = asyncio.create_task(mates.call_tool_full(ctx, "see_screen", {}))
    await _wait(lambda: len(win.requests()) == 1)
    rid = win.requests()[0]["id"]
    assert mates.capture_result("mate_other", rid, {"ok": False, "code": "denied"}) is False  # another mate's id
    assert mates.capture_result(m["id"], rid, {"ok": False, "code": "denied"})
    text, err, imgs = await asyncio.wait_for(task, 5)
    assert err and text == ERRORS["denied"] and imgs == []

    # an answer that is not this conversation's picture
    other = svc.create(provider="claude", model="w", workspace_path=str(tmp_path), title="x")["id"]
    foreign = await _upload(atts, other, "x.png", _png())
    task = asyncio.create_task(mates.call_tool_full(ctx, "see_screen", {}))
    await _wait(lambda: len(win.requests()) == 2)
    rid = win.requests()[1]["id"]
    with pytest.raises(Exception):
        mates.capture_result(m["id"], rid, {"ok": True, "attachment_id": foreign["id"]})
    # one at a time
    text, err, _ = await mates.call_tool_full(ctx, "see_screen", {})
    assert err and text == ERRORS["busy"]
    assert mates.capture_result(m["id"], rid, {"ok": False, "code": "empty"})
    text, err, _ = await asyncio.wait_for(task, 5)
    assert err and text == ERRORS["empty"]

    # nobody answers: a timeout (counted as no) and the window is told to drop its prompt
    mates.capture.ask_timeout, mates.capture.grab_timeout = 0.1, 0.1
    text, err, _ = await asyncio.wait_for(mates.call_tool_full(ctx, "see_screen", {}), 10)
    assert err and text == ERRORS["timeout"]
    assert win.sent[-1] == {"type": "capture.cancel", "data": {"id": win.requests()[-1]["id"]}}

    # the window closes while asking
    mates.capture.ask_timeout, mates.capture.grab_timeout = 5, 5
    task = asyncio.create_task(mates.call_tool_full(ctx, "see_screen", {}))
    await _wait(lambda: len(win.requests()) == 4)
    mates.capture.disconnect(win.conn)
    text, err, _ = await asyncio.wait_for(task, 5)
    assert err and text == ERRORS["gone"]

    # the turn ends (stopped) while it waits
    win2 = _Window(mates.capture, device="dev-a", surface="mate-chat", desktop="0.4.30", capture=1, shares={msid:"ask"})
    task = asyncio.create_task(mates.call_tool_full(ctx, "see_screen", {}))
    await _wait(lambda: win2.requests())
    mates._on_turn_end(msid, {"status": "stopped", "trigger": "turn"})
    text, err, _ = await asyncio.wait_for(task, 5)
    assert err and text == ERRORS["stopped"] and win2.sent[-1]["type"] == "capture.cancel"

    # switched off: refused before anything is asked
    mates.capture.hello(win2.conn, {"shares":{}})
    n = len(win2.sent)
    text, err, _ = await mates.call_tool_full(ctx, "see_screen", {})
    assert err and text == ERRORS["not_shared"] and len(win2.sent) == n
    # "allow without asking" travels with the request
    store.update(m["id"], {"screen": {"enabled": True, "approval": "allow", "format": "jpeg", "hide_avatar": False}})
    mates.capture.hello(win2.conn, {"device":"dev-a", "desktop":"0.4.38", "capture":1, "shares":{msid:"on_turn"}})
    task = asyncio.create_task(mates.call_tool_full(ctx, "see_screen", {}))
    await _wait(lambda: len(win2.requests()) == 2)
    req = win2.requests()[-1]
    assert req["ask"] is False and req["format"] == "jpeg" and req["hide_avatar"] is False
    mates.capture_result(m["id"], req["id"], {"ok": False, "code": "denied"})
    await asyncio.wait_for(task, 5)
    assert not logs.rows  # expected outcomes are not admin errors


# ---- the engine's echo of the picture ----

async def test_the_engines_echo_is_not_stored_again(db, tmp_path):
    svc, atts, store, mates, logs, m, msid, ctx = await _start(db, tmp_path)
    att = await _upload(atts, msid, "screen.png", _png())
    atts.link([att["id"]], "artifact:capture:cap_x")
    rows_before = db.query("SELECT COUNT(*) AS c FROM attachments")[0]["c"]
    b64 = base64.b64encode(_png(300, 200)).decode()
    st = {"tool_calls": {"t1": {"name": "mcp__mate__see_screen", "input": {}}}}
    text = f"Screen captured: the screen — [{att['id']}] screen.png."
    # Claude: the tool result carries the image block (parsed into images)
    ev = ProviderEvent(type="tool.result", data={"id": "t1", "output": text, "is_error": False,
                                                 "images": [{"media_type": "image/png", "data": b64}]})
    assert svc._screen_result(msid, ev, st) is True
    assert ev.data["output"] == text and ev.data["images"] == [atts.out(atts.get(att["id"]))]
    assert b64 not in json.dumps(ev.data)
    # Codex: the MCP result dumped as JSON, image data and all
    raw = json.dumps({"content": [{"type": "text", "text": text}, {"type": "image", "data": b64, "mimeType": "image/png"}]})
    ev = ProviderEvent(type="tool.result", data={"id": "t1", "output": raw, "is_error": False})
    assert svc._screen_result(msid, ev, st) is True
    assert ev.data["output"] == text and b64[:100] not in json.dumps(ev.data) and ev.data["images"][0]["id"] == att["id"]
    # … or that dump cut short (Codex trims long tool output): still only the text
    ev = ProviderEvent(type="tool.result", data={"id": "t1", "output": raw[:3000] + "\n… (truncated)", "is_error": False})
    assert svc._screen_result(msid, ev, st) is True
    assert ev.data["output"] == text and ev.data["images"][0]["id"] == att["id"]
    # through the real event path: stored as an event without the base64, no second attachment
    await svc._record_event(msid, ProviderEvent(type="tool.result", data={
        "id": "t1", "output": text, "is_error": False, "images": [{"media_type": "image/png", "data": b64}]}),
        {**st, "ctx": {}, "provider": "claude", "model": "m"})
    assert db.query("SELECT COUNT(*) AS c FROM attachments")[0]["c"] == rows_before
    dump = json.dumps([dict(r) for r in db.query("SELECT * FROM events WHERE session_id = ?", (msid,))])
    assert att["id"] in dump and b64[:200] not in dump
    # other tools (and chats) keep the usual artifact path
    other = ProviderEvent(type="tool.result", data={"id": "t2", "output": "x", "images": [{"data": b64}]})
    assert svc._screen_result(msid, other, {"tool_calls": {"t2": {"name": "mcp__mate__recall"}}}) is False
