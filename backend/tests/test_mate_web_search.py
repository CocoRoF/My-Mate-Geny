"""메이트 공통 설정 → 스스로 인터넷 검색: every mate may search the web herself in a conversation — her engine's own
search (Claude WebSearch, Codex's web_search), else the server's (search_web on the bridge); off: none of it."""

from __future__ import annotations

from app.mate import mcp_bridge
from app.mate.prompt import prompt_key, system_prompt
from app.providers.base import TurnRequest
from tests.test_mate_codex import _setup


def _req(session, tmp_path):
    return TurnRequest(messages=[{"role": "user", "content": "hi"}], model=session.get("model") or "", cwd=str(tmp_path))


def test_on_by_default_and_switched_from_the_shared_settings(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    assert store.settings()["web_search"] is True
    assert store.update_settings({"web_search": False})["web_search"] is False and "web_search" in store.last_changed
    assert store.update_settings({"web_search": "yes"})["web_search"] is False  # (only a boolean switches it)
    assert store.update_settings({"web_search": True})["web_search"] is True


def test_each_engine_gets_its_own_search_and_none_when_off(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    rin = store.create(name="Rin", llm={"provider": "claude", "effort": "low"})
    sol = store.create(name="Sol", persona={"language": "en"}, llm={"provider": "codex", "effort": "low"})
    claude = mates.conversation(rin["id"])["session"]
    codex = mates.conversation(sol["id"])["session"]
    req = _req(claude, tmp_path)
    mates.configure_engine(claude, req)
    # (and the pages it finds: the latest of anything is on its official page, not in the snippets)
    assert req.tools == ["WebSearch", "WebFetch"] and set(req.allowed_tools) == {"mcp__mate", "WebSearch", "WebFetch"} and not req.web_search
    assert "## Searching the web" in open(req.system_prompt_file).read()
    assert "HRH_MATE_SEARCH" not in req.mcp_config["mcpServers"]["mate"]["env"]  # (it has its own)
    on_key = req.prompt_key
    req = _req(codex, tmp_path)
    mates.configure_engine(codex, req)
    assert req.web_search and req.tools == []
    # switched off: no search anywhere, and her instructions change (a new conversation with the engine)
    store.update_settings({"web_search": False})
    req = _req(claude, tmp_path)
    mates.configure_engine(claude, req)
    assert req.tools == [] and req.allowed_tools == ["mcp__mate"] and not req.web_search
    assert "## Searching the web" not in open(req.system_prompt_file).read() and req.prompt_key != on_key
    req = _req(codex, tmp_path)
    mates.configure_engine(codex, req)
    assert not req.web_search


def test_an_engine_without_its_own_gets_the_servers(monkeypatch):
    monkeypatch.setenv("HRH_MATE_MEMORY", "1")
    monkeypatch.setenv("HRH_MATE_SEARCH", "1")
    assert any(t["name"] == "search_web" for t in mcp_bridge.tools())
    monkeypatch.delenv("HRH_MATE_SEARCH")
    assert not any(t["name"] == "search_web" for t in mcp_bridge.tools())
    # (the rules come and go with it; the key follows, so a switch reaches the engine)
    assert "## Searching the web" in system_prompt("Rin", {}, [], {}, web=True)
    assert "## Searching the web" not in system_prompt("Rin", {}, [], {})
    assert prompt_key("Rin", {}, 1, {}, web=True) != prompt_key("Rin", {}, 1, {})


async def test_the_servers_search_is_refused_when_off(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    m = store.create(name="Rin")
    import app.mate.study as study

    async def fake(q):
        return [{"title": "서울 날씨", "url": "https://example.test/w", "snippet": "맑음"}]

    monkeypatch.setattr(study, "web_search", fake)
    out, err, _ = await mates.call_tool_full({"mate_id": m["id"], "session_id": "s"}, "search_web", {"query": "서울 날씨"})
    assert not err and "https://example.test/w" in out and "맑음" in out
    store.update_settings({"web_search": False})
    out, err, _ = await mates.call_tool_full({"mate_id": m["id"], "session_id": "s"}, "search_web", {"query": "서울 날씨"})
    assert err and "switched off" in out


def test_a_search_reply_closing_list_of_pages_is_shown_not_said():
    from app.mate.voice import speakable_text

    reply = ("오빠, 공식 포럼 패치 노트를 보니 3.27 리그가 이번 주 금요일에 열려요.\n\nSources:\n"
             "- [Path of Exile 3.27 patch notes](https://www.pathofexile.com/forum/view-thread/1)\n- https://poe.ninja\n")
    assert speakable_text(reply) == "오빠, 공식 포럼 패치 노트를 보니 3.27 리그가 이번 주 금요일에 열려요."
    assert speakable_text("**출처:**\n1. [a](https://a.example)") == ""
    # (a "sources" in the middle of what she says is words)
    assert speakable_text("출처: 공식 포럼이에요. 오늘 열렸대요.") == "출처: 공식 포럼이에요. 오늘 열렸대요."
