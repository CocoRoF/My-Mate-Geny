"""One record per thing (docs/mate-memory-graph.md): a memory is one plain sentence filed under the one thing it is about
(the user, her, the two of them, a person, a game …), resting on exact quotes; the same thing's same item is one record,
updated — never a pile of cards titled by their kind; ties between things are lines of her network; a pronoun or a general
word is no one; her own name is her. And what she kept before is put in order once (app/mate/memory_org.py)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import memory as M
from app.mate.consolidation import Consolidator
from app.mate.memory_org import Organizer, org_state
from tests.test_mate_knowledge import setup


def named(store, mid, user="하렴", her="한채린"):
    store.update(mid, {"name": her, "prefs": {"user_name": user}})


def ev(msg_id, quote):
    return {"source_id": "msg:" + msg_id, "revision": 1, "quote": quote}


async def test_a_memory_is_a_sentence_under_the_thing_it_is_about_with_its_quotes_and_a_line_to_who_they_are(db):
    store, mates, mid, sid = setup(db)
    named(store, mid)
    a = mates._svc._add_message(sid, "user", "오늘은 범수프로님 만났어")
    mates._svc._add_message(sid, "assistant", "누구야?")
    b = mates._svc._add_message(sid, "user", "그냥 같이 이런저런 얘기했어 직장 동료야.")

    async def extract(mate, source):
        # (what it is given: the user, the two of them and her, each with what she keeps about them)
        kinds = {e["kind"] for e in source["entities"]}
        assert {"user", "us", "self"} <= kinds
        assert source["user_name"] == "하렴" and source["her_name"] == "한채린"
        return {"memories": [{
            "op": "add", "entity": {"name": "범수프로", "kind": "person", "aliases": ["범수프로님"]}, "kind": "fact",
            "attribute": "관계", "text": "범수프로님은 하렴의 직장 동료다.",
            "evidence": [ev(a, "오늘은 범수프로님 만났어"), ev(b, "직장 동료야.")]}],
            "relations": [{"from": {"kind": "user"}, "to": {"name": "범수프로", "kind": "person"}, "relation": "직장 동료",
                           "text": "범수프로님은 하렴의 직장 동료다.", "evidence": [ev(b, "직장 동료야.")]}]}, {}

    assert await Consolidator(mates).once(extract)
    [m] = store.memories(mid)
    assert m["text"] == "범수프로님은 하렴의 직장 동료다."  # (her sentence, not their words strung together)
    assert m["entity"]["name"] == "범수프로" and m["entity"]["kind"] == "person" and m["predicate"] == "관계"
    evidence = store.knowledge.memory_details(mid, m["id"])["evidence"]
    assert {e["quote"] for e in evidence} == {"오늘은 범수프로님 만났어", "직장 동료야."}
    # in her network: the memory under 범수프로, and a line between the user and them
    g = store.graph
    node = g.node(mid, m["entity"]["id"])
    assert any(f["predicate"] == "직장 동료" for f in g.facts_of(mid, node["id"]))
    snap = g.snapshot(mid)
    assert any({e["source"], e["target"]} == {node["id"], g.special(mid, "user", "하렴")["id"]} for e in snap["links"])
    assert "«범수프로 · 관계»" in M.line(m)


async def test_the_same_things_same_item_is_one_record_updated_never_a_second_card(db):
    store, mates, mid, sid = setup(db)
    named(store, mid)
    worker = Consolidator(mates)
    a = mates._svc._add_message(sid, "user", "나 요즘 패스 오브 엑자일 자주 해")

    async def first(mate, source):
        return {"memories": [{"op": "add", "entity": {"kind": "user"}, "kind": "preference", "attribute": "즐기는 게임",
                              "text": "하렴은 Path of Exile을 자주 한다.", "evidence": [ev(a, "패스 오브 엑자일 자주 해")]}]}, {}

    await worker.once(first)
    [m] = store.memories(mid)
    b = mates._svc._add_message(sid, "user", "디맥도 가끔 해")

    async def again(mate, source):
        # (offered under the user with its item: the model should update it — even when it adds, the store merges)
        user = next(e for e in Consolidator(mates).request(source)["entities"] if e["kind"] == "user")
        assert any(x["id"] == m["id"] and x["attribute"] == "즐기는 게임" for x in user["memories"])
        return {"memories": [{"op": "add", "entity": {"kind": "user"}, "kind": "preference", "attribute": "즐기는 게임",
                              "text": "하렴은 Path of Exile을 자주 하고 DJMAX도 가끔 한다.", "evidence": [ev(b, "디맥도 가끔 해")]}]}, {}

    await worker.once(again)
    [m2] = store.memories(mid)
    assert m2["id"] == m["id"] and m2["text"] == "하렴은 Path of Exile을 자주 하고 DJMAX도 가끔 한다."
    assert m2["revision"] > m["revision"]
    # (the old words kept: a version to go back to)
    assert any(v["snapshot"]["text"] == "하렴은 Path of Exile을 자주 한다." for v in store.knowledge.history(mid, m["id"]))
    c = mates._svc._add_message(sid, "user", "아 이제 엑자일은 접었어")

    async def correction(mate, source):
        return {"memories": [{"op": "update", "id": m["id"], "entity": {"kind": "user"}, "kind": "preference",
                              "attribute": "즐기는 게임", "text": "하렴은 Path of Exile을 접고 DJMAX를 가끔 한다.",
                              "evidence": [ev(c, "이제 엑자일은 접었어")]}]}, {}

    await worker.once(correction)
    [m3] = store.memories(mid)
    assert m3["id"] == m["id"] and "접고" in m3["text"]


async def test_her_name_is_her_a_pronoun_is_no_one_and_the_two_of_them_are_us(db):
    store, mates, mid, sid = setup(db)
    named(store, mid)
    a = mates._svc._add_message(sid, "user", "채린아 우리 이제 서로 자기야라고 부르자")
    b = mates._svc._add_message(sid, "user", "걔는 그냥 아는 사람이야")

    async def extract(mate, source):
        return {"memories": [
            {"op": "add", "entity": {"kind": "us"}, "kind": "preference", "attribute": "호칭",
             "text": "우리는 서로를 자기야라고 부르기로 했다.", "evidence": [ev(a, "우리 이제 서로 자기야라고 부르자")]},
            {"op": "add", "entity": {"name": "걔", "kind": "person"}, "kind": "fact", "attribute": "아는 사람",
             "text": "하렴에게는 그냥 아는 사람이 있다.", "evidence": [ev(b, "걔는 그냥 아는 사람이야")]},
        ]}, {}

    await Consolidator(mates).once(extract)
    by = {m["predicate"]: m for m in store.memories(mid)}
    assert by["호칭"]["entity"]["kind"] == "us"
    assert by["아는 사람"]["entity"]["kind"] == "user"  # ("걔" is no one: filed under the user)
    assert store.graph.find(mid, "걔") is None
    # her own name, as the linker or anyone names it, is her — never a person beside her
    g = store.graph
    g.link_entities(mid, "mem:x", [{"name": "채린", "kind": "person"}, {"name": "다른 여자", "kind": "person"}],
                    user_name="하렴", self_name="한채린")
    assert g.find(mid, "채린") is None or g.find(mid, "채린")["kind"] == "self"
    assert g.find(mid, "다른 여자") is None


async def test_an_item_that_doesnt_hold_up_is_left_out_and_the_rest_stands(db):
    store, mates, mid, sid = setup(db)
    a = mates._svc._add_message(sid, "user", "우리 집 고양이 이름은 나비야")

    async def extract(mate, source):
        return {"memories": [
            {"op": "add", "entity": {"name": "나비", "kind": "thing"}, "kind": "profile", "attribute": "반려동물",
             "text": "하렴의 고양이 이름은 나비다.", "evidence": [ev(a, "고양이 이름은 나비야")]},
            {"op": "add", "entity": {"kind": "user"}, "kind": "fact", "attribute": "직업", "text": "하렴은 의사다.",
             "evidence": [ev(a, "나는 의사야")]},  # (not in the message: never saved)
            {"op": "add", "entity": {"kind": "user"}, "kind": "fact", "text": "", "evidence": [ev(a, "나비야")]},
        ]}, {}

    await Consolidator(mates).once(extract)
    [m] = store.memories(mid)
    assert m["text"] == "하렴의 고양이 이름은 나비다." and store.knowledge.stats(mid)["jobs"] == {"done": 1}


async def test_what_she_kept_before_is_put_in_order_once_and_again_when_asked(db):
    store, mates, mid, sid = setup(db)
    named(store, mid)
    g = store.graph
    a = mates._svc._add_message(sid, "user", "너 크롭탑 이뻐")
    b = mates._svc._add_message(sid, "user", "디맥 같이 할 사람 있어 지수 형이랑")
    c = mates._svc._add_message(sid, "user", "이것도 그냥 싸움 상황을 시뮬레이션 하려고 한 거야")
    d = mates._svc._add_message(sid, "user", "나 디맥 좋아해")
    raw = []
    for msg, quote, kind in ((a, "너 크롭탑 이뻐", "preference"), (b, "디맥 같이 할 사람 있어 지수 형이랑", "fact"),
                             (c, "이것도 그냥 싸움 상황을 시뮬레이션 하려고 한 거야", "context"), (d, "나 디맥 좋아해", "preference")):
        m = store.add_memory(mid, quote, kind=kind, source="mate")
        store.knowledge.attach(mid, m["id"], "msg:" + msg, quote)
        raw.append(m)
    mine = store.add_memory(mid, "생일은 3월 5일", kind="profile", by_user=True)
    # the network as it was: her own name as a person, a pronoun, one game under two names
    chaerin = g.upsert(mid, name="채린", kind="person")
    pronoun = g.upsert(mid, name="걔", kind="person")
    djmax = g.upsert(mid, name="DJMAX", kind="game")
    dimac = g.upsert(mid, name="디맥", kind="game")
    g.mention(mid, dimac["id"], f"mem:{raw[1]['id']}")
    worker = Consolidator(mates)
    org = worker.organizer
    assert org.due() == mid
    calls = []

    async def model(mate, system, payload):
        calls.append(payload)
        if "nodes" in payload:
            ids = {n["name"]: n["id"] for n in payload["nodes"]}
            assert "걔" not in ids  # (a pronoun: dropped before it looks — Organizer.tidy)
            return {"merge": [{"into": ids["DJMAX"], "from": [ids["디맥"]]}], "self": [ids["채린"]]}
        ents = {e["name"]: e["id"] for e in payload["entities"]}
        fixed = {x["id"] for x in payload["memories"] if x.get("fixed_text")}
        assert mine["id"] in fixed and raw[0]["id"] not in fixed
        return {"memories": [
            {"id": raw[0]["id"], "action": "keep", "entity": {"kind": "user"}, "kind": "preference",
             "attribute": "좋아하는 옷차림", "text": "하렴은 내가 크롭탑 입은 모습을 좋아한다."},
            {"id": raw[1]["id"], "action": "keep", "entity": {"name": "지수 형", "kind": "person"}, "kind": "fact",
             "attribute": "관계", "text": "지수 형은 하렴과 DJMAX를 같이 하는 사람이다."},
            {"id": raw[2]["id"], "action": "archive"},
            {"id": raw[3]["id"], "action": "keep", "entity": {"id": ents["DJMAX"]}, "kind": "preference",
             "attribute": "즐기는 게임", "text": "하렴은 DJMAX를 좋아한다."},
            {"id": mine["id"], "action": "keep", "entity": {"kind": "user"}, "kind": "profile", "attribute": "생일",
             "text": "하렴의 생일은 3월 5일이다."},
        ]}

    out = await org.run(store.get(mid), call=model)
    assert out["merged_nodes"] == 2 and out["dropped_nodes"] == 1 and out["archived"] == 1 and out["rewritten"] == 3
    assert g.find(mid, "걔") is None and g.find(mid, "디맥")["id"] == djmax["id"]
    assert g.node(mid, chaerin["id"])["kind"] == "self"
    by = {m["id"]: m for m in store.memories(mid)}
    assert raw[2]["id"] not in by  # (archived: the test scene)
    assert by[raw[0]["id"]]["text"] == "하렴은 내가 크롭탑 입은 모습을 좋아한다." and by[raw[0]["id"]]["entity"]["kind"] == "user"
    assert by[raw[1]["id"]]["entity"]["name"] == "지수 형"
    assert by[raw[3]["id"]]["entity"]["id"] == djmax["id"]
    assert by[mine["id"]]["text"] == "생일은 3월 5일" and by[mine["id"]]["predicate"] == "생일"  # (their words stay)
    # the quotes came along to the new words; the old words are a version
    assert store.knowledge.memory_details(mid, raw[0]["id"])["evidence"]
    assert any(v["snapshot"]["text"] == "너 크롭탑 이뻐" for v in store.knowledge.history(mid, raw[0]["id"]))
    assert org_state(db, mid)["state"] == "done" and org.due() is None
    org.ask(mid)
    assert org.due() == mid and org_state(db, mid)["state"] == "asked"


async def test_two_memories_of_one_item_become_one_record(db):
    store, mates, mid, sid = setup(db)
    a = mates._svc._add_message(sid, "user", "우리 사귀는 사이잖아")
    b = mates._svc._add_message(sid, "user", "난 우리가 연인사이라고 생각했는데")
    m1 = store.add_memory(mid, "우리 사귀는 사이잖아", kind="fact", source="mate")
    store.knowledge.attach(mid, m1["id"], "msg:" + a, "우리 사귀는 사이잖아")
    m2 = store.add_memory(mid, "난 우리가 연인사이라고 생각했는데", kind="fact", source="mate")
    store.knowledge.attach(mid, m2["id"], "msg:" + b, "난 우리가 연인사이라고 생각했는데")
    org = Organizer(Consolidator(mates))

    async def model(mate, system, payload):
        if "nodes" in payload:
            return {}
        return {"memories": [
            {"id": m1["id"], "action": "keep", "entity": {"kind": "us"}, "kind": "fact", "attribute": "관계",
             "text": "하렴은 우리가 연인 사이라고 여긴다."},
            {"id": m2["id"], "action": "merge", "into": m1["id"]},
        ]}

    out = await org.run(store.get(mid), call=model)
    assert out["merged"] == 1
    [m] = store.memories(mid)
    assert m["id"] == m1["id"] and m["entity"]["kind"] == "us"
    quotes = {e["quote"] for e in store.knowledge.memory_details(mid, m["id"])["evidence"]}
    assert quotes == {"우리 사귀는 사이잖아", "난 우리가 연인사이라고 생각했는데"}
    assert store.memory(mid, m2["id"])["status"] == "archived"


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


def test_the_notebook_hears_what_each_memory_is_about_and_can_ask_for_order(client):
    r = client.post("/api/mates", json={"name": "한채린", "prefs": {"user_name": "하렴"}})
    mid = r.json()["id"]
    mem = client.post(f"/api/mates/{mid}/memories", json={"text": "생일은 3월 5일", "kind": "profile"}).json()
    rows = client.get(f"/api/mates/{mid}/memories").json()
    assert rows[0]["id"] == mem["id"] and "entity" in rows[0]
    assert client.get(f"/api/mates/{mid}/knowledge/status").json()["organize"]["state"] == "never"
    assert client.post(f"/api/mates/{mid}/knowledge/organize").json()["state"] == "asked"
    assert client.get(f"/api/mates/{mid}/knowledge/status").json()["organize"]["state"] == "asked"


async def test_a_day_or_their_tie_is_no_thing_a_wrong_id_files_nothing_and_her_diary_is_theirs(db):
    """v2 (what v1 left on 2026-11-20): "11월 20일" and "서먹한 사이" were nodes, a memory about 지수 형 went under the
    node whose id the model slipped in, one of her diary's moments was under nothing."""
    store, mates, mid, sid = setup(db)
    named(store, mid)
    g = store.graph
    a = mates._svc._add_message(sid, "user", "어제 지수 형이랑 디맥 3판 했어")
    jisu = g.upsert(mid, name="지수 형", kind="person")
    day = g.upsert(mid, name="11월 20일", kind="event")
    tie = g.upsert(mid, name="서먹한 사이", kind="concept")
    second_us = g.upsert(mid, name="우리 사이", kind="topic")
    m = store.add_memory(mid, "어제 지수 형이랑 디맥 3판 했어", kind="fact", source="mate")
    store.knowledge.attach(mid, m["id"], "msg:" + a, "어제 지수 형이랑 디맥 3판 했어")
    diary = store.add_memory(mid, "[우리 사이] 11월 20일, 우리는 서먹한 사이가 되었다.", kind="fact", importance=4, source="gss")
    kept = store.add_memory(mid, "하렴은 Path of Exile을 자주 한다", kind="fact", source="mate")
    poe = g.upsert(mid, name="Path of Exile", kind="game")
    db.execute("UPDATE mate_memories SET entity_id=? WHERE id=?", (poe["id"], kept["id"]))
    org = Organizer(Consolidator(mates))

    async def model(mate, system, payload):
        if "nodes" in payload:
            assert {"11월 20일", "서먹한 사이"} & {n["name"] for n in payload["nodes"]} == set()  # (gone before it looks)
            return {}
        ents = {e["name"]: e["id"] for e in payload["entities"]}
        us = next(e["id"] for e in payload["entities"] if e["kind"] == "us")
        return {"memories": [
            # (the id of the two of them, the name of 지수 형: the name decides)
            {"id": m["id"], "action": "keep", "entity": {"id": us, "name": "지수 형", "kind": "person"}, "kind": "fact",
             "attribute": "함께 한 게임", "text": "하렴은 2026-11-19에 지수 형과 DJMAX를 3판 했다."},
            {"id": diary["id"], "action": "keep"},  # (nothing given for her diary: theirs all the same)
            {"id": kept["id"], "action": "keep", "kind": "fact"},  # (nothing given: where it was)
        ]}

    out = await org.run(store.get(mid), call=model)
    assert g.find(mid, "11월 20일") is None and g.node(mid, day["id"]) is None
    us = g.special(mid, "us", "우리 사이")
    for n in (tie, second_us):  # (a merged node reads as the one it went into)
        assert g.node(mid, n["id"])["id"] == us["id"]
    by = {x["id"]: x for x in store.memories(mid)}
    assert by[m["id"]]["entity"]["id"] == jisu["id"]
    assert by[diary["id"]]["entity"]["id"] == us["id"] and by[diary["id"]]["text"].startswith("[우리 사이]")
    assert by[kept["id"]]["entity"]["id"] == poe["id"]
    assert out["dropped_nodes"] >= 1 and out["merged_nodes"] >= 2
    # and from now on: a day is never linked, "… 사이" is the two of them
    assert g.link_entities(mid, "mem:x", [{"name": "11월 21일", "kind": "event"}, {"name": "사귀는 사이", "kind": "concept"}],
                           user_name="하렴", self_name="한채린") == [us["id"]]
    w = Consolidator(mates)
    assert w.entity(mid, {"name": "오늘", "kind": "event"})["kind"] == "user"
    assert w.entity(mid, {"id": jisu["id"], "name": "Path of Exile", "kind": "game"})["id"] == poe["id"]
    assert w.entity(mid, {"id": jisu["id"], "name": "지수형"})["id"] == jisu["id"]  # (the same name, spaced otherwise)


async def test_a_moment_between_them_is_filed_under_the_two_of_them_when_it_is_written(db):
    from datetime import UTC, datetime
    store, mates, mid, sid = setup(db)
    named(store, mid)
    mates.gss._remember(store.get(mid), "hurt", {"kind": "insult", "quote": "바보야"}, datetime.now(UTC))
    [m] = [x for x in store.memories(mid) if x["source"] == "gss"] or [None]
    if m is None:
        pytest.skip("this moment writes no memory")
    assert m["entity"]["kind"] == "us"
    assert any(r["node_id"] == m["entity"]["id"] for r in db.query("SELECT node_id FROM mem_mentions WHERE ref=?",
                                                                   ("mem:" + m["id"],)))
