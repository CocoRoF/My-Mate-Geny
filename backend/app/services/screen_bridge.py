#!/usr/bin/env python3
"""Session-bound stdio MCP for local screen capture. No credentials or images on stderr/disk."""
import json
import os
import sys
from pathlib import Path
import urllib.request

TOOL = {"name": "capture_screen", "description": "See the current screen/window shared by the user of this "
        "conversation on their local device (not the server). Requires their explicit sharing consent.",
        "inputSchema": {"type": "object", "properties": {"reason": {"type": "string"}}}}


def call(args):
    req = urllib.request.Request(os.environ["HRH_SCREEN_API"] + "/api/internal/screen/call",
                                 data=json.dumps({"arguments": args}).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Screen-Token": Path(os.environ["HRH_SCREEN_TOKEN_FILE"]).read_text()})
    try:
        with urllib.request.urlopen(req, timeout=130) as response:
            out = json.load(response)
        content = [{"type": "text", "text": out.get("text") or ""}]
        content += [{"type": "image", "data": img["data"], "mimeType": img["mime"]} for img in out.get("images", [])]
        return {"content": content, "isError": bool(out.get("is_error"))}
    except Exception:
        return {"content": [{"type": "text", "text": "Local screen capture unavailable; check sharing on your device."}], "isError": True}


def main():
    # MCP over stdio is UTF-8. On Windows a pipe is the ANSI code page (cp949, cp1252…) instead, and -I ignores
    # PYTHONUTF8: a tool list or an answer with characters it lacks killed the bridge (no tools for the engine).
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict) or "id" not in msg:
                continue
            method = msg.get("method")
            if method == "initialize":
                result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "geny-local-screen", "version": "1.0"}}
            elif method == "tools/list":
                result = {"tools": [TOOL]}
            elif method == "tools/call" and msg.get("params", {}).get("name") == "capture_screen":
                result = call(msg.get("params", {}).get("arguments") or {})
            elif method == "ping":
                result = {}
            else:
                print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "Unknown method"}}), flush=True)
                continue
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
        except (ValueError, TypeError):
            continue


if __name__ == "__main__":
    main()
