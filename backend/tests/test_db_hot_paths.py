"""The database's hot paths (2026-11-21 review): a commit is no fsync (WAL + synchronous=NORMAL), a message's search-index
row is found by its rowid — never a scan of the whole index, as each written message and each one of a deleted chat
did — an old database's index is carried over once, and every chat's tasks come newest first without a sort."""

import time

from app.db import Database
from app.mate import knowledge as K
from tests.test_mate_knowledge import setup


def test_the_connection_is_set_for_a_busy_database(db):
    assert db.query_one("PRAGMA journal_mode")[0] == "wal"
    assert db.query_one("PRAGMA synchronous")[0] == 1  # NORMAL
    assert db.query_one("PRAGMA cache_size")[0] == -65536
    names = {r["name"] for r in db.query("SELECT name FROM sqlite_master WHERE type='index'")}
    assert "idx_events_session" not in names and "idx_bg_tasks_started" in names
    plan = " ".join(str(tuple(r)) for r in db.query("EXPLAIN QUERY PLAN SELECT * FROM bg_tasks ORDER BY started_at DESC LIMIT 300"))
    assert "idx_bg_tasks_started" in plan and "TEMP B-TREE" not in plan


def test_a_message_s_search_row_is_its_source_s_rowid_and_goes_with_it(db):
    store, mates, mid, sid = setup(db)
    a = mates._svc._add_message(sid, "user", "디맥 같이 할 사람 구해요")
    b = mates._svc._add_message(sid, "user", "오늘은 야근이라 늦어")
    rows = {r["source_id"]: r["rowid"] for r in db.query("SELECT rowid, source_id FROM memory_fts")}
    src = {r["id"]: r["rowid"] for r in db.query("SELECT rowid, id FROM memory_sources")}
    assert rows == {k: src[k] for k in ("msg:" + a, "msg:" + b)}
    plan = " ".join(str(tuple(r)) for r in db.query("EXPLAIN QUERY PLAN SELECT * FROM memory_fts WHERE rowid=1"))
    assert "SCAN" not in plan or "INDEX 0:=" in plan  # (a rowid lookup, not a scan)
    # an edit replaces its row (same rowid), a source that isn't evidence any more leaves the index
    db.execute("UPDATE messages SET content=? WHERE id=?", ("디맥 같이 할 사람 구해요 오늘 밤", a))
    K._record_message(db, a)
    assert db.query_one("SELECT rowid FROM memory_fts WHERE source_id=?", ("msg:" + a,))["rowid"] == src["msg:" + a]
    assert db.query_one("SELECT COUNT(*) FROM memory_fts")[0] == 2
    # the chat deleted: its rows go by the trigger, found by rowid
    db.execute("DELETE FROM memory_sources WHERE session_id=?", (sid,))
    assert db.query_one("SELECT COUNT(*) FROM memory_fts")[0] == 0


def test_an_old_database_s_index_is_carried_over_once(tmp_path):
    path = tmp_path / "old.db"
    d = Database(path)
    d.bootstrap()
    store, mates, mid, sid = setup(d)
    a = mates._svc._add_message(sid, "user", "포켓몬 카드 모으는 중이야")
    # as it was: rows with rowids of their own, the trigger deleting by source_id (a scan)
    d.execute("DROP TRIGGER memory_source_deleted")
    terms = d.query_one("SELECT terms FROM memory_fts")["terms"]
    d.execute("DELETE FROM memory_fts")
    d.execute("INSERT INTO memory_fts(rowid, source_id, terms) VALUES(9999, ?, ?)", ("msg:" + a, terms))
    d.execute("CREATE TRIGGER memory_source_deleted AFTER DELETE ON memory_sources BEGIN "
              "DELETE FROM memory_fts WHERE source_id=old.id; END")
    d.close()
    d = Database(path)
    t = time.perf_counter()
    d.bootstrap()
    assert time.perf_counter() - t < 5
    src = d.query_one("SELECT rowid FROM memory_sources WHERE id=?", ("msg:" + a,))["rowid"]
    assert [tuple(r) for r in d.query("SELECT rowid, source_id, terms FROM memory_fts")] == [(src, "msg:" + a, terms)]
    assert "rowid=old.rowid" in d.query_one("SELECT sql FROM sqlite_master WHERE name='memory_source_deleted'")["sql"]
    d.close()
