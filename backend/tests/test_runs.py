"""Background turns, stop, event ordering, provider parsing/argv."""
import asyncio
import json

import pytest

from app.providers import _codex_json, catalog
from app.providers.base import ProviderEvent, TurnRequest
from app.providers.claude_code import ClaudeCodeProvider
from app.providers.codex import CodexProvider
from app.providers._stream_json import StreamJsonAccumulator
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService, TurnBusyError
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


def _svc(db):
    vault = SecretVault(db)
    return SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))


class SlowProvider:
    """Fake provider: one tool call, then waits (so the test can Stop it)."""

    name = "claude"

    def __init__(self, hold: float = 30.0) -> None:
        self.hold = hold

    async def run_turn_stream(self, req):
        yield ProviderEvent(type="session.start", data={"model": "fake"})
        yield ProviderEvent(type="tool.use", data={"id": "t1", "name": "Bash", "input": {"command": "ls"}}, seq=1)
        yield ProviderEvent(type="tool.result", data={"id": "t1", "output": "ok", "is_error": False}, seq=2)
        await asyncio.sleep(self.hold)
        yield ProviderEvent(type="turn.complete", data={"text": "done", "cli_session_id": "cli-1"}, seq=3)


def test_events_are_ordered_by_insertion_not_seq(db, tmp_path):
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path))
    for turn in range(2):  # seq restarts every turn
        for seq, typ in enumerate(["session.start", "text.delta", "turn.complete"]):
            svc._add_event(s["id"], ProviderEvent(type=typ, data={"turn": turn}, seq=seq))
    types = [(e["type"], e["data"]["turn"]) for e in svc.events(s["id"])]
    assert types == [("session.start", 0), ("text.delta", 0), ("turn.complete", 0),
                     ("session.start", 1), ("text.delta", 1), ("turn.complete", 1)]
    first_eid = svc.events(s["id"])[2]["eid"]
    assert [e["data"]["turn"] for e in svc.events(s["id"], after=first_eid)] == [1, 1, 1]


async def test_background_turn_streams_and_stop_interrupts(db, tmp_path, monkeypatch):
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: SlowProvider())
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path), title=tmp_path.name)
    q = svc.subscribe(s["id"])
    svc.start_turn(s["id"], "list files please", client_msg_id="c1")
    with pytest.raises(TurnBusyError):
        svc.start_turn(s["id"], "again")

    seen = []
    while not any(m.get("type") == "tool.result" for m in seen):
        seen.append(await asyncio.wait_for(q.get(), timeout=5))
    kinds = [m["type"] for m in seen]
    assert kinds[:2] == ["run.state", "user.message"]
    assert seen[1]["data"]["client_msg_id"] == "c1"
    assert all("eid" in m for m in seen if m["type"] in ("tool.use", "tool.result"))
    assert svc.get(s["id"])["running"] is True
    assert svc.get(s["id"])["title"] == "list files please"  # auto-titled from the first message

    assert svc.stop(s["id"]) is True
    while True:
        m = await asyncio.wait_for(q.get(), timeout=5)
        if m["type"] == "run.state":
            assert m["data"]["running"] is False
            break
        last = m
    assert last["type"] == "error" and last["data"]["code"] == "turn.interrupted"
    assert svc.events(s["id"])[-1]["data"]["code"] == "turn.interrupted"  # persisted for reloads
    assert svc.is_running(s["id"]) is False


async def test_reset_context_clears_cli_session(db, tmp_path):
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path))
    svc._set_cli_session(s["id"], "cli-xyz")
    svc.reset_context(s["id"])
    assert svc.get(s["id"])["cli_session_id"] is None
    assert svc.events(s["id"])[-1]["data"]["code"] == "context.reset"


def test_extra_dirs_validated_for_local_sessions(db, tmp_path):
    svc = _svc(db)
    s = svc.create(provider="claude", workspace_path=str(tmp_path))
    (tmp_path / "other").mkdir()
    out = svc.update(s["id"], extra_dirs=[str(tmp_path / "other"), str(tmp_path / "other")])
    assert out["extra_dirs"] == [str(tmp_path / "other")]  # de-duplicated
    with pytest.raises(ValueError):
        svc.update(s["id"], extra_dirs=[str(tmp_path / "nope")])
    with pytest.raises(ValueError):
        svc.update(s["id"], mode="yolo")
    assert svc.update(s["id"], mode="plan")["mode"] == "plan"


# ---- claude ----

def test_claude_modes_and_extra_dirs(tmp_path):
    p = ClaudeCodeProvider()
    req = TurnRequest(messages=[{"role": "user", "content": "x"}], model="sonnet", cwd=str(tmp_path),
                      extra_dirs=["/data/a", "/data/b"])
    argv = p._build_argv(req)
    assert argv[argv.index("--permission-mode") + 1] == "bypassPermissions"
    i = argv.index("--add-dir")
    assert argv[i + 1: i + 3] == ["/data/a", "/data/b"]
    req.mode = "plan"
    argv = p._build_argv(req)
    assert argv[argv.index("--permission-mode") + 1] == "plan"


def test_claude_init_becomes_session_info_and_api_error_is_error():
    acc = StreamJsonAccumulator()
    evs = list(acc.feed({"type": "system", "subtype": "init", "session_id": "s1", "model": "m",
                         "slash_commands": ["compact", "review"], "mcp_servers": [{"name": "x", "status": "connected"}],
                         "tools": ["Bash"]}))
    assert evs[0].type == "session.info" and evs[0].data["slash_commands"] == ["compact", "review"]
    evs = list(acc.feed({"type": "result", "subtype": "success", "is_error": True,
                         "result": "Claude AI usage limit reached"}))
    assert evs[0].type == "error" and "usage limit" in evs[0].data["message"]


# ---- codex ----

def _codex_lines(*objs):
    acc = _codex_json.CodexJsonAccumulator()
    out = []
    for o in objs:
        out += list(acc.feed_line(json.dumps(o).encode()))
    return acc, out


def test_codex_warning_item_is_a_notice_not_a_terminal_error():
    acc, evs = _codex_lines(
        {"type": "thread.started", "thread_id": "th1"},
        {"type": "item.completed", "item": {"id": "e0", "type": "error",
                                             "message": "Model metadata for `x` not found."}},
        {"type": "item.started", "item": {"id": "i1", "type": "command_execution", "command": "ls"}},
        {"type": "item.completed", "item": {"id": "i1", "type": "command_execution", "command": "ls",
                                             "aggregated_output": "a.txt\n", "exit_code": 0}},
        {"type": "item.completed", "item": {"id": "i2", "type": "file_change",
                                             "changes": [{"path": "/w/b.txt", "kind": "add"}], "status": "completed"}},
        {"type": "item.updated", "item": {"id": "m1", "type": "agent_message", "text": "do"}},
        {"type": "item.completed", "item": {"id": "m1", "type": "agent_message", "text": "done"}},
        {"type": "turn.completed", "usage": {"input_tokens": 10}},
    )
    types = [e.type for e in evs]
    assert types[0] == "notice" and "error" not in types
    assert [e.data["name"] for e in evs if e.type == "tool.use"] == ["shell", "apply_patch"]
    assert "".join(e.data["text"] for e in evs if e.type == "text.delta") == "done"  # no duplication
    term = acc.terminal(model="gpt-6-luna", cli_session_id=None)
    assert term.type == "turn.complete" and term.data["cli_session_id"] == "th1"
    assert term.data["model"] == "gpt-6-luna"


def test_codex_failed_turn_is_error():
    acc, _ = _codex_lines({"type": "turn.failed", "error": {"message": "model not supported"}})
    term = acc.terminal(model="m", cli_session_id=None)
    assert term.type == "error" and term.data["message"] == "model not supported"


def test_codex_resume_argv_has_no_unsupported_flags(tmp_path):
    p = CodexProvider()
    req = TurnRequest(messages=[{"role": "user", "content": "hi"}], model="default", cwd=str(tmp_path),
                      cli_session_id="th1", mode="plan")
    argv = p._build_argv(req)
    assert argv[:3] == ["exec", "resume", "th1"]
    assert "-C" not in argv and "--sandbox" not in argv and "--add-dir" not in argv
    assert 'sandbox_mode="read-only"' in argv
    assert "-m" not in argv  # "default" -> let Codex choose
    assert argv[-1] == "-"


def test_codex_unknown_model_falls_back_to_default(tmp_path):
    catalog._store("codex", [{"id": "gpt-6-luna", "label": "GPT-6-Luna"}])
    try:
        p = CodexProvider()
        req = TurnRequest(messages=[{"role": "user", "content": "hi"}], model="gpt-5-codex", cwd=str(tmp_path))
        assert "-m" not in p._build_argv(req)
        req.model = "gpt-6-luna"
        argv = p._build_argv(req)
        assert argv[argv.index("-m") + 1] == "gpt-6-luna"
    finally:
        catalog._cache.pop("codex", None)


# ---- pooled accounts share everything but credentials ----

def test_link_shared_state(tmp_path, monkeypatch):
    from app.providers import accounts

    monkeypatch.setenv("HOME", str(tmp_path))
    host = tmp_path / ".claude"
    (host / "projects" / "p1").mkdir(parents=True)
    (host / "skills").mkdir()
    (host / "CLAUDE.md").write_text("host rules")
    (host / ".credentials.json").write_text("HOST-CREDS")
    (tmp_path / ".claude.json").write_text(json.dumps({"mcpServers": {"x": {"command": "y"}}}))

    acc = "acct_test"
    cfg = accounts.account_config_dir("claude", acc)
    (cfg / "projects" / "p1").mkdir(parents=True)
    (cfg / "projects" / "p1" / "old-session.jsonl").write_text("{}")
    (cfg / ".credentials.json").write_text("ACCOUNT-CREDS")

    accounts.link_shared_state("claude", acc)

    assert (cfg / "projects").is_symlink() and (cfg / "skills").is_symlink()
    assert (cfg / "CLAUDE.md").read_text() == "host rules"
    assert (host / "projects" / "p1" / "old-session.jsonl").exists()  # merged, not lost
    assert (cfg / ".credentials.json").read_text() == "ACCOUNT-CREDS"  # never shared
    assert not (cfg / ".credentials.json").is_symlink()
    assert json.loads((cfg / ".claude.json").read_text())["mcpServers"] == {"x": {"command": "y"}}
    accounts.link_shared_state("claude", acc)  # idempotent
