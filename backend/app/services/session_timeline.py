"""Going back in a chat, and copying one (docs/session-timeline.md).

**Rewind** takes a message the user sent and makes it, and everything after it, as if never sent: the messages, the events,
what those turns attached and started, and what the engines remember. **Copy** makes a second chat that works exactly like
the first from here on, with every setting, the whole history and the same memory in the engines.

Both rest on the same fact: each completed turn records where its engine's CLI session stood (``cli_session_id`` +
``cli_at`` on ``turn.complete``), and both CLIs can continue from a copy of a session up to such a point, leaving the
original alone (``fork`` + ``at`` in ``sessions.cli_sessions``, used by the next turn: Claude's ``--resume --fork-session
--resume-session-at``, Codex's ``thread/fork``). What an engine's copy doesn't hold, because it ran elsewhere or was cut
off, reaches it the usual way: the catch-up or the handoff built from the chat's own history. A session that can't be
continued any more (or turns from before ``cli_at`` existed) falls back to that handoff too, so this works for every
provider, account and host.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
from datetime import datetime
from typing import Any

from app.providers.base import ProviderEvent
from app.services import changes as change_tracker
from app.services._ids import new_id, now_iso

_MESSAGE_ID = re.compile(r"msg_[0-9A-Za-z]+")
#: how long a running turn gets to wind down when a rewind stops it
HALT_S = 20


class TimelineBusy(Exception):
    """The chat is being rewound right now, or its turn wouldn't stop."""


def _epoch(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp()


def _meta(raw: Any) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def first_event_at(db: Any, sid: str, at: str) -> int | None:
    """The first event of this chat from this moment on (events are in id order; turns start after their message)."""
    row = db.query_one("SELECT MIN(id) AS eid FROM events WHERE session_id = ? AND created_at >= ?", (sid, at))
    return row["eid"] if row else None


def engine_state_at(db: Any, sid: str, before_eid: int | None, *, floor: str = "") -> dict[str, dict[str, Any]]:
    """Each engine's CLI session as it stood before this event: the newest completed turn that says where it was, per
    provider. ``seen`` is that turn's answer: whatever came later reaches the engine as a catch-up. An engine with no such
    turn has no entry, so it gets the whole conversation handed over."""
    state: dict[str, dict[str, Any]] = {}
    rows = db.query(
        "SELECT id, data, created_at FROM events INDEXED BY idx_events_sid_type "
        "WHERE session_id = ? AND type = 'turn.complete' AND created_at > ? "
        + ("AND id < ? " if before_eid is not None else "") + "ORDER BY id DESC",
        (sid, floor, *([before_eid] if before_eid is not None else [])),
    )
    for row in rows:
        data = json.loads(row["data"])
        provider, cli, at = data.get("provider"), data.get("cli_session_id"), data.get("cli_at")
        if not provider or provider in state or not cli or not at:
            continue
        answer = db.query_one(
            "SELECT role, created_at FROM messages WHERE session_id = ? AND created_at >= ? ORDER BY created_at LIMIT 1",
            (sid, row["created_at"]),
        )
        seen = answer["created_at"] if answer and answer["role"] == "assistant" else row["created_at"]
        state[provider] = {"id": cli, "seen": seen, "at": at, "fork": True}
    return state


def floor_at(db: Any, sid: str, before_eid: int | None) -> str | None:
    """The chat's /clear floor as it was before this event."""
    row = db.query_one(
        "SELECT MAX(created_at) AS at FROM events INDEXED BY idx_events_sid_type WHERE session_id = ? AND type = 'notice' "
        "AND instr(data, '\"context.reset\"') > 0" + (" AND id < ?" if before_eid is not None else ""),
        (sid, *([before_eid] if before_eid is not None else [])),
    )
    return row["at"] if row else None


def copy_title(title: str, taken: set[str]) -> str:
    """``{title}_copy_{n}``: the first number nobody uses, inside the 200 characters a title may have."""
    n = 1
    while True:
        suffix = f"_copy_{n}"
        name = title[: 200 - len(suffix)] + suffix
        if name not in taken:
            return name
        n += 1


class SessionTimeline:
    def __init__(self, sessions: Any) -> None:
        self.s = sessions
        self.db = sessions._db
        self.busy: set[str] = set()

    # ---- rewind ----

    def _target(self, sid: str, message_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        session = self.s.get(sid)  # KeyError → 404
        if session.get("kind") in ("mate", "avatar"):
            raise ValueError("only a chat can be rewound")
        row = self.db.query_one(
            "SELECT id, role, content, meta, created_at FROM messages WHERE id = ? AND session_id = ?", (message_id, sid))
        if row is None:
            raise KeyError(f"message not found: {message_id}")
        meta = _meta(row["meta"])
        if row["role"] not in ("user", "steer") or meta.get("internal") or meta.get("via"):
            raise ValueError("only a message you sent can be rewound to")
        return session, dict(row)

    async def preview(self, sid: str, message_id: str) -> dict[str, Any]:
        """What a rewind to this message would take back, for the dialog that asks first."""
        session, msg = self._target(sid, message_id)
        eid = first_event_at(self.db, sid, msg["created_at"])
        sent = 0
        for row in self.db.query("SELECT role, meta FROM messages WHERE session_id = ? AND created_at >= ?",
                                 (sid, msg["created_at"])):
            if row["role"] in ("user", "steer") and not _meta(row["meta"]).get("internal"):
                sent += 1
        files: list[dict[str, Any]] = []
        try:
            plan = await self._file_plan(session, eid, joined=msg["role"] == "steer")
        except Exception:  # noqa: BLE001 - (a folder that can't be read right now: the rewind will say so, if asked to restore)
            plan = {}
        for (_host, root), entry in plan.items():
            files += [{"path": p, "root": root} for p in sorted(entry["paths"])]
        return {"messages": sent, "running": self.s.is_running(sid), "files": files[:200], "file_count": len(files),
                "joined": msg["role"] == "steer"}

    def _recorded_turns(self, sid: str, eid: int | None, *, joined: bool) -> list[dict[str, Any]]:
        """The turns from this event on, oldest first, as far as files go: what each started from (``start``), what it reported
        (``changes``), and whether it never got to say (``open``): the turn at work, or one the server went down under. Any
        other turn reports its files if it changed some, however it ended. ``joined``: the cut is inside a turn (a message
        added while it worked): that turn's report covers what came before the cut too, so it isn't one of them."""
        if eid is None:
            return []
        turns: list[dict[str, Any]] = []
        current: dict[str, Any] | None = None
        for row in self.db.query(
            "SELECT type, data FROM events WHERE session_id = ? AND id >= ? AND type IN "
            "('turn.snapshot', 'turn.changes', 'turn.complete', 'error') ORDER BY id", (sid, eid),
        ):
            data = json.loads(row["data"])
            if row["type"] == "turn.snapshot":
                joined, current = False, {"start": data.get("repos") or [], "changes": None, "open": True}
                turns.append(current)
            elif row["type"] == "turn.changes":
                if current is not None:
                    current.update(changes=data.get("repos") or [], open=False)
                elif not joined:  # (a turn from before snapshots were recorded)
                    turns.append({"start": [], "changes": data.get("repos") or [], "open": False})
            else:
                if current is not None:
                    current["open"] = False
                joined, current = False, None
        return turns

    async def _file_plan(self, session: dict[str, Any], eid: int | None, *, joined: bool) -> dict[tuple[Any, str], dict[str, Any]]:
        """For each folder: how it was before the first of those turns, and the files they changed. A report cut at its limit,
        or a turn that never reported, is read from the snapshots."""
        turns = self._recorded_turns(session["id"], eid, joined=joined)
        plan: dict[tuple[Any, str], dict[str, Any]] = {}

        def entry(repo: dict[str, Any]) -> dict[str, Any]:
            key = (self.s._repo_host(session, repo), repo["root"])
            return plan.setdefault(key, {"before": repo["before"], "paths": set()})

        def named(files: list[dict[str, Any]]) -> set[str]:
            return {p for f in files for p in (f.get("path"), f.get("old_path")) if p}

        for k, turn in enumerate(turns):
            for repo in turn["start"]:
                entry(repo)
            for repo in turn["changes"] or []:
                paths = entry(repo)["paths"]
                if repo.get("truncated"):
                    runner = self._runner(session, self.s._repo_host(session, repo))
                    whole = await change_tracker.summarize(runner, repo["root"], repo["before"], repo["after"], strict=True, limit=None)
                    paths |= named(whole["files"]) if whole else set()
                else:
                    paths |= named(repo.get("files") or [])
            if not turn["open"]:
                continue
            following = next((t["start"] for t in turns[k + 1:] if t["start"]), [])
            for repo in turn["start"]:
                host = self.s._repo_host(session, repo)
                runner = self._runner(session, host)
                after = next((r["before"] for r in following if (self.s._repo_host(session, r), r["root"]) == (host, repo["root"])), None)
                if after is None:
                    now = await change_tracker.snapshot(runner, repo["root"])
                    if now is None:
                        raise RuntimeError(f"could not read {repo['root']}")
                    after = now[1]
                diff = await change_tracker.summarize(runner, repo["root"], repo["before"], after, strict=True, limit=None)
                if diff:
                    entry(repo)["paths"] |= named(diff["files"])
        return {key: e for key, e in plan.items() if e["paths"]}

    def _runner(self, session: dict[str, Any], host: Any) -> Any:
        runner = self.s._change_runner(session, host)
        if runner is None:
            raise RuntimeError("the folder of those changes is unavailable")
        return runner

    async def _halt(self, sid: str) -> None:
        """No turn and no engine left: the engine holds the conversation being cut, and may be working on it. (Nothing new
        starts meanwhile: ``busy`` is up.)"""
        task = self.s._tasks.get(sid)
        if task is not None and not task.done():
            self.s.stop(sid)
            with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError, Exception):
                await asyncio.wait_for(asyncio.shield(task), HALT_S)
            if not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    await asyncio.wait_for(asyncio.shield(task), 5)
            if not task.done():
                raise TimelineBusy("the running turn did not stop")
        await self.s._engines.shutdown(sid, reason="rewound")
        from app.harness import runtime as harness_runtime
        await harness_runtime.shutdown(sid)  # (an API-key engine's shells and subagents work on what is cut)
        if getattr(self.s, "speech_input", None):
            self.s.speech_input.cancel(sid)

    async def _restore_files(self, session: dict[str, Any], eid: int | None, *, joined: bool) -> list[str]:
        """The files those turns changed, back to how they were before the first of them. Only those files: anything else
        that happened in the folder stays. Done before anything is deleted: a failure leaves the chat as it was."""
        restored: list[str] = []
        for (host, root), entry in (await self._file_plan(session, eid, joined=joined)).items():
            runner = self._runner(session, host)
            now = await change_tracker.snapshot(runner, root)
            if now is None:
                raise RuntimeError(f"could not read {root}")
            summary = await change_tracker.summarize(runner, root, entry["before"], now[1], strict=True, limit=None)
            if summary is None:
                continue  # (already as it was)
            files = [f for f in summary["files"] if f["path"] in entry["paths"] or f.get("old_path") in entry["paths"]]
            if files:
                restored += await change_tracker.revert(runner, {**summary, "files": files})
        return restored

    def _cut(self, session: dict[str, Any], msg: dict[str, Any], eid: int | None) -> list[dict[str, Any]]:
        """The chat from this message on is gone, the engines stand where they stood. → the message's attachments, which go
        back to the composer with its text. What those turns spent stays on the Usage page: it was spent."""
        sid, at = session["id"], msg["created_at"]
        floor = session.get("context_floor") or None
        if floor and floor >= at:
            floor = floor_at(self.db, sid, eid)
        state = engine_state_at(self.db, sid, eid, floor=floor or "")
        attachments = self.s._attachments
        with self.db.transaction():
            if eid is not None:
                self.db.execute(
                    "INSERT OR IGNORE INTO rewound_usage (id, session_id, type, data, created_at) "
                    "SELECT id, session_id, type, data, created_at FROM events WHERE session_id = ? AND id >= ? "
                    "AND type IN ('turn.complete', 'error') AND json_valid(data) "
                    "AND json_extract(data, '$.usage_copied') IS NULL", (sid, eid))
                self.db.execute("DELETE FROM events WHERE session_id = ? AND id >= ?", (sid, eid))
            gone = [r["id"] for r in self.db.query(
                "SELECT id FROM messages WHERE session_id = ? AND created_at >= ?", (sid, at))]
            # (what a mate learned only from these messages is retracted)
            from app.mate.knowledge import Knowledge
            for mate_id in Knowledge(self.db).retract_messages_from(sid, at):
                self.s.mates_changed("memory", mate_id)
            self.db.execute("DELETE FROM messages WHERE session_id = ? AND created_at >= ?", (sid, at))
            for k in range(0, len(gone), 500):
                chunk = gone[k:k + 500]
                self.db.execute(
                    f"DELETE FROM speech_inputs WHERE session_id = ? AND message_id IN ({','.join('?' * len(chunk))})",
                    (sid, *chunk))
            # (a remote job keeps its row: it did run, and the monitor reports its end)
            self.db.execute("DELETE FROM bg_tasks WHERE session_id = ? AND COALESCE(task_type, '') != 'remote_bash' "
                            "AND started_at >= ?", (sid, _epoch(at)))
            left = self.db.query_one("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?", (sid,))["n"]
            title = session["title"]
            if not left and title == self.s.title_from(msg["content"]):
                title = "New chat"  # (the name came from the message that is gone)
            own = state.get(session["provider"], {})
            self.db.execute(
                "UPDATE sessions SET cli_sessions = ?, cli_session_id = ?, context_floor = ?, title = ?, last_result = NULL, "
                "last_result_at = NULL, updated_at = ? WHERE id = ?",
                (json.dumps(state), own.get("id"), floor, title, now_iso(), sid))
            back = attachments.rewind(sid, msg["id"], gone, at) if attachments is not None else []
            if msg["role"] == "steer" and left:
                # (a message added while a turn worked: what came before it stays, as a turn stopped there)
                self.s._add_event(sid, ProviderEvent(type="error", data={"code": "turn.interrupted", "message": "Stopped by user"}))
        return back

    async def rewind(self, sid: str, message_id: str, *, restore_files: bool = False) -> dict[str, Any]:
        session, msg = self._target(sid, message_id)
        if sid in self.busy:
            raise TimelineBusy("this chat is being rewound")
        self.busy.add(sid)
        try:
            # (before anything stops: a window with messages queued must not send them when the turn ends)
            self.s._publish(sid, {"type": "session.rewinding", "data": {"message_id": message_id}})
            await self._halt(sid)
            self.s.remote_jobs.cancel(sid, include_background=True, since=_epoch(msg["created_at"]))
            session = self.s.get(sid)  # (stopping the turn changed it)
            eid = first_event_at(self.db, sid, msg["created_at"])
            restored = await self._restore_files(session, eid, joined=msg["role"] == "steer") if restore_files else []
            back = self._cut(session, msg, eid)
        finally:
            self.busy.discard(sid)
        self.s.history_aggregates.drop(sid)
        self.s._live_usage_by_session.pop(sid, None)
        self.s._ctx_limits.pop(sid, None)
        self.s.list_changed("updated", sid)
        self.s._publish(sid, {"type": "session.rewound", "data": {"message_id": message_id}})
        return {"text": msg["content"], "attachments": back, "restored_files": restored}

    # ---- copy ----

    def _running_cut(self, sid: str) -> tuple[str | None, int | None]:
        """A running turn isn't copied: the copy stops where the last turn ended."""
        last = self.db.query_one(
            "SELECT id, created_at FROM events INDEXED BY idx_events_sid_type WHERE session_id = ? AND type IN "
            "('turn.complete', 'error') ORDER BY id DESC LIMIT 1", (sid,))
        since = last["created_at"] if last else ""
        user = self.db.query_one(
            "SELECT created_at FROM messages WHERE session_id = ? AND role IN ('user', 'steer') AND created_at > ? "
            "ORDER BY created_at LIMIT 1", (sid, since))
        event = self.db.query_one("SELECT id, created_at FROM events WHERE session_id = ? AND id > ? ORDER BY id LIMIT 1",
                                  (sid, last["id"] if last else 0))
        marks = [m for m in (user["created_at"] if user else None, event["created_at"] if event else None) if m]
        if not marks:
            return None, None
        at = min(marks)
        return at, first_event_at(self.db, sid, at)

    def _copy_rows(self, src: dict[str, Any], new: str, at: str | None, eid: int | None, state: dict[str, Any],
                   title: str, clones: dict[str, dict[str, Any]]) -> None:
        sid, now = src["id"], now_iso()
        raw = dict(self.db.query_one("SELECT * FROM sessions WHERE id = ?", (sid,)))
        # Every column as it is (one added later too), but for what makes this chat this chat.
        raw.update(id=new, title=title, created_at=now, updated_at=now, cli_sessions=json.dumps(state),
                   cli_session_id=state.get(src["provider"], {}).get("id"), last_result=None, last_result_at=None,
                   last_seen_at=None)
        with self.db.transaction():
            names = list(raw)
            self.db.execute(f"INSERT INTO sessions ({', '.join(names)}) VALUES ({', '.join('?' * len(names))})",
                            [raw[n] for n in names])
            message_ids: dict[str, str] = {}
            for row in self.db.query(
                "SELECT id, role, content, provider, model, meta, created_at FROM messages WHERE session_id = ? "
                + ("AND created_at < ? " if at else "") + "ORDER BY created_at", (sid, *([at] if at else [])),
            ):
                if _meta(row["meta"]).get("speech_pending"):
                    continue
                mid = message_ids[row["id"]] = new_id("msg_")
                self.db.execute(
                    "INSERT INTO messages (id, session_id, role, content, provider, model, meta, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (mid, new, row["role"], row["content"], row["provider"], row["model"], row["meta"], row["created_at"]))
            self.db.execute(
                "INSERT INTO events (session_id, seq, type, data, created_at) SELECT ?, seq, type, data, created_at "
                "FROM events WHERE session_id = ? " + ("AND id < ? " if eid is not None else "") + "ORDER BY id",
                (new, sid, *([eid] if eid is not None else [])))
            # An event naming a message names the copy's (a message added mid-turn is rewound by it).
            for row in self.db.query("SELECT id, data FROM events WHERE session_id = ? AND instr(data, '\"message_id\"') > 0", (new,)):
                data = _MESSAGE_ID.sub(lambda m: message_ids.get(m[0], m[0]), row["data"])
                if data != row["data"]:
                    self.db.execute("UPDATE events SET data = ? WHERE id = ?", (data, row["id"]))
            # Spent once, by the original: the copy shows the same costs, the Usage page counts them once.
            self.db.execute(
                "UPDATE events SET data = json_set(data, '$.usage_copied', json('true')) WHERE session_id = ? "
                "AND type IN ('turn.complete', 'error') AND json_valid(data)", (new,))
            for old, row in clones.items():
                owner = row["message_id"]
                if owner in message_ids:
                    owner = message_ids[owner]
                elif not str(owner).startswith("artifact:"):
                    continue  # (its message was left out)
                self.db.execute(
                    "INSERT INTO attachments (id, session_id, message_id, name, mime, size, kind, origin, width, height, "
                    "path, model_path, model_mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (row["id"], new, owner, row["name"], row["mime"], row["size"], row["kind"], row.get("origin") or "user",
                     row["width"], row["height"], row["path"], row["model_path"], row["model_mime"], row["created_at"]))
                self.db.execute("UPDATE events SET data = replace(data, ?, ?) WHERE session_id = ? AND instr(data, ?) > 0",
                                (old, row["id"], new, old))
            # The finished background work shows in the copy's task list too; what still runs belongs to the original.
            self.db.execute(
                "INSERT INTO bg_tasks (session_id, task_id, tool_use_id, description, task_type, is_backgrounded, status, "
                "output_file, summary, started_at, ended_at, updated_at) SELECT ?, task_id, tool_use_id, description, "
                "task_type, is_backgrounded, status, output_file, summary, started_at, ended_at, updated_at FROM bg_tasks "
                "WHERE session_id = ? AND status NOT IN ('running', 'pending')", (new, sid))

    async def copy(self, sid: str) -> dict[str, Any]:
        src = self.s.get(sid)  # KeyError → 404
        if src.get("kind") in ("mate", "avatar"):
            raise ValueError("only a chat can be copied")
        at, eid = self._running_cut(sid) if self.s.is_running(sid) or sid in self.busy else (None, None)
        if at is not None or self.s.is_running(sid):
            state = engine_state_at(self.db, sid, eid, floor=src.get("context_floor") or "")
        else:
            state = {p: {**e, "fork": True} for p, e in self.s._cli_state(src).items()}
        taken = {r["title"] for r in self.db.query("SELECT title FROM sessions")}
        title = copy_title(src["title"], taken)
        new = new_id("sess_")
        clones: dict[str, dict[str, Any]] = {}
        if self.s._attachments is not None:
            clones = await asyncio.to_thread(self.s._attachments.clone, sid, new, at)
        try:
            await asyncio.to_thread(self._copy_rows, src, new, at, eid, state, title, clones)
        except BaseException:
            if self.s._attachments is not None:
                self.s._attachments.purge_session(new)
            raise
        self.s.list_changed("created", new)
        return self.s.get(new)
