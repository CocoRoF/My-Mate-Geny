"""SQLite storage layer.

A thin wrapper around the stdlib ``sqlite3`` module. We keep a single
connection with ``check_same_thread=False`` guarded by a lock — the workload
is light (chat metadata), so a connection pool would be over-engineering.

Schema is created idempotently on startup (``bootstrap``). All tables use
text ULIDs/uuids as primary keys supplied by the services, and store JSON
blobs as TEXT.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable

from app.config import settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS connections (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'remote_ssh',  -- local | remote_ssh
    host         TEXT,
    port         INTEGER DEFAULT 22,
    username     TEXT,
    key_ref      TEXT,          -- secret id in vault for the private key
    default_path TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_auth (
    provider   TEXT PRIMARY KEY,        -- claude | codex
    auth_mode  TEXT NOT NULL,           -- oauth | api_key | none
    secret_ref TEXT,                    -- secret id in vault (api key / token)
    status     TEXT NOT NULL DEFAULT 'disconnected',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT 'New chat',
    provider      TEXT NOT NULL,              -- claude | codex
    model         TEXT NOT NULL DEFAULT '',
    effort        TEXT NOT NULL DEFAULT 'default',  -- reasoning/think level
    connection_id TEXT,                       -- NULL => local workspace
    workspace_path TEXT NOT NULL,             -- absolute path (local or under mount root)
    cli_session_id TEXT,                      -- provider-side resumable session id
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,       -- user | assistant
    content    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    type       TEXT NOT NULL,
    data       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS git_accounts (
    id         TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,              -- github | gitlab
    label      TEXT NOT NULL,
    host       TEXT,                        -- for self-hosted gitlab
    username   TEXT,
    token_ref  TEXT NOT NULL,               -- vault id for the PAT
    scopes     TEXT NOT NULL DEFAULT '',    -- granted token scopes (comma-sep)
    can_push   INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_accounts (
    id            TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,              -- claude | codex
    label         TEXT NOT NULL,
    auth_mode     TEXT NOT NULL DEFAULT 'oauth',  -- oauth | api_key
    secret_ref    TEXT,                       -- vault id (api key) when auth_mode=api_key
    enabled       INTEGER NOT NULL DEFAULT 1,
    weight        INTEGER NOT NULL DEFAULT 1,
    max_concurrency INTEGER NOT NULL DEFAULT 8,
    status        TEXT NOT NULL DEFAULT 'unknown',  -- ready | expired | cooldown | unknown
    cooldown_until TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    total_leases  INTEGER NOT NULL DEFAULT 0,
    total_failures INTEGER NOT NULL DEFAULT 0,
    last_used_at  TEXT,
    last_ok_at    TEXT,
    last_error    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_pool (
    provider  TEXT PRIMARY KEY,               -- claude | codex
    enabled   INTEGER NOT NULL DEFAULT 0,      -- use the pool for this provider?
    strategy  TEXT NOT NULL DEFAULT 'least_busy',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
    ip           TEXT PRIMARY KEY,
    fails        INTEGER NOT NULL DEFAULT 0,
    banned_until TEXT,                  -- ISO timestamp; NULL => not banned
    updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_session   ON events(session_id, seq);
"""


class Database:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or settings.db_file
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None

    def connect(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA journal_mode = WAL")

    def bootstrap(self) -> None:
        if self._conn is None:
            self.connect()
        assert self._conn is not None
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()
        self._migrate()

    def _migrate(self) -> None:
        """Additive, idempotent column migrations for pre-existing databases."""
        assert self._conn is not None
        with self._lock:
            cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(sessions)")}
            if "effort" not in cols:
                self._conn.execute(
                    "ALTER TABLE sessions ADD COLUMN effort TEXT NOT NULL DEFAULT 'default'"
                )
            gcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(git_accounts)")}
            if gcols and "scopes" not in gcols:
                self._conn.execute("ALTER TABLE git_accounts ADD COLUMN scopes TEXT NOT NULL DEFAULT ''")
                self._conn.execute("ALTER TABLE git_accounts ADD COLUMN can_push INTEGER NOT NULL DEFAULT 1")
            self._conn.commit()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ---- low-level helpers (all lock-guarded) ----

    def execute(self, sql: str, params: Iterable[Any] = ()) -> None:
        assert self._conn is not None, "database not connected"
        with self._lock:
            self._conn.execute(sql, tuple(params))
            self._conn.commit()

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        assert self._conn is not None, "database not connected"
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            return cur.fetchall()

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None
