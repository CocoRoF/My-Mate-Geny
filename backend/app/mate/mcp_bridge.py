#!/usr/bin/env python3
"""Mate MCP bridge — the mate engine's only tools.

A stdio MCP server (JSON-RPC 2.0, one message per line; stdlib only) that the
mate engine (Claude Code ``--mcp-config``, Codex ``mcp_servers.mate``) starts. Each ``tools/call`` is
forwarded to the backend's internal API (``POST <api>/api/internal/mate/call``)
authenticated by the per-conversation token — never the user's cookie. The
backend does the work (list/read/steer chats, create chats, find folders,
memory) and returns the text the model sees.

Env: HRH_MATE_API (e.g. http://127.0.0.1:8080), HRH_MATE_TOKEN, HRH_MATE_ID,
HRH_MATE_SESSION; HRH_MATE_SCREEN=1 when the mate may look at the user's screen
(``see_screen`` is listed only then; its picture comes back as MCP image content);
HRH_MATE_STYLE=auto|ask when she may change her own conversation style
(``update_conversation_style``; absent = not listed).
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")

_ATTACHMENTS_PARAM = {
    "type": "array",
    "items": {"type": "string"},
    "description": (
        "Optional: ids of files from this conversation to send along (the [att_…] ids in the "
        "<attachments> list of the user's messages). The chat gets copies, exactly like a user upload."
    ),
}

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
            "as a <delegation_result>; tell the user briefly what you sent and end your turn meanwhile. "
            "To pass along files the user gave you (a screenshot, a document…), list their ids in "
            "`attachments`: the chat receives them exactly like a user upload, and can open what you can't."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "Target chat's session_id."},
                "message": {"type": "string", "description": "The instruction for the worker."},
                "attachments": _ATTACHMENTS_PARAM,
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
            "project. If you are not sure which folder the user means, ask them instead. Files the user gave "
            "you can go along with the first instruction (`attachments`)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_path": {"type": "string", "description": "Absolute path of the project folder."},
                "message": {"type": "string", "description": "Optional first instruction for the new chat."},
                "attachments": _ATTACHMENTS_PARAM,
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
            "Save one memory about the user: who they are (profile), what they like or how they want things "
            "done (preference), a lasting fact (fact), an appointment / promise / reminder with its date (plan), "
            "or what is going on these days (context — fades after a few weeks). If you already remember the "
            "same thing it is updated instead of duplicated; similar memories are listed so you can merge them. "
            "Not for how they want you to talk (speech level, what to call them, language, length, tone): that "
            "is your conversation style. Returns the memory id."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "One short, self-contained memory in the user's language."},
                "kind": {"type": "string", "enum": ["profile", "preference", "fact", "plan", "context"],
                         "description": "Default fact."},
                "importance": {"type": "integer", "minimum": 1, "maximum": 5,
                               "description": "1 – 5 (default 3); 4–5 only for what really matters to them."},
                "due": {"type": "string",
                        "description": "plan: when — YYYY-MM-DD or YYYY-MM-DDTHH:MM, the user's local time."},
            },
            "required": ["text"],
        },
    },
    {
        "name": "update_memory",
        "description": (
            "Change a memory in place (same id): correct or merge its text, change its kind, importance or date, "
            "or mark a plan done (status done). Use it instead of adding a near-duplicate."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "The memory id ([mem_…])."},
                "text": {"type": "string", "description": "The corrected text."},
                "kind": {"type": "string", "enum": ["profile", "preference", "fact", "plan", "context"]},
                "importance": {"type": "integer", "minimum": 1, "maximum": 5},
                "due": {"type": "string", "description": "YYYY-MM-DD or YYYY-MM-DDTHH:MM; empty clears it."},
                "status": {"type": "string", "enum": ["active", "done", "archived"]},
            },
            "required": ["id"],
        },
    },
    {
        "name": "forget",
        "description": "Delete one memory by its id (it was wrong, or the user asked you to drop it).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "The memory id."},
                "reason": {"type": "string", "description": "Optional: why (wrong, outdated, the user asked)."},
            },
            "required": ["id"],
        },
    },
    {
        "name": "recall",
        "description": (
            "Search your memory of the user (everything, not only what the <context> block brought) — e.g. "
            "\"what did they say about the trip\", \"their plans this week\"."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Words to look for."},
                "kind": {"type": "string", "enum": ["profile", "preference", "fact", "plan", "context"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 10, "description": "Default 6."},
                "include_done": {"type": "boolean", "description": "Also done plans and archived memories."},
            },
            "required": ["query"],
        },
    },
]


# offered unless the mate's "may change her own conversation style" setting is off (HRH_MATE_STYLE=auto|ask)
_LEVEL = {"type": "string", "enum": ["low", "auto", "high"]}
UPDATE_STYLE = {
    "name": "update_conversation_style",
    "description": (
        "Change your own conversation style (how you talk to the user — the settings the user sees as "
        "\"Conversation style\") when they ask for a lasting change: e.g. talk casually / politely from now on, "
        "call them something else, refer to yourself differently, answer in another language, keep replies "
        "shorter, drop or adopt a habit, more or less humor, a topic to avoid. Give only the fields that change. "
        "Not for a one-off request (\"answer briefly this time\") — just do that — and never store such "
        "preferences with remember. The user sees every change in the conversation and can undo it. "
        "Returns the style as it is now."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "formality": {"type": "string", "enum": ["auto", "haeyo", "hapsyo", "banmal"],
                          "description": ("Speech level: haeyo (polite 해요체 / warm and friendly), hapsyo (formal "
                                          "합쇼체 / formal), banmal (반말 / casual), auto (your character's own).")},
            "address": {"type": "string",
                        "description": "What you call the user, exactly as you would say it (\"\" = your character's way)."},
            "user_name": {"type": "string", "description": "The user's name."},
            "self_ref": {"type": "string",
                         "description": "How you refer to yourself (\"\" = as your character does)."},
            "language": {"type": "string",
                         "description": "Reply language code: ko, en, ja, zh, es, fr, de, it, pt, vi."},
            "length": {"type": "string", "enum": ["short", "normal", "long"], "description": "Reply length."},
            "emotion": {"type": "integer", "minimum": 0, "maximum": 3,
                        "description": "Emotion tags: 0 none, 1 subtle, 2 normal, 3 expressive."},
            "tone": {"type": "object", "properties": {"warmth": _LEVEL, "humor": _LEVEL, "initiative": _LEVEL},
                     "description": "low | auto (your character's) | high, per key."},
            "speech_style": {"type": "string", "description": (
                "Your speech habits (rhythm, catchphrases, sample lines): the WHOLE new text, replacing the old — "
                "start from your current habits and change only what the user asked.")},
            "avoid": {"type": "string", "description": "Topics to avoid: the whole new list, replacing the old."},
            "reason": {"type": "string",
                       "description": "One short line: what the user asked (shown to them with the change)."},
        },
        "required": ["reason"],
    },
}

# offered only while the mate's Screen setting is on (HRH_MATE_SCREEN=1, app/mate/service.configure_engine)
SEE_SCREEN = {
    "name": "see_screen",
    "description": (
        "Look at the user's screen: their desktop app captures it (the screen or the window they chose in your "
        "settings) and the picture comes back to you; it also appears in your conversation. They may be asked to "
        "allow it first — if they say no, or don't answer, you get no picture. Use it when they ask you to look, "
        "or talk about something on their screen they haven't described. Works only while the desktop app is "
        "open on their computer."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "reason": {"type": "string",
                       "description": "One short line shown to the user with the request: why you want to look."},
        },
    },
}
_SLOW = {"see_screen": 150}  # (waits for the user's answer + the capture; the backend always answers sooner)


def tools() -> list[dict]:
    return (TOOLS + ([UPDATE_STYLE] if os.environ.get("HRH_MATE_STYLE") in ("auto", "ask") else [])
            + ([SEE_SCREEN] if os.environ.get("HRH_MATE_SCREEN") == "1" else []))


def _call(name: str, args: dict) -> dict:
    api = os.environ.get("HRH_MATE_API", "http://127.0.0.1:8080").rstrip("/")
    body = json.dumps({"name": name, "arguments": args if isinstance(args, dict) else {}}).encode()
    req = urllib.request.Request(
        f"{api}/api/internal/mate/call", data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Mate-Token": os.environ.get("HRH_MATE_TOKEN", "")},
    )
    try:
        with urllib.request.urlopen(req, timeout=_SLOW.get(name, 90)) as resp:
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
    content = [{"type": "text", "text": str(out.get("text") or "")}]
    for img in out.get("images") or []:
        if isinstance(img, dict) and img.get("data"):
            content.append({"type": "image", "data": str(img["data"]), "mimeType": str(img.get("mime") or "image/png")})
    return {"content": content, "isError": bool(out.get("is_error"))}


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
            _reply(msg_id, {"tools": tools()})
        elif method == "tools/call":
            params = req.get("params") or {}
            _reply(msg_id, _call(str(params.get("name") or ""), params.get("arguments") or {}))
        elif msg_id is None:
            continue  # notifications (initialized, cancelled, …)
        else:
            _reply(msg_id, error={"code": -32601, "message": f"unknown method: {method}"})


if __name__ == "__main__":
    main()
