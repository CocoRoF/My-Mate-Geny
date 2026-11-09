"""Messages the user deleted from their chat: kept, shown to nobody.

What the user wrote — a message, or a steer (what they added while a turn ran) — can be taken out of their view: in a
mate's conversation as in a chat, with the pictures and files sent along. It is a hiding, not an erasing: the engine
already has it in its context, a mate in her memory, and those stay as they are. The message gets ``meta.hidden``
(when), and every read the chat view makes hands it out empty — no text, no attachments, ``meta = {"hidden": …}`` —
so the turn it started stays where it was (history pages cut at user messages) and the client draws nothing for it.

A steer is stored twice: as a message (role ``steer``) and as the ``user.steer`` event that places it inside its turn,
with its text and files. That event is emptied the same way.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Iterable

STEER = "user.steer"


def _meta(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        out = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        return {}
    return out if isinstance(out, dict) else {}


def is_hidden(meta: Any) -> bool:
    return bool(_meta(meta).get("hidden"))


def redact_message(m: dict[str, Any]) -> dict[str, Any]:
    """A message as a chat view gets it: a hidden one empty (``meta`` parsed or not, as it came)."""
    meta = _meta(m.get("meta"))
    if not meta.get("hidden"):
        return m
    return {**m, "content": "", "meta": {"hidden": meta["hidden"]}, "attachments": []}


def hidden_steers(db: Any, sid: str) -> set[str]:
    return {r["id"] for r in db.query(
        "SELECT id FROM messages WHERE session_id = ? AND role = 'steer' AND json_valid(meta) "
        "AND json_extract(meta, '$.hidden') IS NOT NULL", (sid,))}


def redact_events(db: Any, sid: str, events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Events as a chat view gets them: the ``user.steer`` of a hidden steer without its text and files."""
    events = list(events)
    if not any(e.get("type") == STEER for e in events):
        return events
    hidden = hidden_steers(db, sid)
    if not hidden:
        return events
    out = []
    for e in events:
        mid = str((e.get("data") or {}).get("message_id") or "")
        if e.get("type") == STEER and mid in hidden:
            e = {**e, "data": {"message_id": mid, "hidden": True, "text": "", "attachments": []}}
        out.append(e)
    return out


class NotYours(ValueError):
    """Not something the user wrote: a mate's message, one the app made, or speech still being heard."""


def hide(db: Any, sid: str, mid: str) -> bool:
    """Hide what the user wrote (``KeyError``: no such message in this chat). True: it was shown until now."""
    row = db.query_one("SELECT role, meta FROM messages WHERE id = ? AND session_id = ?", (mid, sid))
    if row is None:
        raise KeyError(mid)
    meta = _meta(row["meta"])
    if row["role"] not in ("user", "steer") or meta.get("internal") or meta.get("via") or meta.get("speech_pending"):
        raise NotYours("only a message you wrote can be deleted")
    if meta.get("hidden"):
        return False
    at = datetime.now(timezone.utc).isoformat()
    db.execute("UPDATE messages SET meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.hidden', ?) "
               "WHERE id = ?", (at, mid))
    return True
