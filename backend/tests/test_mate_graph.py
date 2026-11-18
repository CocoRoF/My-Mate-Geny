"""A mate's memory network (docs/mate-memory-graph.md): names and aliases, grounded facts, remembering and forgetting,
what a message brings to mind, the map, her studies (a scripted engine: no network, no model), reading pages safely,
her memories tied into the network. Synthetic data only."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from app.mate import graph as G
from app.mate import webread
from app.mate.graph import GraphError
from app.mate.linker import Linker
from app.mate.study import Studies
from tests.test_mate_memory_v2 import _svc, _turn

PAGE = """# Path of Exile

Path of Exile is a free-to-play action role-playing game developed by Grinding Gear Games, a studio in New Zealand.

## Leagues

Each league is a temporary season with its own mechanic. The 3.26 league "Secrets of the Atlas" started on 2025-03-07.

The passive skill tree has more than 1,300 passive skills."""


def setup(db):
    store, mates = _svc(db)
    mate = store.create(name="하린")
    return store, mates, mate["id"], store.graph


def doc_with_facts(g, mid):
    poe = g.upsert(mid, name="Path of Exile", kind="game", aliases=["패스 오브 엑자일", "PoE", "엑자일"],
                   summary="그라인딩 기어 게임즈의 액션 RPG", origin="study")
    ggg = g.upsert(mid, name="Grinding Gear Games", kind="org", aliases=["GGG"], origin="study")
    d = g.add_doc(mid, url="https://example.test/poe", title="Path of Exile", text=PAGE, origin="study")
    chunk = g.db.query_one("SELECT id FROM know_chunks WHERE doc_id=? ORDER BY ordinal LIMIT 1", (d["id"],))["id"]
    f1 = g.add_fact(mid, subject=poe["id"], obj=ggg["id"], predicate="developed by",
                    statement="Path of Exile은 뉴질랜드의 Grinding Gear Games가 만든 무료 액션 RPG다",
                    quote="free-to-play action role-playing game developed by Grinding Gear Games", chunk_id=chunk)
    f2 = g.add_fact(mid, subject=poe["id"], predicate="league", statement="3.26 리그 Secrets of the Atlas는 2025-03-07에 시작했다",
                    quote='The 3.26 league "Secrets of the Atlas" started on 2025-03-07.', chunk_id=chunk,
                    valid_from="3.26")
    return poe, ggg, d, chunk, f1, f2


# ---- names ----

def test_a_name_and_its_aliases_are_one_node_across_languages(db):
    _, _, mid, g = setup(db)
    a = g.upsert(mid, name="Path of Exile", kind="game", aliases=["패스 오브 엑자일", "PoE"])
    b = g.upsert(mid, name="패스오브엑자일", kind="topic", aliases=["Path of Exile 2"])  # (spaces don't matter)
    assert a["id"] == b["id"] and b["kind"] == "game"  # (the kind it had stays)
    assert "Path of Exile 2" in b["aliases"]
    assert g.find(mid, "poe")["id"] == a["id"] and g.find(mid, "패스 오브 엑자일")["id"] == a["id"]
    # (another mate's network is its own)
    other = g.db.query_one("SELECT id FROM mates WHERE id!=? LIMIT 1", (mid,))
    assert other is None or g.find(other["id"], "poe") is None


def test_merge_moves_facts_and_names_and_keeps_the_other_as_merged(db):
    _, _, mid, g = setup(db)
    poe, ggg, _, _, f1, _ = doc_with_facts(g, mid)
    dup = g.upsert(mid, name="POE 게임", kind="game")
    g.mention(mid, dup["id"], "mem:x")
    merged = g.merge(mid, dup["id"], poe["id"])
    assert "POE 게임" in merged["aliases"]
    assert g.find(mid, "POE 게임")["id"] == poe["id"]
    assert g.node(mid, dup["id"])["id"] == poe["id"]  # (the old id leads to the one it went into)
    assert g.db.query_one("SELECT node_id FROM mem_mentions WHERE ref='mem:x'")["node_id"] == poe["id"]
    with pytest.raises(GraphError):
        g.merge(mid, poe["id"], poe["id"])


# ---- facts ----

def test_a_fact_needs_an_exact_quote_of_its_chunk_and_a_newer_one_supersedes(db):
    _, _, mid, g = setup(db)
    poe, _, _, chunk, _, f2 = doc_with_facts(g, mid)
    with pytest.raises(GraphError):
        g.add_fact(mid, subject=poe["id"], predicate="x", statement="Path of Exile has 2,000 passive skills",
                   quote="more than 2,000 passive skills", chunk_id=chunk)
    # (line breaks in the page differ from the quote's spaces: still the same words)
    ok = g.add_fact(mid, subject=poe["id"], predicate="tree", statement="패시브 스킬 트리에는 1,300개가 넘는 스킬이 있다",
                    quote="The passive skill tree has   more than 1,300 passive skills.", chunk_id=chunk)
    assert ok["quote"] == "The passive skill tree has more than 1,300 passive skills."
    again = g.add_fact(mid, subject=poe["id"], predicate="tree", statement="패시브 스킬 트리에는 1,300개가 넘는 스킬이 있다",
                       quote="The passive skill tree has more than 1,300 passive skills.", chunk_id=chunk)
    assert again["id"] == ok["id"]  # (the same claim: the same fact, reinforced)
    newer = g.add_fact(mid, subject=poe["id"], predicate="league", statement="3.26 리그는 Secrets of the Atlas다 (갱신)",
                       quote='The 3.26 league "Secrets of the Atlas"', chunk_id=chunk, replaces=f2["id"])
    old = g.db.query_one("SELECT status,superseded_by,invalidated_at FROM mem_facts WHERE id=?", (f2["id"],))
    assert old["status"] == "superseded" and old["superseded_by"] == newer["id"] and old["invalidated_at"]


# ---- remembering and forgetting ----

def test_strength_fades_with_time_and_using_it_holds_it_longer():
    now = datetime(2026, 11, 15, tzinfo=UTC)
    fresh = {"stability": 12.0, "last_access": now.isoformat()}
    month = {"stability": 12.0, "last_access": (now - timedelta(days=30)).isoformat()}
    year = {"stability": 12.0, "last_access": (now - timedelta(days=365)).isoformat()}
    r = [G.retrievability(x, now) for x in (fresh, month, year)]
    assert r[0] == 1.0 and r[0] > r[1] > r[2] and r[2] < 0.3
    assert G.retrievability({**year, "pinned": 1}, now) == 1.0
    # recalled when nearly forgotten grows more than recalled right away (spacing)
    assert G.reinforced(year, now) > G.reinforced(month, now) > G.reinforced(fresh, now) > 12.0
    assert G.stability0(5) > G.stability0(3) > G.stability0(1)


def test_a_message_brings_to_mind_what_it_names_and_spreads_to_neighbours(db):
    _, _, mid, g = setup(db)
    poe, ggg, _, _, f1, f2 = doc_with_facts(g, mid)
    found = g.recall(mid, "어제 엑자일 새 리그 해봤어?")
    ids = [f["id"] for f in found["facts"]]
    assert f2["id"] in ids and f1["id"] in ids
    assert poe["id"] in found["seeds"]
    assert G.context_lines(found).startswith("<knowledge") and "Path of Exile" in G.context_lines(found)
    # GGG is reached through PoE (one hop) when only PoE is named; small talk brings nothing
    act = g.activate(mid, "PoE 재밌어")
    assert act[ggg["id"]] > 0 and act[poe["id"]] > act[ggg["id"]]
    assert g.recall(mid, "오늘 점심 뭐 먹었어?") == {"nodes": [], "facts": [], "seeds": []}


def test_a_faded_fact_waits_to_be_asked_about(db):
    _, _, mid, g = setup(db)
    poe, ggg, _, _, f1, f2 = doc_with_facts(g, mid)
    long_ago = (datetime.now(UTC) - timedelta(days=900)).isoformat()
    g.db.execute("UPDATE mem_facts SET last_access=?,stability=5 WHERE mate_id=?", (long_ago, mid))
    g.db.execute("UPDATE mem_nodes SET last_access=?,stability=5 WHERE mate_id=?", (long_ago, mid))
    # named directly: it comes back however faded
    assert {f["id"] for f in g.recall(mid, "Grinding Gear Games 얘기 기억나?")["facts"]} >= {f1["id"]}
    # only reached indirectly (a neighbour named): a faded fact stays quiet
    other = g.upsert(mid, name="Diablo IV", kind="game")
    g.add_fact(mid, subject=other["id"], obj=ggg["id"], predicate="rival", statement="디아블로 4는 GGG 게임과 경쟁한다",
               quote="free-to-play action role-playing game", chunk_id=g.db.query_one(
                   "SELECT id FROM know_chunks WHERE mate_id=? LIMIT 1", (mid,))["id"])
    found = g.recall(mid, "디아블로 4 어때")
    assert f2["id"] not in [f["id"] for f in found["facts"]]


def test_recall_in_a_turn_reinforces_what_was_given(db):
    store, mates, mid, g = setup(db)
    poe, _, _, _, f1, f2 = doc_with_facts(g, mid)
    req, _ = _turn(mates, mid, "엑자일 3.26 리그 어땠지?")
    assert "<knowledge" in req.preamble and "Secrets of the Atlas" in req.preamble
    before = g.db.query_one("SELECT access_count FROM mem_facts WHERE id=?", (f2["id"],))["access_count"]
    req.on_context_delivered()
    after = g.db.query_one("SELECT access_count,stability FROM mem_facts WHERE id=?", (f2["id"],))
    assert after["access_count"] == before + 1
    assert g.db.query_one("SELECT access_count FROM mem_nodes WHERE id=?", (poe["id"],))["access_count"] >= 1
    # (given once, it isn't given again in the same engine session)
    req2, _ = _turn(mates, mid, "엑자일 3.26 리그 얘기 더 해줘", cli=req.cli_session_id or "cli-1")
    assert req2.preamble.count("Secrets of the Atlas") <= 1


def test_an_alias_widens_the_memory_recall(db):
    store, mates, mid, g = setup(db)
    g.upsert(mid, name="Path of Exile", kind="game", aliases=["엑자일", "패스 오브 엑자일"])
    for i in range(30):  # (enough memories that not all are core)
        store.add_memory(mid, f"사용자 일정 메모 {i}번: 회의와 운동과 장보기", kind="context")
    m = store.add_memory(mid, "사용자는 Path of Exile을 자주 한다", kind="fact")
    req, _ = _turn(mates, mid, "엑자일 새 시즌 언제야?")
    assert m["id"] in req.preamble


# ---- the map ----

def test_the_map_has_the_user_at_the_centre_of_their_memories_and_facts_between_things(db):
    store, mates, mid, g = setup(db)
    poe, ggg, *_ = doc_with_facts(g, mid)
    m = store.add_memory(mid, "사용자는 Path of Exile을 자주 한다", kind="fact")
    g.link_entities(mid, f"mem:{m['id']}", [{"kind": "user"}, {"name": "Path of Exile", "kind": "game", "label": "plays"}],
                    user_name="현석")
    snap = g.snapshot(mid, memories=store.memories(mid))
    names = {n["name"]: n for n in snap["nodes"]}
    assert {"현석", "Path of Exile", "Grinding Gear Games"} <= set(names)
    kinds = {(l["kind"], frozenset((l["source"], l["target"]))) for l in snap["links"]}
    assert ("fact", frozenset((poe["id"], ggg["id"]))) in kinds
    assert ("memory", frozenset((names["현석"]["id"], poe["id"]))) in kinds
    assert all(0 < n["strength"] <= 1 for n in snap["nodes"])
    focus = g.snapshot(mid, focus=ggg["id"], depth=1, memories=store.memories(mid))
    assert {n["id"] for n in focus["nodes"]} == {ggg["id"], poe["id"]}
    # forgetting the node removes its page facts; the user's memory stays
    assert g.forget_node(mid, poe["id"]) == 2
    assert store.memory(mid, m["id"]) is not None



def test_the_search_box_finds_part_of_a_name_and_the_words_of_facts(db):
    _, _, mid, g = setup(db)
    poe, ggg, *_ = doc_with_facts(g, mid)
    found = g.search(mid, "엑자")  # (part of "패스 오브 엑자일")
    assert found["nodes"] and found["nodes"][0]["id"] == poe["id"]
    assert g.search(mid, "grinding")["nodes"][0]["id"] == ggg["id"]
    leagues = g.search(mid, "Secrets of the Atlas league")
    assert any("3.26" in f["statement"] for f in leagues["facts"]) and leagues["passages"]
    assert g.search(mid, "x")["nodes"] == []  # (one letter names nothing)

# ---- her memories in the network ----

def test_the_linker_ties_memories_to_what_they_name_and_nothing_made_up(db):
    store, mates, mid, g = setup(db)
    m1 = store.add_memory(mid, "사용자는 리그 오브 레전드를 자주 한다", kind="fact")
    m2 = store.add_memory(mid, "여동생 민지는 간호사다", kind="profile")
    from app.mate.consolidation import Consolidator

    linker = Linker(Consolidator(mates))
    todo = linker.backlog(mid)
    assert {t["ref"] for t in todo} >= {f"mem:{m1['id']}", f"mem:{m2['id']}"}

    async def call(mate, prompt, payload, kind, timeout=90):
        return {"links": [
            {"ref": f"mem:{m1['id']}", "about_user": True, "entities": [
                {"name": "리그 오브 레전드", "kind": "game", "aliases": ["League of Legends", "롤", "LoL"], "role": "plays"},
                {"name": "발로란트", "kind": "game"}]},  # (not in its words: dropped)
            {"ref": f"mem:{m2['id']}", "about_user": True, "entities": [{"name": "민지", "kind": "person", "role": "sister"}]},
        ]}, {}

    assert asyncio.run(linker.once(call=call))
    assert g.find(mid, "LoL") and g.find(mid, "롤")["kind"] == "game"
    lol = g.find(mid, "LoL")["id"]
    assert lol in g.seeds(mid, "오늘 롤 한 판 할래?") and lol in g.seeds(mid, "League of Legends 새 패치")
    assert lol not in g.seeds(mid, "롤러코스터 타러 가자")
    assert g.find(mid, "발로란트") is None
    assert g.find(mid, "민지")["kind"] == "person"
    assert not {f"mem:{m1['id']}", f"mem:{m2['id']}"} & {t["ref"] for t in linker.backlog(mid)}
    # forgetting a memory unlinks it
    store.delete_memory(mid, m1["id"], by_user=True)
    assert not g.db.query_one("SELECT 1 FROM mem_mentions WHERE ref=?", (f"mem:{m1['id']}",))


# ---- reading pages ----

def test_only_the_public_web_is_read():
    for url in ("http://127.0.0.1:8080/api/admin", "http://localhost/", "http://10.0.0.5/x", "http://192.168.0.106/",
                "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "http://[::1]/", "ftp://example.com/",
                "http://user:pw@example.com/"):
        with pytest.raises(webread.ReadError):
            asyncio.run(webread.check_url(url))


def test_html_becomes_quotable_text():
    html = """<html><head><title>Ignored title</title><meta property="og:title" content="Atlas Guide">
    <meta property="og:site_name" content="PoE Wiki"><meta property="article:published_time" content="2025-03-07">
    <script>var x = "not text";</script><style>.a{}</style></head><body><nav><a href="/home">Home</a> menu</nav>
    <article><h1>Atlas</h1><p>The Atlas&nbsp;of Worlds is the endgame.</p><ul><li>Maps</li><li>Bosses</li></ul>
    <table><tr><th>Tier</th><th>Maps</th></tr><tr><td>1</td><td>Strand</td></tr></table>
    <p>See <a href="/wiki/Maps">the map list</a>.</p></article><footer>© someone</footer></body></html>"""
    page = webread.extract(html, "https://wiki.example/atlas")
    assert page.title == "Atlas Guide" and page.site == "PoE Wiki" and page.published == "2025-03-07"
    assert "# Atlas" in page.text and "The Atlas of Worlds is the endgame." in page.text
    assert "- Maps" in page.text and "Tier | Maps" in page.text and "1 | Strand" in page.text
    assert "not text" not in page.text and "menu" not in page.text and "someone" not in page.text
    assert ("the map list", "https://wiki.example/wiki/Maps") in page.links


def test_long_text_is_cut_on_paragraphs():
    text = ("문단 하나의 문장입니다. " * 30 + "\n\n") * 10
    spans = G.chunks(text, 400)
    assert len(spans) > 5 and spans[0][0] == 0
    assert all(e - s <= 400 * 1.3 + 2 for s, e in spans)
    assert "".join(text[s:e] for s, e in spans).replace(" ", "").replace("\n", "") == text.replace(" ", "").replace("\n", "")


# ---- studies ----

def test_a_study_reads_files_and_reports_back(db, monkeypatch):
    store, mates, mid, g = setup(db)
    studies: Studies = mates.studies
    delivered = []
    studies.deliver = delivered.append

    async def fetch(url, *, respect_robots=False, transport=None):
        return webread.Page(url=url, title="Path of Exile", text=PAGE, site="example.test", published="2025-03-08")

    monkeypatch.setattr(webread, "fetch", fetch)

    async def turn(mate, study, token, *, pages, facts, minutes):
        ctx = studies.token_info(token)
        assert ctx and ctx["study_id"] == study["id"]
        out, err = await studies.tool(ctx, "read_page", {"url": "https://example.test/poe"})
        assert not err and "[d_" in out and ".c1]" in out
        chunk = out.split("[", 2)[2].split("]", 1)[0]
        out, err = await studies.tool(ctx, "add_knowledge", {
            "entities": [{"name": "Path of Exile", "kind": "game", "aliases": ["패스 오브 엑자일", "PoE"],
                          "summary": "무료 액션 RPG"},
                         {"name": "Grinding Gear Games", "kind": "org", "aliases": ["GGG"]}],
            "facts": [{"subject": "Path of Exile", "object": "Grinding Gear Games", "predicate": "developed by",
                       "statement": "Path of Exile은 Grinding Gear Games가 개발했다",
                       "quote": "developed by Grinding Gear Games", "chunk": chunk},
                      {"subject": "Path of Exile", "predicate": "x", "statement": "Path of Exile는 2030년에 끝난다",
                       "quote": "ends in 2030", "chunk": chunk}]})
        assert "Filed 1 facts" in out and "Not filed" in out
        await studies.tool(ctx, "note", {"text": "리그 정보 읽는 중"})
        out, _ = await studies.tool(ctx, "finish_study", {"summary": "PoE는 GGG의 무료 액션 RPG다.", "open_questions": ["3.27?"]})
        return {"cost_usd": 0.12}

    studies.turn = turn
    st = studies.request(mid, kind="topic", topic="Path of Exile", depth="quick")
    assert st["state"] == "queued" and studies.request(mid, kind="topic", topic="path of exile")["id"] == st["id"]
    asyncio.run(studies._one(studies._row(db.query_one("SELECT * FROM know_studies WHERE id=?", (st["id"],)))))
    done = studies.get(mid, st["id"])
    assert done["state"] == "done" and done["pages"] == 1 and done["facts"] == 1 and done["cost"] == 0.12
    assert done["summary"].startswith("PoE") and done["open_questions"] == ["3.27?"]
    assert [e["kind"] for e in done["events"]][:3] == ["queued", "started", "reading"]
    assert delivered and delivered[0]["id"] == st["id"]
    assert g.find(mid, "GGG") and g.stats(mid)["docs"] == 1
    # the token is gone with the study
    assert studies.token_info("nope") is None
    block = mates._study_block(done)
    assert block.startswith("<study_result") and "PoE는" in block and "Still open: 3.27?" in block


def test_a_study_stays_within_its_budget(db, monkeypatch):
    store, mates, mid, g = setup(db)
    studies: Studies = mates.studies
    calls = []

    async def fetch(url, *, respect_robots=False, transport=None):
        calls.append(url)
        return webread.Page(url=url, title=url, text=PAGE + url, site="x")

    monkeypatch.setattr(webread, "fetch", fetch)

    async def turn(mate, study, token, *, pages, facts, minutes):
        ctx = studies.token_info(token)
        for i in range(pages + 2):
            out, _ = await studies.tool(ctx, "read_page", {"url": f"https://example.test/{i}"})
        assert "budget" in out
        return {}

    studies.turn = turn
    st = studies.request(mid, kind="topic", topic="Atlas", depth="quick")
    asyncio.run(studies._one(studies._row(db.query_one("SELECT * FROM know_studies WHERE id=?", (st["id"],)))))
    assert len(calls) == 4 and studies.get(mid, st["id"])["pages"] == 4


def test_a_study_that_learns_nothing_leaves_no_empty_node(db):
    store, mates, mid, g = setup(db)
    studies: Studies = mates.studies
    studies.deliver = lambda study: None

    async def turn(mate, study, token, *, pages, facts, minutes):
        raise RuntimeError("engine down")

    studies.turn = turn
    st = studies.request(mid, kind="topic", topic="젤다의 전설", depth="quick")
    assert g.find(mid, "젤다의 전설")
    asyncio.run(studies._one(studies._row(db.query_one("SELECT * FROM know_studies WHERE id=?", (st["id"],)))))
    after = studies.get(mid, st["id"])
    assert after["state"] == "failed" and after["node_id"] is None and g.find(mid, "젤다의 전설") is None
    # a thing she already knew of stays, studied or not
    m = store.add_memory(mid, "사용자는 원신을 한다", kind="fact")
    n = g.upsert(mid, name="원신", kind="game")
    g.mention(mid, n["id"], f"mem:{m['id']}")
    st = studies.request(mid, kind="topic", topic="원신", depth="quick")
    asyncio.run(studies._one(studies._row(db.query_one("SELECT * FROM know_studies WHERE id=?", (st["id"],)))))
    assert g.find(mid, "원신")["id"] == n["id"]

def test_pages_that_cannot_be_read_are_noted_and_she_stops_trying(db, monkeypatch):
    store, mates, mid, g = setup(db)
    studies: Studies = mates.studies
    studies.deliver = lambda study: None
    tried = []

    async def fetch(url, *, respect_robots=False, transport=None):
        tried.append(url)
        raise webread.ReadError("HTTP 403")

    monkeypatch.setattr(webread, "fetch", fetch)
    replies = []

    async def turn(mate, study, token, *, pages, facts, minutes):
        ctx = studies.token_info(token)
        for i in range(2 * pages + 4):
            replies.append(await studies.tool(ctx, "read_page", {"url": f"https://blocked.test/{i}"}))
        return {}

    studies.turn = turn
    st = studies.request(mid, kind="topic", topic="Atlas", depth="quick")  # (4 pages → 10 tries)
    asyncio.run(studies._one(studies._row(db.query_one("SELECT * FROM know_studies WHERE id=?", (st["id"],)))))
    assert len(tried) == 10
    assert all(err and "try another source" in out for out, err in replies[:10])
    assert "Too many pages" in replies[-1][0]
    done = studies.get(mid, st["id"])
    assert done["state"] == "failed" and sum(e["kind"] == "unreadable" for e in done["events"]) == 10


def test_her_curiosity_picks_what_the_user_cares_about_and_knows_little_of(db):
    store, mates, mid, g = setup(db)
    m = store.add_memory(mid, "사용자는 원신을 자주 한다", kind="fact")
    n = g.upsert(mid, name="원신", kind="game", aliases=["Genshin Impact"])
    g.mention(mid, n["id"], f"mem:{m['id']}")
    g.upsert(mid, name="아무도 말 안 한 게임", kind="game")
    studies: Studies = mates.studies
    assert studies.pick_topic(mid) == "원신"
    studies.request(mid, kind="curiosity", topic="원신", by="self")
    assert studies.pick_topic(mid) is None  # (studied lately)


def test_her_curiosity_never_searches_the_users_personal_things(db):
    store, mates, mid, g = setup(db)
    studies: Studies = mates.studies
    # the user talks a lot about their own project, a friend, their office: none goes to a search engine
    for name, kind in (("내일의 종 프로젝트", "thing"), ("민지", "person"), ("우리 회사", "org"), ("동네 카페", "place"),
                       ("사이드 프로젝트", "topic")):
        n = g.upsert(mid, name=name, kind=kind)
        for i in range(3):
            m = store.add_memory(mid, f"사용자는 {name} 얘기를 한다 {i}", kind="fact")
            g.mention(mid, n["id"], f"mem:{m['id']}")
    assert studies.pick_topic(mid) is None
    # a topic she has already read about on the web is public: she may catch up on it
    poe, ggg, *_ = doc_with_facts(g, mid)
    m = store.add_memory(mid, "사용자는 Grinding Gear Games 소식을 챙겨 본다", kind="fact")
    g.mention(mid, ggg["id"], f"mem:{m['id']}")
    assert studies.pick_topic(mid) == "Grinding Gear Games"


def test_a_study_of_her_own_that_found_nothing_is_not_brought_up(db):
    store, mates, mid, g = setup(db)
    studies: Studies = mates.studies
    found = studies.request(mid, kind="curiosity", topic="원신", by="self")
    empty = studies.request(mid, kind="curiosity", topic="아무것도 없는 주제", by="self")
    db.execute("UPDATE know_studies SET state='done',facts=3,summary='x',finished_at=? WHERE id=?",
               (datetime.now(UTC).isoformat(), found["id"]))
    db.execute("UPDATE know_studies SET state='done',facts=0,summary='못 찾음',finished_at=? WHERE id=?",
               (datetime.now(UTC).isoformat(), empty["id"]))
    assert [s["id"] for s in mates._untold_studies(mid)] == [found["id"]]


def test_a_url_study_and_bad_requests(db):
    store, mates, mid, g = setup(db)
    st = mates.studies.request(mid, kind="url", url="https://example.test/page")
    assert st["depth"] == "normal" and st["url"] == "https://example.test/page"
    # a URL study takes a depth too (very deep: the site explored, dozens of its pages)
    from app.mate.study import URL_FOLLOW, URL_MORE

    deep = mates.studies.request(mid, kind="url", url="https://example.test/docs", depth="very_deep")
    assert deep["depth"] == "very_deep" and URL_FOLLOW["very_deep"] >= 40 and "thoroughly" in URL_MORE["very_deep"]
    assert URL_FOLLOW["very_quick"] == 0 and "none of its links" in URL_MORE["very_quick"]
    with pytest.raises(ValueError):
        mates.studies.request(mid, kind="url", url="javascript:alert(1)")
    with pytest.raises(ValueError):
        mates.studies.request(mid, kind="topic", topic=" ")
    c = mates.studies.cancel(mid, st["id"])
    assert c["state"] == "canceled"


def test_a_study_turn_is_sealed_with_web_search_and_only_the_study_tools(db, monkeypatch):
    from app.mate import study as SM
    from app.providers.base import ProviderEvent

    store, mates, mid, g = setup(db)
    seen = {}

    class Fake:
        async def run_turn_stream(self, req):
            seen["req"] = req
            yield ProviderEvent(type="tool.use", data={"name": "WebSearch", "input": {"query": "Path of Exile 2 league"}})
            yield ProviderEvent(type="turn.complete", data={"text": "", "cost_usd": 0.05})

    monkeypatch.setattr(SM, "get_provider", lambda name: Fake())
    mate = store.get(mid)
    st = mates.studies.request(mid, kind="topic", topic="Path of Exile 2", depth="quick")
    usage = asyncio.run(mates.studies._turn(mate, st, "tok", pages=4, facts=30, minutes=10))
    req = seen["req"]
    assert usage["cost_usd"] == 0.05
    assert req.sealed and req.ephemeral and req.web_search
    assert req.tools == ["WebSearch"] and set(req.allowed_tools) == {"WebSearch", "mcp__study"}
    env = req.mcp_config["mcpServers"]["study"]["env"]
    assert env["HRH_MATE_STUDY"] == "1" and env["HRH_MATE_TOKEN"] == "tok" and "HRH_MATE_MEMORY" not in env
    assert "Korean" in req.system_prompt and "at most 4 pages" in req.system_prompt
    assert "Study: Path of Exile 2" in req.messages[0]["content"]
    assert any(e["kind"] == "search" for e in mates.studies.get(mid, st["id"])["events"])


# ---- over the API ----

def test_the_network_and_studies_over_the_api():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        svc = app.state.mate_service
        ran = []

        async def turn(mate, study, token, *, pages, facts, minutes):
            ran.append(study["id"])
            return {}

        svc.studies.turn = turn
        mid = c.post("/api/mates", json={"name": "하린"}).json()["id"]
        g = svc.store.graph
        poe, ggg, d, chunk, f1, f2 = doc_with_facts(g, mid)
        base = f"/api/mates/{mid}"

        snap = c.get(f"{base}/graph").json()
        assert {"Path of Exile", "Grinding Gear Games"} <= {n["name"] for n in snap["nodes"]} and snap["stats"]["facts"] == 2
        assert c.get(f"{base}/graph", params={"origin": "knowledge"}).status_code == 200
        assert c.get(f"{base}/graph", params={"origin": "x"}).status_code == 400
        assert c.get(f"{base}/graph/search", params={"q": "엑자"}).json()["nodes"][0]["id"] == poe["id"]
        assert c.get(f"{base}/graph/search", params={"q": " "}).json() == {"nodes": [], "facts": [], "passages": []}

        det = c.get(f"{base}/graph/nodes/{poe['id']}").json()
        assert det["node"]["pinned"] is False and {f["id"] for f in det["facts"]} == {f1["id"], f2["id"]}
        assert any(n["id"] == ggg["id"] for n in det["neighbors"])
        r = c.patch(f"{base}/graph/nodes/{poe['id']}", json={"pinned": True, "summary": "액션 RPG"})
        assert r.status_code == 200 and r.json()["pinned"] is True
        assert c.patch(f"{base}/graph/nodes/{poe['id']}", json={"kind": "spaceship"}).status_code == 400
        twin = g.upsert(mid, name="PoE 1", kind="game")
        assert c.post(f"{base}/graph/nodes/{twin['id']}/merge", json={"into": poe["id"]}).status_code == 200
        assert g.find(mid, "PoE 1")["id"] == poe["id"]

        assert c.delete(f"{base}/graph/facts/{f2['id']}").status_code == 200
        assert c.delete(f"{base}/graph/facts/{f2['id']}").status_code == 404
        assert c.get(f"{base}/graph/docs").json()[0]["id"] == d["id"]
        page = c.get(f"{base}/graph/docs/{d['id']}", params={"chunk": chunk}).json()
        assert page["chunk"]["id"] == chunk and "Grinding Gear Games" in page["chunk"]["text"]

        # another mate sees none of it
        other = c.post("/api/mates", json={"name": "B"}).json()["id"]
        assert c.get(f"/api/mates/{other}/graph/nodes/{poe['id']}").status_code == 404
        assert c.get(f"/api/mates/{other}/graph/docs/{d['id']}").status_code == 404
        assert c.delete(f"/api/mates/{other}/graph/nodes/{poe['id']}").status_code == 404

        # studies
        assert c.post(f"{base}/studies", json={"kind": "url", "url": "file:///etc/passwd"}).status_code == 400
        assert c.post(f"{base}/studies", json={"kind": "topic"}).status_code == 400
        st = c.post(f"{base}/studies", json={"kind": "topic", "topic": "Atlas", "depth": "quick"}).json()
        assert st["state"] in ("queued", "running") and st["requested_by"] == "user"
        assert c.get(f"{base}/studies/{st['id']}").json()["id"] == st["id"]
        assert c.get(f"/api/mates/{other}/studies/{st['id']}").status_code == 404
        assert any(s["id"] == st["id"] for s in c.get(f"{base}/studies").json())
        c.post(f"{base}/studies/{st['id']}/cancel")
        for _ in range(100):
            if c.get(f"{base}/studies/{st['id']}").json()["state"] not in ("queued", "running"):
                break
            import time
            time.sleep(0.05)
        assert c.delete(f"{base}/studies/{st['id']}").json() == {"deleted": True}
        assert c.get(f"{base}/studies/{st['id']}").status_code == 404

        r = c.delete(f"{base}/graph/nodes/{poe['id']}")
        assert r.status_code == 200 and r.json()["forgotten"] is True
        assert c.get(f"{base}/graph/nodes/{poe['id']}").status_code == 404
