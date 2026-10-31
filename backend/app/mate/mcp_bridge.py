#!/usr/bin/env python3
"""Mate MCP bridge — the mate engine's only tools.

A stdio MCP server (JSON-RPC 2.0, one message per line; stdlib only) that the
mate's Claude Code engine starts via ``--mcp-config``. Each ``tools/call`` is
forwarded to the backend's internal API (``POST <api>/api/internal/mate/call``)
authenticated by the per-conversation token — never the user's cookie. The
backend does the work (list/read/steer chats, create chats, find folders,
memory) and returns the text the model sees.

Env: HRH_MATE_API (e.g. http://127.0.0.1:8080), HRH_MATE_TOKEN, HRH_MATE_ID,
HRH_MATE_SESSION.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")

TOOLS = [
    {
        "name": "list_sessions",
        "description": (
            "List the user's chat sessions (the workers: coding agents such as Claude Code or Codex, each "
            "working in one project folder), most recently active first. For each: session_id, title, "
            "workspace folder, provider/model, whether it is running a turn right now, last activity time, "
            "and short snippets of the last user message and the last answer. Use it to find the chat that "
            "already works on the project the user means before sending it anything."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string",
                          "description": "Optional filter: only chats whose title or folder contains this text."},
            },
        },
    },
    {
        "name": "read_session",
        "description": (
            "Read one chat: its recent messages (user instructions and the agent's answers, newest last), "
            "whether it is running, and what it is doing right now (current tool). Use it when the user asks "
            "how something is going or what a chat said. Don't call it repeatedly to wait for a result — "
            "results of work you delegated arrive by themselves as <delegation_result>."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "The chat's session_id (from list_sessions)."},
                "limit": {"type": "integer", "description": "How many recent messages (default 10, max 40)."},
            },
            "required": ["session_id"],
        },
    },
    {
        "name": "send_to_session",
        "description": (
            "Send an instruction to a chat, exactly as if the user typed it there: if the chat is idle it "
            "starts a new turn; if it is running, the message is added to the running turn (steering). The "
            "chat shows it as sent via you. Write a complete, self-contained instruction in the user's "
            "language — the worker cannot see your conversation. When that chat finishes, you get its answer "
            "as a <delegation_result>; tell the user briefly what you sent and end your turn meanwhile."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "Target chat's session_id."},
                "message": {"type": "string", "description": "The instruction for the worker."},
            },
            "required": ["session_id", "message"],
        },
    },
    {
        "name": "create_session",
        "description": (
            "Open a new chat on a project folder of this server (it must exist; use find_folders to get the "
            "exact path), optionally with a first instruction which starts its first turn right away (its "
            "result comes back to you as a <delegation_result>). Only when no existing chat works on that "
            "project. If you are not sure which folder the user means, ask them instead."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_path": {"type": "string", "description": "Absolute path of the project folder."},
                "message": {"type": "string", "description": "Optional first instruction for the new chat."},
                "title": {"type": "string", "description": "Optional chat title (default: from the message)."},
                "provider": {"type": "string", "enum": ["claude", "codex"],
                             "description": "Agent engine (default claude)."},
                "model": {"type": "string", "description": "Optional model id (default: the engine's default)."},
            },
            "required": ["workspace_path"],
        },
    },
    {
        "name": "find_folders",
        "description": (
            "Find project folders on this server by (part of) their name: first the folders existing chats "
            "work in, then a quick search of the home directories (a few levels deep; git repositories are "
            "marked). Returns absolute paths. Use before create_session; if several match, ask the user which."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Folder or project name to look for."}},
            "required": ["query"],
        },
    },
    {
        "name": "remember",
        "description": (
            "Save one lasting fact or preference about the user to your long-term memory (e.g. their name, "
            "what a project is for, how they like reports). Memories are shown to you in every conversation. "
            "Returns the memory id."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "One short, self-contained fact."}},
            "required": ["text"],
        },
    },
    {
        "name": "forget",
        "description": "Delete one memory by its id (the [id] shown in your memory list).",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "The memory id."}},
            "required": ["id"],
        },
    },
]


def _call(name: str, args: dict) -> dict:
    api = os.environ.get("HRH_MATE_API", "http://127.0.0.1:8080").rstrip("/")
    body = json.dumps({"name": name, "arguments": args if isinstance(args, dict) else {}}).encode()
    req = urllib.request.Request(
        f"{api}/api/internal/mate/call", data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Mate-Token": os.environ.get("HRH_MATE_TOKEN", "")},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            out = json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read(2000).decode(errors="replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except ValueError:
            pass
        return {"content": [{"type": "text", "text": f"{name} failed (HTTP {exc.code}): {detail}"}], "isError": True}
    except Exception as exc:  # noqa: BLE001 - backend unreachable
        return {"content": [{"type": "text", "text": f"{name} failed: backend unreachable ({exc})"}], "isError": True}
    return {"content": [{"type": "text", "text": str(out.get("text") or "")}], "isError": bool(out.get("is_error"))}


def _reply(msg_id, result=None, error=None) -> None:
    resp = {"jsonrpc": "2.0", "id": msg_id}
    resp["error" if error is not None else "result"] = error if error is not None else result
    sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(req, dict):
            continue
        method, msg_id = req.get("method"), req.get("id")
        if method == "initialize":
            asked = (req.get("params") or {}).get("protocolVersion")
            _reply(msg_id, {
                "protocolVersion": asked if asked in _PROTOCOLS else _PROTOCOLS[-1],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "mate", "version": "1.0.0"},
            })
        elif method == "ping":
            _reply(msg_id, {})
        elif method == "tools/list":
            _reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = req.get("params") or {}
            _reply(msg_id, _call(str(params.get("name") or ""), params.get("arguments") or {}))
        elif msg_id is None:
            continue  # notifications (initialized, cancelled, …)
        else:
            _reply(msg_id, error={"code": -32601, "message": f"unknown method: {method}"})


if __name__ == "__main__":
    main()
