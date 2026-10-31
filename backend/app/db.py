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
    mode          TEXT NOT NULL DEFAULT 'agent',    -- agent | plan
    extra_dirs    TEXT NOT NULL DEFAULT '[]',       -- additional folders (JSON list of paths)
    cli_info      TEXT NOT NULL DEFAULT '{}',       -- last CLI capabilities (tools, slash commands, MCP…)
    cli_sessions  TEXT NOT NULL DEFAULT '{}',       -- per provider: {"claude": {"id", "seen"}, "codex": {...}}
    context_floor TEXT,                             -- /clear: handoffs only include messages after this
    auto_compact_window INTEGER,                    -- Claude: this chat's auto-compact window (NULL = default, 0 = CLI default)
    accounts      TEXT NOT NULL DEFAULT '{}',       -- per provider: the account it ran on last (sticky balancing)
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,       -- user | assistant | steer
    content    TEXT NOT NULL DEFAULT '',
    provider   TEXT,                -- assistant: which engine answered (claude | codex)
    model      TEXT,
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
    primary_mode TEXT NOT NULL DEFAULT 'normal',  -- host login: normal | fallback | off
    near_5h   REAL,                           -- avoid an account at/above this 5-hour % (default 90)
    near_7d   REAL,                           -- ... and this 7-day % (default 95)
    limit_priority TEXT NOT NULL DEFAULT 'balanced',  -- which window decides: balanced | seven_day | five_hour
    auto_compact_window INTEGER NOT NULL DEFAULT 0,  -- Claude: default auto-compact window (0 = CLI default)
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
    ip           TEXT PRIMARY KEY,
    fails        INTEGER NOT NULL DEFAULT 0,
    banned_until TEXT,                  -- ISO timestamp; NULL => not banned
    updated_at   TEXT NOT NULL
);

-- Chat attachments. Uploaded first (message_id NULL = still in the composer),
-- then linked to the user message they were sent with.
CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    message_id  TEXT,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    kind        TEXT NOT NULL,            -- image | file
    width       INTEGER,
    height      INTEGER,
    path        TEXT NOT NULL,            -- original, on this runtime host
    model_path  TEXT,                     -- image variant sized for the model
    model_mime  TEXT,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Admin: everything that went wrong (provider/tool/http/ws/auth/client/...).
CREATE TABLE IF NOT EXISTS error_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    level       TEXT NOT NULL,            -- error | warning | info
    source      TEXT NOT NULL,            -- provider | tool | http | ws | auth | account | workspace | upload | client | system
    code        TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '{}',
    session_id  TEXT,
    path        TEXT,
    ip          TEXT
);

-- Background / long-running tasks the Claude engine reported (Claude Code's
-- "background tasks"): live status + where their output is written.
CREATE TABLE IF NOT EXISTS bg_tasks (
    session_id      TEXT NOT NULL,
    task_id         TEXT NOT NULL,
    tool_use_id     TEXT,
    description     TEXT,
    task_type       TEXT,
    is_backgrounded INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'running',
    output_file     TEXT,
    summary         TEXT,
    started_at      REAL,
    ended_at        REAL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (session_id, task_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id, message_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_ts ON error_logs(ts);
CREATE INDEX IF NOT EXISTS idx_error_logs_filter ON error_logs(level, source);
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
            for col, ddl in (
                ("mode", "TEXT NOT NULL DEFAULT 'agent'"),
                ("extra_dirs", "TEXT NOT NULL DEFAULT '[]'"),
                ("cli_info", "TEXT NOT NULL DEFAULT '{}'"),
                ("cli_sessions", "TEXT NOT NULL DEFAULT '{}'"),
                ("context_floor", "TEXT"),
                ("auto_compact_window", "INTEGER"),
                ("accounts", "TEXT NOT NULL DEFAULT '{}'"),
            ):
                if col not in cols:
                    self._conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} {ddl}")
            pcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(provider_pool)")}
            for col, ddl in (
                ("primary_mode", "TEXT NOT NULL DEFAULT 'normal'"),
                ("near_5h", "REAL"),
                ("near_7d", "REAL"),
                ("auto_compact_window", "INTEGER NOT NULL DEFAULT 0"),
                ("limit_priority", "TEXT NOT NULL DEFAULT 'balanced'"),
            ):
                if pcols and col not in pcols:
                    self._conn.execute(f"ALTER TABLE provider_pool ADD COLUMN {col} {ddl}")
            mcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(messages)")}
            for col in ("provider", "model"):
                if col not in mcols:
                    self._conn.execute(f"ALTER TABLE messages ADD COLUMN {col} TEXT")
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

    def insert(self, sql: str, params: Iterable[Any] = ()) -> int | None:
        """Execute an INSERT and return the new rowid."""
        assert self._conn is not None, "database not connected"
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            self._conn.commit()
            return cur.lastrowid

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        assert self._conn is not None, "database not connected"
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            return cur.fetchall()

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None
