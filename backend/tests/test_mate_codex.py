"""Codex as a Mate engine: the store accepts it, configure_engine seals it
(own CODEX_HOME with only the instructions + the mate MCP bridge, none of
Codex's tools, none of the user's ~/.codex), turns run/resume/reset through
the real session code against a fake codex CLI, delegation results reach it,
and switching engine mid-conversation hands the conversation over. Also the
Codex default model (GPT-6.1-Sol) for chats and mates."""

from __future__ import annotations

import json
import os
import stat
import sys
import textwrap
from pathlib import Path

import pytest

from app.mate.service import MateService
from app.mate.store import MateError, MateStore, normalize_llm
from app.providers import _codex_sealed, catalog
from app.providers.base import TurnRequest
from app.providers.claude_code import ClaudeCodeProvider
from app.providers.codex import CodexProvider
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from tests.test_engine import FAKE, _until

FAKE_CODEX = r'''
import json, os, sys
args = sys.argv[1:]
prompt = sys.stdin.read()
home = os.environ.get("CODEX_HOME", "")
cfg = open(os.path.join(home, "config.toml")).read() if home and os.path.exists(os.path.join(home, "config.toml")) else ""
log = open("__FAKE_DIR__/codex.log", "a")
log.write(json.dumps({"argv": args, "prompt": prompt, "codex_home": home, "home": os.environ.get("HOME"),
                      "config": cfg, "cwd": os.getcwd()}) + "\n"); log.close()
n = sum(1 for _ in open("__FAKE_DIR__/codex.log"))
if args[:2] != ["exec", "resume"]:
    print(json.dumps({"type": "thread.started", "thread_id": f"th-{n}"}), flush=True)
print(json.dumps({"type": "turn.started"}), flush=True)
last = [ln for ln in prompt.strip().splitlines() if ln.strip()][-1]
print(json.dumps({"type": "item.completed", "item": {"id": "m1", "type": "agent_message", "text": "[smile] codex: " + last}}), flush=True)
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 7, "cached_input_tokens": 2, "output_tokens": 3}}), flush=True)
'''

MODELS_CACHE = {"fetched_at": "x", "models": [
    {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1-Sol", "tool_mode": "code_mode_only", "multi_agent_version": "v2",
     "apply_patch_tool_type": "freeform", "experimental_supported_tools": ["clock"], "supports_search_tool": True,
     "context_window": 500000},
]}


def _user_codex(tmp_path: Path) -> Path:
    """A user ~/.codex with things a mate must never load."""
    home = tmp_path / "userhome"
    codex = home / ".codex"
    codex.mkdir(parents=True)
    (codex / "auth.json").write_text('{"auth_mode": "chatgpt"}')
    (codex / "config.toml").write_text('[mcp_servers.user_canary]\ncommand = "canary"\n')
    (codex / "AGENTS.md").write_text("USER AGENTS CANARY")
    (codex / "models_cache.json").write_text(json.dumps(MODELS_CACHE))
    return home


def _setup(db, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(_user_codex(tmp_path)))
    claude = tmp_path / "claude"
    claude.write_text(f"#!{sys.executable}\n" + textwrap.dedent(FAKE).replace("__FAKE_DIR__", str(tmp_path)))
    codex = tmp_path / "codex"
    codex.write_text(f"#!{sys.executable}\n" + textwrap.dedent(FAKE_CODEX).replace("__FAKE_DIR__", str(tmp_path)))
    for f in (claude, codex):
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: CodexProvider(binary=str(codex)) if name == "codex"
                        else ClaudeCodeProvider(binary=str(claude)))
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    store = MateStore(db, vault)
    return svc, store, MateService(svc, store)


def _codex_calls(tmp_path):
    p = tmp_path / "codex.log"
    return [json.loads(line) for line in open(p)] if p.exists() else []


def _ended(m):
    return m["type"] == "run.state" and not m["data"]["running"]


async def _turn(svc, q, sid, text):
    svc.start_turn(sid, text)
    return await _until(q, _ended)


# ---- store / defaults ----

def test_normalize_llm_accepts_codex_with_its_own_default_model():
    assert normalize_llm({"provider": "codex"}) == {"provider": "codex", "model": "gpt-6.1-sol", "effort": "low"}
    assert normalize_llm({"provider": "codex", "model": "gpt-6-luna", "effort": "medium"})["model"] == "gpt-6-luna"
    base = {"provider": "codex", "model": "gpt-6-luna", "effort": "high"}
    assert normalize_llm({"effort": "low"}, base)["model"] == "gpt-6-luna"  # no engine change: model kept
    assert normalize_llm({"provider": "claude"}, base)["model"] == "claude-sonnet-5-5"
    assert normalize_llm({"provider": "codex"}, base)["model"] == "gpt-6-luna"  # same engine: kept
    with pytest.raises(MateError):
        normalize_llm({"provider": "gemini"})


def test_codex_default_model_is_gpt_6_1_sol(db, monkeypatch):
    assert catalog.DEFAULT_CODEX_MODEL == "gpt-6.1-sol" and catalog.DEFAULT_CLAUDE_MODEL == "claude-opus-5-5"
    assert catalog.default_mate_model("codex") == "gpt-6.1-sol"
    assert catalog.default_mate_model("claude") == "claude-sonnet-5-5"
    static = catalog._STATIC["codex"]
    assert static["default_model"] == "gpt-6.1-sol" and static["models"][0]["label"] == "GPT-6.1-Sol"
    # live list: Sol is the default even when the account lists another model first
    monkeypatch.setattr(catalog, "_fetch_codex_models", lambda d: [
        {"id": "gpt-6-astra", "label": "GPT-6-Astra"}, {"id": "gpt-6.1-sol", "label": "GPT-6.1-Sol"}])
    catalog._cache.pop("codex", None)
    try:
        assert catalog._codex_catalog("/nope")["default_model"] == "gpt-6.1-sol"
        catalog._cache.pop("codex", None)
        monkeypatch.setattr(catalog, "_fetch_codex_models", lambda d: [{"id": "gpt-6-astra", "label": "A"}])
        assert catalog._codex_catalog("/nope")["default_model"] == "gpt-6-astra"  # not offered: account default
    finally:
        catalog._cache.pop("codex", None)
    # a new Codex chat without a model runs on Sol (Claude: Opus 5.5); "default" stays the account's default
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    assert svc.create(provider="codex", model="", workspace_path="/tmp")["model"] == "gpt-6.1-sol"
    assert svc.create(provider="codex", model="default", workspace_path="/tmp")["model"] == "default"
    assert svc.create(provider="claude", model="", workspace_path="/tmp")["model"] == "claude-opus-5-5"


# ---- the sealed engine ----

def test_configure_engine_seals_a_codex_mate(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    m = store.create(name="Sol", persona={"language": "en"}, llm={"provider": "codex", "effort": "low"})
    conv = mates.conversation(m["id"])
    session = conv["session"]
    assert session["provider"] == "codex" and session["model"] == "gpt-6.1-sol"
    req = TurnRequest(messages=[{"role": "user", "content": "hi"}], model=session["model"], cwd=session["workspace_path"],
                      cli_session_id=None)
    mates.configure_engine(session, req)
    assert req.sealed and req.tools == [] and req.extra_dirs == [] and req.mode == "agent"
    assert req.model == "gpt-6.1-sol" and req.effort == "low"
    assert req.engine_home and Path(req.engine_home).parent.name == m["id"]
    assert open(req.system_prompt_file).read().startswith("You are Sol")
    assert list(req.mcp_config["mcpServers"]) == ["mate"] and req.mcp_config_file is None

    argv = CodexProvider()._build_argv(req)
    assert argv[:2] == ["exec", "--json"] and argv[-1] == "-"
    assert "--dangerously-bypass-approvals-and-sandbox" not in argv
    assert argv[argv.index("-m") + 1] == "gpt-6.1-sol" and "model_reasoning_effort=low" in argv
    assert not any(a.startswith("mcp_servers.") for a in argv)  # (in the 0600 config: no token in argv)
    token = req.mcp_config["mcpServers"]["mate"]["env"]["HRH_MATE_TOKEN"]
    assert token not in " ".join(argv)

    source = Path(os.environ["HOME"]) / ".codex"
    env, warnings = _codex_sealed.prepare(req, str(source))
    home = Path(req.engine_home)
    assert env == {"CODEX_HOME": str(home), "HOME": str(home)} and warnings == []
    cfg = (home / "config.toml").read_text()
    assert oct((home / "config.toml").stat().st_mode & 0o777) == "0o600"
    assert f'model_instructions_file = "{req.system_prompt_file}"' in cfg
    assert 'approval_policy = "never"' in cfg and 'sandbox_mode = "read-only"' in cfg
    assert 'web_search = "disabled"' in cfg and "project_doc_max_bytes = 0" in cfg
    for f in ("shell_tool", "unified_exec", "view_image", "image_generation", "memories", "plugins", "hooks",
              "multi_agent", "apps"):
        assert f"\n{f} = false\n" in cfg
    assert "[mcp_servers.mate]" in cfg and 'default_tools_approval_mode = "approve"' in cfg
    assert cfg.count("[mcp_servers.") == 1 and "user_canary" not in cfg and token in cfg
    # the user's login, linked (refreshes write through to it); nothing else of ~/.codex
    assert (home / "auth.json").is_symlink() and os.readlink(home / "auth.json") == str(source / "auth.json")
    assert not (home / "AGENTS.md").exists() and sorted(p.name for p in home.iterdir()) == [
        "auth.json", "config.toml", "sealed-models.json"]
    sealed = json.loads((home / "sealed-models.json").read_text())["models"][0]
    assert sealed["slug"] == "gpt-6.1-sol" and sealed["apply_patch_tool_type"] is None
    assert "tool_mode" not in sealed and "multi_agent_version" not in sealed
    assert sealed["experimental_supported_tools"] == [] and sealed["supports_search_tool"] is False
    assert f'model_catalog_json = "{home / "sealed-models.json"}"' in cfg

    # a pooled account's CODEX_HOME: its auth.json instead; signed out -> no stale link
    acct = tmp_path / "acct" / ".codex"
    acct.mkdir(parents=True)
    (acct / "auth.json").write_text("{}")
    _codex_sealed.prepare(req, str(acct))
    assert os.readlink(home / "auth.json") == str(acct / "auth.json")
    (acct / "auth.json").unlink()
    _env, warnings = _codex_sealed.prepare(req, str(acct))
    assert not (home / "auth.json").exists() and not (home / "auth.json").is_symlink()
    assert warnings and not (home / "sealed-models.json").exists()  # (no model list in that account's home)


def test_no_model_cache_still_seals_with_a_warning(tmp_path):
    req = TurnRequest(messages=[], model="gpt-6.1-sol", cwd=str(tmp_path), sealed=True,
                      engine_home=str(tmp_path / "eng"), system_prompt_file=str(tmp_path / "p.md"))
    (tmp_path / "src").mkdir()
    _env, warnings = _codex_sealed.prepare(req, str(tmp_path / "src"))
    cfg = (tmp_path / "eng" / "config.toml").read_text()
    assert warnings and "model_catalog_json" not in cfg and 'sandbox_mode = "read-only"' in cfg
    assert "[mcp_servers." not in cfg


def test_codex_instructions_stay_put_while_only_the_mates_own_memories_change(db, tmp_path, monkeypatch):
    """A resumed thread gets the whole prompt again each time the file changes:
    keep it while the prompt key holds (the mate's own `remember`), like the
    Claude engine that keeps running."""
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    m = store.create(name="Sol", llm={"provider": "codex"})
    session = mates.conversation(m["id"])["session"]

    def prompt(resume):
        req = TurnRequest(messages=[], model="", cwd=session["workspace_path"], cli_session_id=resume)
        mates.configure_engine(session, req)
        return open(req.system_prompt_file).read()

    first = prompt(None)
    store.add_memory(m["id"], "likes tea")  # the mate remembering mid-conversation
    assert prompt("th-1") == first
    assert "likes tea" in prompt(None)  # a fresh thread: everything current
    mates.update(m["id"], {"persona": {"address": "boss"}})
    assert "boss" in prompt("th-1")  # a persona edit: the new prompt


# ---- turns through the session code ----

async def test_codex_mate_turns_resume_reset_and_delegation(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    proj = tmp_path / "proj"
    proj.mkdir()
    worker = svc.create(provider="claude", model="w1", workspace_path=str(proj), title="proj")["id"]
    m = store.create(name="Sol", persona={"greeting": "hello!"}, llm={"provider": "codex"})
    msid = mates.conversation(m["id"])["session_id"]
    qm, qw = svc.subscribe(msid), svc.subscribe(worker)
    try:
        seen = await _turn(svc, qm, msid, "hi there")
        done = next(x for x in seen if x["type"] == "turn.complete")["data"]
        assert done["text"] == "[smile] codex: hi there" and done["cli_session_id"] == "th-1"
        call = _codex_calls(tmp_path)[-1]
        home = str(Path(call["codex_home"]))
        assert call["argv"][:2] == ["exec", "--json"] and home.endswith(f"{m['id']}/codex")
        assert call["home"] == home and "user_canary" not in call["config"] and "[mcp_servers.mate]" in call["config"]
        assert "--dangerously-bypass-approvals-and-sandbox" not in call["argv"]

        await _turn(svc, qm, msid, "second")
        call = _codex_calls(tmp_path)[-1]
        assert call["argv"][:3] == ["exec", "resume", "th-1"] and call["prompt"].startswith("<context>\nNow: ") \
            and call["prompt"].split("</context>", 1)[1].strip() == "second"

        # a delegation: the worker's answer comes back as an internal turn of the Codex mate
        ctx = mates.token_info(mates._token(m["id"], msid))
        text, err = await mates.call_tool(ctx, "send_to_session", {"session_id": worker, "message": "say pong"})
        assert not err
        await _until(qw, _ended)
        mseen = await _until(qm, _ended)
        res = next(x for x in mseen if x["type"] == "user.message")["data"]
        assert res["internal"] is True and res["kind"] == "delegation_result"
        call = _codex_calls(tmp_path)[-1]
        assert call["argv"][:3] == ["exec", "resume", "th-1"]
        assert "<delegation_result" in call["prompt"] and "echo[w1]: say pong" in call["prompt"]

        mates.reset(m["id"])
        await _turn(svc, qm, msid, "fresh start")
        call = _codex_calls(tmp_path)[-1]
        assert call["argv"][:2] == ["exec", "--json"]  # a new thread
        assert "hi there" not in call["prompt"]  # (nothing handed over after a reset)
    finally:
        await svc.shutdown()


async def test_switching_engine_keeps_the_conversation(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    m = store.create(name="Rin", llm={"model": "m1"})  # Claude
    msid = mates.conversation(m["id"])["session_id"]
    q = svc.subscribe(msid)
    try:
        await _turn(svc, q, msid, "my cat is called Nabi")
        mates.update(m["id"], {"llm": {"provider": "codex"}})
        s = svc.get(msid)
        assert s["provider"] == "codex" and s["model"] == "gpt-6.1-sol"
        seen = await _turn(svc, q, msid, "what is my cat called?")
        assert any(x["type"] == "notice" and x["data"].get("code") == "context.handoff" for x in seen)
        call = _codex_calls(tmp_path)[-1]
        assert call["argv"][:2] == ["exec", "--json"] and "my cat is called Nabi" in call["prompt"]
        assert "echo[m1]: my cat is called Nabi" in call["prompt"]  # the Claude mate's answer too

        mates.update(m["id"], {"llm": {"provider": "claude", "model": "m1"}})
        assert svc.get(msid)["provider"] == "claude"
        seen = await _turn(svc, q, msid, "and back")
        # Claude resumes its own session and is caught up on the Codex turn
        assert any(x["type"] == "notice" and x["data"].get("code") == "context.catchup" for x in seen)
    finally:
        await svc.shutdown()
