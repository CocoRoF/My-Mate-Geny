"""Session-wide history numbers, folded once and extended as events arrive.

Every history page carries numbers about the whole chat or about everything
before its cursor (services/history_page.py): the turn costs (which need the
session's terminal events from the start, for the legacy running-total
normalization), the "Changed files" before the cursor, the latest TodoWrite
before the cursor. Computing them from scratch meant rescanning the session's
tool calls on every page.

:class:`SessionAggregates` keeps, per session, what those numbers are folded
from — one small record per terminal event, per edit call, per failed tool
result, per git snapshot and per TodoWrite candidate — together with the
highest event id it has folded in. Each request extends it with the events
added since (``id > upto``); events are only ever appended (a deleted chat
takes its rows with it: :meth:`drop`), so the extension is exact. The answers
for a cursor are then cheap folds over those records with the same rules
(and the same SQL text matches) the full scans used, so they are identical to
the old per-request scans.

It also remembers each tool call's name by id: a tool result names only its
call, and the lite pages (services/history_lite.py) pick a result's preview
rule by the tool's name.
"""

from __future__ import annotations

import copy
import json
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from app.db import Database
from app.services.turn_cost import TurnCostNormalizer

# Text json.dumps writes (default separators), matched with instr() as before.
TODO_NAME = '"name": "TodoWrite"'
# Tool calls the "Changed files" list counts (SessionPanel.changesOf):
EDIT_NAMES = ("edit", "multiedit", "notebookedit", "write", "remote_write", "apply_patch")
_HEAD = 400  # chars of a tool call's JSON read for its id + name


def tool_norm(name: Any) -> str:
    n = str(name or "")
    if n.startswith("mcp__remote__"):
        n = n[len("mcp__remote__"):]
    return n.lower()


def _head_name(text: str) -> str | None:
    """The text after the first ``"name": "`` up to its closing quote (what the
    old SQL read: ``substr(data, instr(data, '"name": "') + 9, 64)``)."""
    i = text.find('"name": "')
    if i < 0:
        return None
    seg = text[i + 9:i + 9 + 64]
    q = seg.find('"')
    return seg[:q] if q >= 0 else ""


def _head_id(text: str) -> str | None:
    if not text.startswith('{"id": "'):
        return None
    q = text.find('"', 8)
    return text[8:q] if q >= 0 else None


def edit_touches(name: Any, inp: Any) -> list[tuple[Any, bool]]:
    """(path, created) for each file an edit call touched (SessionPanel.changesOf)."""
    n = tool_norm(name)
    i = inp if isinstance(inp, dict) else {}
    if n in ("edit", "multiedit", "notebookedit"):
        return [(i.get("file_path") or i.get("notebook_path"), False)]
    if n in ("write", "remote_write"):
        return [(i.get("file_path") or i.get("path"), True)]
    if n == "apply_patch" and isinstance(i.get("changes"), list):
        return [(c.get("path"), c.get("kind") == "add") for c in i["changes"] if isinstance(c, dict)]
    return []


@dataclass
class _Agg:
    upto: int = 0  # highest event id folded in
    norm: TurnCostNormalizer = field(default_factory=TurnCostNormalizer)
    terminal: list[dict[str, Any]] = field(default_factory=list)  # {eid, type, at, data (normalized)}, id order
    terminal_by_eid: dict[int, dict[str, Any]] = field(default_factory=dict)
    names: dict[str, str] = field(default_factory=dict)  # tool call id -> tool name
    edits: list[tuple[int, str, str, list[tuple[Any, bool]]]] = field(default_factory=list)  # (eid, at, call id, touches)
    failed: set[str] = field(default_factory=set)  # ids of failed tool calls
    git: list[tuple[int, str, list[tuple[str, bool]]]] = field(default_factory=list)  # turn.changes
    todos: list[tuple[str, int, bool, Any]] = field(default_factory=list)  # (at, eid, is TodoWrite, its input)


class SessionAggregates:
    """Per-session :class:`_Agg` records (the most recently used ``max_sessions``)."""

    def __init__(self, max_sessions: int = 32) -> None:
        self._lock = threading.Lock()
        self._by_sid: OrderedDict[str, _Agg] = OrderedDict()
        self._max = max_sessions

    def drop(self, sid: str) -> None:
        with self._lock:
            self._by_sid.pop(sid, None)

    def get(self, db: Database, sid: str) -> _Agg:
        """The session's records, extended with every event stored so far."""
        with self._lock:
            agg = self._by_sid.get(sid)
            row = db.query_one("SELECT MAX(id) AS m FROM events WHERE session_id = ?", (sid,))
            hi = int(row["m"] or 0) if row else 0
            if agg is None or hi < agg.upto:  # (fewer rows than folded: rebuild)
                agg = _Agg()
            if hi > agg.upto:
                _extend(db, sid, agg, hi)
            self._by_sid[sid] = agg
            self._by_sid.move_to_end(sid)
            while len(self._by_sid) > self._max:
                self._by_sid.popitem(last=False)
            return agg

    # ---- answers for a cursor (start: the page's cursor; None = everything) ----

    @staticmethod
    def todos(agg: _Agg, start: str) -> Any:
        """Input of the latest TodoWrite before ``start`` — among the 5 latest
        calls whose JSON holds ``"name": "TodoWrite"`` (the old query's window)."""
        cands = sorted((t for t in agg.todos if t[0] < start), key=lambda t: (t[0], t[1]), reverse=True)[:5]
        for _at, _eid, real, inp in cands:
            if real:
                return copy.deepcopy(inp)
        return None

    @staticmethod
    def changes(agg: _Agg, start: str, skip: set[int]) -> dict[str, Any]:
        """SessionPanel's "Changed files" for the events before ``start``: git
        snapshots when the chat has any, else the edit calls (most recent last)."""
        files: dict[str, dict[str, Any]] = {}

        def touch(path: Any, created: bool, failed: bool) -> None:
            if not path:
                return
            path = str(path)
            c = files.pop(path, None) or {"path": path, "ops": 0, "created": False, "failed": False}
            c["ops"] += 1
            c["created"] = c["created"] or created
            c["failed"] = c["failed"] or failed
            files[path] = c

        git = [g for g in agg.git if g[1] < start]
        if git:
            for _eid, _at, touches in git:
                for path, created in touches:
                    touch(path, created, False)
            return {"git": True, "files": list(files.values())}
        for eid, at, call_id, touches in agg.edits:
            if at >= start or eid in skip:
                continue
            err = call_id in agg.failed
            for path, created in touches:
                touch(path, created, err)
        return {"git": False, "files": list(files.values())}


def _extend(db: Database, sid: str, agg: _Agg, hi: int) -> None:
    lo = agg.upto
    span = (sid, lo, hi)
    # Terminal events, normalized in id order (turn_cost's running totals).
    for r in db.query(
        "SELECT id, type, data, created_at FROM events INDEXED BY idx_events_sid_type "
        "WHERE session_id = ? AND type IN ('turn.complete', 'error') AND id > ? AND id <= ? ORDER BY id",
        span,
    ):
        data = json.loads(r["data"])
        if isinstance(data, dict):
            data = agg.norm.feed(data)
        t = {"eid": r["id"], "type": r["type"], "at": r["created_at"], "data": data}
        agg.terminal.append(t)
        agg.terminal_by_eid[r["id"]] = data
    # Failed tool results (the partial index).
    for r in db.query(
        "SELECT data FROM events INDEXED BY idx_events_tool_err "
        "WHERE session_id = ? AND type = 'tool.result' AND instr(data, '\"is_error\": true') > 0 "
        "AND id > ? AND id <= ?",
        span,
    ):
        d = json.loads(r["data"])
        if d.get("is_error"):
            agg.failed.add(str(d.get("id")))
    # Git snapshots.
    for r in db.query(
        "SELECT id, data, created_at FROM events INDEXED BY idx_events_sid_type "
        "WHERE session_id = ? AND type = 'turn.changes' AND id > ? AND id <= ? ORDER BY id",
        span,
    ):
        d = json.loads(r["data"])
        touches = [(f"{repo.get('root')}/{f.get('path')}", f.get("status") == "A")
                   for repo in d.get("repos") or [] for f in repo.get("files") or []]
        agg.git.append((r["id"], r["created_at"], touches))
    # Tool calls: the head (id + name) of every one; edits and TodoWrites in full.
    full: list[tuple[int, str, bool]] = []  # (eid, at, todo candidate)
    for r in db.query(
        "SELECT id, created_at, substr(data, 1, ?) AS head, instr(data, ?) > 0 AS todo "
        "FROM events INDEXED BY idx_events_sid_type "
        "WHERE session_id = ? AND type = 'tool.use' AND id > ? AND id <= ? ORDER BY id",
        (_HEAD, TODO_NAME, *span),
    ):
        head = str(r["head"] or "")
        call_id, name = _head_id(head), _head_name(head)
        if call_id is None or not name:
            full.append((r["id"], r["created_at"], bool(r["todo"])))  # (not readable from the head)
            continue
        agg.names[call_id] = name
        low = name.lower()
        if low in EDIT_NAMES or low.startswith("mcp__remote__") or r["todo"]:
            full.append((r["id"], r["created_at"], bool(r["todo"])))
    for k in range(0, len(full), 500):
        chunk = full[k:k + 500]
        rows = {r["id"]: r["data"] for r in db.query(
            f"SELECT id, data FROM events WHERE id IN ({','.join('?' * len(chunk))})", [c[0] for c in chunk])}
        for eid, at, todo in chunk:
            try:
                d = json.loads(rows[eid])
            except (KeyError, TypeError, ValueError):
                continue
            if not isinstance(d, dict):
                continue
            if d.get("id") is not None and isinstance(d.get("name"), str):
                agg.names.setdefault(str(d.get("id")), d["name"])
            n = tool_norm(d.get("name"))
            if n in EDIT_NAMES:
                agg.edits.append((eid, at, str(d.get("id")), edit_touches(d.get("name"), d.get("input"))))
            if todo:
                real = n == "todowrite"
                agg.todos.append((at, eid, real, d.get("input") if real else None))
    agg.upto = hi
