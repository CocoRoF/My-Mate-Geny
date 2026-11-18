#!/usr/bin/env python3
"""Session-bound stdio MCP: "tell me when it's done" (app/services/done_notify.py). Its token is in a 0600 file."""
import json
import os
import sys
import urllib.request
from pathlib import Path

TOOL = {"name": "notify_when_done", "description": (
    "The user asked to be told when this work is done (끝나면 알려 줘 / 다 되면 알람 / let me know when it's done): call this "
    "once, right away, then do the work. When your turn ends, their mate phones them with what you did."),
    "inputSchema": {"type": "object", "properties": {
        "note": {"type": "string", "description": "Optional: what they want to hear about, in their words."}}}}


def call(args):
    req = urllib.request.Request(os.environ["HRH_NOTIFY_API"] + "/api/internal/notify/call",
                                 data=json.dumps({"arguments": args}).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "X-Notify-Token": Path(os.environ["HRH_NOTIFY_TOKEN_FILE"]).read_text()})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            out = json.load(response)
        return {"content": [{"type": "text", "text": out.get("text") or ""}], "isError": bool(out.get("is_error"))}
    except Exception:
        return {"content": [{"type": "text", "text": "Couldn't set it now; tell them to use the bell by the message box."}],
                "isError": True}


def main():
    # (MCP over stdio is UTF-8; a Windows pipe is the ANSI code page, and -I ignores PYTHONUTF8)
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict) or "id" not in msg:
                continue
            method = msg.get("method")
            if method == "initialize":
                result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "geny-notify", "version": "1.0"}}
            elif method == "tools/list":
                result = {"tools": [TOOL]}
            elif method == "tools/call" and msg.get("params", {}).get("name") == "notify_when_done":
                result = call(msg.get("params", {}).get("arguments") or {})
            elif method == "ping":
                result = {}
            else:
                print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "Unknown method"}}),
                      flush=True)
                continue
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
        except (ValueError, TypeError):
            continue


if __name__ == "__main__":
    main()
