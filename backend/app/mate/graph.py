"""A mate's memory network (docs/mate-memory-graph.md): entities as nodes, what she knows about them as facts
(edges), every fact tied to where it came from — a page she read (a document chunk) or a conversation (a source
message) — and how strongly each one is held right now.

    mem_nodes       people, places, games, works, topics, concepts, events … (+ the user and herself)
    mem_node_keys   the normalized names and aliases a node answers to (entity resolution, cross-language:
                    "Path of Exile" · "패스 오브 엑자일" · "PoE")
    mem_facts       subject —predicate→ object (or a literal in the statement), bi-temporal (valid_from/until as
                    the source says; recorded_at/invalidated_at as she learned it), exact quote of its source
    mem_mentions    what else talks about a node: a personal memory (mem:<id>), an episode (ep:<id>), a page
    know_docs/know_chunks   the pages she read, cut in chunks (FTS), the ground truth of every document fact

Strength (docs/mate-memory-graph.md "Remembering and forgetting"): each node and fact has a *stability* S in days
and a last access; how retrievable it is now is the FSRS power curve R = (1 + t / 9S)^-1. Using it — recalled into a
conversation, said by the user, opened by her tools — makes it more stable, more so when it was nearly forgotten
(the spacing effect). Ranking multiplies relevance by R, so old untouched things come up less and less while what
was said lately stays strong; nothing is deleted by fading (only the user forgets, or a newer fact supersedes).

Per turn there is no model call: the user's words (and the last few turns, weaker) light up the nodes they name,
the activation spreads one or two hops along facts and co-mentions, and the strongest facts around the lit nodes go
into her context within a budget. Pure SQLite; no service, no embeddings: names and aliases (written by the model
when it files a fact) carry the cross-language matching.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import threading
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from app.mate import memory as M
from app.mate.knowledge import terms
from app.services._ids import new_id, now_iso

KINDS = ("user", "self", "person", "place", "org", "work", "game", "thing", "concept", "topic", "event")
ORIGINS = ("chat", "document", "study", "user")
# stability (days) a new item starts with, by importance 1–5 (5: what she should practically never lose)
STABILITY0 = {1: 2.0, 2: 5.0, 3: 12.0, 4: 40.0, 5: 180.0}
STABILITY_MAX = 3650.0
GROWTH = 2.5           # reinforcement: S' = S · (1 + GROWTH · (1 − R)) + 0.5
FADED = 0.2            # below this retrievability an item only comes up on a strong match
SPREAD = (1.0, 0.5, 0.2)   # activation at the seed, one hop, two hops
# knowledge in a turn's context (prefs.memory.recall): facts, characters
KNOW_BUDGET = {"off": (0, 0), "light": (3, 500), "normal": (6, 1100), "rich": (10, 2000)}
MAX_FACT_CHARS = 400
MAX_SUMMARY_CHARS = 600
MAX_ALIASES = 12

SCHEMA = """
CREATE TABLE IF NOT EXISTS mem_nodes (
 id TEXT PRIMARY KEY, mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '',
 origin TEXT NOT NULL DEFAULT 'chat', importance INTEGER NOT NULL DEFAULT 3,
 stability REAL NOT NULL DEFAULT 12, last_access TEXT, access_count INTEGER NOT NULL DEFAULT 0,
 pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active', merged_into TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_nodes_mate ON mem_nodes(mate_id,status);
CREATE TABLE IF NOT EXISTS mem_node_keys (
 mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE, key TEXT NOT NULL,
 node_id TEXT NOT NULL REFERENCES mem_nodes(id) ON DELETE CASCADE, PRIMARY KEY(mate_id,key,node_id)
);
CREATE INDEX IF NOT EXISTS idx_mem_node_keys_node ON mem_node_keys(node_id);
CREATE TABLE IF NOT EXISTS know_docs (
 id TEXT PRIMARY KEY, mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', site TEXT NOT NULL DEFAULT '',
 origin TEXT NOT NULL DEFAULT 'url', study_id TEXT, digest TEXT NOT NULL, chars INTEGER NOT NULL DEFAULT 0,
 published TEXT, fetched_at TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_know_docs_mate ON know_docs(mate_id,fetched_at);
CREATE INDEX IF NOT EXISTS idx_know_docs_url ON know_docs(mate_id,url);
CREATE TABLE IF NOT EXISTS know_chunks (
 id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES know_docs(id) ON DELETE CASCADE,
 mate_id TEXT NOT NULL, ordinal INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_know_chunks_doc ON know_chunks(doc_id,ordinal);
CREATE TABLE IF NOT EXISTS mem_facts (
 id TEXT PRIMARY KEY, mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 subject TEXT NOT NULL REFERENCES mem_nodes(id) ON DELETE CASCADE, predicate TEXT NOT NULL,
 object TEXT REFERENCES mem_nodes(id) ON DELETE SET NULL, statement TEXT NOT NULL,
 origin TEXT NOT NULL DEFAULT 'document',
 doc_id TEXT REFERENCES know_docs(id) ON DELETE CASCADE, chunk_id TEXT,
 source_id TEXT, source_revision INTEGER, quote TEXT NOT NULL DEFAULT '',
 valid_from TEXT, valid_until TEXT, recorded_at TEXT NOT NULL, invalidated_at TEXT, superseded_by TEXT,
 confidence REAL NOT NULL DEFAULT 0.8, importance INTEGER NOT NULL DEFAULT 3,
 stability REAL NOT NULL DEFAULT 12, last_access TEXT, access_count INTEGER NOT NULL DEFAULT 0,
 study_id TEXT, status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_mem_facts_subject ON mem_facts(mate_id,subject,status);
CREATE INDEX IF NOT EXISTS idx_mem_facts_object ON mem_facts(mate_id,object,status);
CREATE INDEX IF NOT EXISTS idx_mem_facts_doc ON mem_facts(doc_id);
CREATE TABLE IF NOT EXISTS mem_mentions (
 mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL REFERENCES mem_nodes(id) ON DELETE CASCADE,
 ref TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'about', label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
 PRIMARY KEY(mate_id,node_id,ref)
);
CREATE INDEX IF NOT EXISTS idx_mem_mentions_ref ON mem_mentions(mate_id,ref);
CREATE TABLE IF NOT EXISTS mem_linked (
 mate_id TEXT NOT NULL REFERENCES mates(id) ON DELETE CASCADE, ref TEXT NOT NULL, linked_at TEXT NOT NULL,
 PRIMARY KEY(mate_id,ref)
)
"""
FTS = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS mem_facts_fts USING fts5(fact_id UNINDEXED, terms)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS know_chunks_fts USING fts5(chunk_id UNINDEXED, terms)",
)


def bootstrap(db) -> bool:
    """The tables (idempotent) → whether FTS5 is there."""
    with db.transaction():
        for statement in SCHEMA.split(";"):
            if statement.strip():
                db.execute(statement)
    try:
        with db.transaction():
            for s in FTS:
                db.execute(s)
            db.execute("CREATE TRIGGER IF NOT EXISTS mem_fact_deleted AFTER DELETE ON mem_facts "
                       "BEGIN DELETE FROM mem_facts_fts WHERE fact_id=old.id; END")
            db.execute("CREATE TRIGGER IF NOT EXISTS know_chunk_deleted AFTER DELETE ON know_chunks "
                       "BEGIN DELETE FROM know_chunks_fts WHERE chunk_id=old.id; END")
        return True
    except sqlite3.OperationalError:
        return False


# ---- strength ----

def _days(iso: str | None, now: datetime) -> float:
    if not iso:
        return 0.0
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    if t.tzinfo is None:
        t = t.replace(tzinfo=UTC)
    return max(0.0, (now - t).total_seconds() / 86400)


def stability0(importance: int | None) -> float:
    return STABILITY0.get(max(1, min(5, int(importance or 3))), 12.0)


def retrievability(row: dict[str, Any], now: datetime | None = None) -> float:
    """How readily it comes to mind now (1 = just used, → 0 as it fades). Pinned: always 1."""
    if row.get("pinned"):
        return 1.0
    now = now or datetime.now(UTC)
    s = max(0.5, float(row.get("stability") or stability0(row.get("importance"))))
    t = _days(row.get("last_access") or row.get("updated_at") or row.get("created_at")
              or row.get("recorded_at"), now)
    return (1.0 + t / (9.0 * s)) ** -1


def reinforced(row: dict[str, Any], now: datetime | None = None) -> float:
    """Its stability after being used now: more when it was nearly gone, a little when it was fresh."""
    r = retrievability({**row, "pinned": 0}, now)
    s = float(row.get("stability") or stability0(row.get("importance")))
    return min(STABILITY_MAX, s * (1.0 + GROWTH * (1.0 - r)) + 0.5)


# ---- names ----

def key(text: str) -> str:
    """A name as it is matched: NFKC, lower case, no spaces / punctuation ("Path of Exile" → "pathofexile")."""
    return M.normalized(text)[:120]


def _clean_name(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()[:120]


def _aliases(values: Any, name: str) -> list[str]:
    out, seen = [], {key(name)}
    for v in values if isinstance(values, list) else []:
        a = _clean_name(v)
        k = key(a)
        if a and k and (len(k) >= 2 or "가" <= k[0] <= "힣") and k not in seen:
            seen.add(k)
            out.append(a)
        if len(out) >= MAX_ALIASES:
            break
    return out


def _quote_in(quote: str, text: str) -> tuple[int, int] | None:
    """Where an exact quote is in a text — whitespace may differ (a page's line breaks), nothing else."""
    q = quote.strip()
    if len(q) < 8:
        return None
    i = text.find(q)
    if i >= 0:
        return i, i + len(q)
    parts = [re.escape(p) for p in q.split()]
    if not parts:
        return None
    m = re.search(r"\s+".join(parts), text)
    return (m.start(), m.end()) if m else None


class GraphError(ValueError):
    pass


class Graph:
    """One installation's memory networks (every call is scoped by the mate)."""

    def __init__(self, db) -> None:
        self.db = db
        self.fts = bootstrap(db)
        self._lock = threading.RLock()
        self._keys: dict[str, tuple[int, list[tuple[str, str]]]] = {}  # mate → (version, [(key, node)])
        self._version: dict[str, int] = {}
        self.on_change = lambda mate_id: None

    # ---- the cache of names ----
    def _bump(self, mate_id: str) -> None:
        self._version[mate_id] = self._version.get(mate_id, 0) + 1
        self.on_change(mate_id)

    def _names(self, mate_id: str) -> list[tuple[str, str]]:
        v = self._version.get(mate_id, 0)
        hit = self._keys.get(mate_id)
        if hit and hit[0] == v:
            return hit[1]
        rows = self.db.query("SELECT k.key,k.node_id FROM mem_node_keys k JOIN mem_nodes n ON n.id=k.node_id "
                             "WHERE k.mate_id=? AND n.status='active' AND n.kind NOT IN ('user','self')", (mate_id,))
        names = sorted(((r["key"], r["node_id"]) for r in rows), key=lambda x: -len(x[0]))
        self._keys[mate_id] = (v, names)
        return names

    # ---- nodes ----
    def node(self, mate_id: str, nid: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM mem_nodes WHERE id=? AND mate_id=?", (nid, mate_id))
        if r is None:
            return None
        d = dict(r)
        if d["status"] == "merged" and d.get("merged_into"):
            return self.node(mate_id, d["merged_into"])
        d["aliases"] = json.loads(d["aliases"] or "[]")
        d["pinned"] = bool(d["pinned"])
        return d

    def find(self, mate_id: str, name: str) -> dict[str, Any] | None:
        """The node a name (or alias) means, if she knows one."""
        k = key(name)
        if not k:
            return None
        r = self.db.query_one("SELECT n.id FROM mem_node_keys k JOIN mem_nodes n ON n.id=k.node_id "
                              "WHERE k.mate_id=? AND k.key=? AND n.status='active' ORDER BY n.access_count DESC LIMIT 1",
                              (mate_id, k))
        return self.node(mate_id, r["id"]) if r else None

    def special(self, mate_id: str, kind: str, name: str) -> dict[str, Any]:
        """The user's node / her own (one each)."""
        r = self.db.query_one("SELECT id FROM mem_nodes WHERE mate_id=? AND kind=? AND status='active' LIMIT 1",
                              (mate_id, kind))
        if r:
            return self.node(mate_id, r["id"])  # type: ignore[return-value]
        return self.upsert(mate_id, name=name, kind=kind, origin="user", importance=5)

    def upsert(self, mate_id: str, *, name: str, kind: str = "concept", aliases: Any = None, summary: str = "",
               origin: str = "chat", importance: int = 3) -> dict[str, Any]:
        """The node a name means — found by its name or any alias, else made; new aliases and an empty summary
        are filled in. A kind already set stays (a later call may call it something else)."""
        name = _clean_name(name)
        if not key(name):
            raise GraphError("a node needs a name")
        kind = kind if kind in KINDS else "concept"
        al = _aliases(aliases, name)
        now = now_iso()
        with self._lock, self.db.transaction():
            found = None
            if kind not in ("user", "self"):
                for k in [key(name), *[key(a) for a in al]]:
                    r = self.db.query_one(
                        "SELECT n.id FROM mem_node_keys k JOIN mem_nodes n ON n.id=k.node_id WHERE k.mate_id=? AND "
                        "k.key=? AND n.status='active' AND n.kind NOT IN ('user','self') ORDER BY n.access_count DESC LIMIT 1",
                        (mate_id, k))
                    if r:
                        found = r["id"]
                        break
            if found:
                node = self.node(mate_id, found)
                assert node is not None
                known = {key(node["name"]), *[key(a) for a in node["aliases"]]}
                extra = [a for a in [name, *al] if key(a) not in known][: max(0, MAX_ALIASES - len(node["aliases"]))]
                sets, vals = ["updated_at=?"], [now]
                if extra:
                    sets.append("aliases=?")
                    vals.append(json.dumps(node["aliases"] + extra, ensure_ascii=False))
                if summary and not node["summary"]:
                    sets.append("summary=?")
                    vals.append(summary.strip()[:MAX_SUMMARY_CHARS])
                if node["kind"] in ("topic", "concept") and kind not in ("topic", "concept", "user", "self"):
                    sets.append("kind=?")  # (a study's topic turns out to be a game, a person …: the specific kind wins)
                    vals.append(kind)
                if int(importance) > int(node["importance"]):
                    sets += ["importance=?", "stability=MAX(stability,?)"]
                    vals += [int(importance), stability0(importance)]
                self.db.execute(f"UPDATE mem_nodes SET {', '.join(sets)} WHERE id=?", (*vals, found))
                for a in extra:
                    self.db.execute("INSERT OR IGNORE INTO mem_node_keys VALUES(?,?,?)", (mate_id, key(a), found))
                if extra:
                    self._bump(mate_id)
                return self.node(mate_id, found)  # type: ignore[return-value]
            nid = new_id("n_")
            imp = max(1, min(5, int(importance or 3)))
            self.db.execute(
                "INSERT INTO mem_nodes(id,mate_id,kind,name,aliases,summary,origin,importance,stability,last_access,"
                "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (nid, mate_id, kind, name, json.dumps(al, ensure_ascii=False), summary.strip()[:MAX_SUMMARY_CHARS],
                 origin if origin in ORIGINS else "chat", imp, stability0(imp), now, now, now))
            for k in {key(name), *[key(a) for a in al]}:
                if k:
                    self.db.execute("INSERT OR IGNORE INTO mem_node_keys VALUES(?,?,?)", (mate_id, k, nid))
            self._bump(mate_id)
            return self.node(mate_id, nid)  # type: ignore[return-value]

    def edit(self, mate_id: str, nid: str, patch: dict[str, Any]) -> dict[str, Any]:
        node = self.node(mate_id, nid)
        if node is None:
            raise GraphError("no such node")
        if "kind" in patch and patch["kind"] not in KINDS:
            raise GraphError("kind: " + " | ".join(KINDS))
        sets, vals = ["updated_at=?"], [now_iso()]
        if "name" in patch and key(_clean_name(patch["name"])):
            sets.append("name=?")
            vals.append(_clean_name(patch["name"]))
        if "summary" in patch:
            sets.append("summary=?")
            vals.append(str(patch["summary"] or "").strip()[:MAX_SUMMARY_CHARS])
        if "kind" in patch and patch["kind"] in KINDS and node["kind"] not in ("user", "self"):
            sets.append("kind=?")
            vals.append(patch["kind"])
        if "importance" in patch:
            imp = max(1, min(5, int(patch["importance"])))
            sets += ["importance=?", "stability=MAX(stability,?)"]
            vals += [imp, stability0(imp)]
        if "pinned" in patch:
            sets.append("pinned=?")
            vals.append(1 if patch["pinned"] else 0)
        name = _clean_name(patch.get("name") or node["name"])
        al = _aliases(patch["aliases"], name) if "aliases" in patch else node["aliases"]
        sets.append("aliases=?")
        vals.append(json.dumps(al, ensure_ascii=False))
        with self._lock, self.db.transaction():
            self.db.execute(f"UPDATE mem_nodes SET {', '.join(sets)} WHERE id=? AND mate_id=?", (*vals, node["id"], mate_id))
            self.db.execute("DELETE FROM mem_node_keys WHERE node_id=?", (node["id"],))
            for k in {key(name), *[key(a) for a in al]}:
                if k:
                    self.db.execute("INSERT OR IGNORE INTO mem_node_keys VALUES(?,?,?)", (mate_id, k, node["id"]))
            self._bump(mate_id)
        return self.node(mate_id, node["id"])  # type: ignore[return-value]

    def merge(self, mate_id: str, nid: str, into: str) -> dict[str, Any]:
        """Two nodes that are one thing: facts, mentions, names move to ``into``; the other is kept as merged."""
        a, b = self.node(mate_id, nid), self.node(mate_id, into)
        if a is None or b is None or a["id"] == b["id"]:
            raise GraphError("merge needs two different nodes")
        if a["kind"] in ("user", "self"):
            raise GraphError("the user's node and her own can't be merged into another")
        with self._lock, self.db.transaction():
            self.db.execute("UPDATE mem_facts SET subject=? WHERE subject=?", (b["id"], a["id"]))
            self.db.execute("UPDATE mem_facts SET object=? WHERE object=?", (b["id"], a["id"]))
            for r in self.db.query("SELECT ref,role,label,created_at FROM mem_mentions WHERE node_id=?", (a["id"],)):
                self.db.execute("INSERT OR IGNORE INTO mem_mentions VALUES(?,?,?,?,?,?)",
                                (mate_id, b["id"], r["ref"], r["role"], r["label"], r["created_at"]))
            self.db.execute("DELETE FROM mem_mentions WHERE node_id=?", (a["id"],))
            names = _aliases([*b["aliases"], a["name"], *a["aliases"]], b["name"])
            self.db.execute("UPDATE mem_nodes SET aliases=?,summary=CASE WHEN summary='' THEN ? ELSE summary END,"
                            "importance=MAX(importance,?),stability=MAX(stability,?),access_count=access_count+?,"
                            "updated_at=? WHERE id=?",
                            (json.dumps(names, ensure_ascii=False), a["summary"], a["importance"], a["stability"],
                             a["access_count"], now_iso(), b["id"]))
            self.db.execute("UPDATE mem_node_keys SET node_id=? WHERE node_id=? AND NOT EXISTS("
                            "SELECT 1 FROM mem_node_keys x WHERE x.mate_id=mem_node_keys.mate_id AND x.key=mem_node_keys.key "
                            "AND x.node_id=?)", (b["id"], a["id"], b["id"]))
            self.db.execute("DELETE FROM mem_node_keys WHERE node_id=?", (a["id"],))
            self.db.execute("UPDATE mem_nodes SET status='merged',merged_into=?,updated_at=? WHERE id=?",
                            (b["id"], now_iso(), a["id"]))
            self._bump(mate_id)
        return self.node(mate_id, b["id"])  # type: ignore[return-value]

    def forget_node(self, mate_id: str, nid: str) -> int:
        """The user's "forget this": the node, the facts about it from pages and her notes, its links. Personal
        memories stay (they are managed as memories); they only lose the link. → facts removed"""
        node = self.node(mate_id, nid)
        if node is None:
            raise GraphError("no such node")
        if node["kind"] in ("user", "self"):
            raise GraphError("the user's node and her own stay")
        with self._lock, self.db.transaction():
            n = len(self.db.query("SELECT id FROM mem_facts WHERE mate_id=? AND (subject=? OR object=?)",
                                  (mate_id, node["id"], node["id"])))
            self.db.execute("DELETE FROM mem_facts WHERE mate_id=? AND subject=?", (mate_id, node["id"]))
            self.db.execute("DELETE FROM mem_facts WHERE mate_id=? AND object=?", (mate_id, node["id"]))
            self.db.execute("DELETE FROM mem_nodes WHERE id=? AND mate_id=?", (node["id"], mate_id))
            self._bump(mate_id)
        return n

    def drop_if_bare(self, mate_id: str, nid: str, ref: str) -> bool:
        """A node made for something that came to nothing (a study that learned nothing): gone again — unless she
        knows a fact about it, it is pinned or described, or anything besides ``ref`` refers to it. → dropped"""
        with self._lock, self.db.transaction():
            node = self.db.query_one("SELECT * FROM mem_nodes WHERE id=? AND mate_id=? AND status='active'", (nid, mate_id))
            if node is None or node["pinned"] or node["summary"] or node["kind"] in ("user", "self"):
                return False
            if self.db.query_one("SELECT 1 FROM mem_facts WHERE mate_id=? AND (subject=? OR object=?) LIMIT 1",
                                 (mate_id, nid, nid)):
                return False
            if self.db.query_one("SELECT 1 FROM mem_mentions WHERE mate_id=? AND node_id=? AND ref!=? LIMIT 1",
                                 (mate_id, nid, ref)):
                return False
            if self.db.query_one("SELECT 1 FROM mem_nodes WHERE mate_id=? AND merged_into=? LIMIT 1", (mate_id, nid)):
                return False
            for t in ("mem_mentions", "mem_node_keys"):
                self.db.execute(f"DELETE FROM {t} WHERE mate_id=? AND node_id=?", (mate_id, nid))
            self.db.execute("DELETE FROM mem_nodes WHERE id=? AND mate_id=?", (nid, mate_id))
            self._bump(mate_id)
        return True

    def wipe(self, mate_id: str) -> None:
        with self._lock, self.db.transaction():
            for t in ("mem_facts", "mem_mentions", "mem_node_keys", "mem_nodes", "mem_linked", "know_chunks", "know_docs"):
                self.db.execute(f"DELETE FROM {t} WHERE mate_id=?", (mate_id,))
            self._bump(mate_id)

    # ---- mentions (personal memories, episodes) ----
    def mention(self, mate_id: str, node_id: str, ref: str, *, role: str = "about", label: str = "") -> None:
        self.db.execute("INSERT OR IGNORE INTO mem_mentions VALUES(?,?,?,?,?,?)",
                        (mate_id, node_id, ref, role[:20], label[:80], now_iso()))

    def unmention(self, mate_id: str, ref: str) -> None:
        self.db.execute("DELETE FROM mem_mentions WHERE mate_id=? AND ref=?", (mate_id, ref))
        self.db.execute("DELETE FROM mem_linked WHERE mate_id=? AND ref=?", (mate_id, ref))
        self._bump(mate_id)

    def link_entities(self, mate_id: str, ref: str, entities: Iterable[dict[str, Any]], *, origin: str = "chat",
                      user_name: str = "", self_name: str = "", final: bool = True) -> list[str]:
        """A memory / episode → the nodes it is about (made as needed). ``{"name", "kind", "aliases", "role",
        "label"}``; kind "user" / "self" mean the user / her. ``final``: the linker has looked at it (not the quick
        link a new memory gets at once — the linker still adds what else it names)."""
        out = []
        with self._lock, self.db.transaction():
            for e in entities:
                if not isinstance(e, dict):
                    continue
                kind = str(e.get("kind") or "concept")
                if kind == "user":
                    n = self.special(mate_id, "user", user_name or "user")
                elif kind == "self":
                    n = self.special(mate_id, "self", self_name or "me")
                else:
                    try:
                        n = self.upsert(mate_id, name=str(e.get("name") or ""), kind=kind, aliases=e.get("aliases"),
                                        origin=origin, importance=int(e.get("importance") or 3))
                    except GraphError:
                        continue
                self.mention(mate_id, n["id"], ref, role=str(e.get("role") or "about"), label=str(e.get("label") or ""))
                out.append(n["id"])
            if final:
                self.db.execute("INSERT OR REPLACE INTO mem_linked VALUES(?,?,?)", (mate_id, ref, now_iso()))
        if out:
            self._bump(mate_id)
        return out

    def unlinked(self, mate_id: str, refs: list[str]) -> list[str]:
        if not refs:
            return []
        have = {r["ref"] for r in self.db.query(
            f"SELECT ref FROM mem_linked WHERE mate_id=? AND ref IN ({','.join('?' for _ in refs)})", (mate_id, *refs))}
        return [r for r in refs if r not in have]

    # ---- documents ----
    def add_doc(self, mate_id: str, *, url: str, title: str, text: str, site: str = "", origin: str = "url",
                study_id: str | None = None, published: str | None = None, chunk_chars: int = 1200) -> dict[str, Any]:
        """A page she read, cut into chunks on paragraph boundaries (the same text again: the same document)."""
        from app.mate.knowledge import digest

        text = text.strip()
        dg = digest(text)
        old = self.db.query_one("SELECT id FROM know_docs WHERE mate_id=? AND digest=?", (mate_id, dg))
        if old:
            return self.doc(mate_id, old["id"], with_text=False)  # type: ignore[return-value]
        did = new_id("d_")
        with self._lock, self.db.transaction():
            self.db.execute("INSERT INTO know_docs(id,mate_id,url,title,site,origin,study_id,digest,chars,published,"
                            "fetched_at,text) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                            (did, mate_id, url[:2000], title[:300], site[:200], origin, study_id, dg, len(text),
                             published, now_iso(), text))
            for i, (s, e) in enumerate(chunks(text, chunk_chars)):
                cid = f"{did}.c{i + 1}"
                self.db.execute("INSERT INTO know_chunks(id,doc_id,mate_id,ordinal,start,end,text) VALUES(?,?,?,?,?,?,?)",
                                (cid, did, mate_id, i + 1, s, e, text[s:e]))
                if self.fts:
                    self.db.execute("INSERT INTO know_chunks_fts(chunk_id,terms) VALUES(?,?)",
                                    (cid, terms(title + "\n" + text[s:e])))
        self._bump(mate_id)
        return self.doc(mate_id, did, with_text=False)  # type: ignore[return-value]

    def doc(self, mate_id: str, did: str, *, with_text: bool = True) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM know_docs WHERE id=? AND mate_id=?", (did, mate_id))
        if r is None:
            return None
        d = dict(r)
        if not with_text:
            d.pop("text", None)
        d["chunks"] = self.db.query_one("SELECT COUNT(*) n FROM know_chunks WHERE doc_id=?", (did,))["n"]
        d["facts"] = self.db.query_one("SELECT COUNT(*) n FROM mem_facts WHERE doc_id=? AND status='active'", (did,))["n"]
        return d

    def chunk(self, mate_id: str, cid: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT c.*,d.title,d.url FROM know_chunks c JOIN know_docs d ON d.id=c.doc_id "
                              "WHERE c.id=? AND c.mate_id=?", (cid, mate_id))
        return dict(r) if r else None

    def docs(self, mate_id: str, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT id,url,title,site,origin,study_id,chars,published,fetched_at,"
                             "(SELECT COUNT(*) FROM mem_facts f WHERE f.doc_id=know_docs.id AND f.status='active') facts "
                             "FROM know_docs WHERE mate_id=? ORDER BY fetched_at DESC LIMIT ? OFFSET ?",
                             (mate_id, limit, offset))
        return [dict(r) for r in rows]

    def forget_doc(self, mate_id: str, did: str) -> int:
        with self._lock, self.db.transaction():
            n = self.db.query_one("SELECT COUNT(*) n FROM mem_facts WHERE doc_id=?", (did,))["n"]
            self.db.execute("DELETE FROM know_docs WHERE id=? AND mate_id=?", (did, mate_id))
            self._bump(mate_id)
        return n

    # ---- facts ----
    def add_fact(self, mate_id: str, *, subject: str, predicate: str, statement: str, quote: str,
                 obj: str | None = None, chunk_id: str | None = None, source: dict[str, Any] | None = None,
                 origin: str = "document", valid_from: str | None = None, valid_until: str | None = None,
                 importance: int = 3, confidence: float = 0.8, replaces: str | None = None,
                 study_id: str | None = None) -> dict[str, Any]:
        """A fact about ``subject`` (a node id), grounded in an exact quote of a document chunk (``chunk_id``) or of a
        conversation source (``source``: the allowed evidence row of knowledge.allowed). The same statement about
        the same subject again: the existing fact, reinforced. ``replaces``: an older fact this one corrects or
        updates (kept, invalidated — the history of what she believed when)."""
        statement = re.sub(r"\s+", " ", str(statement or "")).strip()
        predicate = re.sub(r"\s+", " ", str(predicate or "")).strip()[:60] or "about"
        if not (8 <= len(statement) <= MAX_FACT_CHARS):
            raise GraphError(f"a statement is 8–{MAX_FACT_CHARS} characters")
        subj = self.node(mate_id, subject)
        if subj is None:
            raise GraphError("unknown subject node")
        target = self.node(mate_id, obj) if obj else None
        doc_id = None
        src_id, src_rev = None, None
        if chunk_id:
            ch = self.chunk(mate_id, chunk_id)
            if ch is None:
                raise GraphError(f"unknown chunk {chunk_id}")
            span = _quote_in(quote, ch["text"])
            if span is None:
                raise GraphError("the quote is not in that chunk (copy it exactly)")
            quote = ch["text"][span[0]:span[1]]
            doc_id = ch["doc_id"]
        elif source:
            span = _quote_in(quote, source.get("content") or "")
            if span is None:
                raise GraphError("the quote is not in that message")
            quote = source["content"][span[0]:span[1]]
            src_id, src_rev = source["id"], source["revision"]
        else:
            raise GraphError("a fact needs its source: a chunk_id or a conversation source")
        now = now_iso()
        imp = max(1, min(5, int(importance or 3)))
        with self._lock, self.db.transaction():
            same = self.db.query_one("SELECT * FROM mem_facts WHERE mate_id=? AND subject=? AND status='active' AND "
                                     "lower(statement)=lower(?)", (mate_id, subj["id"], statement))
            if same:
                self.touch_facts(mate_id, [same["id"]])
                return dict(same)
            fid = new_id("f_")
            self.db.execute(
                "INSERT INTO mem_facts(id,mate_id,subject,predicate,object,statement,origin,doc_id,chunk_id,source_id,"
                "source_revision,quote,valid_from,valid_until,recorded_at,confidence,importance,stability,last_access,"
                "study_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (fid, mate_id, subj["id"], predicate, target["id"] if target else None, statement, origin, doc_id,
                 chunk_id, src_id, src_rev, quote[:1500], valid_from, valid_until, now,
                 max(0.0, min(1.0, float(confidence))), imp, stability0(imp), now, study_id))
            if self.fts:
                self.db.execute("INSERT INTO mem_facts_fts(fact_id,terms) VALUES(?,?)",
                                (fid, terms(" ".join([statement, subj["name"], *subj["aliases"],
                                                      *([target["name"], *target["aliases"]] if target else [])]))))
            if replaces:
                self.db.execute("UPDATE mem_facts SET status='superseded',invalidated_at=?,superseded_by=? "
                                "WHERE id=? AND mate_id=? AND status='active'", (now, fid, replaces, mate_id))
            self.db.execute("UPDATE mem_nodes SET updated_at=? WHERE id IN (?,?)", (now, subj["id"], target["id"] if target else subj["id"]))
            self._bump(mate_id)
        return dict(self.db.query_one("SELECT * FROM mem_facts WHERE id=?", (fid,)))

    def facts_of(self, mate_id: str, nid: str, *, include_old: bool = False, limit: int = 200) -> list[dict[str, Any]]:
        st = "" if include_old else " AND f.status='active'"
        rows = self.db.query(
            "SELECT f.*,s.name subject_name,o.name object_name,d.title doc_title,d.url doc_url FROM mem_facts f "
            "JOIN mem_nodes s ON s.id=f.subject LEFT JOIN mem_nodes o ON o.id=f.object LEFT JOIN know_docs d ON d.id=f.doc_id "
            f"WHERE f.mate_id=? AND (f.subject=? OR f.object=?){st} ORDER BY f.status='active' DESC,f.recorded_at DESC LIMIT ?",
            (mate_id, nid, nid, limit))
        return [dict(r) for r in rows]

    def forget_fact(self, mate_id: str, fid: str) -> bool:
        with self._lock, self.db.transaction():
            r = self.db.query_one("SELECT id FROM mem_facts WHERE id=? AND mate_id=?", (fid, mate_id))
            if not r:
                return False
            self.db.execute("DELETE FROM mem_facts WHERE id=?", (fid,))
            self._bump(mate_id)
        return True

    # ---- using makes it stronger ----
    def touch_nodes(self, mate_id: str, ids: Iterable[str]) -> None:
        now = datetime.now(UTC)
        iso = now.isoformat()
        for nid in set(ids):
            r = self.db.query_one("SELECT * FROM mem_nodes WHERE id=? AND mate_id=?", (nid, mate_id))
            if r:
                self.db.execute("UPDATE mem_nodes SET stability=?,last_access=?,access_count=access_count+1 WHERE id=?",
                                (reinforced(dict(r), now), iso, nid))

    def touch_facts(self, mate_id: str, ids: Iterable[str]) -> None:
        now = datetime.now(UTC)
        iso = now.isoformat()
        for fid in set(ids):
            r = self.db.query_one("SELECT * FROM mem_facts WHERE id=? AND mate_id=?", (fid, mate_id))
            if r:
                self.db.execute("UPDATE mem_facts SET stability=?,last_access=?,access_count=access_count+1 WHERE id=?",
                                (reinforced(dict(r), now), iso, fid))

    # ---- what a text brings to mind ----
    def seeds(self, mate_id: str, text: str, weight: float = 1.0) -> dict[str, float]:
        """The nodes a text names (a name or an alias inside it) → weight. A longer name anywhere in the text; a short
        one only as a word of its own — Latin up to 3 letters ("poe", "ai") as a whole word, Hangul up to 2 syllables
        ("롤", "원신") as a whole word or that word with a particle ("롤 하자", "원신이") — so "롤러코스터" or "복원신청"
        name nothing."""
        out: dict[str, float] = {}
        text = text[:4000]
        norm = key(text)
        if not norm:
            return out
        low = text.lower()
        words = set(re.findall(r"[a-z0-9]+", low))
        runs = re.findall(r"[가-힣]+", low)
        hangul = set(runs) | {M._ko_stem(r) for r in runs}
        for k, nid in self._names(mate_id):
            if k.isascii() and len(k) <= 3:
                if k not in words:
                    continue
            elif "가" <= k[0] <= "힣" and len(k) <= 2:
                if k not in hangul:
                    continue
            elif len(k) < 2 or k not in norm:
                continue
            out[nid] = max(out.get(nid, 0.0), weight)
        return out

    def _hubs(self, mate_id: str) -> set[str]:
        """the user's node and hers: everything personal touches them, so activation never spreads through them"""
        return {r["id"] for r in self.db.query("SELECT id FROM mem_nodes WHERE mate_id=? AND kind IN ('user','self')",
                                               (mate_id,))}

    def neighbors(self, mate_id: str, ids: list[str]) -> dict[str, list[tuple[str, float]]]:
        """node → [(neighbor, weight)] along active facts (1.0) and shared mentions (0.6); never via the hubs"""
        hubs = self._hubs(mate_id)
        ids = [i for i in ids if i not in hubs]
        if not ids:
            return {}
        q = ",".join("?" for _ in ids)
        out: dict[str, list[tuple[str, float]]] = {i: [] for i in ids}
        for r in self.db.query(f"SELECT subject,object FROM mem_facts WHERE mate_id=? AND status='active' AND object IS NOT NULL "
                               f"AND (subject IN ({q}) OR object IN ({q}))", (mate_id, *ids, *ids)):
            if r["subject"] in out and r["object"] not in hubs:
                out[r["subject"]].append((r["object"], 1.0))
            if r["object"] in out and r["subject"] not in hubs:
                out[r["object"]].append((r["subject"], 1.0))
        for r in self.db.query(f"SELECT a.node_id a,b.node_id b FROM mem_mentions a JOIN mem_mentions b ON b.mate_id=a.mate_id "
                               f"AND b.ref=a.ref AND b.node_id!=a.node_id WHERE a.mate_id=? AND a.node_id IN ({q}) LIMIT 2000",
                               (mate_id, *ids)):
            if r["b"] not in hubs:
                out[r["a"]].append((r["b"], 0.6))
        return out

    def activate(self, mate_id: str, query: str, recent: list[str] | None = None, *, hops: int = 2,
                 now: datetime | None = None) -> dict[str, float]:
        """Spreading activation from what the user just said (and, weaker, the last turns) → node → activation.
        A node named in the message itself keeps its full activation however faded it is (a direct question always
        reaches it); one reached by spreading or from earlier turns is weighed by its own strength (retrievability)."""
        now = now or datetime.now(UTC)
        direct = self.seeds(mate_id, query, SPREAD[0])
        act = dict(direct)
        for i, t in enumerate(reversed(recent or [])):  # (the newest earlier turn counts most)
            for nid, w in self.seeds(mate_id, t, 0.5 * (0.7 ** i)).items():
                act[nid] = max(act.get(nid, 0.0), w)
        frontier = dict(act)
        for h in range(1, hops + 1):
            nb = self.neighbors(mate_id, list(frontier)[:60])
            nxt: dict[str, float] = {}
            for nid, a in frontier.items():
                fan = max(1, len(nb.get(nid, [])))
                for other, w in nb.get(nid, []):
                    # (a hub's energy is shared among its many links: the fan effect)
                    gain = a * w * (SPREAD[h] / SPREAD[h - 1]) / math.sqrt(fan) if h < len(SPREAD) else 0.0
                    if gain > act.get(other, 0.0) and gain > 0.05:
                        nxt[other] = max(nxt.get(other, 0.0), gain)
            for nid, a in nxt.items():
                act[nid] = max(act.get(nid, 0.0), a)
            frontier = nxt
            if not frontier:
                break
        if not act:
            return {}
        rows = {r["id"]: dict(r) for r in self.db.query(
            f"SELECT * FROM mem_nodes WHERE mate_id=? AND status='active' AND id IN ({','.join('?' for _ in act)})",
            (mate_id, *act))}
        out = {}
        for nid, a in act.items():
            if nid not in rows:
                continue
            out[nid] = a if nid in direct else a * (0.35 + 0.65 * retrievability(rows[nid], now))
        return out

    def fact_hits(self, mate_id: str, query: str, limit: int = 40) -> dict[str, float]:
        """Facts whose words meet the query's → 0…1. Words in common, not a stray syllable: at least two shared
        words, or one word and two shared character pairs (small talk doesn't drag knowledge in)."""
        ts = terms(query[:2000]).split()[:60]
        if not ts or not self.fts:
            return {}
        rows = self.db.query("SELECT f.id,f.statement FROM mem_facts_fts x JOIN mem_facts f ON f.id=x.fact_id WHERE f.mate_id=? "
                             "AND f.status='active' AND mem_facts_fts MATCH ? ORDER BY bm25(mem_facts_fts) LIMIT ?",
                             (mate_id, " OR ".join(ts), limit))
        qt = set(M.tokens(query[:2000]))
        out: dict[str, float] = {}
        n = len(rows)
        for i, r in enumerate(rows):
            shared = qt & set(M.tokens(r["statement"]))
            words = sum(1 for t in shared if t.startswith("w:"))
            pairs = len(shared) - words
            if words >= 2 or (words >= 1 and pairs >= 2):
                out[r["id"]] = (1.0 - i / max(1, n)) * min(1.0, 0.5 + 0.15 * words)
        return out

    def recall(self, mate_id: str, query: str, recent: list[str] | None = None, *, level: str = "normal",
               skip: set[str] | None = None, now: datetime | None = None) -> dict[str, Any]:
        """What her network brings to mind for this message: the lit nodes and the strongest facts around them
        within the level's budget → {"nodes": [...], "facts": [...], "seeds": [...]}. No model call.

        Relevance leads (what was named, the words in common); strength — how recently and how often it was used —
        decides among the relevant and fades out what was only reached indirectly: a faded fact comes back when it is
        asked about, not on its own."""
        n_max, c_max = KNOW_BUDGET.get(level, KNOW_BUDGET["normal"])
        now = now or datetime.now(UTC)
        empty = {"nodes": [], "facts": [], "seeds": []}
        if n_max <= 0 or not (query or "").strip():
            return empty
        direct = self.seeds(mate_id, query)
        act = self.activate(mate_id, query, recent, now=now)
        lexical = self.fact_hits(mate_id, query)
        if not act and not lexical:
            return empty
        top_nodes = sorted(act.items(), key=lambda x: -x[1])[:24]
        ids = [n for n, _ in top_nodes]
        cand: dict[str, dict[str, Any]] = {}
        if ids:
            q = ",".join("?" for _ in ids)
            for r in self.db.query(f"SELECT * FROM mem_facts WHERE mate_id=? AND status='active' AND "
                                   f"(subject IN ({q}) OR object IN ({q})) LIMIT 600", (mate_id, *ids, *ids)):
                cand[r["id"]] = dict(r)
        if lexical:
            q = ",".join("?" for _ in lexical)
            for r in self.db.query(f"SELECT * FROM mem_facts WHERE id IN ({q})", tuple(lexical)):
                cand[r["id"]] = dict(r)
        skip = skip or set()
        scored = []
        for fid, f in cand.items():
            if fid in skip:
                continue
            named = f["subject"] in direct or (f["object"] or "") in direct
            a = max(act.get(f["subject"], 0.0), act.get(f["object"] or "", 0.0) * 0.8)
            lex = lexical.get(fid, 0.0)
            r = retrievability(f, now)
            rel = 0.6 * a + 0.4 * lex + (0.2 if named and lex else 0.0)
            if not named and r < FADED and lex < 0.5:
                continue  # (faded, and only reached indirectly: it waits to be asked about)
            imp = (int(f["importance"]) - 1) / 4
            s = rel * (1.0 if named else 0.35 + 0.65 * r) + 0.08 * imp + 0.07 * r
            scored.append((s, f))
        scored.sort(key=lambda x: -x[0])
        out, used, per_subject = [], 0, {}
        for s, f in scored:
            if len(out) >= n_max:
                break
            if per_subject.get(f["subject"], 0) >= 3:  # (spread over what was named)
                continue
            if used + len(f["statement"]) > c_max:
                continue
            out.append({**f, "score": round(s, 3)})
            used += len(f["statement"])
            per_subject[f["subject"]] = per_subject.get(f["subject"], 0) + 1
        node_ids = list(dict.fromkeys([*[n for n in ids[:6] if act.get(n, 0) >= 0.3], *[f["subject"] for f in out]]))
        nodes = []
        if node_ids:
            q = ",".join("?" for _ in node_ids)
            rows = {r["id"]: dict(r) for r in self.db.query(f"SELECT * FROM mem_nodes WHERE id IN ({q})", tuple(node_ids))}
            for nid in node_ids:
                if nid in rows:
                    n = rows[nid]
                    n["aliases"] = json.loads(n["aliases"] or "[]")
                    n["activation"] = round(act.get(nid, 0.0), 3)
                    nodes.append(n)
        return {"nodes": nodes, "facts": out, "seeds": list(direct)}

    def expand(self, mate_id: str, query: str) -> str:
        """The query with the other names of the nodes it names (so a memory saying "Path of Exile" meets a message
        saying "엑자일")."""
        extra = []
        for nid in list(self.seeds(mate_id, query))[:8]:
            n = self.node(mate_id, nid)
            if n:
                extra += [n["name"], *n["aliases"][:4]]
        return query if not extra else query + "\n" + " ".join(extra)

    def memories_about(self, mate_id: str, node_ids: list[str]) -> set[str]:
        if not node_ids:
            return set()
        q = ",".join("?" for _ in node_ids)
        return {r["ref"][4:] for r in self.db.query(
            f"SELECT ref FROM mem_mentions WHERE mate_id=? AND ref LIKE 'mem:%' AND node_id IN ({q})", (mate_id, *node_ids))}

    # ---- search (her tools, the UI) ----
    def search(self, mate_id: str, query: str, *, limit: int = 12) -> dict[str, Any]:
        """Nodes, facts and page passages for a query: names (and part of a name) first, then words."""
        now = datetime.now(UTC)
        act = self.activate(mate_id, query, hops=1, now=now)
        # what the user types in the search box is often part of a name ("엑자일" for "패스 오브 엑자일 2")
        q = key(query)
        if len(q) >= 2:
            for k, nid in self._names(mate_id):
                if q in k:
                    act[nid] = max(act.get(nid, 0.0), 1.0 if k == q else 0.8 * len(q) / len(k) + 0.2)
        lexical = self.fact_hits(mate_id, query, limit=30)
        node_ids = [n for n, _ in sorted(act.items(), key=lambda x: -x[1])[:limit]]
        nodes = [self.node(mate_id, n) for n in node_ids]
        facts = []
        if lexical:
            q = ",".join("?" for _ in lexical)
            rows = self.db.query(
                f"SELECT f.*,s.name subject_name,o.name object_name,d.title doc_title,d.url doc_url FROM mem_facts f "
                f"JOIN mem_nodes s ON s.id=f.subject LEFT JOIN mem_nodes o ON o.id=f.object LEFT JOIN know_docs d ON d.id=f.doc_id "
                f"WHERE f.id IN ({q})", tuple(lexical))
            facts = sorted((dict(r) for r in rows), key=lambda f: -lexical[f["id"]])[:limit]
        passages = []
        ts = terms(query[:2000]).split()[:60]
        if ts and self.fts:
            for r in self.db.query("SELECT c.id,c.doc_id,c.text,d.title,d.url FROM know_chunks_fts x JOIN know_chunks c ON c.id=x.chunk_id "
                                   "JOIN know_docs d ON d.id=c.doc_id WHERE c.mate_id=? AND know_chunks_fts MATCH ? "
                                   "ORDER BY bm25(know_chunks_fts) LIMIT ?", (mate_id, " OR ".join(ts), min(limit, 8))):
                passages.append({"chunk_id": r["id"], "doc_id": r["doc_id"], "title": r["title"], "url": r["url"],
                                 "text": r["text"][:700]})
        return {"nodes": [n for n in nodes if n], "facts": facts, "passages": passages}

    def detail(self, mate_id: str, nid: str) -> dict[str, Any]:
        node = self.node(mate_id, nid)
        if node is None:
            raise GraphError("no such node")
        now = datetime.now(UTC)
        node["strength"] = round(retrievability(node, now), 3)
        facts = self.facts_of(mate_id, node["id"], include_old=True)
        for f in facts:
            f["strength"] = round(retrievability(f, now), 3)
        mentions = [dict(r) for r in self.db.query("SELECT ref,role,label FROM mem_mentions WHERE mate_id=? AND node_id=?",
                                                   (mate_id, node["id"]))]
        nb = self.neighbors(mate_id, [node["id"]]).get(node["id"], [])
        weights: dict[str, float] = {}
        for other, w in nb:
            weights[other] = weights.get(other, 0.0) + w
        near = []
        for other, w in sorted(weights.items(), key=lambda x: -x[1])[:30]:
            o = self.node(mate_id, other)
            if o:
                near.append({"id": o["id"], "name": o["name"], "kind": o["kind"], "weight": round(w, 2)})
        docs = [dict(r) for r in self.db.query(
            "SELECT DISTINCT d.id,d.title,d.url,d.fetched_at FROM mem_facts f JOIN know_docs d ON d.id=f.doc_id "
            "WHERE f.mate_id=? AND (f.subject=? OR f.object=?) ORDER BY d.fetched_at DESC LIMIT 20", (mate_id, node["id"], node["id"]))]
        return {"node": node, "facts": facts, "mentions": mentions, "neighbors": near, "docs": docs}

    # ---- the whole picture (the UI's map) ----
    def snapshot(self, mate_id: str, *, focus: str | None = None, depth: int = 2, limit: int = 400,
                 origin: str = "all", memories: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """Nodes and links for the map: the strongest ``limit`` nodes (or ``focus`` and ``depth`` hops around it),
        each with its strength now; links from facts (labelled), from personal memories (the user ↔ what they are
        about, labelled by the memory's predicate / kind) and from things mentioned together."""
        now = datetime.now(UTC)
        nodes = {r["id"]: dict(r) for r in self.db.query("SELECT * FROM mem_nodes WHERE mate_id=? AND status='active'", (mate_id,))}
        facts = [dict(r) for r in self.db.query("SELECT id,subject,object,predicate,statement,origin,importance,stability,"
                                                "last_access,recorded_at,doc_id FROM mem_facts WHERE mate_id=? AND status='active'",
                                                (mate_id,))]
        mentions = [dict(r) for r in self.db.query("SELECT node_id,ref,role,label FROM mem_mentions WHERE mate_id=?", (mate_id,))]
        mem_by_id = {m["id"]: m for m in (memories or [])}
        degree: dict[str, int] = {}
        links: dict[tuple[str, str, str], dict[str, Any]] = {}

        def add(a: str, b: str, label: str, kind: str, weight: float, ref: str = "") -> None:
            if a == b or a not in nodes or b not in nodes:
                return
            k = (min(a, b), max(a, b), kind)
            cur = links.get(k)
            if cur:
                cur["weight"] += weight
                cur["count"] += 1
                if label and label not in cur["labels"] and len(cur["labels"]) < 4:
                    cur["labels"].append(label)
                return
            links[k] = {"source": a, "target": b, "kind": kind, "labels": [label] if label else [], "weight": weight,
                        "count": 1, "ref": ref}
            degree[a] = degree.get(a, 0) + 1
            degree[b] = degree.get(b, 0) + 1

        if origin in ("all", "knowledge"):
            for f in facts:
                if f["object"]:
                    add(f["subject"], f["object"], f["predicate"], "fact", 1.0, f["id"])
                else:
                    degree[f["subject"]] = degree.get(f["subject"], 0) + 0  # (a literal fact: the node's own)
        user = next((n for n in nodes.values() if n["kind"] == "user"), None)
        if origin in ("all", "personal"):
            by_ref: dict[str, list[dict[str, Any]]] = {}
            for m in mentions:
                by_ref.setdefault(m["ref"], []).append(m)
            for ref, ms in by_ref.items():
                ids = [m["node_id"] for m in ms]
                mem = mem_by_id.get(ref[4:]) if ref.startswith("mem:") else None
                label = (ms[0]["label"] or (mem or {}).get("predicate") or (mem or {}).get("kind") or "")
                if ref.startswith("mem:") and user and user["id"] not in ids:
                    for nid in ids:
                        add(user["id"], nid, label, "memory", 1.0, ref)
                for i, a in enumerate(ids):
                    for b in ids[i + 1:]:
                        add(a, b, label if ref.startswith("mem:") else "", "memory" if ref.startswith("mem:") else "episode", 0.6, ref)
        fact_count: dict[str, int] = {}
        for f in facts:
            fact_count[f["subject"]] = fact_count.get(f["subject"], 0) + 1
            if f["object"]:
                fact_count[f["object"]] = fact_count.get(f["object"], 0) + 1
        mention_count: dict[str, int] = {}
        for m in mentions:
            mention_count[m["node_id"]] = mention_count.get(m["node_id"], 0) + 1

        def weight_of(n: dict[str, Any]) -> float:
            return ((2.0 if n["kind"] in ("user", "self") else 0.0) + retrievability(n, now) * 1.5
                    + (int(n["importance"]) - 1) / 4 + math.log1p(degree.get(n["id"], 0) + fact_count.get(n["id"], 0)
                                                                  + mention_count.get(n["id"], 0)))

        keep: set[str]
        if focus and focus in nodes:
            keep = {focus}
            frontier = {focus}
            adj: dict[str, set[str]] = {}
            for (a, b, _), _l in links.items():
                adj.setdefault(a, set()).add(b)
                adj.setdefault(b, set()).add(a)
            for _ in range(max(1, min(3, depth))):
                frontier = {o for n in frontier for o in adj.get(n, ())} - keep
                keep |= frontier
            if len(keep) > limit:
                keep = {focus} | set(sorted(keep - {focus}, key=lambda i: -weight_of(nodes[i]))[: limit - 1])
        else:
            ranked = sorted(nodes.values(), key=lambda n: -weight_of(n))
            if origin == "knowledge":
                ranked = [n for n in ranked if fact_count.get(n["id"]) or n["origin"] in ("document", "study")]
            elif origin == "personal":
                ranked = [n for n in ranked if mention_count.get(n["id"]) or n["kind"] in ("user", "self")]
            keep = {n["id"] for n in ranked[:limit]}
        out_nodes = []
        for nid in keep:
            n = nodes[nid]
            out_nodes.append({
                "id": nid, "kind": n["kind"], "name": n["name"], "summary": n["summary"][:240],
                "aliases": json.loads(n["aliases"] or "[]")[:6], "origin": n["origin"],
                "importance": n["importance"], "pinned": bool(n["pinned"]),
                "strength": round(retrievability(n, now), 3), "last_access": n["last_access"],
                "created_at": n["created_at"], "facts": fact_count.get(nid, 0), "memories": mention_count.get(nid, 0),
                "degree": degree.get(nid, 0),
            })
        out_links = [{**l, "label": " · ".join(l["labels"][:3])} for l in links.values()
                     if l["source"] in keep and l["target"] in keep]
        for l in out_links:
            l.pop("labels", None)
        return {"nodes": out_nodes, "links": out_links,
                "stats": {"nodes": len(nodes), "facts": len(facts), "memories_linked": len({m["ref"] for m in mentions}),
                          "docs": self.db.query_one("SELECT COUNT(*) n FROM know_docs WHERE mate_id=?", (mate_id,))["n"],
                          "shown": len(out_nodes)}}

    def stats(self, mate_id: str) -> dict[str, int]:
        one = lambda sql: self.db.query_one(sql, (mate_id,))["n"]
        return {"nodes": one("SELECT COUNT(*) n FROM mem_nodes WHERE mate_id=? AND status='active'"),
                "facts": one("SELECT COUNT(*) n FROM mem_facts WHERE mate_id=? AND status='active'"),
                "docs": one("SELECT COUNT(*) n FROM know_docs WHERE mate_id=?"),
                "linked": one("SELECT COUNT(*) n FROM mem_linked WHERE mate_id=?")}


def chunks(text: str, size: int = 1200) -> list[tuple[int, int]]:
    """Spans of about ``size`` characters, cut at a blank line, else a line end, else a sentence end."""
    out, i, n = [], 0, len(text)
    while i < n:
        if n - i <= size * 1.3:
            out.append((i, n))
            break
        window = text[i:i + size]
        cut = -1
        for sep in ("\n\n", "\n", ". ", "다. ", "。", " "):
            j = window.rfind(sep, int(size * 0.5))
            if j > 0:
                cut = j + len(sep)
                break
        if cut <= 0:
            cut = size
        out.append((i, i + cut))
        i += cut
        while i < n and text[i] in " \n":
            i += 1
    return [(s, e) for s, e in out if text[s:e].strip()]


def context_lines(found: dict[str, Any]) -> str:
    """The <knowledge> block of a turn's context (empty when nothing came to mind)."""
    if not found.get("facts") and not found.get("nodes"):
        return ""
    by_subject: dict[str, list[dict[str, Any]]] = {}
    for f in found["facts"]:
        by_subject.setdefault(f["subject"], []).append(f)
    lines = []
    for n in found["nodes"]:
        if n["kind"] in ("user", "self") and not by_subject.get(n["id"]):
            continue
        head = f"• {n['name']} ({n['kind']})"
        if n.get("aliases"):
            head += f" aka {', '.join(n['aliases'][:3])}"
        if n.get("summary"):
            head += f": {n['summary'][:200]}"
        lines.append(head + f" [{n['id']}]")
        for f in by_subject.get(n["id"], []):
            src = f" (from a page, learned {str(f['recorded_at'])[:10]})" if f.get("doc_id") else ""
            when = f" [valid {f['valid_from']}]" if f.get("valid_from") else ""
            lines.append(f"  - {f['statement']}{when}{src} [{f['id']}]")
    if not lines:
        return ""
    return ("<knowledge note=\"what your memory network brings to mind for this message — your own knowledge, "
            "strongest first; page facts may be outdated, open details with memory tools when it matters\">\n"
            + "\n".join(lines) + "\n</knowledge>")
