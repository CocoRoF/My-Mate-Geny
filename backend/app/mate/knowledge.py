"""Source-backed personal memory. SQLite is the authority; search is rebuildable.

No network access or model downloads here. All access is scoped by the caller's
mate, and raw evidence is always re-read from the original message, not a model
summary. One installation owns this database (never a provider account).
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import UTC, datetime

from app.mate import memory as M
from app.services._ids import new_id, now_iso

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_sources (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1, digest TEXT NOT NULL, role TEXT NOT NULL,
 observed_at TEXT NOT NULL, eligible INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_memory_source_session ON memory_sources(session_id,observed_at,id);
CREATE TABLE IF NOT EXISTS memory_dirty (
 message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS memory_versions (
 memory_id TEXT NOT NULL REFERENCES mate_memories(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, snapshot TEXT NOT NULL, actor TEXT NOT NULL,
 recorded_at TEXT NOT NULL, PRIMARY KEY(memory_id,revision)
);
CREATE TABLE IF NOT EXISTS memory_evidence (
 memory_id TEXT NOT NULL REFERENCES mate_memories(id) ON DELETE CASCADE,
 memory_revision INTEGER NOT NULL DEFAULT 1,
 source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
 source_revision INTEGER NOT NULL, quote TEXT NOT NULL, start INTEGER NOT NULL,
 end INTEGER NOT NULL, relation TEXT NOT NULL DEFAULT 'supports',
 PRIMARY KEY(memory_id,memory_revision,source_id,source_revision,start)
);
CREATE TABLE IF NOT EXISTS memory_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 memory_id TEXT, action TEXT NOT NULL, revision INTEGER, actor TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_exclusions (
 mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 key TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(mate_id,key)
);
CREATE TABLE IF NOT EXISTS memory_episodes (
 id TEXT PRIMARY KEY, mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 title TEXT NOT NULL, occurred_at TEXT, until_at TEXT, precision TEXT NOT NULL DEFAULT 'unknown',
 entities TEXT NOT NULL DEFAULT '[]', source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
 source_revision INTEGER NOT NULL, quote TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(mate_id,source_id,title)
);
CREATE INDEX IF NOT EXISTS idx_memory_episode_source ON memory_episodes(mate_id,source_id);
CREATE TABLE IF NOT EXISTS memory_links (
 mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 origin TEXT NOT NULL REFERENCES memory_episodes(id) ON DELETE CASCADE,
 target TEXT NOT NULL REFERENCES memory_episodes(id) ON DELETE CASCADE,
 relation TEXT NOT NULL, PRIMARY KEY(mate_id,origin,target,relation)
);
CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(mate_id,target);
CREATE TABLE IF NOT EXISTS memory_jobs (
 id TEXT PRIMARY KEY, mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
 source_revision INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, error TEXT, cost REAL NOT NULL DEFAULT 0,
 UNIQUE(mate_id,source_id,source_revision)
);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_state ON memory_jobs(state,available_at);
CREATE TABLE IF NOT EXISTS memory_context (
 mate_id TEXT PRIMARY KEY REFERENCES mates(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL DEFAULT 0, privacy_reset INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS mate_delegation_requests (
 id TEXT PRIMARY KEY, mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 mate_sid TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 worker_sid TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 instruction TEXT NOT NULL, title TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'requested', result TEXT, outcome TEXT,
 delivered INTEGER NOT NULL DEFAULT 0, result_revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mate_requests_worker ON mate_delegation_requests(worker_sid,state);
CREATE TABLE IF NOT EXISTS memory_runs (
 id TEXT PRIMARY KEY, mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 started_at TEXT NOT NULL, finished_at TEXT, state TEXT NOT NULL,
 sources INTEGER NOT NULL DEFAULT 0, facts INTEGER NOT NULL DEFAULT 0, episodes INTEGER NOT NULL DEFAULT 0,
 error TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_runs_mate ON memory_runs(mate_id,started_at);
CREATE TABLE IF NOT EXISTS memory_checkpoints (key TEXT PRIMARY KEY,value TEXT NOT NULL);
"""


def bootstrap(db) -> None:
    with db.transaction():
        for statement in SCHEMA.split(";"):
            if statement.strip():
                db.execute(statement)
        db.execute(
            "CREATE TRIGGER IF NOT EXISTS memory_message_created AFTER INSERT ON messages BEGIN INSERT OR IGNORE INTO memory_dirty VALUES(new.id); END"
        )
        db.execute(
            "CREATE TRIGGER IF NOT EXISTS memory_message_edited AFTER UPDATE OF content,meta ON messages BEGIN INSERT OR IGNORE INTO memory_dirty VALUES(new.id); END"
        )
        evidence_cols = {r["name"] for r in db.query("PRAGMA table_info(memory_evidence)")}
        if "memory_revision" not in evidence_cols:
            db.execute("ALTER TABLE memory_evidence RENAME TO memory_evidence_v0")
            ddl = SCHEMA[SCHEMA.index("CREATE TABLE IF NOT EXISTS memory_evidence (") :].split(
                ";", 1
            )[0]
            db.execute(ddl)
            db.execute(
                "INSERT INTO memory_evidence(memory_id,memory_revision,source_id,source_revision,quote,start,end,relation) SELECT memory_id,1,source_id,source_revision,quote,start,end,relation FROM memory_evidence_v0"
            )
            db.execute("DROP TABLE memory_evidence_v0")
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_memory_evidence_source ON memory_evidence(source_id,source_revision)"
        )
        ccols = {r["name"] for r in db.query("PRAGMA table_info(memory_context)")}
        if "privacy_reset" not in ccols:
            db.execute(
                "ALTER TABLE memory_context ADD COLUMN privacy_reset INTEGER NOT NULL DEFAULT 0"
            )
        tcols = {r["name"] for r in db.query("PRAGMA table_info(mate_delegation_requests)")}
        if "result_revision" not in tcols:
            db.execute(
                "ALTER TABLE mate_delegation_requests ADD COLUMN result_revision INTEGER NOT NULL DEFAULT 0"
            )
        jcols = {r["name"] for r in db.query("PRAGMA table_info(memory_jobs)")}
        if "duration_ms" not in jcols:
            db.execute("ALTER TABLE memory_jobs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0")
        cols = {r["name"] for r in db.query("PRAGMA table_info(mate_memories)")}
        for name, ddl in [
            ("revision", "INTEGER NOT NULL DEFAULT 1"),
            ("evidence_type", "TEXT NOT NULL DEFAULT 'legacy'"),
            ("subject", "TEXT"),
            ("subject_type", "TEXT NOT NULL DEFAULT 'other'"),
            ("predicate", "TEXT"),
            ("valid_from", "TEXT"),
            ("valid_until", "TEXT"),
        ]:
            if name not in cols:
                db.execute(f"ALTER TABLE mate_memories ADD COLUMN {name} {ddl}")
        try:
            db.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(source_id UNINDEXED, terms)"
            )
            db.execute(
                "CREATE TRIGGER IF NOT EXISTS memory_source_deleted AFTER DELETE ON memory_sources BEGIN DELETE FROM memory_fts WHERE source_id=old.id; END"
            )
        except sqlite3.OperationalError:
            # Embedded SQLite builds without FTS5 use the exact same scoped
            # candidate corpus with lexical scoring; recorded in stats.
            pass


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def terms(text: str) -> str:
    return " ".join(sorted({digest(t)[:24] for t in M.tokens(text)}))


# Do not turn secrets into personal facts or repeat them in an index/trace.
_SECRET = re.compile(
    r"(?i)(?:\b(?:sk|ghp|github_pat|ATATT|xox[baprs])[-_A-Za-z0-9=]{16,}|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    r"(?:api[_ -]?key|password|비밀번호|토큰|access[_ -]?token)\s*[:=]\s*\S{8,})"
)


def safe_text(text: str) -> bool:
    return not bool(_SECRET.search(text))


def source_meta(raw: str | None) -> dict:
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {"internal": True}
    except (ValueError, TypeError):
        return {"internal": True}  # unknown historical policy: do not index


def record_message(db, mid: str, *, enqueue: bool = True) -> set[str]:
    with db.transaction():
        return _record_message(db, mid, enqueue=enqueue)


def _record_message(db, mid: str, *, enqueue: bool = True) -> set[str]:
    """Called in the message transaction: source revision + durable outbox.

    Speech drafts are indexed only after confirmation. Internal screen snapshots,
    greetings and automatic prompts are not personal conversation evidence.
    """
    row = db.query_one(
        "SELECT m.*,s.kind,s.mate_id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=?",
        (mid,),
    )
    if not row:
        return set()
    meta = source_meta(row["meta"])
    text = row["content"]
    eligible = bool(
        text.strip()
        and row["role"] in ("user", "assistant", "steer")
        and not meta.get("internal")
        and not meta.get("speech_pending")
        and not meta.get("speech_cancelled")
        and safe_text(text)
    )
    source_id = "msg:" + mid
    old = db.query_one("SELECT * FROM memory_sources WHERE id=?", (source_id,))
    h = digest(text + "\0" + str(eligible))
    if old and old["digest"] == h:
        db.execute("DELETE FROM memory_dirty WHERE message_id=?", (mid,))
        return set()
    revision = old["revision"] + 1 if old else 1
    db.execute(
        "INSERT INTO memory_sources(id,session_id,message_id,revision,digest,role,observed_at,eligible) "
        "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,"
        "role=excluded.role,eligible=excluded.eligible",
        (
            source_id,
            row["session_id"],
            mid,
            revision,
            h,
            row["role"],
            row["created_at"],
            int(eligible),
        ),
    )
    # Quotes from an edited source must never silently cite the new text.
    changed = Knowledge(db).retract_source(source_id, revision) if old else set()
    db.execute(
        "DELETE FROM memory_evidence WHERE source_id=? AND source_revision!=?",
        (source_id, revision),
    )
    db.execute(
        "DELETE FROM memory_episodes WHERE source_id=? AND source_revision!=?",
        (source_id, revision),
    )
    try:
        db.execute("DELETE FROM memory_fts WHERE source_id=?", (source_id,))
        if eligible:
            db.execute(
                "INSERT INTO memory_fts(source_id,terms) VALUES(?,?)",
                (source_id, terms(text[:100000])),
            )
    except sqlite3.OperationalError:
        pass
    db.execute("DELETE FROM memory_dirty WHERE message_id=?", (mid,))
    if (
        enqueue
        and eligible
        and row["mate_id"]
        and row["kind"] == "mate"
        and row["role"] in ("user", "steer")
    ):
        prefs = db.query_one("SELECT prefs FROM mates WHERE id=?", (row["mate_id"],))
        if prefs and json.loads(prefs["prefs"] or "{}").get("memory", {}).get("self_save", True):
            now = now_iso()
            db.execute(
                "INSERT OR IGNORE INTO memory_jobs(id,mate_id,source_id,source_revision,available_at,updated_at) "
                "VALUES(?,?,?,?,?,?)",
                (new_id("mj_"), row["mate_id"], source_id, revision, now, now),
            )

    return changed


class Knowledge:
    def __init__(self, db):
        self.db = db
        self.changed_mates: set[str] = set()
        self.fts = bool(db.query_one("SELECT 1 FROM sqlite_master WHERE name='memory_fts'"))

    def backfill(self, batch: int = 100) -> int:
        """Incremental, resumable and bounded. No provider calls in this pass."""
        self.changed_mates.clear()
        dirty = self.db.query("SELECT message_id FROM memory_dirty LIMIT ?", (batch,))
        for r in dirty:
            self.changed_mates.update(record_message(self.db, r["message_id"]))
        row = self.db.query_one("SELECT value FROM memory_checkpoints WHERE key='messages_v1'")
        cursor = int(row["value"]) if row else 0
        rows = self.db.query(
            "SELECT rowid,id FROM messages WHERE rowid>? ORDER BY rowid LIMIT ?", (cursor, batch)
        )
        # Each source commits independently so a large history never holds
        # the connection lock across a batch. A crash replays idempotently
        # from the last completed checkpoint.
        for r in rows:
            self.changed_mates.update(record_message(self.db, r["id"], enqueue=False))
        if rows:
            self.db.execute(
                "INSERT INTO memory_checkpoints VALUES('messages_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(rows[-1]["rowid"]),),
            )
        return len(rows) + len(dirty)

    def excluded(self, mate_id: str, key: str) -> bool:
        return bool(
            self.db.query_one(
                "SELECT 1 FROM memory_exclusions WHERE mate_id=? AND key=?", (mate_id, key)
            )
        )

    def allowed(self, mate_id: str, source_id: str, scope: str = "all") -> dict | None:
        row = self.db.query_one(
            "SELECT x.*,m.content,m.meta,s.kind,s.mate_id,s.title FROM memory_sources x "
            "JOIN messages m ON m.id=x.message_id JOIN sessions s ON s.id=x.session_id "
            "WHERE x.id=? AND x.eligible=1",
            (source_id,),
        )
        if not row or (row["kind"] == "mate" and row["mate_id"] != mate_id):
            return None
        meta = source_meta(row["meta"])
        if (
            meta.get("internal")
            or meta.get("speech_pending")
            or meta.get("speech_cancelled")
            or not safe_text(row["content"])
        ):
            return None
        if digest(row["content"] + "\0True") != row["digest"]:
            return None  # updated source waiting for its durable outbox repair
        if scope == "mate" and row["kind"] != "mate":
            return None
        if scope == "sessions" and row["kind"] == "mate":
            return None
        if self.excluded(mate_id, source_id) or self.excluded(
            mate_id, "text:" + digest(M.normalized(row["content"]))
        ):
            return None
        return dict(row)

    def snapshot(
        self, memory: dict, actor: str, action: str, *, source_id: str | None = None
    ) -> None:
        with self.db.transaction():
            doc = dict(memory)
            if source_id:
                doc["source_id"] = source_id
            self.db.execute(
                "INSERT OR IGNORE INTO memory_versions VALUES(?,?,?,?,?)",
                (
                    memory["id"],
                    memory.get("revision", 1),
                    json.dumps(doc, ensure_ascii=False),
                    actor,
                    memory.get("updated_at") or memory["created_at"],
                ),
            )
            self.db.execute(
                "INSERT INTO memory_audit(mate_id,memory_id,action,revision,actor,created_at) VALUES(?,?,?,?,?,?)",
                (
                    memory["mate_id"],
                    memory["id"],
                    action,
                    memory.get("revision", 1),
                    actor,
                    now_iso(),
                ),
            )

    def history(self, mate_id: str, memory_id: str) -> list[dict]:
        return [
            {**dict(r), "snapshot": json.loads(r["snapshot"])}
            for r in self.db.query(
                "SELECT v.* FROM memory_versions v JOIN mate_memories m ON m.id=v.memory_id "
                "WHERE m.mate_id=? AND m.id=? ORDER BY v.revision DESC LIMIT 100",
                (mate_id, memory_id),
            )
        ]

    def forget(self, mate_id: str, memory: dict) -> None:
        """Purge derived copies and blacklist their sources (including backfill).

        Original chat is retained as chat history, but excluded from this mate's
        retrieval. Forget is not implemented as an archive with an invisible copy.
        """
        mid, now = memory["id"], now_iso()
        keys = {"text:" + digest(M.normalized(memory["text"]))}
        for r in self.db.query("SELECT source_id FROM memory_evidence WHERE memory_id=?", (mid,)):
            keys.add(r["source_id"])
        for r in self.history(mate_id, mid):
            keys.add("text:" + digest(M.normalized(r["snapshot"]["text"])))
            if r["snapshot"].get("source_id"):
                keys.add(r["snapshot"]["source_id"])
        with self.db.transaction():
            for key in keys:
                self.db.execute(
                    "INSERT OR IGNORE INTO memory_exclusions VALUES(?,?,?)", (mate_id, key, now)
                )
                if key.startswith("msg:"):
                    self.db.execute(
                        "DELETE FROM memory_episodes WHERE mate_id=? AND source_id=?",
                        (mate_id, key),
                    )
                    self.db.execute(
                        "UPDATE memory_jobs SET state='excluded',error=NULL WHERE mate_id=? AND source_id=?",
                        (mate_id, key),
                    )
            self.db.execute("DELETE FROM mate_memories WHERE id=? AND mate_id=?", (mid, mate_id))
            self.invalidate(mate_id)
            self.db.execute(
                "INSERT INTO memory_audit(mate_id,memory_id,action,actor,created_at) VALUES(?,?,?,?,?)",
                (mate_id, mid, "forgotten", "user", now),
            )

    def wipe(self, mate_id: str) -> None:
        """All she has learned is gone (the sources went with the sessions they came from; a memory takes its versions and
        evidence with it): what [Reset her memory] does."""
        with self.db.transaction():
            for table in ("mate_memories", "memory_audit", "memory_exclusions", "memory_episodes", "memory_links", "memory_jobs", "memory_runs"):
                self.db.execute(f"DELETE FROM {table} WHERE mate_id=?", (mate_id,))  # noqa: S608 - our own table names
            self.invalidate(mate_id)
            self.db.execute("UPDATE memory_context SET state='{}' WHERE mate_id=?", (mate_id,))

    def invalidate(self, mate_id: str) -> None:
        self.db.execute(
            "INSERT INTO memory_context(mate_id,generation,privacy_reset) VALUES(?,1,1) ON CONFLICT(mate_id) DO UPDATE SET generation=generation+1,privacy_reset=1,state='{}'",
            (mate_id,),
        )
        self.db.execute("UPDATE mates SET memory_rev=memory_rev+1 WHERE id=?", (mate_id,))
        self.db.execute(
            "UPDATE sessions SET cli_sessions='{}',cli_session_id=NULL,context_floor=? WHERE kind='mate' AND mate_id=?",
            (now_iso(), mate_id),
        )

    def evidence(
        self,
        mate_id: str,
        source_id: str,
        revision: int | None = None,
        before: int = 1,
        after: int = 1,
        offset: int = 0,
    ) -> dict:
        source = self.allowed(mate_id, source_id)
        if not source:
            raise ValueError("Evidence is unavailable or outside this mate’s scope")
        if revision is not None and source["revision"] != revision:
            raise ValueError("Evidence was edited; search again for its current revision")
        offset = max(0, min(len(source["content"]), int(offset)))
        previous = self.db.query(
            "SELECT id FROM memory_sources WHERE session_id=? AND eligible=1 AND (observed_at,id)<(?,?) ORDER BY observed_at DESC,id DESC LIMIT ?",
            (source["session_id"], source["observed_at"], source_id, min(3, max(0, before))),
        )
        following = self.db.query(
            "SELECT id FROM memory_sources WHERE session_id=? AND eligible=1 AND (observed_at,id)>(?,?) ORDER BY observed_at,id LIMIT ?",
            (source["session_id"], source["observed_at"], source_id, min(3, max(0, after))),
        )
        ids = [r["id"] for r in reversed(previous)] + [source_id] + [r["id"] for r in following]
        messages = []
        for sid in ids:
            r = source if sid == source_id else self.allowed(mate_id, sid)
            if not r:
                continue
            start, budget = (offset, 6000) if sid == source_id else (0, 1000)
            text = r["content"][start : start + budget]
            messages.append(
                {
                    "source_id": sid,
                    "revision": r["revision"],
                    "role": r["role"],
                    "text": text,
                    "observed_at": r["observed_at"],
                    "offset": start,
                    "truncated": start > 0 or start + len(text) < len(r["content"]),
                }
            )
        end = min(len(source["content"]), offset + 6000)
        return {
            "source_id": source_id,
            "session_id": source["session_id"],
            "title": source["title"],
            "revision": source["revision"],
            "messages": messages,
            "untrusted_evidence": True,
            "next_offset": end if end < len(source["content"]) else None,
        }

    def search(
        self,
        mate_id: str,
        query: str,
        *,
        scope: str = "mate",
        session_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 10,
        offset: int = 0,
        aliases: list[str] | None = None,
    ) -> dict:
        if scope not in ("mate", "sessions", "all"):
            raise ValueError("scope: mate | sessions | all")

        def boundary(value):
            if not value:
                return None
            dt = datetime.fromisoformat(str(value))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return dt.astimezone(UTC).isoformat()

        since, until = boundary(since), boundary(until)
        if aliases is not None and not isinstance(aliases, list):
            raise ValueError("aliases must be an array")
        limit, offset = max(1, min(20, limit)), max(0, min(1000, offset))
        queries = [query[:2000], *[str(q)[:200] for q in (aliases or [])[:5]]]
        rankings: list[list[str]] = []
        # The same permission/time filter is applied before candidate limiting.
        where, params = (
            [
                "x.eligible=1",
                "(s.kind!='mate' OR s.mate_id=?)",
                "NOT EXISTS(SELECT 1 FROM memory_exclusions e WHERE e.mate_id=? AND e.key=x.id)",
            ],
            [mate_id, mate_id],
        )
        if scope == "mate":
            where.append("s.kind='mate'")
        if scope == "sessions":
            where.append("s.kind!='mate'")
        for clause, value in [
            ("x.session_id=?", session_id),
            ("x.observed_at>=?", since),
            ("x.observed_at<=?", until),
        ]:
            if value:
                where.append(clause)
                params.append(value)
        joins = " FROM memory_sources x JOIN messages m ON m.id=x.message_id JOIN sessions s ON s.id=x.session_id "
        for q in queries:
            ts = terms(q).split()[:80]
            if not ts:
                continue
            if self.fts:
                rows = self.db.query(
                    "SELECT x.id,m.content"
                    + joins
                    + "JOIN memory_fts ON memory_fts.source_id=x.id WHERE "
                    + " AND ".join(where)
                    + " AND memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT 80",
                    (*params, " OR ".join(ts)),
                )
                ranked_ids = []
                qt = set(M.tokens(q))
                for hit in rows:
                    shared = qt & set(M.tokens(hit["content"]))
                    if (
                        any(t.startswith("w:") for t in shared)
                        or sum(t.startswith("b:") for t in shared) >= 2
                    ):
                        ranked_ids.append(hit["id"])
                rankings.append(ranked_ids)
            else:
                rows = self.db.query(
                    "SELECT x.id,m.content"
                    + joins
                    + "WHERE "
                    + " AND ".join(where)
                    + " ORDER BY x.observed_at DESC LIMIT 5000",
                    params,
                )
                qt = set(M.tokens(q))
                scores = sorted(
                    [(len(qt & set(M.tokens(r["content"]))), r["id"]) for r in rows], reverse=True
                )
                rankings.append([i for score, i in scores[:80] if score >= 2])
        # Episode entity names/aliases are source-grounded. Matching one event
        # opens explicit neighboring events, for at most two hops.
        # Entity labels and titles are exact source phrases, so lexical hits
        # already find their seed episodes. Avoid tokenizing years of episodes
        # on every keystroke/turn. Expand bounded indexed edges from those seeds.
        seed_sources = list(dict.fromkeys(s for ranking in rankings for s in ranking[:20]))[:40]
        linked: set[str] = set()
        if seed_sources:
            slots = ",".join("?" for _ in seed_sources)
            linked = {
                r["id"]
                for r in self.db.query(
                    f"SELECT id FROM memory_episodes WHERE mate_id=? AND source_id IN ({slots}) LIMIT 40",
                    (mate_id, *seed_sources),
                )
            }
        for _ in range(2):
            frontier = set(linked)
            if not frontier:
                break
            slots = ",".join("?" for _ in frontier)
            edges = self.db.query(
                f"SELECT origin,target FROM memory_links WHERE mate_id=? AND (origin IN ({slots}) OR target IN ({slots})) LIMIT 80",
                (mate_id, *frontier, *frontier),
            )
            for edge in edges:
                if len(linked) >= 80:
                    break
                linked.update((edge["origin"], edge["target"]))
        eps = []
        if linked:
            slots = ",".join("?" for _ in linked)
            eps = self.db.query(
                f"SELECT * FROM memory_episodes WHERE mate_id=? AND id IN ({slots}) LIMIT 80",
                (mate_id, *linked),
            )
        rankings.append([e["source_id"] for e in eps])
        scores: dict[str, float] = {}
        for ranked in rankings:
            for rank, sid in enumerate(dict.fromkeys(ranked)):
                scores[sid] = scores.get(sid, 0) + 1 / (60 + rank)
        out = []
        for sid, score in sorted(scores.items(), key=lambda v: (-v[1], v[0])):
            r = self.allowed(mate_id, sid, scope)
            if (
                not r
                or (session_id and r["session_id"] != session_id)
                or (since and r["observed_at"] < since)
                or (until and r["observed_at"] > until)
            ):
                continue
            # Center the excerpt on a matching term, not the first 600 chars.
            pos = max(
                0,
                next(
                    (
                        r["content"].lower().find(w[2:])
                        for w in M.tokens(query)
                        if w.startswith("w:") and w[2:] in r["content"].lower()
                    ),
                    0,
                )
                - 120,
            )
            out.append(
                {
                    "source_id": sid,
                    "revision": r["revision"],
                    "session_id": r["session_id"],
                    "title": r["title"],
                    "role": r["role"],
                    "observed_at": r["observed_at"],
                    "excerpt": r["content"][pos : pos + 600],
                    "offset": pos,
                    "evidence_type": "asserted" if r["role"] in ("user", "steer") else "reported",
                    "episodes": [e["id"] for e in eps if e["source_id"] == sid],
                    "score": round(score, 6),
                }
            )
        return {
            "items": out[offset : offset + limit],
            "next_offset": offset + limit if len(out) > offset + limit else None,
            "candidate_limit": 80,
            "indexing_pending": self.unindexed(mate_id, scope),
            "candidate_limit_reached": any(len(r) >= 80 for r in rankings),
            "method": "fts+relations" if self.fts else "lexical+relations",
            "untrusted_evidence": True,
        }

    def retract_source(self, source_id: str, revision: int) -> set[str]:
        """Source corrections retract only the currently supported version,
        preserve its ledger, and invalidate cached prompts as well as citations.
        """
        affected = self.db.query(
            "SELECT DISTINCT m.* FROM mate_memories m JOIN memory_evidence e ON e.memory_id=m.id AND e.memory_revision=m.revision WHERE e.source_id=? AND e.source_revision!=? AND m.evidence_type='extracted' AND m.status='active'",
            (source_id, revision),
        )
        mates = set()
        for raw in affected:
            memory = dict(raw)
            mid, mate_id = memory["id"], memory["mate_id"]
            self.snapshot(memory, "source", "before_source_edit")
            self.db.execute(
                "UPDATE mate_memories SET status='archived',revision=revision+1,updated_at=? WHERE id=?",
                (now_iso(), mid),
            )
            self.snapshot(
                dict(self.db.query_one("SELECT * FROM mate_memories WHERE id=?", (mid,))),
                "source",
                "source_edited",
            )
            key = "memchg:" + mate_id
            pending = self.db.query_one("SELECT value FROM mate_settings WHERE key=?", (key,))
            changes = json.loads(pending["value"]) if pending else []
            changes = [c for c in changes if c.get("id") != mid]
            changes.append(
                {
                    "id": mid,
                    "op": "archived",
                    "text": "Original evidence changed; do not rely on this assertion. Search the corrected source.",
                }
            )
            self.db.execute(
                "INSERT INTO mate_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(changes[-20:], ensure_ascii=False)),
            )
            mates.add(mate_id)
        for mate_id in mates:
            self.db.execute("UPDATE mates SET memory_rev=memory_rev+1 WHERE id=?", (mate_id,))
            self.db.execute(
                "INSERT INTO memory_context(mate_id,generation) VALUES(?,1) ON CONFLICT(mate_id) DO UPDATE SET generation=generation+1,state='{}'",
                (mate_id,),
            )
        return mates

    def unindexed(self, mate_id: str | None = None, scope: str = "mate") -> int:
        where, params = [], []
        if mate_id:
            where.append("(s.kind!='mate' OR s.mate_id=?)")
            params.append(mate_id)
            if scope == "mate":
                where.append("s.kind='mate'")
            elif scope == "sessions":
                where.append("s.kind!='mate'")
        where.append("(x.id IS NULL OR d.message_id IS NOT NULL)")
        return self.db.query_one(
            "SELECT COUNT(*) n FROM messages m JOIN sessions s ON s.id=m.session_id LEFT JOIN memory_sources x ON x.message_id=m.id LEFT JOIN memory_dirty d ON d.message_id=m.id WHERE "
            + " AND ".join(where),
            params,
        )["n"]

    def stats(self, mate_id: str) -> dict:
        jobs = {
            r["state"]: r["n"]
            for r in self.db.query(
                "SELECT state,COUNT(*) n FROM memory_jobs WHERE mate_id=? GROUP BY state",
                (mate_id,),
            )
        }
        return {
            "jobs": jobs,
            "unindexed": self.unindexed(mate_id),
            "fts": self.fts,
            "episodes": self.db.query_one(
                "SELECT COUNT(*) n FROM memory_episodes WHERE mate_id=?", (mate_id,)
            )["n"],
            "evidence": self.db.query_one(
                "SELECT COUNT(*) n FROM memory_evidence e JOIN mate_memories m ON m.id=e.memory_id WHERE m.mate_id=?",
                (mate_id,),
            )["n"],
            "recent_runs": [
                dict(r)
                for r in self.db.query(
                    "SELECT started_at,finished_at,state,sources,facts,episodes,error FROM memory_runs WHERE mate_id=? ORDER BY started_at DESC LIMIT 5",
                    (mate_id,),
                )
            ],
            "cost": self.db.query_one(
                "SELECT COALESCE(SUM(cost),0) n FROM memory_jobs WHERE mate_id=?", (mate_id,)
            )["n"],
        }

    def attach(
        self,
        mate_id: str,
        memory_id: str,
        source_id: str,
        quote: str,
        revision: int | None = None,
        *,
        contextual: bool = False,
    ) -> None:
        source = self.allowed(mate_id, source_id)
        memory = self.db.query_one(
            "SELECT * FROM mate_memories WHERE id=? AND mate_id=?", (memory_id, mate_id)
        )
        if not source or not memory or not quote.strip() or quote not in source["content"]:
            raise ValueError("An exact quote from accessible original evidence is required")
        if revision is not None and revision != source["revision"]:
            raise ValueError("Source revision changed")
        if M.normalized(memory["text"]) != M.normalized(quote) and not (
            contextual and " ".join(quote.split()) in memory["text"]
        ):
            raise ValueError(
                "A citation must support the complete stored assertion; save the exact supported quote"
            )
        start = source["content"].index(quote)
        self.db.execute(
            "INSERT OR IGNORE INTO memory_evidence VALUES(?,?,?,?,?,?,?,?)",
            (
                memory_id,
                memory["revision"],
                source_id,
                source["revision"],
                quote[:2000],
                start,
                start + len(quote[:2000]),
                "context" if contextual else "supports",
            ),
        )

    def episode(self, mate_id: str, body: dict) -> dict:
        source_id, quote = str(body.get("source_id") or ""), str(body.get("quote") or "")
        source = self.allowed(mate_id, source_id)
        if not source or not quote.strip() or len(quote) > 4000 or quote not in source["content"]:
            raise ValueError("Episode needs an exact quote from an accessible original source")
        title = str(body.get("title") or "")[:200].strip()
        if not title or title not in quote:
            raise ValueError("Episode title must be an exact supported phrase")
        if not isinstance(body.get("entities", []), list):
            raise TypeError("entities must be an array")
        # Extraction cannot invent a date or an alias. Store only strings
        # explicitly anchored in the cited passage; unknown remains unknown.
        entities = [
            str(x)[:120]
            for x in (body.get("entities") or [])[:20]
            if isinstance(x, str) and x.strip() and x in quote
        ]
        occurred_at = str(body.get("occurred_at") or "")[:40] or None
        if occurred_at:
            try:
                datetime.fromisoformat(occurred_at)
            except ValueError as exc:
                raise ValueError("Use an ISO event date or leave it unknown") from exc
            if occurred_at[:10] not in quote:
                occurred_at = None
        if self.excluded(mate_id, source_id):
            raise ValueError("This source was forgotten")
        eid, now = new_id("ep_"), now_iso()
        with self.db.transaction():
            self.db.execute(
                "INSERT OR IGNORE INTO memory_episodes(id,mate_id,title,occurred_at,precision,entities,source_id,source_revision,quote,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    eid,
                    mate_id,
                    title,
                    occurred_at,
                    "date" if occurred_at else "unknown",
                    json.dumps(entities, ensure_ascii=False),
                    source_id,
                    source["revision"],
                    quote,
                    now,
                ),
            )
            row = self.db.query_one(
                "SELECT * FROM memory_episodes WHERE mate_id=? AND source_id=? AND title=?",
                (mate_id, source_id, title),
            )
            # Exact shared identifiers (e.g. shoot S42) or explicit entity
            # names link episodes. Generic overlapping words never do.
            neighbors = 0
            for other in self.db.query(
                "SELECT id,entities FROM memory_episodes WHERE mate_id=? AND id!=? ORDER BY created_at DESC LIMIT 1000",
                (mate_id, row["id"]),
            ):
                common = set(entities) & set(json.loads(other["entities"]))
                if common:
                    neighbors += 1
                    if neighbors > 40:
                        break
                    self.db.execute(
                        "INSERT OR IGNORE INTO memory_links VALUES(?,?,?,?)",
                        (mate_id, row["id"], other["id"], "shared_entity"),
                    )
        return self.get_episode(mate_id, row["id"])

    def get_episode(self, mate_id: str, eid: str) -> dict:
        row = self.db.query_one(
            "SELECT * FROM memory_episodes WHERE mate_id=? AND id=?", (mate_id, eid)
        )
        if not row or not self.allowed(mate_id, row["source_id"]):
            raise ValueError("Episode not found")
        source = self.allowed(mate_id, row["source_id"])
        if source["revision"] != row["source_revision"]:
            raise ValueError("Episode evidence changed")
        return {
            **dict(row),
            "evidence_type": "asserted" if source["role"] in ("user", "steer") else "reported",
            "entities": json.loads(row["entities"]),
            "related": [
                dict(r)
                for r in self.db.query(
                    "SELECT origin,target,relation FROM memory_links WHERE mate_id=? AND (origin=? OR target=?) LIMIT 40",
                    (mate_id, eid, eid),
                )
            ],
        }

    def memory_details(self, mate_id: str, mid: str) -> dict:
        memory = self.db.query_one(
            "SELECT * FROM mate_memories WHERE mate_id=? AND id=?", (mate_id, mid)
        )
        if not memory:
            raise ValueError("Memory not found")
        evidence = []
        for r in self.db.query("SELECT * FROM memory_evidence WHERE memory_id=?", (mid,)):
            source = self.allowed(mate_id, r["source_id"])
            if source and source["revision"] == r["source_revision"]:
                evidence.append(
                    {
                        **dict(r),
                        "session_id": source["session_id"],
                        "title": source["title"],
                        "observed_at": source["observed_at"],
                    }
                )
        return {
            "versions": [
                {**v, "evidence": [e for e in evidence if e["memory_revision"] == v["revision"]]}
                for v in self.history(mate_id, mid)
            ],
            "evidence": [e for e in evidence if e["memory_revision"] == memory["revision"]],
            "evidence_type": memory["evidence_type"],
        }

    def exclude_source(self, mate_id: str, source_id: str) -> None:
        if not self.allowed(mate_id, source_id):
            raise ValueError("Source not found")
        with self.db.transaction():
            memories = self.db.query(
                "SELECT DISTINCT m.* FROM mate_memories m JOIN memory_evidence e ON e.memory_id=m.id WHERE m.mate_id=? AND e.source_id=?",
                (mate_id, source_id),
            )
            for mem in memories:
                self.forget(mate_id, dict(mem))
            self.db.execute(
                "INSERT OR IGNORE INTO memory_exclusions VALUES(?,?,?)",
                (mate_id, source_id, now_iso()),
            )
            self.db.execute(
                "DELETE FROM memory_episodes WHERE mate_id=? AND source_id=?", (mate_id, source_id)
            )
            self.db.execute(
                "UPDATE memory_jobs SET state='excluded',error=NULL WHERE mate_id=? AND source_id=?",
                (mate_id, source_id),
            )
            self.invalidate(mate_id)

    def purge_session(self, sid: str) -> None:
        with self.db.transaction():
            rows = self.db.query(
                "SELECT DISTINCT m.* FROM mate_memories m JOIN memory_evidence e ON e.memory_id=m.id JOIN memory_sources s ON s.id=e.source_id WHERE s.session_id=?",
                (sid,),
            )
            for row in rows:
                self.forget(row["mate_id"], dict(row))
            # FKs purge sources, episodes, outbox, jobs and the FTS delete trigger.

    def temporal_memories(self, mate_id: str, at: str, query: str = "") -> list[dict]:
        """What was recorded as known at a point in time, distinct from the
        event's occurred_at. Unknown validity is never assigned a made-up date."""
        dt = datetime.fromisoformat(at)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        stamp = dt.astimezone(UTC).isoformat()
        rows = self.db.query(
            "SELECT v.* FROM memory_versions v JOIN mate_memories m ON m.id=v.memory_id WHERE m.mate_id=? AND v.recorded_at<=? ORDER BY v.recorded_at DESC,v.revision DESC",
            (mate_id, stamp),
        )
        found = {}
        qt = set(M.tokens(query))
        for r in rows:
            if r["memory_id"] in found:
                continue
            doc = json.loads(r["snapshot"])
            found[r["memory_id"]] = doc
        return [v for v in found.values() if not query or qt & set(M.tokens(v["text"]))][:20]

    def diagnostics(self) -> dict:
        jobs = {
            r["state"]: r["n"]
            for r in self.db.query("SELECT state,COUNT(*) n FROM memory_jobs GROUP BY state")
        }
        perf = self.db.query_one(
            "SELECT COALESCE(AVG(duration_ms),0) latency_ms,COALESCE(SUM(cost),0) cost FROM memory_jobs WHERE attempts>0"
        )
        return {
            "jobs": jobs,
            "fts": self.fts,
            "sources": self.db.query_one("SELECT COUNT(*) n FROM memory_sources")["n"],
            "unindexed": self.unindexed(),
            "episodes": self.db.query_one("SELECT COUNT(*) n FROM memory_episodes")["n"],
            "latency_ms": round(perf["latency_ms"]),
            "cost_usd": round(perf["cost"], 6),
            "max_calls_per_minute": 2,
            "batch_size": 8,
            "content_logged": False,
        }

    def episodes(
        self, mate_id: str, *, limit: int = 40, before: str | None = None, q: str = ""
    ) -> dict:
        limit = min(100, max(1, limit))
        where, params = (
            [
                "e.mate_id=?",
                "x.eligible=1",
                "e.source_revision=x.revision",
                "NOT EXISTS(SELECT 1 FROM memory_exclusions z WHERE z.mate_id=e.mate_id AND z.key=e.source_id)",
            ],
            [mate_id],
        )
        if q.strip():
            where.append("instr(lower(e.title||' '||e.quote||' '||e.entities),lower(?))>0")
            params.append(q.strip()[:300])
        if before:
            stamp, eid = before.split("|", 1)
            where.append("(e.created_at,e.id)<(?,?)")
            params.extend([stamp, eid])
        rows = self.db.query(
            "SELECT e.*,s.title source_title,x.observed_at FROM memory_episodes e JOIN memory_sources x ON x.id=e.source_id JOIN sessions s ON s.id=x.session_id WHERE "
            + " AND ".join(where)
            + " ORDER BY e.created_at DESC,e.id DESC LIMIT ?",
            (*params, min(100, max(1, limit)) + 1),
        )
        out = []
        for row in rows[:limit]:
            if self.allowed(mate_id, row["source_id"]):
                out.append({**dict(row), "entities": json.loads(row["entities"])})
        return {
            "items": out,
            "next_cursor": rows[limit - 1]["created_at"] + "|" + rows[limit - 1]["id"]
            if len(rows) > limit
            else None,
        }
