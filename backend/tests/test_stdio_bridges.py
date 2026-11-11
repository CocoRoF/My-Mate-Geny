"""The app's own stdio MCP servers (mate, Avatar Create, screen, remote hosts) speak UTF-8 whatever the system's code page.

On Windows a pipe is the ANSI code page (cp949 on a Korean system, cp1252 on an English one) and the bridges run with
``-I``, which ignores PYTHONUTF8: the mate's tool list (an em dash, Korean examples) killed the bridge at
``tools/list``, and the mate, without her tools, wrote the calls out as text. Here each bridge gets a tool list request
and a Korean request through a pipe in such a code page: on Windows exactly as the app starts them, elsewhere with the
code page forced on the pipe. Stdlib only, no app import (CI runs it on Windows with ``--noconftest``).
"""

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1] / "app"
KOREAN = "쿼벨 폴더 — 찾아줘…"


class _Api(BaseHTTPRequestHandler):
    """the backend's internal API, as far as a bridge sees it: echoes what it got, in Korean"""

    got: list = []

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
        _Api.got.append(body)
        out = json.dumps({"text": "찾았어요 — " + json.dumps(body, ensure_ascii=False)}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


@pytest.fixture
def api():
    srv = HTTPServer(("127.0.0.1", 0), _Api)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    _Api.got = []
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def _run(bridge: str, env: dict, requests: list[dict]) -> list[dict]:
    """The bridge as the app starts it (``-I``); off Windows the pipe's code page is forced to cp949 instead."""
    env = {**os.environ, **env}
    if sys.platform == "win32":
        args = [sys.executable, "-I", str(APP / bridge)]
    else:
        args = [sys.executable, str(APP / bridge)]
        env["PYTHONIOENCODING"] = "cp949"
    env.pop("PYTHONUTF8", None)
    lines = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in requests).encode("utf-8")
    p = subprocess.run(args, input=lines, capture_output=True, env=env, timeout=60)
    out = p.stdout.decode("utf-8")  # (what the engine reads: UTF-8, by the protocol)
    replies = [json.loads(line) for line in out.splitlines() if line.strip()]
    assert len(replies) == sum(1 for r in requests if "id" in r), f"the bridge died: {p.stderr.decode(errors='replace')[-800:]}"
    return replies


def _init(i=1):
    return {"jsonrpc": "2.0", "id": i, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}


def _call(i, name, args):
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}}


def test_the_mate_bridge(api):
    env = {"HRH_MATE_API": api, "HRH_MATE_TOKEN": "t", "HRH_MATE_MEMORY": "1", "HRH_MATE_STYLE": "auto", "HRH_MATE_STATE": "1",
           "HRH_MATE_OUTFIT": "1", "HRH_MATE_LIFE": "1", "HRH_MATE_SCREEN": "1"}
    init, listed, found = _run("mate/mcp_bridge.py", env, [
        _init(), {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        _call(3, "find_folders", {"query": KOREAN}),
    ])
    assert init["result"]["serverInfo"]["name"] == "mate"
    names = [t["name"] for t in listed["result"]["tools"]]
    assert {"find_folders", "list_sessions"} <= set(names)
    assert any(ch in json.dumps(listed, ensure_ascii=False) for ch in "—–"), "(the characters that broke it are still there)"
    assert _Api.got == [{"name": "find_folders", "arguments": {"query": KOREAN}}], "the Korean argument arrived whole"
    assert KOREAN in found["result"]["content"][0]["text"] and not found["result"]["isError"]


def test_the_avatar_bridge(api):
    env = {"HRH_AVATAR_API": api, "HRH_AVATAR_TOKEN": "t"}
    _init_reply, listed = _run("avatar/mcp_bridge.py", env, [_init(), {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}])
    assert listed["result"]["tools"]


def test_the_screen_bridge(api, tmp_path):
    token = tmp_path / "token"
    token.write_text("t")
    _init_reply, listed, called = _run("services/screen_bridge.py", {"HRH_SCREEN_API": api, "HRH_SCREEN_TOKEN_FILE": str(token)}, [
        _init(), {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, _call(3, "capture_screen", {"reason": KOREAN}),
    ])
    assert listed["result"]["tools"][0]["name"] == "capture_screen"
    assert "result" in called or "error" in called


def test_the_remote_bridge():
    hosts = json.dumps([{"name": "서버", "connection_id": "c1", "host": "h", "user": "u", "port": 22}], ensure_ascii=False)
    _init_reply, listed = _run("workspaces/mcp_remote_bridge.py", {"HRH_REMOTE_HOSTS": hosts},
                               [_init(), {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}])
    assert listed["result"]["tools"]
