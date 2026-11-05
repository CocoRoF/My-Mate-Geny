"""Memory ranking (app/mate/memory.py): Korean + English tokens, BM25 recall with importance / recency / plan
dates, budgets, the core, dedup similarity, the migration's kind guess, housekeeping rules."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.mate import memory as M

NOW = datetime(2026, 11, 2, 10, 0, tzinfo=timezone.utc)
LOCAL = datetime(2026, 11, 2, 19, 0)  # (Asia/Seoul)


def mem(i, text, kind="fact", importance=3, **kw):
    return {"id": f"mem_{i}", "text": text, "kind": kind, "importance": importance, "status": "active",
            "pinned": False, "created_at": (NOW - timedelta(days=kw.pop("age", 10))).isoformat(),
            "updated_at": None, "use_count": 0, **kw}


def ids(rows):
    return [m["id"] for m in rows]


def test_tokens_korean_stems_bigrams_and_english():
    t = M.tokens("현석이는 치과예약을 화요일에 했어요")
    assert "w:치과예약" in t and "b:치과" in t and "w:화요일" in t and "w:현석이" in t
    assert "w:report" in M.tokens("Reports are due") and "w:the" not in M.tokens("the report")
    assert M.tokens("Running tests") == ["w:runn", "w:test"]  # (crude stemming, both sides alike)
    assert set(M.tokens("치과 예약")) & set(M.tokens("치과예약"))  # spaced and unspaced still meet


def test_recall_is_relevant_and_bounded():
    rows = [mem(1, "치과 예약은 화요일 오후 3시", "plan", due_at="2026-11-20T15:00"),
            mem(2, "Likes reports as three bullet points", "preference", 4),
            mem(3, "고양이 이름은 나비", "fact"),
            mem(4, "프로젝트 hr-harnessor는 FastAPI 백엔드", "fact")]
    got = M.recall(rows, "치과 언제였지?", now_utc=NOW, now_local=LOCAL)
    assert ids(got) == ["mem_1"]
    assert ids(M.recall(rows, "how should the weekly report look?", now_utc=NOW, now_local=LOCAL)) == ["mem_2"]
    assert M.recall(rows, "오늘 날씨 어때", now_utc=NOW, now_local=LOCAL) == []  # nothing matches: nothing recalled
    assert M.recall(rows, "치과", now_utc=NOW, now_local=LOCAL, level="off") == []
    assert M.recall(rows, "치과", now_utc=NOW, now_local=LOCAL, skip={"mem_1"}) == []  # already in its context


def test_budget_levels_and_ranking_by_importance():
    rows = [mem(i, f"coffee note number {i}", importance=1 + i % 5) for i in range(20)]
    light = M.recall(rows, "coffee", now_utc=NOW, now_local=LOCAL, level="light")
    normal = M.recall(rows, "coffee", now_utc=NOW, now_local=LOCAL)
    rich = M.recall(rows, "coffee", now_utc=NOW, now_local=LOCAL, level="rich")
    assert (len(light), len(normal), len(rich)) == (4, 8, 14)
    assert all(m["importance"] == 5 for m in light)  # same relevance: the important ones first
    big = [mem(i, "coffee " + "x" * 500) for i in range(5)]
    assert len(M.recall(big, "coffee", now_utc=NOW, now_local=LOCAL)) == 2  # 1200 characters


def test_plans_due_soon_come_without_a_match():
    rows = [mem(1, "Dentist", "plan", due_at="2026-11-03"), mem(2, "Trip to Busan", "plan", due_at="2026-12-20"),
            mem(3, "Call mom", "plan", due_at="2026-11-02T21:00")]
    got = M.recall(rows, "hello!", now_utc=NOW, now_local=LOCAL)
    assert set(ids(got)) == {"mem_1", "mem_3"}  # within 48 h; next month's isn't offered unasked
    assert M.recall(rows, "hello!", now_utc=NOW, now_local=LOCAL, due_soon=False) == []


def test_core_small_sets_are_all_core_big_sets_pinned_and_profile():
    small = [mem(i, f"fact {i}") for i in range(10)]
    assert ids(M.core(small)) == ids(small)
    big = [mem(i, f"some fact number {i}") for i in range(40)]
    big += [mem(100, "Name is 현석", "profile"), mem(101, "Hates small talk", "preference", 4),
            mem(102, "Likes tea", "preference", 3), {**mem(103, "Pinned thing"), "pinned": True}]
    core = ids(M.core(big))
    assert core[0] == "mem_103" and "mem_100" in core and "mem_101" in core and "mem_102" not in core
    assert len(core) == 3


def test_similarity_and_merge_thresholds():
    assert M.similarity("Likes tea", "likes tea!") == 1.0
    assert M.similarity("현석은 아메리카노를 좋아해", "현석은 아메리카노 좋아함") >= M.SIMILAR_AT
    assert M.similarity("Likes tea", "Works at a bank") < M.SIMILAR_AT
    rows = [mem(1, "Likes tea", "preference"), mem(2, "Likes tea", "fact")]
    assert ids([m for _s, m in M.similar("likes TEA", "preference", rows)]) == ["mem_1"]  # same kind only


def test_guess_kind_and_dates():
    assert M.guess_kind("사용자 이름은 현석") == "profile" and M.guess_kind("Call me Alex") == "profile"
    assert M.guess_kind("보고서는 짧게 받는 걸 좋아함") == "preference" and M.guess_kind("Prefers tea") == "preference"
    assert M.guess_kind("The repo uses FastAPI") == "fact"
    assert M.parse_due("2026-11-03") == "2026-11-03" and M.parse_due("2026-11-03 15:30") == "2026-11-03T15:30"
    assert M.parse_due("") is None
    for bad in ("tomorrow", "2026-13-01", "2026-02-30"):
        try:
            M.parse_due(bad)
        except ValueError:
            continue
        raise AssertionError(bad)


def test_housekeeping_rules():
    old_ctx = mem(1, "busy week", "context", expires_at=(NOW - timedelta(days=1)).isoformat())
    live_ctx = mem(2, "busy week", "context", expires_at=(NOW + timedelta(days=1)).isoformat())
    important_ctx = mem(3, "moving house", "context", 4, expires_at=(NOW - timedelta(days=1)).isoformat())
    past_plan = mem(4, "dentist", "plan", due_at="2026-10-20")
    recent_plan = mem(5, "dentist", "plan", due_at="2026-10-30")
    pinned = {**old_ctx, "id": "mem_6", "pinned": True}
    got = {m["id"]: M.expired(m, NOW, LOCAL) for m in (old_ctx, live_ctx, important_ctx, past_plan, recent_plan, pinned)}
    assert got == {"mem_1": "archived", "mem_2": None, "mem_3": None, "mem_4": None, "mem_5": None, "mem_6": None}


def test_line_shows_kind_and_due():
    assert M.line(mem(1, "Dentist", "plan", due_at="2026-11-03T15:00")) == "[mem_1] (plan, due 2026-11-03 15:00) Dentist"
    assert M.line(mem(2, "Likes tea", "preference")) == "[mem_2] (preference) Likes tea"
