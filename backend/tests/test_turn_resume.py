"""Chats cut off from outside go on by themselves (app/services/turn_resume.py): the server restarting under a turn (a
deploy, a reboot, a crash) and the connection to the model dropping. 2026-11-19: 26 chat turns since 11-01 had simply
ended mid-work at a restart, and the user asked for them to carry on by themselves."""

import asyncio
from datetime import datetime, timedelta, timezone

from app.providers.base import ProviderEvent
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.turn_resume import continue_prompt, cut_reason
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


class Engine:
    """A stand-in engine: each turn plays the next script — "ok", "net" (a dropped connection), "hang" (works until
    the server goes down), "exited" (its process died)."""

    def __init__(self, *scripts):
        self.scripts, self.reqs = list(scripts), []
        self.started = asyncio.Event()

    async def run_turn_stream(self, req):
        self.reqs.append({"text": req.messages[-1]["content"], "resume": req.cli_session_id, "preamble": req.preamble})
        script = self.scripts.pop(0) if self.scripts else "ok"
        yield ProviderEvent(type="session.start", data={"provider": "codex", "model": "m"})
        yield ProviderEvent(type="session.info", data={"provider": "codex", "cli_session_id": "cli-1"})
        yield ProviderEvent(type="tool.use", data={"id": f"t{len(self.reqs)}", "name": "Bash", "input": {"command": "make"}})
        if script == "net":
            yield ProviderEvent(type="error", data={"code": "exec.cli.api_error", "message": "API Error: Connection error."})
            return
        if script == "auth":
            yield ProviderEvent(type="error", data={"code": "exec.cli.api_error", "message": "Failed to authenticate. API Error: 401"})
            return
        if script == "exited":
            yield ProviderEvent(type="error", data={"code": "exec.cli.exited", "message": "the Claude engine stopped unexpectedly"})
            return
        if script == "hang":
            self.started.set()
            await asyncio.sleep(3600)
        yield ProviderEvent(type="turn.complete", data={"text": f"done {len(self.reqs)}", "cli_session_id": "cli-1"})


def _svc(db, monkeypatch, engine, *, auto=True):
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: engine)

    async def online(provider, **kw):
        return True

    monkeypatch.setattr(ss_mod, "wait_reachable", online)
    monkeypatch.setattr(ss_mod, "BACKOFF", {"restart": [0, 0, 0], "network": [0, 0, 0, 0], "engine": [0, 0]})
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    svc.auto_continue = auto
    return svc


async def _settle(svc, sid, rounds=200):
    """Until the chat has no turn running and no continue waiting."""
    for _ in range(rounds):
        await asyncio.sleep(0.01)
        if sid not in svc._tasks and sid not in svc._continues:
            return
    raise AssertionError("still running")


def _events(svc, sid, typ=None):
    return [e for e in svc.events(sid) if typ is None or e["type"] == typ]


def test_what_a_continue_can_mend():
    net = cut_reason({"code": "exec.cli.api_error", "message": "API Error: Connection error."})
    assert net == "network"
    assert cut_reason({"code": "exec.cli.api_error", "message": "x", "api_error": {"status": 529, "kind": "overloaded_error"}}) == "network"
    assert cut_reason({"code": "exec.cli.api_error", "message": "Request timed out."}) == "network"
    assert cut_reason({"code": "exec.cli.exited", "message": "the Claude engine stopped unexpectedly"}) == "engine"
    assert cut_reason({"code": "exec.cli.timeout", "message": "Codex app-server timed out"}) == "engine"
    # a key, a limit, a bill, a stop: waiting a minute mends none of them
    for err in ({"code": "exec.cli.api_error", "message": "Failed to authenticate. API Error: 401 Attention Required! | Cloudflare"},
                {"code": "exec.cli.api_error", "message": "Claude AI usage limit reached"},
                {"code": "exec.cli.api_error", "message": "x", "api_error": {"status": 429}},
                {"code": "turn.interrupted", "message": "Stopped by user"},
                {"code": "account.unavailable", "message": "No Claude account can take this turn right now"},
                {"code": "exec.cli.error_max_turns", "message": "the agent hit its maximum number of turns"},
                {"code": "exec.cli.api_error", "message": "Prompt is too long"}):
        assert cut_reason(err) is None, err
    said = continue_prompt("restart", attempt=1)
    assert "server" in said and "background commands" in said and "1/3" in said and "did not type this" in said


async def test_a_dropped_connection_goes_on_by_itself(db, tmp_path, monkeypatch):
    engine = Engine("net", "ok")
    svc = _svc(db, monkeypatch, engine)
    sid = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    svc.start_turn(sid, "build the report")
    await _settle(svc, sid)
    assert len(engine.reqs) == 2
    said = engine.reqs[1]["text"]
    assert "automatic continue 1/4" in said and "connection to the model dropped" in said
    # the continue resumes the engine's own session, and isn't handed the request again
    assert engine.reqs[1]["resume"] == "cli-1" and "build the report" not in engine.reqs[1]["preamble"]
    users = [m for m in svc.messages(sid) if m["role"] == "user"]
    assert users[-1]["meta"] == {"internal": True, "kind": "resume", "reason": "network", "attempt": 1}
    assert svc.journal.get(sid) is None  # done: nothing left to continue
    assert [m["content"] for m in svc.messages(sid) if m["role"] == "assistant"] == ["done 2"]


async def test_a_failure_waiting_wont_mend_is_left_alone(db, tmp_path, monkeypatch):
    engine = Engine("auth")
    svc = _svc(db, monkeypatch, engine)
    sid = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    svc.start_turn(sid, "go")
    await _settle(svc, sid)
    assert len(engine.reqs) == 1 and svc.journal.get(sid) is None


async def test_continues_stop_after_a_few(db, tmp_path, monkeypatch):
    engine = Engine("exited", "exited", "exited", "ok")
    svc = _svc(db, monkeypatch, engine)
    sid = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    svc.start_turn(sid, "go")
    await _settle(svc, sid)
    assert len(engine.reqs) == 3  # the turn + 2 continues ("engine": 2), not the 4th
    gave_up = [e for e in _events(svc, sid, "notice") if e["data"].get("code") == "turn.resume_gave_up"]
    assert gave_up and gave_up[0]["data"]["attempts"] == 2
    assert svc.journal.get(sid) is None


async def test_the_users_own_message_takes_over_a_waiting_continue(db, tmp_path, monkeypatch):
    engine = Engine("net", "ok")
    svc = _svc(db, monkeypatch, engine)
    monkeypatch.setattr(ss_mod, "BACKOFF", {"restart": [0], "network": [30, 30, 30, 30], "engine": [0]})
    sid = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    svc.start_turn(sid, "go")
    for _ in range(200):
        await asyncio.sleep(0.01)
        if sid not in svc._tasks and sid in svc._continues:
            break
    waiting = svc._continues[sid]
    note = [e for e in _events(svc, sid, "notice") if e["data"].get("code") == "turn.resume_scheduled"]
    assert note and note[0]["data"]["delay"] == 30
    svc.start_turn(sid, "never mind, do this instead")
    await _settle(svc, sid)
    # (the waiting continue ended without sending anything: the engine got the user's message, and nothing after)
    assert waiting.done() and len(engine.reqs) == 2 and engine.reqs[1]["text"] == "never mind, do this instead"


async def test_a_restart_cuts_the_turn_off_and_the_next_server_goes_on(db, tmp_path, monkeypatch):
    engine = Engine("hang")
    svc = _svc(db, monkeypatch, engine)
    ended = []
    svc.add_turn_end_listener(lambda sid, outcome: ended.append(outcome))
    sid = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    svc.start_turn(sid, "run the 10-video test")
    await asyncio.wait_for(engine.started.wait(), 5)
    await svc.begin_shutdown()
    # said in the chat as a restart, not as the user stopping it; no "done" listeners (no call saying it finished)
    errs = [e["data"] for e in _events(svc, sid, "error")]
    assert errs == [{"code": "turn.interrupted", "reason": "server",
                     "message": "The server restarted — this goes on by itself once it's back"}]
    assert ended == []
    row = svc.journal.get(sid)
    assert row["status"] == "interrupted" and row["reason"] == "restart" and row["request"] == "run the 10-video test"

    # the server is back
    engine2 = Engine("ok")
    svc2 = _svc(db, monkeypatch, engine2)
    await svc2._resume_cut_off(0)
    await _settle(svc2, sid)
    said = engine2.reqs[0]["text"]
    assert "automatic continue 1/3" in said and "server running this chat restarted" in said
    assert engine2.reqs[0]["resume"] == "cli-1"
    # (it had worked on the request: the engine has it — not handed over again)
    assert "run the 10-video test" not in engine2.reqs[0]["preamble"]
    assert svc2.journal.get(sid) is None


async def test_a_crash_leaves_the_row_running_which_says_the_same(db, tmp_path, monkeypatch):
    svc = _svc(db, monkeypatch, Engine())
    sid = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    svc.journal.begin(sid, trigger="turn", provider="codex", request="deploy it")  # (and the process died)
    engine = Engine("ok")
    svc2 = _svc(db, monkeypatch, engine)
    await svc2._resume_cut_off(0)
    await _settle(svc2, sid)
    assert len(engine.reqs) == 1 and "server running this chat restarted" in engine.reqs[0]["text"]


async def test_a_turn_cut_off_long_ago_or_too_often_is_left_alone(db, tmp_path, monkeypatch):
    svc = _svc(db, monkeypatch, Engine())
    old = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    tired = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    svc.journal.begin(old, trigger="turn", provider="codex")
    long_ago = (datetime.now(timezone.utc) - timedelta(hours=13)).isoformat()
    db.execute("UPDATE turn_journal SET beat_at = ? WHERE session_id = ?", (long_ago, old))
    svc.journal.begin(tired, trigger="resume", provider="codex", attempt=3)
    engine = Engine()
    svc2 = _svc(db, monkeypatch, engine)
    await svc2._resume_cut_off(0)
    await asyncio.sleep(0.05)
    assert engine.reqs == [] and svc2.journal.all() == []
    assert any(e["data"].get("code") == "turn.resume_gave_up" for e in _events(svc2, tired, "notice"))


async def test_chats_cut_off_before_the_journal_go_on_too(db, tmp_path, monkeypatch):
    """(the restart deploying this: the turns it cuts have no journal row — their last turn started and never ended)"""
    svc = _svc(db, monkeypatch, Engine())
    recent = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    done = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    stale = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    for sid in (recent, done, stale):
        svc._add_message(sid, "user", "work")
        svc._add_event(sid, ProviderEvent(type="session.start", data={"provider": "claude"}))
        svc._add_event(sid, ProviderEvent(type="tool.use", data={"id": "a", "name": "Bash", "input": {}}))
    svc._add_event(done, ProviderEvent(type="turn.complete", data={"text": "ok"}))
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    db.execute("UPDATE events SET created_at = ? WHERE session_id = ?", (week_ago, stale))
    # (a long turn: started 9 hours ago, still working a minute before the cut — it goes on)
    long_turn = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    svc._add_message(long_turn, "user", "the 10-video run")
    svc._add_event(long_turn, ProviderEvent(type="session.start", data={"provider": "codex"}))
    nine_h = (datetime.now(timezone.utc) - timedelta(hours=9)).isoformat()
    db.execute("UPDATE events SET created_at = ? WHERE session_id = ?", (nine_h, long_turn))
    svc._add_event(long_turn, ProviderEvent(type="tool.use", data={"id": "b", "name": "Bash", "input": {}}))
    engine = Engine()
    svc2 = _svc(db, monkeypatch, engine)
    await svc2._resume_cut_off(0)
    await _settle(svc2, recent)
    await _settle(svc2, long_turn, rounds=1000)
    assert len(engine.reqs) == 2  # the recent one and the long one, not the finished or the week-old one
    assert [m for m in svc2.messages(recent) if (m.get("meta") or {}).get("kind") == "resume"]


async def test_a_mates_turns_are_not_continued(db, tmp_path, monkeypatch):
    engine = Engine("net")
    svc = _svc(db, monkeypatch, engine)
    sid = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    svc._mate_sids.add(sid)
    svc.start_turn(sid, "hi")
    await _settle(svc, sid)
    assert len(engine.reqs) == 1 and svc.journal.get(sid) is None


async def test_off_means_off(db, tmp_path, monkeypatch):
    engine = Engine("net")
    svc = _svc(db, monkeypatch, engine, auto=False)
    sid = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    svc.start_turn(sid, "go")
    await _settle(svc, sid)
    assert len(engine.reqs) == 1 and svc.journal.get(sid) is None
    svc.start_resumer(0)
    assert svc._resumer is None


async def test_a_claude_turn_cut_off_before_the_early_watermark_isnt_handed_over_twice(db, tmp_path, monkeypatch):
    """(a Claude engine marked what it had seen only at a turn's end: a turn the old server lost mid-work left the
    request looking unseen, and the continue would hand it over again as a catch-up)"""
    svc = _svc(db, monkeypatch, Engine())
    sid = svc.create(provider="claude", workspace_path=str(tmp_path))["id"]
    svc._set_cli_session(sid, "claude-sess", "claude")  # (the previous turn's end)
    await asyncio.sleep(0.01)
    svc._add_message(sid, "user", "run the 10-video test")
    svc._add_event(sid, ProviderEvent(type="session.start", data={"provider": "claude"}))
    svc._add_event(sid, ProviderEvent(type="tool.use", data={"id": "a", "name": "Bash", "input": {}}))
    session = svc.get(sid)
    _, pre, kind, _ = svc._context_for(session, "claude", "none")
    assert kind == "catchup" and "run the 10-video test" in pre  # (what the continue would have said)
    svc._seen_through_cut(sid)
    _, pre, kind, _ = svc._context_for(svc.get(sid), "claude", "none")
    assert pre == "" and kind == ""


async def test_a_turn_whose_answer_is_in_isnt_cut_off_by_a_shutdown_while_it_wraps_up(db, tmp_path, monkeypatch):
    """(the real-restart E2E, 2026-11-19: SIGTERM landed between the answer and the end of the turn's wrap-up, and the
    finished turn was marked cut off — to be continued for nothing)"""
    engine = Engine("ok")
    svc = _svc(db, monkeypatch, engine)
    sid = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    gate = asyncio.Event()
    real = svc._report_changes

    async def slow_wrap_up(*a, **kw):
        await gate.wait()  # (the wrap-up after the answer: still running when the server goes down)
        return await real(*a, **kw)

    monkeypatch.setattr(svc, "_report_changes", slow_wrap_up)
    svc.start_turn(sid, "go")
    for _ in range(300):
        await asyncio.sleep(0.01)
        if sid in svc._turn_end_seen:
            break
    assert sid in svc._turn_end_seen and sid in svc._tasks
    await svc.begin_shutdown()
    assert svc.journal.get(sid) is None
    assert not [e for e in _events(svc, sid, "error")]
