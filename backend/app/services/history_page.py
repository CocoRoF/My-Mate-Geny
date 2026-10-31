"""Paged chat history: the newest turns first, older ones on demand.

``GET /api/history/{sid}`` used to hand out every message and event of a chat;
the client replays them all. This module serves the same data a few turns at a
time, plus the session-wide numbers the client used to derive from the full
replay (cost, context meter, todo list, changed files, still-running
background work).

Turns and pages
---------------
The client rebuilds turns from messages and events merged on ONE timeline,
sorted by timestamp (``chatStore.reconstruct``). A turn starts at

* a **user message** (``messages.role = 'user'``; a mate's delegation results
  are user messages too), or
* an **auto turn**: the ``session.start`` event Claude's engine emits when it
  starts a turn by itself (``"trigger": "background"``).

Everything else lives between two such anchors and belongs to the turn before
it: the turn's events, steers, notices that arrive while idle, compaction
markers, background-subagent steps. A page is therefore a half-open time range
``[cursor, until)`` that starts exactly at an anchor — the same cut the full
replay would make, so a page never splits a turn. The oldest page also takes
whatever precedes the first anchor (a mate's greeting, an early notice).

The cursor handed to the client is the start of its loaded range (an ISO
timestamp, ``None`` = the beginning). Older pages: ``before=<cursor>``. A
reconnect reloads ``since=<cursor>`` — everything the client had, plus what it
missed — without dropping the pages it already scrolled through.

Cross-page references
---------------------
A background subagent launched in an old turn keeps reporting later: its steps
are stored (by time) in a newer page while its Agent call sits in an older one.
The client parks such events until their turn is loaded. For background tasks
that are still running, ``summary.pinned`` carries the launching call and its
steps from before the cursor, so their cards show without paging back.

All queries are indexed (see ``db.py``): ``events(session_id, created_at)`` for
slices, ``events(session_id, type, id)`` for "latest X" lookups, and a partial
index for failed tool results. Big tool outputs are only read for the page
itself.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Callable

from app.db import Database
from app.services.turn_cost import COST_EVENTS, TurnCostNormalizer, turn_cost

# Text json.dumps writes (default separators) — matched with instr(), which
# never fails on a value that isn't valid JSON, unlike json_extract.
_AUTO_START = '"trigger": "background"'
_TODO_NAME = '"name": "TodoWrite"'
# Tool calls the "Changed files" list counts (SessionPanel.changesOf):
_EDIT_NAMES = ("edit", "multiedit", "notebookedit", "write", "remote_write", "apply_patch")
_EDIT_PATTERNS = (
    '"name": "Edit"', '"name": "MultiEdit"', '"name": "NotebookEdit"', '"name": "Write"',
    '"name": "apply_patch"', '"name": "remote_write"', '"name": "mcp__remote__',
    '"name": "edit"', '"name": "multiedit"', '"name": "notebookedit"', '"name": "write"',
)
_CTX_KEYS = ("window", "model_window", "threshold", "window_source")

MAX_TURNS = 200


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def _tool_norm(name: Any) -> str:
    n = str(name or "")
    if n.startswith("mcp__remote__"):
        n = n[len("mcp__remote__"):]
    return n.lower()


def _usage_add(acc: dict[str, int], usage: Any) -> None:
    """``lib/usage.tokenBreakdown``, summed (Codex counts cached input inside input)."""
    if not isinstance(usage, dict):
        return

    def num(k: str) -> int:
        try:
            return int(float(usage.get(k) or 0))
        except (TypeError, ValueError):
            return 0

    out, inp, cread, cwrite = num("output_tokens"), num("input_tokens"), num("cache_read_input_tokens"), \
        num("cache_creation_input_tokens")
    if not cread and usage.get("cached_input_tokens") is not None:
        cread = num("cached_input_tokens")
        inp = max(0, inp - cread)
    acc["input_tokens"] += inp
    acc["cache_read_input_tokens"] += cread
    acc["cache_creation_input_tokens"] += cwrite
    acc["output_tokens"] += out


class HistoryPager:
    def __init__(self, db: Database, attachments_by_message: Callable[[str], dict[str, list]] | None = None) -> None:
        self._db = db
        self._atts = attachments_by_message

    # ---- the page ----

    def page(self, sid: str, *, turns: int | None = None, before: str | None = None,
             since: str | None = None, running_tasks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """One slice of a session's history.

        * ``turns=N``: the newest N turns (``before`` unset) or the N turns
          before the cursor ``before``;
        * ``since=C``: everything from cursor C (``""`` = the beginning) on.

        ``running_tasks``: the session's running background tasks (bg_tasks
        rows) — for ``summary.pinned`` on newest / since pages.
        """
        newest = before is None
        # Highest event id first: the slice holds nothing newer, so the client's
        # attach(after=last_eid) delivers everything else exactly once.
        last_eid = self._last_eid(sid) if newest else None
        until = before  # exclusive upper bound; None = now
        if since is not None:
            start: str | None = since or None
        else:
            start = self._start_of(sid, max(1, min(int(turns or 1), MAX_TURNS)), until)
        has_more = start is not None and self._has_anchor_before(sid, start)
        if not has_more:
            start = None  # fold what precedes the first turn into this (oldest) page

        messages = self._messages(sid, start, until)
        events = self._events(sid, start, until, last_eid)
        terminal = self._terminal(sid)  # normalized, in id order
        by_eid = {t["eid"]: t["data"] for t in terminal}
        for e in events:
            if e["type"] in COST_EVENTS and e["eid"] in by_eid:
                e["data"] = by_eid[e["eid"]]

        out: dict[str, Any] = {
            "messages": messages,
            "events": events,
            "page": {
                "cursor": start,
                "until": until,
                "has_more": has_more,
                "turns": sum(1 for m in messages if m["role"] == "user")
                + sum(1 for e in events if e["type"] == "session.start" and e["data"].get("trigger") == "background"),
            },
        }
        pinned = self._pinned(sid, start, running_tasks or []) if newest and start else []
        out["before"] = self._before(sid, start, terminal, {e["eid"] for e in pinned})
        if newest:
            out["page"]["last_eid"] = last_eid
            out["summary"] = {
                **self._cost(terminal, None),
                **self._context(sid),
                "pinned": pinned,
            }
        return out

    # ---- boundaries ----

    def _last_eid(self, sid: str) -> int:
        row = self._db.query_one("SELECT MAX(id) AS m FROM events WHERE session_id = ?", (sid,))
        return int(row["m"] or 0) if row else 0

    def _anchors_desc(self, sid: str, until: str | None, limit: int) -> list[str]:
        """Start times of the newest ``limit`` turns before ``until``."""
        bound = until if until is not None else "￿"
        rows = self._db.query(
            "SELECT created_at AS at FROM ("
            "  SELECT created_at FROM messages WHERE session_id = ? AND role = 'user' AND created_at < ?"
            "  ORDER BY created_at DESC LIMIT ?)"
            " UNION ALL "
            "SELECT created_at AS at FROM ("
            "  SELECT created_at FROM events INDEXED BY idx_events_sid_type"
            "  WHERE session_id = ? AND type = 'session.start' AND created_at < ? AND instr(data, ?) > 0"
            "  ORDER BY created_at DESC LIMIT ?)"
            " ORDER BY at DESC LIMIT ?",
            (sid, bound, limit, sid, bound, _AUTO_START, limit, limit),
        )
        return [r["at"] for r in rows]

    def _start_of(self, sid: str, n: int, until: str | None) -> str | None:
        anchors = self._anchors_desc(sid, until, n)
        return anchors[-1] if anchors else None

    def _has_anchor_before(self, sid: str, at: str) -> bool:
        return bool(self._anchors_desc(sid, at, 1))

    # ---- the slice ----

    def _messages(self, sid: str, start: str | None, until: str | None) -> list[dict[str, Any]]:
        rows = self._db.query(
            "SELECT id, role, content, provider, model, meta, created_at FROM messages "
            "WHERE session_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at",
            (sid, start or "", until if until is not None else "￿"),
        )
        by_msg = self._atts(sid) if self._atts is not None and rows else {}
        out = []
        for r in rows:
            meta = r["meta"]
            try:
                meta = json.loads(meta) if meta else None
            except (TypeError, ValueError):
                meta = None
            out.append({**dict(r), "meta": meta, "attachments": by_msg.get(r["id"], [])})
        return out

    def _events(self, sid: str, start: str | None, until: str | None, max_eid: int | None) -> list[dict[str, Any]]:
        rows = self._db.query(
            "SELECT id, seq, type, data, created_at FROM events INDEXED BY idx_events_sid_ts "
            "WHERE session_id = ? AND created_at >= ? AND created_at < ? AND id <= ? ORDER BY id",
            (sid, start or "", until if until is not None else "￿",
             max_eid if max_eid is not None else 2 ** 62),
        )
        return [{"eid": r["id"], "seq": r["seq"], "type": r["type"], "data": json.loads(r["data"]),
                 "timestamp": r["created_at"]} for r in rows]

    # ---- cost (turn_cost needs the session's terminal events from the start) ----

    def _terminal(self, sid: str) -> list[dict[str, Any]]:
        rows = self._db.query(
            "SELECT id, type, data, created_at FROM events INDEXED BY idx_events_sid_type "
            "WHERE session_id = ? AND type IN ('turn.complete', 'error') ORDER BY id",
            (sid,),
        )
        norm = TurnCostNormalizer()
        out = []
        for r in rows:
            data = json.loads(r["data"])
            if isinstance(data, dict):
                data = norm.feed(data)
            out.append({"eid": r["id"], "type": r["type"], "at": r["created_at"], "data": data})
        return out

    @staticmethod
    def _cost(terminal: list[dict[str, Any]], start: str | None) -> dict[str, Any]:
        """What ``chatStore`` sums over turns: a turn.complete's cost, or a
        failed/stopped turn's when it says it is per turn."""
        usd, n = 0.0, 0
        usage = {"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0}
        for t in terminal:
            if start is not None and t["at"] >= start:
                continue
            d = t["data"] if isinstance(t["data"], dict) else {}
            if t["type"] == "error" and d.get("cost_kind") != "turn":
                continue
            c = turn_cost(d)
            if c is None:
                continue
            usd += c
            n += 1
            _usage_add(usage, d.get("usage"))
        return {"cost_usd": round(usd, 6), "costed_turns": n, "usage": usage}

    # ---- what precedes the cursor ----

    def _before(self, sid: str, start: str | None, terminal: list[dict[str, Any]],
                skip: set[int]) -> dict[str, Any]:
        if start is None:
            return {"cost_usd": 0.0, "costed_turns": 0, "usage": {}, "changes": {"git": False, "files": []},
                    "todos": None}
        return {**self._cost(terminal, start), "changes": self._changes(sid, start, skip),
                "todos": self._todos(sid, start)}

    def _todos(self, sid: str, start: str) -> Any:
        """Input of the latest TodoWrite before ``start`` (SessionPanel's task list)."""
        for r in self._db.query(
            "SELECT data FROM events INDEXED BY idx_events_sid_type "
            "WHERE session_id = ? AND type = 'tool.use' AND created_at < ? AND instr(data, ?) > 0 "
            "ORDER BY created_at DESC LIMIT 5",
            (sid, start, _TODO_NAME),
        ):
            d = json.loads(r["data"])
            if _tool_norm(d.get("name")) == "todowrite":
                return d.get("input")
        return None

    def _changes(self, sid: str, start: str, skip: set[int]) -> dict[str, Any]:
        """SessionPanel's "Changed files" for the events before ``start``:
        git-based turn changes when the chat has any, else the files
        Edit/Write/apply_patch touched (most recent last)."""
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

        git = self._db.query(
            "SELECT id, data FROM events INDEXED BY idx_events_sid_type "
            "WHERE session_id = ? AND type = 'turn.changes' AND created_at < ? ORDER BY id",
            (sid, start),
        )
        if git:
            for r in git:
                d = json.loads(r["data"])
                for repo in d.get("repos") or []:
                    for f in repo.get("files") or []:
                        touch(f"{repo.get('root')}/{f.get('path')}", f.get("status") == "A", False)
            return {"git": True, "files": list(files.values())}

        failed = set()
        for r in self._db.query(
            "SELECT data FROM events INDEXED BY idx_events_tool_err "
            "WHERE session_id = ? AND type = 'tool.result' AND instr(data, '\"is_error\": true') > 0",
            (sid,),
        ):
            d = json.loads(r["data"])
            if d.get("is_error"):
                failed.add(str(d.get("id")))
        cond = " OR ".join("instr(data, ?) > 0" for _ in _EDIT_PATTERNS)
        for r in self._db.query(
            "SELECT id, data FROM events INDEXED BY idx_events_sid_type "
            f"WHERE session_id = ? AND type = 'tool.use' AND created_at < ? AND ({cond}) ORDER BY id",
            (sid, start, *_EDIT_PATTERNS),
        ):
            if r["id"] in skip:
                continue
            d = json.loads(r["data"])
            n = _tool_norm(d.get("name"))
            if n not in _EDIT_NAMES:
                continue
            i = d.get("input") if isinstance(d.get("input"), dict) else {}
            err = str(d.get("id")) in failed
            if n in ("edit", "multiedit", "notebookedit"):
                touch(i.get("file_path") or i.get("notebook_path"), False, err)
            elif n in ("write", "remote_write"):
                touch(i.get("file_path") or i.get("path"), True, err)
            elif n == "apply_patch" and isinstance(i.get("changes"), list):
                for c in i["changes"]:
                    if isinstance(c, dict):
                        touch(c.get("path"), c.get("kind") == "add", err)
        return {"git": False, "files": list(files.values())}

    # ---- session-wide state (the newest page) ----

    def _context(self, sid: str) -> dict[str, Any]:
        """``chatStore.contextOf`` over the whole chat: the last context report
        (window/threshold from earlier ones when it lacks them) and the last
        compaction, both since the last /clear."""
        reset = ""
        for r in self._db.query(
            "SELECT data, created_at FROM events INDEXED BY idx_events_sid_type "
            "WHERE session_id = ? AND type = 'notice' AND instr(data, '\"context.reset\"') > 0 "
            "ORDER BY created_at DESC LIMIT 5",
            (sid,),
        ):
            if json.loads(r["data"]).get("code") == "context.reset":
                reset = r["created_at"]
                break
        context: dict[str, Any] | None = None
        for r in self._db.query(
            "SELECT data FROM events INDEXED BY idx_events_sid_type "
            "WHERE session_id = ? AND type = 'context.update' AND created_at >= ? "
            "ORDER BY created_at DESC, id DESC LIMIT 50",
            (sid, reset),
        ):
            d = json.loads(r["data"])
            if context is None:
                context = d
            else:  # an older report fills what the newer one lacks
                for k in _CTX_KEYS:
                    if context.get(k) is None and d.get(k) is not None:
                        context[k] = d[k]
                if "auto_compact" not in context and "auto_compact" in d:
                    context["auto_compact"] = d["auto_compact"]
            if all(context.get(k) is not None for k in _CTX_KEYS) and "auto_compact" in context:
                break
        compaction = None
        for r in self._db.query(
            "SELECT data, created_at FROM events INDEXED BY idx_events_sid_type "
            "WHERE session_id = ? AND type = 'notice' AND created_at >= ? "
            "AND instr(data, '\"context.compacted\"') > 0 ORDER BY created_at DESC LIMIT 5",
            (sid, reset),
        ):
            d = json.loads(r["data"])
            if d.get("code") == "context.compacted":
                compaction = {"trigger": d.get("trigger"), "pre_tokens": d.get("pre_tokens"),
                              "post_tokens": d.get("post_tokens"), "at": r["created_at"]}
                break
        return {"context": context, "last_compaction": compaction}

    def _pinned(self, sid: str, start: str, tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """For each running background task launched before ``start``: its
        launching tool call and everything it reported before ``start``
        (subagent steps at any depth, task updates, the call's result)."""
        out: dict[int, dict[str, Any]] = {}
        for task in tasks:
            tid = str(task.get("tool_use_id") or "")
            if not tid:
                continue
            lo = _iso(float(task["started_at"]) - 600) if task.get("started_at") else ""
            launch = None
            for r in self._db.query(
                "SELECT id, created_at, data FROM events INDEXED BY idx_events_sid_type "
                "WHERE session_id = ? AND type = 'tool.use' AND created_at >= ? AND created_at < ? "
                "AND instr(data, ?) > 0 ORDER BY created_at LIMIT 3",
                (sid, lo, start, json.dumps({"id": tid})[1:-1]),
            ):
                if json.loads(r["data"]).get("id") == tid:
                    launch = r
                    break
            if launch is None:
                continue  # launched inside the slice (or unknown): nothing to pin
            ids = {tid}
            # Only rows that name a parent / task / this call are read in full.
            for r in self._db.query(
                "SELECT id, seq, type, data, created_at FROM events INDEXED BY idx_events_sid_ts "
                "WHERE session_id = ? AND created_at >= ? AND created_at < ? AND type IN "
                "('tool.use', 'tool.result', 'subagent.text', 'subagent.thinking', 'task.update') "
                "AND (id = ? OR instr(data, '\"parent\": \"') > 0 OR instr(data, '\"tool_use_id\": \"') > 0 "
                "OR instr(data, ?) > 0) ORDER BY id",
                (sid, launch["created_at"], start, launch["id"], json.dumps(tid)),
            ):
                d = json.loads(r["data"])
                if r["id"] == launch["id"]:
                    hit = True
                elif r["type"] == "task.update":
                    hit = str(d.get("tool_use_id")) in ids
                elif r["type"] == "tool.use":
                    hit = str(d.get("parent")) in ids
                    if hit:
                        ids.add(str(d.get("id")))  # nested subagents' steps follow their own parent
                elif r["type"] == "tool.result":
                    hit = str(d.get("id")) in ids or str(d.get("parent")) in ids
                else:
                    hit = str(d.get("parent")) in ids
                if hit:
                    out[r["id"]] = {"eid": r["id"], "seq": r["seq"], "type": r["type"], "data": d,
                                    "timestamp": r["created_at"]}
        return [out[k] for k in sorted(out)]
