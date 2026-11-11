"""A tool server the engine couldn't start is said in the chat (SessionService._tools_failed_notice): once, until that
changes — not a model working on without its tools unseen (a mate wrote her calls out as text)."""

import asyncio

import pytest

import app.services.session_service as ss_mod
from app.providers.base import ProviderEvent
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


class Engine:
    """starts with what Claude Code's init says about its MCP servers, then answers"""

    def __init__(self):
        self.servers = []

    async def run_turn_stream(self, req):
        yield ProviderEvent(type="session.start", data={"provider": "claude", "model": "fake"})
        yield ProviderEvent(type="session.info", data={"model": "fake", "mcp_servers": self.servers})
        yield ProviderEvent(type="turn.complete", data={"text": "ok", "model": "fake", "cost_usd": 0.01, "cost_kind": "turn"})


@pytest.fixture
def chat(db, tmp_path, monkeypatch):
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    svc.persistent_engines = False
    engine = Engine()
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: engine)
    sid = svc.create(provider="claude", workspace_path=str(tmp_path), title="Tools")["id"]
    return svc, sid, engine


def _turn(svc, sid, text):
    async def run():
        svc.start_turn(sid, text)
        await svc._tasks[sid]
    asyncio.run(run())
    return [e["data"] for e in svc.events(sid) if e["type"] == "notice" and e["data"].get("code") == "mcp.failed"]


def test_said_once_until_it_changes(chat):
    svc, sid, engine = chat
    engine.servers = [{"name": "mate", "status": "failed"}, {"name": "screen", "status": "connected"}]
    [note] = _turn(svc, sid, "one")
    assert note["servers"] == ["mate"] and note["level"] == "warning" and "mate" in note["message"]
    assert len(_turn(svc, sid, "two")) == 1, "the same failure is not said again every turn"
    engine.servers = [{"name": "mate", "status": "connected"}]
    assert len(_turn(svc, sid, "three")) == 1, "nothing to say once it starts"
    engine.servers = [{"name": "mate", "status": "failed"}]
    assert len(_turn(svc, sid, "four")) == 2, "failing again after it worked is said again"


def test_nothing_when_all_start(chat):
    svc, sid, engine = chat
    engine.servers = [{"name": "mate", "status": "connected"}, {"name": "x", "status": "pending"}]
    assert _turn(svc, sid, "one") == []
