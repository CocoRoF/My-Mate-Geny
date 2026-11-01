"""The mate MCP bridge speaks MCP over stdio and forwards tool calls to the
internal API with the conversation token (here: a fake backend over HTTP)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.mate import mcp_bridge

BRIDGE = mcp_bridge.__file__


class _Fake(BaseHTTPRequestHandler):
    calls: list = []

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _Fake.calls.append({"path": self.path, "token": self.headers.get("X-Mate-Token"), "body": body})
        if self.headers.get("X-Mate-Token") != "tok-123":
            self.send_response(401)
            out = json.dumps({"detail": "invalid mate token"}).encode()
        else:
            self.send_response(200)
            out = json.dumps({"text": f"ran {body['name']}", "is_error": body["name"] == "forget"}).encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):  # quiet
        pass


def _rpc(proc, msg):
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    if "id" not in msg:
        return None
    return json.loads(proc.stdout.readline())


def test_bridge_protocol_and_forwarding():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    api = f"http://127.0.0.1:{srv.server_address[1]}"
    env = {"PATH": os.environ.get("PATH", ""), "HRH_MATE_API": api, "HRH_MATE_TOKEN": "tok-123",
           "HRH_MATE_ID": "mate_x", "HRH_MATE_SESSION": "sess_y"}
    proc = subprocess.Popen([sys.executable, "-I", BRIDGE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            text=True, env=env)
    try:
        init = _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                           "params": {"protocolVersion": "2025-06-18", "capabilities": {}}})
        assert init["result"]["protocolVersion"] == "2025-06-18"
        assert init["result"]["serverInfo"]["name"] == "mate" and "tools" in init["result"]["capabilities"]
        _rpc(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        assert _rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "ping"})["result"] == {}
        tools = _rpc(proc, {"jsonrpc": "2.0", "id": 3, "method": "tools/list"})["result"]["tools"]
        names = [t["name"] for t in tools]
        assert names == ["list_sessions", "read_session", "send_to_session", "create_session", "find_folders",
                         "remember", "update_memory", "forget", "recall"]
        assert all(len(t["description"]) > 60 and t["inputSchema"]["type"] == "object" for t in tools)
        r = _rpc(proc, {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                        "params": {"name": "send_to_session", "arguments": {"session_id": "s", "message": "hi"}}})
        assert r["result"] == {"content": [{"type": "text", "text": "ran send_to_session"}], "isError": False}
        assert _Fake.calls[-1] == {"path": "/api/internal/mate/call", "token": "tok-123",
                                   "body": {"name": "send_to_session", "arguments": {"session_id": "s", "message": "hi"}}}
        r = _rpc(proc, {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "forget", "arguments": {"id": "m"}}})
        assert r["result"]["isError"] is True
        assert _rpc(proc, {"jsonrpc": "2.0", "id": 6, "method": "nope"})["error"]["code"] == -32601
        old = 2024
        init2 = _rpc(proc, {"jsonrpc": "2.0", "id": 7, "method": "initialize", "params": {"protocolVersion": f"{old}-01-01"}})
        assert init2["result"]["protocolVersion"] == "2024-11-05"
    finally:
        proc.stdin.close()
        proc.wait(timeout=5)
    # a wrong token: the model gets a readable error, the bridge keeps running
    proc = subprocess.Popen([sys.executable, "-I", BRIDGE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            text=True, env={**env, "HRH_MATE_TOKEN": "bad"})
    try:
        r = _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_sessions"}})
        assert r["result"]["isError"] is True and "HTTP 401" in r["result"]["content"][0]["text"]
        assert "invalid mate token" in r["result"]["content"][0]["text"]
    finally:
        proc.stdin.close()
        proc.wait(timeout=5)
        srv.shutdown()
    # backend down
    proc = subprocess.Popen([sys.executable, "-I", BRIDGE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            text=True, env={**env, "HRH_MATE_API": "http://127.0.0.1:9"})
    try:
        r = _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_sessions"}})
        assert r["result"]["isError"] is True and "unreachable" in r["result"]["content"][0]["text"]
    finally:
        proc.stdin.close()
        proc.wait(timeout=5)
