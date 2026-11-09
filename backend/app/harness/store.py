"""The harness's conversations, kept so a chat can go on, be copied and be rewound.

A conversation (``hs_…``) is a list of entries, each one neutral message (``llm.base``). Its id is what the session
layer stores as the engine's CLI session id, and the number of entries after a turn is that turn's position
(``cli_at``) — so ``fork(id, at)`` is a copy of the first ``at`` entries, exactly what Claude's ``--fork-session
--resume-session-at`` and Codex's ``thread/fork`` give the CLIs (services/session_timeline.py).

A compaction appends an entry marked ``compaction`` holding the summary; the model is shown the conversation from the
last such entry on, while everything before it stays for forks and rewinds to earlier points.
"""

from __future__ import annotations

import json
from typing import Any

from app.harness.models import SCHEMA as MODELS_SCHEMA
from app.services._ids import new_id, now_iso

SCHEMA = MODELS_SCHEMA + """
CREATE TABLE IF NOT EXISTS harness_sessions (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT,
    provider   TEXT NOT NULL,
    parent_id  TEXT,
    parent_at  INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_harness_sessions_chat ON harness_sessions(chat_id);
CREATE TABLE IF NOT EXISTS harness_entries (
    session_id TEXT NOT NULL REFERENCES harness_sessions(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, idx)
);
"""


def bootstrap(db: Any) -> None:
    with db.transaction():
        for statement in SCHEMA.split(";"):
            if statement.strip():
                db.execute(statement)


class TranscriptStore:
    def __init__(self, db: Any) -> None:
        self.db = db

    def create(self, chat_id: str | None, provider: str) -> str:
        sid = new_id("hs_")
        now = now_iso()
        self.db.execute(
            "INSERT INTO harness_sessions (id, chat_id, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (sid, chat_id, provider, now, now))
        return sid

    def exists(self, sid: str) -> bool:
        return self.db.query_one("SELECT 1 FROM harness_sessions WHERE id = ?", (sid,)) is not None

    def fork(self, src: str, at: int | None, chat_id: str | None, provider: str) -> str:
        """A new conversation holding the first ``at`` entries of ``src`` (all of them when None)."""
        new = new_id("hs_")
        now = now_iso()
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO harness_sessions (id, chat_id, provider, parent_id, parent_at, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)", (new, chat_id, provider, src, at, now, now))
            self.db.execute(
                "INSERT INTO harness_entries (session_id, idx, data, created_at) SELECT ?, idx, data, created_at "
                "FROM harness_entries WHERE session_id = ?" + (" AND idx < ?" if at is not None else ""),
                (new, src, *([at] if at is not None else [])))
        return new

    def load(self, sid: str) -> list[dict[str, Any]]:
        return [json.loads(r["data"]) for r in
                self.db.query("SELECT data FROM harness_entries WHERE session_id = ? ORDER BY idx", (sid,))]

    def count(self, sid: str) -> int:
        row = self.db.query_one("SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM harness_entries WHERE session_id = ?", (sid,))
        return int(row["n"]) if row else 0

    def append(self, sid: str, entries: list[dict[str, Any]]) -> int:
        """Add entries at the end. → the conversation's length after them (the position to fork at)."""
        if not entries:
            return self.count(sid)
        now = now_iso()
        with self.db.transaction():
            n = self.count(sid)
            for i, e in enumerate(entries):
                self.db.execute("INSERT INTO harness_entries (session_id, idx, data, created_at) VALUES (?, ?, ?, ?)",
                                (sid, n + i, json.dumps(e, ensure_ascii=False), now))
            self.db.execute("UPDATE harness_sessions SET updated_at = ? WHERE id = ?", (now, sid))
        return n + len(entries)

    def delete_chat(self, chat_id: str) -> None:
        with self.db.transaction():
            self.db.execute("DELETE FROM harness_entries WHERE session_id IN "
                            "(SELECT id FROM harness_sessions WHERE chat_id = ?)", (chat_id,))
            self.db.execute("DELETE FROM harness_sessions WHERE chat_id = ?", (chat_id,))


def model_view(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What the model is shown: from the last compaction on."""
    start = 0
    for i, e in enumerate(entries):
        if e.get("compaction"):
            start = i
    return [{k: v for k, v in e.items() if k != "compaction"} for e in entries[start:]]
