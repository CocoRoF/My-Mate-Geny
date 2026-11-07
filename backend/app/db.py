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
from contextlib import contextmanager
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
    extra_dirs    TEXT NOT NULL DEFAULT '[]',       -- additional folders: JSON [{path, connection_id|null}] (services/folders.py)
    cli_info      TEXT NOT NULL DEFAULT '{}',       -- last CLI capabilities (tools, slash commands, MCP…)
    cli_sessions  TEXT NOT NULL DEFAULT '{}',       -- per provider: {"claude": {"id", "seen"}, "codex": {...}}
    context_floor TEXT,                             -- /clear: handoffs only include messages after this
    auto_compact_window INTEGER,                    -- Claude: this chat's auto-compact window (NULL = default, 0 = CLI default)
    accounts      TEXT NOT NULL DEFAULT '{}',       -- per provider: the account it ran on last (sticky balancing)
    kind          TEXT NOT NULL DEFAULT 'chat',     -- chat | mate (a Mate's conversation, hidden from the chat list)
    mate_id       TEXT,                             -- kind = mate: which mate
    git_repo      TEXT,                             -- the top bar's Git repo: NULL = the workspace's (auto), '' = none
    git_repo_conn TEXT,                             -- that repo's host: NULL = the workspace's (older rows), 'local', a connection id
    last_result   TEXT,                             -- how the last run ended: ok | error | stopped (NULL: none yet)
    last_result_at TEXT,                            -- when it ended
    last_seen_at  TEXT,                             -- when someone last had the chat open (a newer result = unseen)
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
    meta       TEXT,                -- JSON: {"via": {...}} sent by a mate; {"internal": true, ...} system-made
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

-- Plan usage per account: the last numbers + the request backoff (Retry-After),
-- so a restart neither forgets them nor asks a throttled endpoint again
-- (providers/plan_fetch.py). No secrets: windows, timestamps, error text.
CREATE TABLE IF NOT EXISTS provider_plan_cache (
    account_id TEXT PRIMARY KEY,            -- provider_accounts.id or __primary__<provider>
    data       TEXT NOT NULL,               -- JSON (PlanEntry)
    updated_at TEXT NOT NULL
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
-- What rewound turns spent (services/session_timeline.py): gone from the chat, still counted on the Usage page.
CREATE TABLE IF NOT EXISTS rewound_usage (
    id         INTEGER PRIMARY KEY,   -- the event's own id, so the order stays
    session_id TEXT NOT NULL,
    type       TEXT NOT NULL,
    data       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    message_id  TEXT,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    kind        TEXT NOT NULL,            -- image | file
    origin      TEXT NOT NULL DEFAULT 'user', -- user | screen: presentation provenance, not model access
    width       INTEGER,
    height      INTEGER,
    path        TEXT NOT NULL,            -- original, on this runtime host
    model_path  TEXT,                     -- image variant sized for the model
    model_mime  TEXT,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Accepted speech remains durable while its response window is open. Delivered rows retain only identity.
CREATE TABLE IF NOT EXISTS speech_inputs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL,
    created_at REAL NOT NULL,
    deadline REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_speech_pending ON speech_inputs(session_id,state);

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

CREATE INDEX IF NOT EXISTS idx_bg_tasks_page ON bg_tasks(session_id, COALESCE(started_at, unixepoch(updated_at), 0) DESC, task_id DESC);
CREATE INDEX IF NOT EXISTS idx_bg_tasks_status ON bg_tasks(session_id, status);

-- Mates (avatar secretaries). Persona/avatar/llm/voice are JSON documents
-- (docs/mate.md); the conversation is a sessions row with kind = 'mate'.
CREATE TABLE IF NOT EXISTS mates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    is_default  INTEGER NOT NULL DEFAULT 0,
    persona     TEXT NOT NULL DEFAULT '{}',
    avatar      TEXT NOT NULL DEFAULT '{"kind": "none"}',
    llm         TEXT NOT NULL DEFAULT '{}',
    voice       TEXT NOT NULL DEFAULT '{}',
    prefs       TEXT NOT NULL DEFAULT '{}',   -- conversation settings (docs/mate-memory-affinity.md §3)
    screen      TEXT NOT NULL DEFAULT '{}',   -- screen capture settings (docs/mate.md §4 "Seeing the screen")
    session_id  TEXT,
    memory_rev  INTEGER NOT NULL DEFAULT 0,   -- bumped by user edits of the memory (the engine reloads it)
    builtin     TEXT,                         -- bundled character key (chaerin, …) for built-in mates
    builtin_hash TEXT,                        -- the bundled version it was last synced from
    builtin_snapshot TEXT,                    -- JSON: that bundle (names, greetings, persona, avatar) for field merges
    customized  INTEGER NOT NULL DEFAULT 0,   -- the user edited its persona/avatar (updates keep the edited fields)
    draft       INTEGER NOT NULL DEFAULT 0,   -- being made in the Mate Create studio: hidden until finished
    persona_legacy TEXT,                      -- JSON: the persona before speech/address moved into prefs (backup)
    outfits     TEXT NOT NULL DEFAULT '{}',   -- her wardrobe: the avatar sets she doesn't have on (docs/mate.md "Outfits")
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mate_trigger_links (
    owner_sid TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    worker_sid TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mate_memories (
    id         TEXT PRIMARY KEY,
    mate_id    TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'fact',    -- profile | preference | fact | plan | context (app/mate/memory.py)
    importance INTEGER NOT NULL DEFAULT 3,      -- 1 – 5
    pinned     INTEGER NOT NULL DEFAULT 0,      -- the user's: always in the system prompt
    due_at     TEXT,                            -- plan: YYYY-MM-DD[THH:MM], the user's local time
    expires_at TEXT,                            -- context: archived after this
    status     TEXT NOT NULL DEFAULT 'active',  -- active | done | archived
    source     TEXT NOT NULL DEFAULT 'mate',    -- mate | user | import | merge
    updated_at TEXT,                            -- NULL = saved before kinds existed (migrated once)
    last_used_at TEXT,
    use_count  INTEGER NOT NULL DEFAULT 0,
    supersedes TEXT,
    FOREIGN KEY (mate_id) REFERENCES mates(id) ON DELETE CASCADE
);

-- How close the user and a mate are, and its mood (app/mate/affinity.py): one JSON document per mate.
CREATE TABLE IF NOT EXISTS mate_relation (
    mate_id    TEXT PRIMARY KEY,
    doc        TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- How a mate feels right now, and why (app/mate/state.py): one JSON document per mate.
CREATE TABLE IF NOT EXISTS mate_state (
    mate_id    TEXT PRIMARY KEY,
    doc        TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Changes of a mate's conversation style made by the mate herself (update_conversation_style): applied or proposed,
-- undone / applied / dismissed by the user (docs/mate.md "Prompt composition").
CREATE TABLE IF NOT EXISTS mate_style_changes (
    id          TEXT PRIMARY KEY,
    mate_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    actor       TEXT NOT NULL,                -- mate | user
    status      TEXT NOT NULL,                -- applied | proposed | dismissed | undone
    reason      TEXT NOT NULL DEFAULT '',
    changes     TEXT NOT NULL,                -- JSON {path: {from, to}}
    session_id  TEXT,
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mate_style_changes ON mate_style_changes(mate_id, created_at);

-- Global Mate settings (voice service URLs); API keys live in the vault.
CREATE TABLE IF NOT EXISTS mate_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mate_memories ON mate_memories(mate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id, message_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_ts ON error_logs(ts);
CREATE INDEX IF NOT EXISTS idx_error_logs_filter ON error_logs(level, source);
CREATE INDEX IF NOT EXISTS idx_events_session   ON events(session_id, seq);
-- Paged history (services/history_page.py): replay tails by id, turn slices by
-- time, "the latest X" lookups by type, and the (rare) failed tool results.
-- The error index matches json.dumps' text, so it never parses JSON.
CREATE INDEX IF NOT EXISTS idx_events_sid_id    ON events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_events_sid_ts    ON events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_sid_type  ON events(session_id, type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_usage_window ON events(created_at,id,session_id)
    WHERE type IN ('turn.complete','error');
CREATE INDEX IF NOT EXISTS idx_events_tool_err  ON events(session_id, id)
    WHERE type = 'tool.result' AND instr(data, '"is_error": true') > 0;
"""


class Database:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or settings.db_file
        self._lock = threading.RLock()
        self._transaction_depth = 0
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
        from app.mate.knowledge import bootstrap
        bootstrap(self)

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
                ("kind", "TEXT NOT NULL DEFAULT 'chat'"),
                ("mate_id", "TEXT"),
                ("git_repo", "TEXT"),
                ("git_repo_conn", "TEXT"),  # the Git repo's host: NULL = the workspace's (older rows), 'local', a connection id
                ("last_result", "TEXT"),
                ("last_result_at", "TEXT"),
                ("last_seen_at", "TEXT"),
                ("mcp", "TEXT NOT NULL DEFAULT '{}'"),
                ("higgsfield", "TEXT"),  # the chat's Higgsfield settings (JSON; NULL = defaults)
            ):
                if col not in cols:
                    self._conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} {ddl}")
            self._migrate_folders()
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
            matecols = {r["name"] for r in self._conn.execute("PRAGMA table_info(mates)")}
            for col, ddl in (("builtin", "TEXT"), ("builtin_hash", "TEXT"), ("builtin_snapshot", "TEXT"),
                             ("customized", "INTEGER NOT NULL DEFAULT 0"), ("prefs", "TEXT NOT NULL DEFAULT '{}'"),
                             ("screen", "TEXT NOT NULL DEFAULT '{}'"), ("draft", "INTEGER NOT NULL DEFAULT 0"),
                             ("persona_legacy", "TEXT"), ("outfits", "TEXT NOT NULL DEFAULT '{}'")):
                if matecols and col not in matecols:
                    self._conn.execute(f"ALTER TABLE mates ADD COLUMN {col} {ddl}")
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS mate_builtin_removed (key TEXT PRIMARY KEY, removed_at TEXT NOT NULL)")
            memcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(mate_memories)")}
            for col, ddl in (("kind", "TEXT NOT NULL DEFAULT 'fact'"), ("importance", "INTEGER NOT NULL DEFAULT 3"),
                             ("pinned", "INTEGER NOT NULL DEFAULT 0"), ("due_at", "TEXT"), ("expires_at", "TEXT"),
                             ("status", "TEXT NOT NULL DEFAULT 'active'"), ("source", "TEXT NOT NULL DEFAULT 'mate'"),
                             ("updated_at", "TEXT"), ("last_used_at", "TEXT"),
                             ("use_count", "INTEGER NOT NULL DEFAULT 0"), ("supersedes", "TEXT")):
                if memcols and col not in memcols:
                    self._conn.execute(f"ALTER TABLE mate_memories ADD COLUMN {col} {ddl}")
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_mate_memories_status ON mate_memories(mate_id, status, kind)")
            mcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(messages)")}
            for col in ("provider", "model", "meta"):
                if col not in mcols:
                    self._conn.execute(f"ALTER TABLE messages ADD COLUMN {col} TEXT")
            acols = {r["name"] for r in self._conn.execute("PRAGMA table_info(attachments)")}
            if "origin" not in acols:
                self._conn.execute("ALTER TABLE attachments ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'")
                self._conn.execute("UPDATE attachments SET origin='screen' WHERE message_id LIKE 'artifact:screen:%' OR message_id LIKE 'artifact:capture:%' OR message_id IN (SELECT id FROM messages WHERE CASE WHEN json_valid(meta) THEN json_extract(meta,'$.kind') END='screen_observation')")
            gcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(git_accounts)")}
            if gcols and "scopes" not in gcols:
                self._conn.execute("ALTER TABLE git_accounts ADD COLUMN scopes TEXT NOT NULL DEFAULT ''")
                self._conn.execute("ALTER TABLE git_accounts ADD COLUMN can_push INTEGER NOT NULL DEFAULT 1")
            self._conn.commit()

    def _migrate_folders(self) -> None:
        """Additional folders were plain paths on the workspace's host; now (host, path) pairs
        (app/services/folders.py). Rewrites the old rows once (caller holds the lock)."""
        import json

        from app.services.folders import normalize

        rows = self._conn.execute(
            "SELECT id, connection_id, extra_dirs FROM sessions WHERE extra_dirs LIKE '[\"%'").fetchall()
        for r in rows:
            try:
                new = normalize(r["extra_dirs"], r["connection_id"])
            except Exception:  # noqa: BLE001 - leave an unreadable value alone (read as empty)
                continue
            self._conn.execute("UPDATE sessions SET extra_dirs = ? WHERE id = ?", (json.dumps(new), r["id"]))

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ---- low-level helpers (all lock-guarded) ----

    @contextmanager
    def transaction(self):
        """Serialize a synchronous unit of work. Nested callers use savepoints.

        Never hold this context across an await: the connection and lock belong
        to this thread. Outside a unit of work helpers retain their old autocommit.
        """
        assert self._conn is not None, "database not connected"
        with self._lock:
            depth = self._transaction_depth
            point = f"unit_{depth}"
            self._conn.execute("BEGIN IMMEDIATE" if depth == 0 else f"SAVEPOINT {point}")
            self._transaction_depth += 1
            try:
                yield self
            except BaseException:
                if depth == 0:
                    self._conn.rollback()
                else:
                    self._conn.execute(f"ROLLBACK TO {point}")
                    self._conn.execute(f"RELEASE {point}")
                raise
            else:
                if depth == 0:
                    self._conn.commit()
                else:
                    self._conn.execute(f"RELEASE {point}")
            finally:
                self._transaction_depth -= 1

    def execute(self, sql: str, params: Iterable[Any] = ()) -> None:
        assert self._conn is not None, "database not connected"
        with self._lock:
            self._conn.execute(sql, tuple(params))
            if not self._transaction_depth:
                self._conn.commit()

    def insert(self, sql: str, params: Iterable[Any] = ()) -> int | None:
        """Execute an INSERT and return the new rowid."""
        assert self._conn is not None, "database not connected"
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            if not self._transaction_depth:
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
