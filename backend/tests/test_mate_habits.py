"""What the user often does and talks about becomes something she remembers (app/mate/consolidation.py ``habit``): the
games, sites and apps she keeps seeing on their shared screen (her own replies say what she saw), the topics they keep coming
back to. A turn that carried their screen is marked as such for the extractor (never the picture); a one-off glimpse stays a
glimpse; a sighting of a habit she knows adds to it instead of a copy, and one seen often is always on her mind."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.mate import memory as M
from app.mate.consolidation import SCREEN_NOTE, Consolidator
from app.services._ids import new_id, now_iso
from tests.test_mate_knowledge import setup


def _say(mates, db, sid, role, text, *, days_ago=0, screen=False):
    """A message of the conversation, ``days_ago`` days back; ``screen``: it carried a picture of their screen."""
    mid = mates._svc._add_message(sid, role, text)
    at = (datetime.now(UTC) - timedelta(days=days_ago)).isoformat()
    db.execute("UPDATE messages SET created_at=? WHERE id=?", (at, mid))
    db.execute("UPDATE memory_sources SET observed_at=? WHERE message_id=?", (at, mid))
    if screen:
        db.execute("INSERT INTO attachments (id, session_id, message_id, name, mime, size, kind, origin, path, created_at) "
                   "VALUES (?, ?, ?, 'screen.png', 'image/png', 10, 'image', 'screen', '/nowhere/screen.png', ?)",
                   (new_id("att_"), sid, mid, now_iso()))
    return "msg:" + mid


def _seen_before(mates, db, sid, *, days_ago, filler=20):
    """A shared screen and what she saw of it ``days_ago`` days back, then enough talk to push it out of the window."""
    u = _say(mates, db, sid, "user", "이거 봐", days_ago=days_ago, screen=True)
    a = _say(mates, db, sid, "assistant", "[smile] 오, 리그 오브 레전드 하시는구나요. 미드 아리네요?", days_ago=days_ago)
    for i in range(filler // 2):
        _say(mates, db, sid, "user", f"ㅇㅇ {i}", days_ago=days_ago)
        _say(mates, db, sid, "assistant", "네.", days_ago=days_ago)
    db.execute("UPDATE memory_jobs SET state='done'")  # (that day is long consolidated)
    return u, a


def _habit(text, *quotes, existing=None, kind="preference"):
    return {"facts": [], "habits": [{"text": text, "kind": kind, **({"existing_id": existing} if existing else {}),
                                     "evidence": [{"source_id": s, "quote": q} for s, q in quotes]}]}, {}


async def test_a_shared_screen_is_marked_her_reply_is_with_it_and_what_she_saw_before_is_offered(db):
    store, mates, mid, sid = setup(db)
    _, a1 = _seen_before(mates, db, sid, days_ago=3)
    u2 = _say(mates, db, sid, "user", "또 한판 하는 중", screen=True)
    a2 = _say(mates, db, sid, "assistant", "[laugh] 또 롤이에요? 오늘도 아리네요.")
    worker, seen = Consolidator(mates), []

    async def extract(mate, source):
        seen.append(source)
        return _habit("리그 오브 레전드(롤)를 자주 한다", (a1, "리그 오브 레전드 하시는구나요"), (a2, "또 롤이에요?"))

    assert await worker.once(extract)
    by_id = {x["id"]: x for x in seen[0]["context"]}
    assert by_id[u2]["screen"] and by_id[a2]["saw_screen"] and by_id[a2]["reply_to"] == u2  # (her reply came after it)
    assert by_id[a1]["earlier"] and by_id[a1]["saw_screen"] and a2 in seen[0]["fresh"]
    doc = worker.request(seen[0])
    msgs = {m["source_id"]: m for m in doc["messages"]}
    assert msgs[u2]["note"] == SCREEN_NOTE and "note" not in msgs[a2] and msgs[a2]["saw_screen"] is True
    assert msgs[a1]["earlier"] is True and msgs[a1]["day"] != msgs[a2]["day"]
    assert all(set(m) <= {"source_id", "revision", "role", "observed_at", "day", "text", "note", "saw_screen", "earlier"}
               for m in doc["messages"])  # (text only: never the picture)
    [mem] = store.memories(mid)
    assert mem["text"] == "리그 오브 레전드(롤)를 자주 한다" and mem["predicate"] == "habit" and mem["kind"] == "preference"
    assert mem["evidence_type"] == "extracted" and mem["importance"] == 3 and ", habit)" in M.line(mem)
    evidence = store.knowledge.memory_details(mid, mem["id"])["evidence"]
    assert {e["source_id"] for e in evidence} == {a1, a2} and {e["relation"] for e in evidence} == {"observed"}
    assert store.knowledge.stats(mid)["jobs"] == {"done": 12}
    got = mates.preview_context(mid, "롤 한판 할까")
    assert mem["id"] in {m["id"] for m in got["core"] + got["recalled"]}


def _looked(db, sid, days_ago=0):
    """She looked at their screen herself (see_screen keeps the picture as the conversation's own, ``artifact:``)."""
    at = (datetime.now(UTC) - timedelta(days=days_ago)).isoformat()
    db.execute("INSERT INTO attachments (id, session_id, message_id, name, mime, size, kind, origin, path, created_at) "
               "VALUES (?, ?, ?, 'capture.png', 'image/png', 10, 'image', 'screen', '/nowhere/capture.png', ?)",
               (new_id("att_"), sid, "artifact:capture:" + new_id("cap_"), at))


async def test_a_look_of_her_own_at_their_screen_is_what_she_saw_too(db):
    store, mates, mid, sid = setup(db)
    _say(mates, db, sid, "user", "뭐 하는지 맞혀 봐", days_ago=2)
    _looked(db, sid, days_ago=2)
    before = _say(mates, db, sid, "assistant", "[smile] 유튜브에서 게임 방송 보고 계시네요.", days_ago=2)
    for i in range(10):
        _say(mates, db, sid, "user", f"ㅇㅇ {i}", days_ago=2)
        _say(mates, db, sid, "assistant", "네.", days_ago=2)
    db.execute("UPDATE memory_jobs SET state='done'")
    u = _say(mates, db, sid, "user", "지금은?")
    _looked(db, sid)
    now = _say(mates, db, sid, "assistant", "[laugh] 오늘도 유튜브 게임 방송이네요.")
    seen = []

    async def extract(mate, source):
        seen.append(source)
        return _habit("유튜브로 게임 방송을 자주 본다", (before, "유튜브에서 게임 방송"), (now, "유튜브 게임 방송이네요"))

    assert await Consolidator(mates).once(extract)
    by_id = {x["id"]: x for x in seen[0]["context"]}
    assert by_id[now]["saw_screen"] and by_id[now]["reply_to"] == u and not by_id[u]["screen"]  # (their message had none)
    assert by_id[before]["earlier"] and by_id[before]["saw_screen"]
    assert [m["text"] for m in store.memories(mid) if m["predicate"] == "habit"] == ["유튜브로 게임 방송을 자주 본다"]


async def test_a_one_off_glimpse_is_no_habit_and_the_rest_of_the_batch_stands(db):
    store, mates, mid, sid = setup(db)
    _say(mates, db, sid, "user", "ㅋㅋ 이거", screen=True)
    a = _say(mates, db, sid, "assistant", "[smile] 유튜브에서 게임 방송 보시네요.")
    likes = _say(mates, db, sid, "user", "나는 매운 음식 좋아해")
    plain = _say(mates, db, sid, "assistant", "저도 유튜브 자주 봐요.", days_ago=2)  # (no screen before it)

    async def extract(mate, source):
        doc, usage = _habit("유튜브로 게임 방송을 자주 본다", (a, "유튜브에서 게임 방송 보시네요"))
        doc["habits"].append(_habit("유튜브를 자주 본다", (a, "유튜브에서 게임 방송 보시네요"), (plain, "유튜브 자주 봐요"))[0]["habits"][0])
        doc["facts"] = [{"kind": "preference", "evidence": [{"source_id": likes, "quote": "나는 매운 음식 좋아해"}]}]
        return doc, usage

    assert await Consolidator(mates).once(extract)
    assert [m["text"] for m in store.memories(mid)] == ["나는 매운 음식 좋아해"]  # (one day; her own words without a screen)
    assert store.knowledge.stats(mid)["jobs"] == {"done": 2}


async def test_seeing_it_again_adds_to_what_she_knows_and_often_seen_she_always_knows_it(db):
    store, mates, mid, sid = setup(db)
    for i in range(30):  # (enough memories that not all of them are always in her mind)
        store.add_memory(mid, f"기억해 둔 일 {i}번: 화분에 물 주기", kind="fact")
    _, a1 = _seen_before(mates, db, sid, days_ago=6, filler=0)
    _, a2 = _seen_before(mates, db, sid, days_ago=5, filler=0)
    worker = Consolidator(mates)
    db.execute("UPDATE memory_jobs SET state='pending' WHERE source_id IN (SELECT id FROM memory_sources WHERE role='user')")

    async def first(mate, source):
        return _habit("리그 오브 레전드를 자주 한다", (a1, "리그 오브 레전드 하시는구나요"), (a2, "미드 아리네요?"))

    assert await worker.once(first)
    habit = next(m for m in store.memories(mid) if m["predicate"] == "habit")
    assert habit not in M.core(store.memories(mid))
    for days_ago in (3, 0):
        u = _say(mates, db, sid, "user", "오늘도 한판", days_ago=days_ago, screen=True)
        a = _say(mates, db, sid, "assistant", "[laugh] 또 롤이네요, 오늘은 정글이에요?", days_ago=days_ago)
        seen = []

        async def again(mate, source, a=a, seen=seen):
            seen.append(source)
            return _habit("리그 오브 레전드(롤)를 자주 한다, 요즘은 정글도", (a, "또 롤이네요"), existing=habit["id"])

        assert await worker.once(again)
        offered = {k["id"]: k for k in worker.request(seen[0])["known_memories"]}
        assert offered[habit["id"]]["habit"] is True  # (offered whatever the words of the batch: so it is confirmed, not copied)
        assert u in seen[0]["batch_ids"]
    habits = [m for m in store.memories(mid) if m["predicate"] == "habit"]
    assert [m["id"] for m in habits] == [habit["id"]] and habits[0]["text"] == "리그 오브 레전드(롤)를 자주 한다, 요즘은 정글도"
    evidence = store.knowledge.memory_details(mid, habit["id"])["evidence"]
    assert len({e["source_id"] for e in evidence}) == 4  # (every sighting, kept with it across its words)
    assert habits[0]["importance"] == 4 and habits[0] in M.core(store.memories(mid))  # (seen on four days)


async def test_a_topic_they_keep_coming_back_to_on_other_days(db):
    store, mates, mid, sid = setup(db)
    old = _say(mates, db, sid, "user", "회사 일 때문에 오늘도 늦게 끝났어", days_ago=2)
    for i in range(10):
        _say(mates, db, sid, "assistant", "고생했어요.", days_ago=2)
        _say(mates, db, sid, "user", f"ㅇㅇ {i}", days_ago=2)
    db.execute("UPDATE memory_jobs SET state='done'")
    new = _say(mates, db, sid, "user", "오늘도 회사 회의가 길었어")
    seen = []

    async def extract(mate, source):
        seen.append(source)
        return _habit("회사 일 얘기를 자주 한다", (old, "회사 일 때문에"), (new, "회사 회의가 길었어"), kind="fact")

    assert await Consolidator(mates).once(extract)
    assert {x["id"]: x for x in seen[0]["context"]}[old].get("earlier")  # (found among what came before the window)
    [mem] = [m for m in store.memories(mid) if m["predicate"] == "habit"]
    assert mem["text"] == "회사 일 얘기를 자주 한다" and mem["kind"] == "fact"
