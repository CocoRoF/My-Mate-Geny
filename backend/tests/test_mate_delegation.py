"""The mate engine + delegation, through the real session/engine code against
the fake Claude CLI of test_engine: engine flags, send_to_session (start vs
steer, ``via`` tag), delegation results (incl. queued while the mate talks,
stopped turns, the chain cap), engine restarts on persona/LLM/memory edits,
and the read-side tools."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import textwrap

from app.mate.service import MAX_CHAIN, MateService, find_folders
from app.mate.store import MateStore
from app.providers.claude_code import ClaudeCodeProvider
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from tests.test_engine import FAKE, _until


def _setup(db, tmp_path, monkeypatch):
    fake = tmp_path / "claude"
    fake.write_text(f"#!{sys.executable}\n" + textwrap.dedent(FAKE).replace("__FAKE_DIR__", str(tmp_path)))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: ClaudeCodeProvider(binary=str(fake)))
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    store = MateStore(db, vault)
    return svc, store, MateService(svc, store)


def _calls(tmp_path):
    return [json.loads(line) for line in open(tmp_path / "calls.log")]


def _mate_calls(tmp_path):
    return [c for c in _calls(tmp_path) if "--system-prompt-file" in c["argv"]]


def _prompt(argv):
    return open(argv[argv.index("--system-prompt-file") + 1], encoding="utf-8").read()


def _ended(m):
    return m["type"] == "run.state" and not m["data"]["running"]


async def _turn(svc, q, sid, text):
    svc.start_turn(sid, text)
    return await _until(q, _ended)


async def test_autonomous_voice_targets_its_device_and_persists_the_target_for_late_joiners(db,tmp_path,monkeypatch):
    svc,store,mates=_setup(db,tmp_path,monkeypatch)
    mate=store.create(name='Voice routing',llm={'model':'m1'})
    sid=mates.conversation(mate['id'])['session_id'];q=svc.subscribe(sid)
    device='dev_0123456789abcdef0123456789abcdef'
    try:
        svc.start_turn(sid,'earlier question',client_msg_id='m~otherdevice')
        await _until(q,_ended)
        svc.start_turn(sid,'reach out now',client_msg_id=f'thinking~{device}',meta={'internal':True,'kind':'thinking_trigger'})
        seen=await _until(q,_ended)
        start=next(e for e in seen if e['type']=='session.start')
        assert start['data']['voice_device']==device
        delta=next(e for e in seen if e['type']=='text.delta')
        end=next(e for e in seen if e['type']=='turn.complete')
        assert delta['timestamp']==end['timestamp']
        persisted=svc.events(sid)
        assert [e['data']['voice_device'] for e in persisted if e['type']=='session.start']==['otherdevice',device]
    finally:
        await svc.shutdown()


def _ctx(mates, mate_id, msid):
    return mates.token_info(mates._token(mate_id, msid))


async def test_mate_engine_flags_and_delegation_roundtrip(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    proj = tmp_path / "proj"
    proj.mkdir()
    worker = svc.create(provider="claude", model="w1", workspace_path=str(proj), title="proj")["id"]
    mate = store.create(name="Geny", persona={"greeting": "hi", "language": "ko"}, llm={"model": "m1"})
    msid = mates.conversation(mate["id"])["session_id"]
    qm, qw = svc.subscribe(msid), svc.subscribe(worker)
    try:
        seen = await _turn(svc, qm, msid, "hello")
        assert any(m["type"] == "turn.complete" and m["data"]["text"] == "echo[m1]: hello" for m in seen)
        argv = _mate_calls(tmp_path)[-1]["argv"]
        assert argv[argv.index("--tools") + 1] == ""  # no built-in tools at all
        assert argv[argv.index("--allowedTools") + 1] == "mcp__mate"
        assert "--append-system-prompt" not in argv  # (no wait guide for mates)
        assert argv[argv.index("--system-prompt-snapshot") + 1] == "off"
        assert "--strict-mcp-config" in argv and "--disable-slash-commands" in argv
        assert argv[argv.index("--effort") + 1] == "low"
        prompt = _prompt(argv)
        assert prompt.startswith("You are Geny") and "<delegation_result" in prompt and "[joy]" in prompt
        assert "Always reply in Korean, whatever language" in prompt and "(nothing yet)" in prompt
        mcp_file = argv[argv.index("--mcp-config") + 1]
        assert oct(os.stat(mcp_file).st_mode & 0o777) == "0o600" and "HRH_MATE_TOKEN" not in " ".join(argv)
        server = json.load(open(mcp_file))["mcpServers"]["mate"]
        assert server["command"] == sys.executable and server["args"][-1].endswith("app/mate/mcp_bridge.py")
        assert mates.token_info(server["env"]["HRH_MATE_TOKEN"]) == {"mate_id": mate["id"], "session_id": msid}
        assert server["env"]["HRH_MATE_API"].startswith("http://127.0.0.1:")
        # the mate's history: the seeded greeting stays out of the engine's context (no handoff)
        assert not any(m["type"] == "notice" and "context." in m["data"].get("code", "") for m in seen)

        ctx = _ctx(mates, mate["id"], msid)
        text, err = await mates.call_tool(ctx, "send_to_session", {"session_id": worker, "message": "say pong"})
        assert not err and "started a new turn" in text
        wseen = await _until(qw, _ended)
        um = next(m for m in wseen if m["type"] == "user.message")
        assert um["data"]["via"] == {"kind": "mate", "mate_id": mate["id"], "name": "Geny"}
        assert svc.messages(worker)[0]["meta"] == {"via": {"kind": "mate", "mate_id": mate["id"], "name": "Geny"}}

        # the worker's answer comes back to the mate as an internal turn
        mseen = await _until(qm, _ended)
        res = next(m for m in mseen if m["type"] == "user.message")
        assert res["data"]["internal"] is True and res["data"]["kind"] == "delegation_result"
        assert res["data"]["delegations"] == [{"session_id": worker, "title": "say pong", "status": "ok"}]
        assert f'<delegation_result session_id="{worker}"' in res["data"]["text"]
        assert 'status="ok"' in res["data"]["text"] and "echo[w1]: say pong" in res["data"]["text"]
        stored = [m for m in svc.messages(msid) if m["role"] == "user"][-1]
        assert stored["meta"]["internal"] is True
        assert mates.describe()["delegations"] == {}  # done: no further results from that chat
        await _turn(svc, qw, worker, "user typed this")  # a later user turn is not reported
        await asyncio.sleep(0.3)
        assert not svc.is_running(msid) and mates.describe()["pending"] == {}
    finally:
        await svc.shutdown()


async def test_steer_running_turn_and_queue_while_mate_busy(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    worker = svc.create(provider="claude", model="w1", workspace_path=str(tmp_path), title="w")["id"]
    mate = store.create(name="Mate", llm={"model": "m1"})
    msid = mates.conversation(mate["id"])["session_id"]
    ctx = _ctx(mates, mate["id"], msid)
    qm, qw = svc.subscribe(msid), svc.subscribe(worker)
    try:
        # running worker turn (started by the user) -> the mate's message steers it
        svc.start_turn(worker, "LONG build")
        await _until(qw, lambda m: m["type"] == "tool.use")
        text, err = await mates.call_tool(ctx, "send_to_session", {"session_id": worker, "message": "also lint"})
        assert not err and "added to the turn it is running" in text
        steer = await _until(qw, lambda m: m["type"] == "user.steer")
        assert steer[-1]["data"]["via"]["name"] == "Mate" and steer[-1]["data"]["text"] == "also lint"
        assert svc.stop(worker)
        await _until(qw, _ended)
        mseen = await _until(qm, _ended)
        res = next(m for m in mseen if m["type"] == "user.message")["data"]
        assert 'status="stopped"' in res["text"] and "Stopped by user" in res["text"]

        # the mate is talking (a long turn) when a delegated chat finishes -> queued
        svc.start_turn(msid, "LONG chat")
        await _until(qm, lambda m: m["type"] == "tool.use")
        text, err = await mates.call_tool(ctx, "send_to_session", {"session_id": worker, "message": "quick one"})
        assert not err and "started" in text
        await _until(qw, _ended)
        await asyncio.sleep(0.2)
        assert mates.describe()["pending"] == {msid: 1} and svc.is_running(msid)
        svc.stop(msid)
        await _until(qm, _ended)          # the mate's own turn ends …
        mseen = await _until(qm, _ended)  # … then the queued result is delivered
        res = next(m for m in mseen if m["type"] == "user.message")["data"]
        assert res["internal"] and "echo[w1]: quick one" in res["text"]
    finally:
        await svc.shutdown()


async def test_chain_cap_never_loops(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    mate = store.create(name="Mate")
    msid = mates.conversation(mate["id"])["session_id"]
    q = svc.subscribe(msid)
    mates._pending[msid] = [{"session_id": "sess_x", "title": "x", "status": "ok", "text": "done", "error": None,
                             "depth": MAX_CHAIN}]
    mates._flush(msid)
    assert not svc.is_running(msid)  # no turn: a notice instead
    note = await asyncio.wait_for(q.get(), 2)
    assert note["type"] == "notice" and note["data"]["code"] == "mate.delegation_held"
    # a mate conversation is never a delegation target
    ctx = _ctx(mates, mate["id"], msid)
    text, err = await mates.call_tool(ctx, "send_to_session", {"session_id": msid, "message": "loop"})
    assert err and "mate conversation" in text
    await svc.shutdown()


async def test_engine_restarts_only_when_the_prompt_or_launch_settings_change(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    mate = store.create(name="Mate", persona={"personality": "calm"}, llm={"model": "m1"})
    msid = mates.conversation(mate["id"])["session_id"]
    ctx = _ctx(mates, mate["id"], msid)
    q = svc.subscribe(msid)

    def pids():
        return [c["pid"] for c in _mate_calls(tmp_path)]

    try:
        await _turn(svc, q, msid, "one")
        mates.update(mate["id"], {"llm": {"model": "m2"}})  # model: switched live
        seen = await _turn(svc, q, msid, "two")
        assert any(m["type"] == "turn.complete" and m["data"]["text"] == "echo[m2]: two" for m in seen)
        text, err = await mates.call_tool(ctx, "remember", {"text": "user's name is Hyeon"})
        assert not err
        await _turn(svc, q, msid, "three")  # the mate's own memory: no restart
        assert len(set(pids())) == 1
        assert svc.get(msid)["model"] == "m2"

        mates.update(mate["id"], {"persona": {"personality": "cheerful"}})
        await _turn(svc, q, msid, "four")
        calls = _mate_calls(tmp_path)
        assert len({c["pid"] for c in calls}) == 2
        argv = calls[-1]["argv"]
        prompt = _prompt(argv)
        assert "cheerful" in prompt and "user's name is Hyeon" in prompt
        assert argv[argv.index("--resume") + 1] == "fake-cli-session"  # same conversation

        mem = store.add_memory(mate["id"], "prefers short answers", by_user=True)  # edited in Mate settings
        await _turn(svc, q, msid, "five")
        assert len(set(pids())) == 3
        store.delete_memory(mate["id"], mem["id"], by_user=True)
        mates.update(mate["id"], {"llm": {"effort": "high"}})
        await _turn(svc, q, msid, "six")
        assert len(set(pids())) == 4
        argv = _mate_calls(tmp_path)[-1]["argv"]
        assert "prefers short answers" not in _prompt(argv)
        assert argv[argv.index("--effort") + 1] == "high"
        text, err = await mates.call_tool(ctx, "forget", {"id": "mem_nope"})
        assert err
    finally:
        await svc.shutdown()


async def test_read_side_tools_and_create_session(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    proj = tmp_path / "home" / "alice" / "hr-harnessor"
    (proj / ".git").mkdir(parents=True)
    (tmp_path / "home" / "alice" / "node_modules" / "hr-harnessor").mkdir(parents=True)
    other = tmp_path / "home" / "bob" / "web-site"
    other.mkdir(parents=True)
    worker = svc.create(provider="claude", model="w1", workspace_path=str(other), title="site work")["id"]
    mate = store.create(name="Mate", llm={"model": "m1"})
    msid = mates.conversation(mate["id"])["session_id"]
    ctx = _ctx(mates, mate["id"], msid)
    qw = svc.subscribe(worker)
    try:
        await _turn(svc, qw, worker, "fix the header")
        text, err = await mates.call_tool(ctx, "list_sessions", {})
        rows = json.loads(text)
        assert [r["session_id"] for r in rows] == [worker]  # the mate's own conversation isn't listed
        assert rows[0]["last_user"] == "fix the header" and rows[0]["last_answer"] == "echo[w1]: fix the header"
        assert rows[0]["running"] is False and rows[0]["workspace"] == str(other)
        text, err = await mates.call_tool(ctx, "read_session", {"session_id": worker, "limit": 5})
        info = json.loads(text)
        assert [m["role"] for m in info["messages"]] == ["user", "assistant"]
        text, err = await mates.call_tool(ctx, "read_session", {"session_id": "sess_missing"})
        assert err and "list_sessions" in text

        found = find_folders("hr harnessor", [(str(other), "site work")], [str(tmp_path / "home")])
        assert [f["path"] for f in found] == [str(proj)] and found[0]["git"] is True  # node_modules skipped
        found = find_folders("site", [(str(other), "site work")], [str(tmp_path / "home")])
        assert found[0]["path"] == str(other) and found[0]["source"] == 'chat "site work"'

        text, err = await mates.call_tool(ctx, "create_session", {"workspace_path": str(tmp_path / "nope")})
        assert err and "find_folders" in text
        qm = svc.subscribe(msid)
        text, err = await mates.call_tool(ctx, "create_session", {"workspace_path": str(proj), "message": "run tests"})
        assert not err and "sent the instruction" in text
        new = next(s for s in svc.list_all() if s["workspace_path"] == str(proj))
        assert new["provider"] == "claude"
        mseen = await _until(qm, _ended)
        assert svc.messages(new["id"])[0]["meta"]["via"]["name"] == "Mate"
        res = next(m for m in mseen if m["type"] == "user.message")["data"]
        assert f'session_id="{new["id"]}"' in res["text"] and "echo[" in res["text"]
    finally:
        await svc.shutdown()


def test_persona_edit_reaches_the_next_message(db, tmp_path, monkeypatch):
    """Changing how the mate calls the user takes effect at the next message:
    new system prompt and an explicit settings note in that message."""
    from app.mate.prompt import settings_change_note, system_prompt

    note = settings_change_note("한채린", {}, "한채린", {}, {"address": ""}, {"address": "하렴"})
    assert "Call the user “하렴”" in note and note.startswith("<settings_update>")
    assert settings_change_note("A", {}, "A", {}, {"address": "x"}, {"address": "x"}) == ""
    assert "Call the user “하렴”" in system_prompt("한채린", {}, [], {"address": "하렴"})
    # (an old persona document that still has its address: read as the style's)
    assert "Call the user “하렴”" in system_prompt("한채린", {"address": "하렴"}, [])

    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    m = store.create(name="Rin", prefs={"address": "사용자"})
    session = {"id": "sess_x", "mate_id": m["id"], "title": "Rin", "model": m["llm"]["model"], "effort": m["llm"]["effort"]}
    from app.providers.base import TurnRequest
    req = TurnRequest(messages=[{"role": "user", "content": "hi"}], model="", cwd=str(tmp_path))
    mates.configure_engine(session, req)
    assert "settings_update" not in req.preamble  # first turn: nothing to announce
    mates.update(m["id"], {"prefs": {"address": "하렴"}})
    req2 = TurnRequest(messages=[{"role": "user", "content": "hi"}], model="", cwd=str(tmp_path))
    mates.configure_engine(session, req2)
    assert "settings_update" in req2.preamble and "하렴" in req2.preamble
    req3 = TurnRequest(messages=[{"role": "user", "content": "hi"}], model="", cwd=str(tmp_path))
    mates.configure_engine(session, req3)
    assert "settings_update" not in req3.preamble  # announced once
