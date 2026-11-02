#!/usr/bin/env python3
"""Avatar Create MCP bridge — the avatar agent's only tools (docs/avatar-create.md §3).

A stdio MCP server (JSON-RPC 2.0, one message per line; stdlib only) the agent's engine starts. Each ``tools/call``
goes to the backend's internal API (``POST <api>/api/internal/avatar/call``) with the conversation's token — never
the user's cookie. The backend does the work; nothing here can spend credits without the user's confirmation (the
server's gate, app/avatar/plan.py).

Env: HRH_AVATAR_API (e.g. http://127.0.0.1:8080), HRH_AVATAR_TOKEN, HRH_AVATAR_PROJECT.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
_OBJ = {"type": "object", "properties": {}}

_CLIP = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "lowercase id, e.g. idle_a, wave2"},
        "kind": {"type": "string", "enum": ["idle", "talk", "listen", "think", "react", "away"]},
        "action": {"type": "string", "description": "What happens, one short English sentence with {S} for the "
                                                    "subject and {pos} for the possessive, e.g. '{S} waves shyly'."},
        "emotion": {"type": "string", "description": "react clips: the emotion tag that plays it"},
    },
    "required": ["id", "kind", "action"],
}
_STILL = {"type": "object", "properties": {"name": {"type": "string"}, "face": {"type": "string"}},
          "required": ["name"]}

TOOLS = [
    {"name": "get_project",
     "description": "The avatar project now: status and phase, the brief (reference, design prompt, pronoun, "
                    "candidates, aspect, tier, preset, clips, stills, target mate), what is still missing before an "
                    "estimate, the plan with its prices, the user's confirmation, credits counted vs the cap, each "
                    "item's state, failures, the clip check and whether the avatar is ready or applied.",
     "inputSchema": _OBJ},
    {"name": "ask_user",
     "description": "Show the user a question card and wait for the answer (it arrives as their next message). "
                    "kind: choice (one option), multi (several), slider (a number: min/max/step/default/unit), "
                    "upload (a reference picture; include an option like 'no reference'), text (free text), "
                    "mate (pick one of their mates, or a new mate). Write the question and labels in the user's "
                    "language; option values may be short English words. One topic per card; end your turn after.",
     "inputSchema": {"type": "object", "properties": {
         "question": {"type": "string"},
         "kind": {"type": "string", "enum": ["choice", "multi", "slider", "upload", "text", "mate"]},
         "options": {"type": "array", "items": {"type": "object", "properties": {
             "value": {"type": "string"}, "label": {"type": "string"}, "description": {"type": "string"}}}},
         "allow_other": {"type": "boolean", "description": "offer a free-text 'other' answer (choice/multi)"},
         "min": {"type": "number"}, "max": {"type": "number"}, "step": {"type": "number"},
         "default": {"type": "number"}, "unit": {"type": "string"}},
         "required": ["question", "kind"]}},
    {"name": "update_brief",
     "description": "Record decisions in the brief (merged, checked; returns the brief and what is still missing). "
                    "Fields: reference {mode: none|redraw|as_base}, design {prompt: 1-3 English sentences describing "
                    "the character only, notes}, pronoun (she|he|they), candidates (1-4), aspect (1:1|9:16), tier "
                    "(studio|light), preset (minimal|standard|rich|custom — a preset fills clips and stills), clips "
                    "[{id, kind, action, emotion?}], stills [{name, face}], target {mode: new|existing, mate_id?, "
                    "name?}. Locked once the plan is confirmed.",
     "inputSchema": {"type": "object", "properties": {"patch": {"type": "object", "properties": {
         "reference": {"type": "object"}, "design": {"type": "object"}, "pronoun": {"type": "string"},
         "candidates": {"type": "integer"}, "aspect": {"type": "string"}, "tier": {"type": "string"},
         "preset": {"type": "string"}, "clips": {"type": "array", "items": _CLIP},
         "stills": {"type": "array", "items": _STILL}, "target": {"type": "object"}}}},
         "required": ["patch"]}},
    {"name": "use_reference",
     "description": "Make a picture the user attached in this chat (its [att_…] id) the character reference.",
     "inputSchema": {"type": "object", "properties": {"attachment_id": {"type": "string"}},
                     "required": ["attachment_id"]}},
    {"name": "estimate",
     "description": "Build the whole plan from the brief and get Higgsfield's real price for every job (free, "
                    "nothing is created). The user then sees the estimate card (items, total, reserve, balance "
                    "after, time) with Confirm / Change plan / Cancel. Only their Confirm starts anything.",
     "inputSchema": _OBJ},
    {"name": "look",
     "description": "See pictures yourself to judge them: target reference | candidates | home (the base picture "
                    "and the face region stills may change) | stills | clip:<id> (four frames).",
     "inputSchema": {"type": "object", "properties": {"target": {"type": "string"}}, "required": ["target"]}},
    {"name": "regenerate",
     "description": "Redo one item after the plan was confirmed: item = design (a new batch of candidates) | home "
                    "(the cut-out) | still:<name> | clip:<id>. note = a short English hint for the redo (e.g. "
                    "'keep both hands on the desk'). Small redos inside the cap run at once; bigger ones show the "
                    "user a card to confirm (then end your turn).",
     "inputSchema": {"type": "object", "properties": {"item": {"type": "string"}, "note": {"type": "string"}},
                     "required": ["item"]}},
    {"name": "extend",
     "description": "Add clips and/or stills after the plan was confirmed (priced from the plan; the user confirms "
                    "a card).",
     "inputSchema": {"type": "object", "properties": {"clips": {"type": "array", "items": _CLIP},
                                                      "stills": {"type": "array", "items": _STILL}}}},
    {"name": "pause", "description": "Pause the run: no new jobs start; running jobs finish.", "inputSchema": _OBJ},
    {"name": "resume", "description": "Resume a paused (or failed) run of the confirmed plan.", "inputSchema": _OBJ},
    {"name": "cancel", "description": "Cancel the project's run (no new jobs; running ones finish). Only when the "
                                      "user asks for it.", "inputSchema": _OBJ},
]

_SLOW = {"estimate": 240, "look": 330}


def _call(name: str, args: dict) -> dict:
    api = os.environ.get("HRH_AVATAR_API", "http://127.0.0.1:8080").rstrip("/")
    body = json.dumps({"name": name, "arguments": args if isinstance(args, dict) else {}}).encode()
    req = urllib.request.Request(
        f"{api}/api/internal/avatar/call", data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Avatar-Token": os.environ.get("HRH_AVATAR_TOKEN", "")},
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
            content.append({"type": "image", "data": str(img["data"]), "mimeType": str(img.get("mime") or "image/jpeg")})
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
            _reply(msg_id, {"protocolVersion": asked if asked in _PROTOCOLS else _PROTOCOLS[-1],
                            "capabilities": {"tools": {}}, "serverInfo": {"name": "avatar", "version": "1.0.0"}})
        elif method == "ping":
            _reply(msg_id, {})
        elif method == "tools/list":
            _reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = req.get("params") or {}
            _reply(msg_id, _call(str(params.get("name") or ""), params.get("arguments") or {}))
        elif msg_id is None:
            continue
        else:
            _reply(msg_id, error={"code": -32601, "message": f"unknown method: {method}"})


if __name__ == "__main__":
    main()
