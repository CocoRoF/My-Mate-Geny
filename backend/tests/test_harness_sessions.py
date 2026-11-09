"""API-key chats through the whole session layer: keys from the account pool (balanced, failed over), turns that go on,
rewind and copy like Claude Code / Codex chats, Stop keeps what was spent, background work in the task list — and the
Settings endpoints for keys and models."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.harness import engine as engine_mod
from app.harness import runtime
from app.harness.models import ModelCatalog
from app.providers.accounts import AccountPool, AccountStore
from app.services.attachment_service import AttachmentService
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from tests.fake_vendors import MODELS, Server


@pytest.fixture(scope="module")
def server():
    s = Server().start()
    yield s
    s.stop()


@pytest.fixture
def stack(db, server, monkeypatch, tmp_path):
    for vendor, url in server.urls().items():
        monkeypatch.setenv(f"HRH_{vendor.upper()}_BASE_URL", url)
    from app.harness.llm import anthropic_api, google_api, openai_api

    for mod in (anthropic_api, google_api, openai_api):
        mod._clients.clear()
    server.fake.reset()
    monkeypatch.setattr(engine_mod, "_pause", lambda s: asyncio.sleep(0))
    from app.config import settings

    monkeypatch.setattr(settings, "uploads_root", str(tmp_path / "uploads"))
    vault = SecretVault(db)
    store = AccountStore(db, vault)
    pool = AccountPool(store)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)), pool=pool,
                         attachments=AttachmentService(db))
    cat = ModelCatalog(db)
    cat.merge("anthropic", [{"id": m["id"], "label": m["display_name"], "context_window": m["max_input_tokens"]}
                            for m in MODELS["anthropic"]])
    cat.merge("openai", [{"id": m, "label": m} for m in MODELS["openai"]])
    return svc, store, pool, server.fake, tmp_path


@pytest.fixture(autouse=True)
async def _clean():
    yield
    await runtime.shutdown_all()


def key(store, provider, label, secret):
    return store.create(provider, label=label, auth_mode="api_key", api_key=secret)


async def say(svc, sid, text, **kw):
    svc.start_turn(sid, text, **kw)
    await svc._tasks[sid]
    return next(m for m in reversed(svc.messages(sid)) if m["role"] == "user" and m["content"] == text)["id"]


def chat(svc, tmp, provider="anthropic", model=""):
    return svc.create(provider=provider, model=model, workspace_path=str(tmp), title="API chat")["id"]


async def test_an_api_chat_runs_on_a_pool_key_and_remembers_where_it_stands(stack):
    svc, store, pool, fake, tmp = stack
    key(store, "anthropic", "Work key", "sk-ant-1")
    sid = chat(svc, tmp)
    assert svc.get(sid)["model"] == "claude-opus-5-5"  # (the catalog's first switched-on model)
    fake.script("anthropic", {"blocks": [{"type": "text", "text": "Hello from the API."}]})
    await say(svc, sid, "hi")
    msgs = svc.messages(sid)
    assert [m["role"] for m in msgs] == ["user", "assistant"] and msgs[-1]["content"] == "Hello from the API."
    state = svc.get(sid)["cli_sessions"]["anthropic"]
    assert state["id"].startswith("hs_")
    done = [e for e in svc.events(sid) if e["type"] == "turn.complete"][-1]["data"]
    assert done["provider"] == "anthropic" and done["cost_kind"] == "turn" and done["cost_usd"] > 0
    start = [e for e in svc.events(sid) if e["type"] == "session.start"][-1]["data"]
    assert start["account"] == "Work key"
    fake.script("anthropic", {"blocks": [{"type": "text", "text": "Still here."}]})
    await say(svc, sid, "again")
    assert "Hello from the API." in json.dumps(fake.requests["anthropic"][-1]["messages"])


async def test_without_a_key_the_turn_says_where_to_add_one(stack):
    svc, _store, _pool, _fake, tmp = stack
    sid = chat(svc, tmp)
    await say(svc, sid, "hi")
    err = [e for e in svc.events(sid) if e["type"] == "error"][-1]["data"]
    assert err["code"] == "account.unavailable" and "Settings → Providers → Anthropic" in err["message"]


async def test_a_limited_key_hands_over_and_the_chat_stays_on_the_next(stack):
    svc, store, pool, fake, tmp = stack
    a = key(store, "openai", "A", "sk-a")
    b = key(store, "openai", "B", "sk-b")
    store.set_pool("openai", strategy="round_robin")
    sid = chat(svc, tmp, "openai")
    fake.script("openai", {"error": {"status": 429, "message": "Rate limit reached", "type": "rate_limit_error",
                                     "retry_after": 120}},
                {"blocks": [{"type": "text", "text": "Done on the other key."}]})
    await say(svc, sid, "hi")
    events = svc.events(sid)
    assert [e for e in events if e["type"] == "turn.complete"][-1]["data"]["text"] == "Done on the other key."
    assert any(e["type"] == "notice" and e["data"]["code"] == "account.failover" for e in events)
    used = fake.keys["openai"]
    first, second = used[0], used[-1]
    assert first != second
    limited = a if first == "sk-a" else b
    assert store.get(limited["id"])["status"] == "cooldown"
    sticky = svc.get(sid)["accounts"]["openai"]["id"]
    assert sticky == (b if limited is a else a)["id"]


async def test_rewind_and_copy_continue_from_the_right_point(stack):
    svc, store, _pool, fake, tmp = stack
    key(store, "anthropic", "K", "sk-k")
    sid = chat(svc, tmp)
    for text in ("PLUM", "KIWI"):
        fake.script("anthropic", {"blocks": [{"type": "text", "text": f"noted {text}"}]})
    await say(svc, sid, "remember PLUM")
    two = await say(svc, sid, "remember KIWI")
    await svc.timeline.rewind(sid, two)
    fake.script("anthropic", {"blocks": [{"type": "text", "text": "PLUM"}]})
    await say(svc, sid, "what do you remember?")
    sent = json.dumps(fake.requests["anthropic"][-1]["messages"])
    assert "remember PLUM" in sent and "remember KIWI" not in sent
    copy = await svc.timeline.copy(sid)
    fake.script("anthropic", {"blocks": [{"type": "text", "text": "copy"}]})
    await say(svc, copy["id"], "in the copy")
    sent = json.dumps(fake.requests["anthropic"][-1]["messages"])
    assert "what do you remember?" in sent and "remember KIWI" not in sent
    assert svc.get(copy["id"])["cli_sessions"]["anthropic"]["id"] != svc.get(sid)["cli_sessions"]["anthropic"]["id"]


async def test_stop_keeps_what_the_turn_spent(stack):
    svc, store, _pool, fake, tmp = stack
    key(store, "anthropic", "K", "sk-k")
    sid = chat(svc, tmp)
    fake.script("anthropic", {"blocks": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "sleep 30"}}],
                              "usage": {"input": 2000, "output": 100}})
    svc.start_turn(sid, "long")
    for _ in range(100):
        if any(e["type"] == "tool.use" for e in svc.events(sid)):
            break
        await asyncio.sleep(0.05)
    svc.stop(sid)
    await svc._tasks.get(sid) or asyncio.sleep(0)
    for _ in range(50):
        if sid not in svc._tasks:
            break
        await asyncio.sleep(0.05)
    stopped = [e for e in svc.events(sid) if e["type"] == "error"][-1]["data"]
    assert stopped["code"] == "turn.interrupted" and stopped["usage"]["output_tokens"] == 100
    assert stopped["cost_kind"] == "turn" and stopped["cost_usd"] > 0 and stopped["provider"] == "anthropic"


async def test_background_work_is_in_the_task_list(stack):
    svc, store, _pool, fake, tmp = stack
    key(store, "anthropic", "K", "sk-k")
    sid = chat(svc, tmp)
    fake.script("anthropic", {"blocks": [{"type": "tool_use", "id": "bg1", "name": "Bash",
                                          "input": {"command": "sleep 0.2; echo ok", "run_in_background": True,
                                                    "description": "a short job"}}]},
                {"blocks": [{"type": "text", "text": "Started it."}]},
                {"blocks": [{"type": "text", "text": "It finished fine."}]})
    await say(svc, sid, "start a job")
    rows = svc._db.query("SELECT * FROM bg_tasks WHERE session_id = ?", (sid,))
    assert rows and rows[0]["task_type"] == "local_bash" and rows[0]["description"] == "a short job"
    for _ in range(100):  # (it ends while no turn runs: the chat goes on by itself)
        if any(m["content"] == "It finished fine." for m in svc.messages(sid)):
            break
        await asyncio.sleep(0.05)
    assert svc._db.query_one("SELECT status FROM bg_tasks WHERE session_id = ?", (sid,))["status"] == "completed"
    assert any(m["content"] == "It finished fine." for m in svc.messages(sid))
    assert "task-notification" in json.dumps(fake.requests["anthropic"][-1]["messages"])


async def test_deleting_the_chat_deletes_its_conversation(stack):
    svc, store, _pool, fake, tmp = stack
    key(store, "anthropic", "K", "sk-k")
    sid = chat(svc, tmp)
    await say(svc, sid, "hi")
    hs = svc.get(sid)["cli_sessions"]["anthropic"]["id"]
    svc.delete(sid)
    assert svc._db.query_one("SELECT 1 FROM harness_sessions WHERE id = ?", (hs,)) is None


# ---- Settings endpoints ----

def test_keys_and_models_through_the_api(server, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    for vendor, url in server.urls().items():
        monkeypatch.setenv(f"HRH_{vendor.upper()}_BASE_URL", url)
    server.fake.reset()
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        r = c.post("/api/providers/google/keys", json={"label": "Studio", "api_key": "AIza-test-key"}).json()
        assert r["check"]["ok"] and r["check"]["generation"]["ok"] and r["catalog"]["total"] == 3
        assert r["account"]["label"] == "Studio" and r["account"]["auth_mode"] == "api_key"
        models = c.get("/api/providers/google/models").json()["models"]
        on = [m["id"] for m in models if m["enabled"]]
        assert on == ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.5-flash-lite"]
        assert all(m["price_source"] == "list" for m in models)
        r = c.patch("/api/providers/google/models/gemini-3.5-flash-lite", json={"enabled": False,
                                                                               "price": {"input": 1, "output": 2}})
        assert r.json()["enabled"] is False and r.json()["price"] == {"input": 1.0, "output": 2.0}
        cfg = c.get("/api/config").json()
        assert [m["id"] for m in cfg["catalog"]["google"]["models"]] == ["gemini-4-argon", "gemini-3.8-flash"]
        status = {p["provider"]: p for p in c.get("/api/providers").json()}
        assert status["google"]["connected"] and not status["openai"]["connected"]
        server.fake.bad_keys.add("AIza-bad-key")
        bad = c.post("/api/providers/google/keys", json={"label": "Old", "api_key": "AIza-bad-key"}).json()
        assert not bad["check"]["ok"] and bad["check"]["kind"] == "auth"
        pool = c.get("/api/providers/google/pool").json()
        assert {a["label"]: a["status"] for a in pool["accounts"]} == {"Studio": "ready", "Old": "expired"}
        assert not any(a.get("primary") for a in pool["accounts"])
        assert c.get("/api/usage/subscription?provider=google").json()["available"] is False


# ---- mates ----

async def test_a_mate_can_think_on_an_api_key(stack):
    from app.mate.service import MateService
    from app.mate.store import MateStore, normalize_llm

    svc, store, _pool, fake, _tmp = stack
    key(store, "anthropic", "K", "sk-k")
    assert normalize_llm({"provider": "anthropic"})["model"] == "claude-sonnet-5-5"  # (the mid model, switched on)
    mates = MateService(svc, MateStore(svc._db, SecretVault(svc._db)))
    mate = mates.store.create(name="Mio")
    mates.store.update(mate["id"], {"llm": {"provider": "anthropic"}})
    sid = mates.conversation(mate["id"])["session_id"]
    assert svc.get(sid)["provider"] == "anthropic"
    fake.script("anthropic", {"blocks": [{"type": "text", "text": "Hi, I'm Mio."}]})
    await say(svc, sid, "hello")
    body = fake.requests["anthropic"][-1]
    assert body["model"] == "claude-sonnet-5-5"
    assert "Mio" in body["system"][0]["text"]
    names = [t["name"] for t in body.get("tools", [])]
    assert names and all(n.startswith("mcp__mate__") for n in names)  # (only her own tools)
    assert svc.messages(sid)[-1]["content"] == "Hi, I'm Mio."
