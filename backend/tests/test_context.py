"""Context carries across engines: handoff on switch, catch-up on return."""
import json

from app.providers.base import ProviderEvent
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


class Recorder:
    def __init__(self, name, fail_resume=False):
        self.name, self.fail_resume, self.reqs, self.n = name, fail_resume, [], 0

    async def run_turn_stream(self, req):
        self.reqs.append({"resume": req.cli_session_id, "preamble": req.preamble,
                          "text": req.messages[-1]["content"] if req.messages else ""})
        yield ProviderEvent(type="session.start", data={"provider": self.name, "model": f"{self.name}-model"})
        if self.fail_resume and req.cli_session_id:
            yield ProviderEvent(type="error", data={"code": "exec.cli.error_during_execution",
                                                    "message": "No conversation found with session ID: x"})
            return
        self.n += 1
        yield ProviderEvent(type="tool.use", data={"id": f"t{self.n}", "name": "Bash",
                                                   "input": {"command": f"echo {self.name}{self.n}"}}, seq=1)
        yield ProviderEvent(type="tool.result", data={"id": f"t{self.n}", "output": "ok"}, seq=2)
        yield ProviderEvent(type="turn.complete", data={"text": f"{self.name} answer {self.n}",
                                                        "cli_session_id": f"{self.name}-sess", "model": f"{self.name}-model"}, seq=3)


def _svc(db, monkeypatch, **engines):
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: engines[name])
    vault = SecretVault(db)
    return SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))


async def _turn(svc, sid, text):
    return [ev async for ev in svc.run_turn(sid, text)]


async def test_switching_engines_keeps_full_context(db, tmp_path, monkeypatch):
    claude, codex = Recorder("claude"), Recorder("codex")
    svc = _svc(db, monkeypatch, claude=claude, codex=codex)
    sid = svc.create(provider="claude", workspace_path=str(tmp_path))["id"]

    await _turn(svc, sid, "first question")
    await _turn(svc, sid, "second question")
    assert claude.reqs[0] == {"resume": None, "preamble": "", "text": "first question"}
    assert claude.reqs[1]["resume"] == "claude-sess" and claude.reqs[1]["preamble"] == ""

    svc.update(sid, provider="codex")
    evs = await _turn(svc, sid, "third question")
    first_codex = codex.reqs[0]
    assert first_codex["resume"] is None  # fresh engine...
    pre = first_codex["preamble"]  # ...but it gets the whole conversation
    for needle in ("first question", "claude answer 1", "ran `echo claude1`", "second question", "claude answer 2",
                   "Claude Code · claude-model"):
        assert needle in pre, needle
    assert "third question" not in pre  # the new message is sent separately
    notes = [e for e in evs if e.type == "notice"]
    assert notes and notes[0].data["code"] == "context.handoff" and "4 messages" in notes[0].data["message"]

    await _turn(svc, sid, "fourth question")
    assert codex.reqs[1]["resume"] == "codex-sess" and codex.reqs[1]["preamble"] == ""

    svc.update(sid, provider="claude")
    assert svc.get(sid)["cli_session_id"] == "claude-sess"  # its own session survived the switch
    evs = await _turn(svc, sid, "fifth question")
    back = claude.reqs[2]
    assert back["resume"] == "claude-sess"  # resumes its own rich session
    assert "<meanwhile>" in back["preamble"]  # ...plus only what it missed
    for needle in ("third question", "codex answer 1", "fourth question", "codex answer 2", "ran `echo codex2`"):
        assert needle in back["preamble"], needle
    assert "first question" not in back["preamble"]
    assert any(e.type == "notice" and e.data["code"] == "context.catchup" for e in evs)

    msgs = svc.messages(sid)
    assert [(m["role"], m["provider"]) for m in msgs if m["role"] == "assistant"] == [
        ("assistant", "claude"), ("assistant", "claude"), ("assistant", "codex"), ("assistant", "codex"), ("assistant", "claude")]

    # /clear: every engine starts fresh, nothing before the clear is handed over
    svc.reset_context(sid)
    await _turn(svc, sid, "sixth question")
    assert claude.reqs[3] == {"resume": None, "preamble": "", "text": "sixth question"}
    svc.update(sid, provider="codex")
    await _turn(svc, sid, "seventh question")
    assert "sixth question" in codex.reqs[2]["preamble"] and "first question" not in codex.reqs[2]["preamble"]


async def test_stale_session_retries_with_full_handoff(db, tmp_path, monkeypatch):
    claude = Recorder("claude", fail_resume=True)
    svc = _svc(db, monkeypatch, claude=claude)
    sid = svc.create(provider="claude", workspace_path=str(tmp_path))["id"]
    await _turn(svc, sid, "hello")
    evs = await _turn(svc, sid, "again")
    assert [r["resume"] for r in claude.reqs] == [None, "claude-sess", None]
    assert "hello" in claude.reqs[2]["preamble"]
    types = [e.type for e in evs]
    assert "error" not in types and types.count("session.start") == 1 and types[-1] == "turn.complete"
    persisted = [e["type"] for e in svc.events(sid)]
    assert "error" not in persisted


def test_legacy_session_id_trusted_only_for_single_engine_chats(db, tmp_path, monkeypatch):
    svc = _svc(db, monkeypatch, codex=Recorder("codex"))
    sid = svc.create(provider="codex", workspace_path=str(tmp_path))["id"]
    db.execute("UPDATE sessions SET cli_session_id = 'old-thread' WHERE id = ?", (sid,))
    svc._add_event(sid, ProviderEvent(type="session.start", data={"provider": "codex"}))
    assert svc._cli_state(svc.get(sid))["codex"]["id"] == "old-thread"
    svc._add_event(sid, ProviderEvent(type="session.start", data={"provider": "claude"}))
    assert svc._cli_state(svc.get(sid)) == {}  # the thread misses the claude turns -> fresh + handoff
