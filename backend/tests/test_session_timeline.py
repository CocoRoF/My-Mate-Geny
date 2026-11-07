"""Rewinding a chat and copying one (docs/session-timeline.md): what the chat holds, and what each engine is told."""

import asyncio
import json
import os
import subprocess

import pytest

import app.services.session_service as ss_mod
from app.config import settings
from app.providers.base import ProviderEvent, TurnRequest
from app.providers.claude_code import ClaudeCodeProvider
from app.providers._stream_json import StreamJsonAccumulator
from app.services import changes as change_tracker
from app.services.attachment_service import AttachmentService
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService, TurnBusyError
from app.services.session_timeline import TimelineBusy, copy_title
from app.services.usage_service import UsageService
from app.services.usage_week import week
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


class Engine:
    """An engine that remembers what it was asked: each turn answers, and says where its session stands."""

    def __init__(self, name):
        self.name, self.reqs, self.turns, self.hold, self.stale, self.asked = name, [], 0, None, [], []

    async def run_turn_stream(self, req):
        self.reqs.append(req)
        self.asked.append((req.cli_session_id, req.fork_session, req.resume_at))  # (a retry changes the request itself)
        self.turns += 1
        n = self.turns
        yield ProviderEvent(type="session.start", data={"provider": self.name, "model": "fake"})
        if self.stale and req.cli_session_id:
            yield ProviderEvent(type="error", data={"code": "exec.cli.x", "message": self.stale.pop()})
            return
        cli = req.cli_session_id if req.cli_session_id and not req.fork_session else f"{self.name}-{n}"
        yield ProviderEvent(type="tool.use", data={"id": f"t{n}", "name": "Bash", "input": {"command": f"step {n}"}})
        if self.hold is not None:
            await self.hold.wait()
        yield ProviderEvent(type="turn.complete", seq=9, data={
            "text": f"{self.name} answer {n}", "model": "fake", "usage": {"input_tokens": 10, "output_tokens": 5},
            "cost_usd": 0.5, "cost_kind": "turn", "cli_session_id": cli, "cli_at": f"{self.name}-at-{n}"})


@pytest.fixture
def stack(db, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "uploads_root", str(tmp_path / "uploads"))
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)),
                         attachments=AttachmentService(db))
    svc.persistent_engines = False
    engines = {"claude": Engine("claude"), "codex": Engine("codex")}
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: engines[name])
    return svc, engines, tmp_path


async def _say(svc, sid, text, **kw):
    svc.start_turn(sid, text, **kw)
    await svc._tasks[sid]
    return next(m for m in reversed(svc.messages(sid)) if m["role"] == "user" and m["content"] == text)["id"]


def _roles(svc, sid):
    return [(m["role"], m["content"]) for m in svc.messages(sid)]


def _new(svc, tmp_path, **kw):
    return svc.create(provider=kw.pop("provider", "claude"), workspace_path=str(tmp_path), title=kw.pop("title", "Work"),
                      **kw)["id"]


async def test_a_rewound_chat_holds_nothing_from_that_message_on(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    two = await _say(svc, sid, "two")
    await _say(svc, sid, "three")
    last_kept = max(e["eid"] for e in svc.events(sid) if e["type"] == "turn.complete" and e["data"]["text"] == "claude answer 1")
    q = svc.subscribe(sid)

    res = await svc.timeline.rewind(sid, two)

    assert res["text"] == "two" and res["attachments"] == [] and res["restored_files"] == []
    assert _roles(svc, sid) == [("user", "one"), ("assistant", "claude answer 1")]
    assert all(e["eid"] <= last_kept for e in svc.events(sid))
    assert (await asyncio.wait_for(q.get(), 1))["type"] == "session.rewound"
    # the history pages agree (their numbers are folded once per chat)
    page = svc.history_page(sid, turns=10)
    assert [m["content"] for m in page["messages"]] == ["one", "claude answer 1"]


async def test_the_engine_continues_from_a_copy_of_its_session_at_that_point(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    two = await _say(svc, sid, "two")
    await svc.timeline.rewind(sid, two)

    state = svc.get(sid)["cli_sessions"]["claude"]
    assert state["id"] == "claude-1" and state["at"] == "claude-at-1" and state["fork"] is True
    assert svc.get(sid)["cli_session_id"] == "claude-1"

    await _say(svc, sid, "two again")
    req = engines["claude"].reqs[-1]
    assert (req.cli_session_id, req.fork_session, req.resume_at) == ("claude-1", True, "claude-at-1")
    assert not req.preamble  # (nothing it wouldn't know)
    # that was once: from here on it is this chat's own session
    state = svc.get(sid)["cli_sessions"]["claude"]
    assert state["id"] == "claude-3" and "fork" not in state and "at" not in state
    await _say(svc, sid, "next")
    assert (engines["claude"].reqs[-1].cli_session_id, engines["claude"].reqs[-1].fork_session) == ("claude-3", False)


async def test_rewinding_the_first_message_starts_over(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp, title="New chat")
    first = await _say(svc, sid, "a title from this")
    assert svc.get(sid)["title"] == "a title from this"
    await svc.timeline.rewind(sid, first)
    s = svc.get(sid)
    assert svc.messages(sid) == [] and svc.events(sid) == []
    assert s["title"] == "New chat" and s["cli_sessions"] == {} and s["cli_session_id"] is None
    await _say(svc, sid, "fresh")
    req = engines["claude"].reqs[-1]
    assert (req.cli_session_id, req.fork_session, req.preamble) == (None, False, "")


async def test_a_name_the_user_gave_stays_when_the_first_message_goes(stack):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp, title="My name")
    first = await _say(svc, sid, "hello")
    await svc.timeline.rewind(sid, first)
    assert svc.get(sid)["title"] == "My name"


async def test_each_engine_goes_back_to_its_own_point_and_hears_what_it_missed(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")                     # claude
    svc.update(sid, provider="codex")
    await _say(svc, sid, "two")                     # codex
    svc.update(sid, provider="claude")
    three = await _say(svc, sid, "three")           # claude, told about two
    assert "codex answer 1" in engines["claude"].reqs[-1].preamble

    await svc.timeline.rewind(sid, three)
    state = svc.get(sid)["cli_sessions"]
    assert state["claude"]["id"] == "claude-1" and state["claude"]["at"] == "claude-at-1"
    assert state["codex"]["id"] == "codex-1" and state["codex"]["at"] == "codex-at-1"
    await _say(svc, sid, "three again")
    req = engines["claude"].reqs[-1]
    assert req.resume_at == "claude-at-1" and "<meanwhile>" in req.preamble and "codex answer 1" in req.preamble
    assert "three" not in req.preamble.replace("three again", "") and "claude answer 2" not in req.preamble


async def test_an_engine_that_only_ran_after_the_point_is_forgotten(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    svc.update(sid, provider="codex")
    two = await _say(svc, sid, "two")
    await svc.timeline.rewind(sid, two)
    s = svc.get(sid)
    assert "codex" not in s["cli_sessions"] and s["cli_session_id"] is None and s["provider"] == "codex"
    await _say(svc, sid, "two again")
    req = engines["codex"].reqs[-1]
    assert req.cli_session_id is None and "<conversation_so_far>" in req.preamble and "claude answer 1" in req.preamble
    assert "codex answer 1" not in req.preamble


async def test_turns_from_before_positions_were_kept_get_the_conversation_handed_over(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    two = await _say(svc, sid, "two")
    for row in svc._db.query("SELECT id, data FROM events WHERE session_id = ? AND type = 'turn.complete'", (sid,)):
        data = json.loads(row["data"])
        data.pop("cli_at")
        svc._db.execute("UPDATE events SET data = ? WHERE id = ?", (json.dumps(data), row["id"]))
    await svc.timeline.rewind(sid, two)
    assert svc.get(sid)["cli_sessions"] == {}
    await _say(svc, sid, "two again")
    req = engines["claude"].reqs[-1]
    assert req.cli_session_id is None and "claude answer 1" in req.preamble and "claude answer 2" not in req.preamble


@pytest.mark.parametrize("message", ["No message found with message.uuid of: x", "No conversation found with session ID: x",
                                     "thread/fork failed: nope"])
async def test_a_copy_that_cant_be_made_falls_back_to_the_handover(stack, message):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    two = await _say(svc, sid, "two")
    await svc.timeline.rewind(sid, two)
    engines["claude"].stale.append(message)
    await _say(svc, sid, "two again")
    assert engines["claude"].asked[-2:] == [("claude-1", True, "claude-at-1"), (None, False, None)]
    assert "claude answer 1" in engines["claude"].reqs[-1].preamble
    assert _roles(svc, sid)[-1][1].startswith("claude answer")


async def test_clear_is_undone_when_the_rewind_goes_past_it(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    one = await _say(svc, sid, "one")
    await asyncio.sleep(0.01)
    svc.reset_context(sid)
    assert svc.get(sid)["context_floor"]
    two = await _say(svc, sid, "two")
    three = await _say(svc, sid, "three")
    # after /clear: it stays cleared, and the engine stands where it stood after it
    await svc.timeline.rewind(sid, three)
    s = svc.get(sid)
    assert s["context_floor"] and s["cli_sessions"]["claude"]["id"] == "claude-2"
    # before /clear: the notice is gone, and the engine remembers again
    await svc.timeline.rewind(sid, two)
    s = svc.get(sid)
    assert s["context_floor"] and s["cli_sessions"] == {}  # ("two" was the first turn after it)
    await svc.timeline.rewind(sid, one)
    s = svc.get(sid)
    assert s["context_floor"] is None and s["cli_sessions"] == {} and svc.events(sid) == []


async def test_a_running_turn_is_stopped_first_and_leaves_no_trace(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    engines["claude"].hold = asyncio.Event()
    svc.start_turn(sid, "oops, wrong chat")
    for _ in range(100):
        if any(e["type"] == "tool.use" and e["data"]["id"] == "t2" for e in svc.events(sid)):
            break
        await asyncio.sleep(0.01)
    wrong = next(m for m in svc.messages(sid) if m["content"] == "oops, wrong chat")["id"]
    assert svc.is_running(sid)
    await svc.timeline.rewind(sid, wrong)
    assert not svc.is_running(sid)
    assert _roles(svc, sid) == [("user", "one"), ("assistant", "claude answer 1")]
    assert not any(e["type"] == "error" for e in svc.events(sid))
    engines["claude"].hold = None
    await _say(svc, sid, "right")
    assert engines["claude"].reqs[-1].resume_at == "claude-at-1"


async def test_no_turn_starts_while_a_rewind_is_under_way(stack):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp)
    one = await _say(svc, sid, "one")
    svc.timeline.busy.add(sid)
    with pytest.raises(TurnBusyError):
        svc.start_turn(sid, "two")
    with pytest.raises(TimelineBusy):
        await svc.timeline.rewind(sid, one)
    svc.timeline.busy.discard(sid)


async def test_only_a_message_the_user_sent_can_be_rewound_to(stack):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    answer = next(m for m in svc.messages(sid) if m["role"] == "assistant")["id"]
    with pytest.raises(ValueError):
        await svc.timeline.rewind(sid, answer)
    with pytest.raises(KeyError):
        await svc.timeline.rewind(sid, "msg_nope")
    made = svc.seed_message(sid, "user", "from a mate", meta={"via": {"mate_id": "m"}})
    with pytest.raises(ValueError):
        svc.timeline.preview(sid, made)
    mate = svc.create(provider="claude", workspace_path=str(tmp), kind="mate", mate_id="m")["id"]
    mine = svc.seed_message(mate, "user", "hi")
    with pytest.raises(ValueError):
        await svc.timeline.rewind(mate, mine)
    with pytest.raises(ValueError):
        await svc.timeline.copy(mate)


async def _attach(svc, sid, name="a.txt", data=b"data"):
    from fastapi import UploadFile
    import io

    return await svc._attachments.save(sid, UploadFile(filename=name, file=io.BytesIO(data)))


async def test_the_rewound_message_keeps_its_files_for_sending_again_the_rest_go(stack):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp)
    mine = await _attach(svc, sid, "mine.txt")
    later = await _attach(svc, sid, "later.txt")
    waiting = await _attach(svc, sid, "waiting.txt")
    msg = await _say(svc, sid, "with a file", attachment_ids=[mine["id"]])
    await _say(svc, sid, "later", attachment_ids=[later["id"]])
    made = await svc._attachments.save_bytes(sid, "tool.png", "image/png", b"\x89PNG", tag="artifact:t2")
    made_path = svc._attachments.get(made["id"])["path"]
    later_path = svc._attachments.get(later["id"])["path"]

    res = await svc.timeline.rewind(sid, msg)

    assert [a["id"] for a in res["attachments"]] == [mine["id"]]
    assert svc._attachments.pending(sid, [mine["id"], waiting["id"]])  # (ready to be sent, as if never sent)
    assert svc._attachments.get(later["id"]) is None and not os.path.exists(later_path)
    assert svc._attachments.get(made["id"]) is None and not os.path.exists(made_path)
    await _say(svc, sid, "with a file again", attachment_ids=[mine["id"]])


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.email=t@e", "-c", "user.name=t", *args], cwd=cwd, check=True, capture_output=True)


async def _changed_turn(svc, sid, repo, text, edit):
    """A turn that changes files, with the record a real one leaves."""
    runner = change_tracker.local_runner()
    top, before = await change_tracker.snapshot(runner, str(repo))
    mid = await _say(svc, sid, text)
    edit()
    _top, after = await change_tracker.snapshot(runner, str(repo))
    summary = await change_tracker.summarize(runner, top, before, after)
    svc._add_event(sid, ProviderEvent(type="turn.changes", data={"repos": [{**summary, "connection_id": None}]}))
    return mid


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "repo"
    path.mkdir()
    _git(path, "init", "-q")
    (path / "keep.txt").write_text("v1\n")
    (path / "other.txt").write_text("other\n")
    _git(path, "add", "-A")
    _git(path, "commit", "-qm", "init")
    return path


async def test_files_go_back_to_before_the_first_rewound_turn_and_only_those(stack, repo):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp)
    svc._db.execute("UPDATE sessions SET workspace_path = ? WHERE id = ?", (str(repo), sid))
    keep, new = repo / "keep.txt", repo / "new.txt"
    first = await _changed_turn(svc, sid, repo, "first", lambda: keep.write_text("v2\n"))
    second = await _changed_turn(svc, sid, repo, "second", lambda: (keep.write_text("v3\n"), new.write_text("new\n")))
    (repo / "other.txt").write_text("edited by someone else\n")

    preview = svc.timeline.preview(sid, second)
    assert preview["messages"] == 1 and preview["file_count"] == 2 and {f["path"] for f in preview["files"]} == {"keep.txt", "new.txt"}
    assert svc.timeline.preview(sid, first)["messages"] == 2

    res = await svc.timeline.rewind(sid, second, restore_files=True)
    assert sorted(res["restored_files"]) == ["keep.txt", "new.txt"]
    assert keep.read_text() == "v2\n" and not new.exists()
    assert (repo / "other.txt").read_text() == "edited by someone else\n"

    res = await svc.timeline.rewind(sid, first, restore_files=True)
    assert res["restored_files"] == ["keep.txt"] and keep.read_text() == "v1\n"


async def test_without_being_asked_files_stay_and_a_failed_restore_changes_nothing(stack, repo, monkeypatch):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp)
    svc._db.execute("UPDATE sessions SET workspace_path = ? WHERE id = ?", (str(repo), sid))
    keep = repo / "keep.txt"
    first = await _changed_turn(svc, sid, repo, "first", lambda: keep.write_text("v2\n"))

    async def broken(*_a, **_k):
        raise RuntimeError("revert failed")

    monkeypatch.setattr(change_tracker, "revert", broken)
    with pytest.raises(RuntimeError):
        await svc.timeline.rewind(sid, first, restore_files=True)
    assert [m for m in _roles(svc, sid)][0] == ("user", "first") and sid not in svc.timeline.busy
    await svc.timeline.rewind(sid, first)
    assert keep.read_text() == "v2\n" and svc.messages(sid) == []


async def test_what_rewound_turns_spent_stays_on_the_usage_page(stack):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    two = await _say(svc, sid, "two")
    before = UsageService(svc._db).summary()["total"]
    assert before["turns"] == 2
    await svc.timeline.rewind(sid, two)
    assert svc.events(sid) and not any(e["data"].get("text") == "claude answer 2" for e in svc.events(sid))
    after = UsageService(svc._db).summary()["total"]
    assert after["turns"] == 2 and after["cost_usd"] == before["cost_usd"]
    assert week(svc._db)["total"]["turns"] == 2
    # a chat deleted takes its numbers with it, as ever
    svc.delete(sid)
    assert UsageService(svc._db).summary()["total"]["turns"] == 0


# ---- copy ----


async def test_a_copy_has_every_setting_the_whole_history_and_its_own_name(stack):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp, mode="plan", effort="high", title="Work")
    await _say(svc, sid, "one")
    await _say(svc, sid, "two")
    svc._db.execute(
        "UPDATE sessions SET auto_compact_window = 120000, git_repo = '/r', git_repo_conn = 'local', mcp = ?, higgsfield = ?, "
        "accounts = ? WHERE id = ?",
        (json.dumps({"m1": True}), json.dumps({"enabled": False, "max_credits": 7}), json.dumps({"claude": {"id": "a1"}}), sid))
    svc._on_task(sid, {"task_id": "done", "task_type": "local_bash", "status": "completed", "description": "finished"})
    svc._on_task(sid, {"task_id": "live", "task_type": "local_bash", "status": "running", "description": "going"})

    copy = await svc.timeline.copy(sid)

    assert copy["id"] != sid and copy["title"] == "Work_copy_1" and copy["running"] is False
    src_row, new_row = (dict(svc._db.query_one("SELECT * FROM sessions WHERE id = ?", (x,))) for x in (sid, copy["id"]))
    differ = {"id", "title", "created_at", "updated_at", "cli_sessions", "cli_session_id", "last_result", "last_result_at",
              "last_seen_at"}
    assert {k: v for k, v in src_row.items() if k not in differ} == {k: v for k, v in new_row.items() if k not in differ}
    assert _roles(svc, copy["id"]) == _roles(svc, sid)
    old_ids = {m["id"] for m in svc.messages(sid)}
    assert not old_ids & {m["id"] for m in svc.messages(copy["id"])}
    src_events, new_events = svc.events(sid), svc.events(copy["id"])
    assert [(e["type"], e["seq"], e["timestamp"]) for e in src_events] == [(e["type"], e["seq"], e["timestamp"]) for e in new_events]
    tasks = {t["task_id"] for t in svc.list_tasks(copy["id"])}
    assert tasks == {"done"}


async def test_copy_names_count_up(stack):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp, title="Work")
    assert (await svc.timeline.copy(sid))["title"] == "Work_copy_1"
    second = await svc.timeline.copy(sid)
    assert second["title"] == "Work_copy_2"
    assert (await svc.timeline.copy(second["id"]))["title"] == "Work_copy_2_copy_1"
    assert copy_title("x" * 200, set()) == "x" * 193 + "_copy_1"


async def test_a_copy_continues_from_its_own_copy_of_the_engine_and_the_original_goes_on_alone(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    copy = (await svc.timeline.copy(sid))["id"]

    await _say(svc, copy, "in the copy")
    req = engines["claude"].reqs[-1]
    assert (req.cli_session_id, req.fork_session, req.resume_at, req.preamble) == ("claude-1", True, None, "")
    assert svc.get(copy)["cli_sessions"]["claude"]["id"] == "claude-2"

    await _say(svc, sid, "in the original")
    req = engines["claude"].reqs[-1]
    assert (req.cli_session_id, req.fork_session) == ("claude-1", False)
    assert "in the copy" not in req.preamble and svc.get(sid)["cli_sessions"]["claude"]["id"] == "claude-1"
    assert "in the original" not in [m["content"] for m in svc.messages(copy)]


async def test_every_engine_the_chat_used_is_copied(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    svc.update(sid, provider="codex")
    await _say(svc, sid, "two")
    copy = (await svc.timeline.copy(sid))["id"]
    s = svc.get(copy)
    assert s["provider"] == "codex" and s["cli_session_id"] == "codex-1"
    assert s["cli_sessions"]["claude"]["fork"] and s["cli_sessions"]["codex"]["fork"]
    await _say(svc, copy, "three")
    assert engines["codex"].reqs[-1].fork_session is True
    svc.update(copy, provider="claude")
    await _say(svc, copy, "four")
    req = engines["claude"].reqs[-1]
    assert req.fork_session is True and req.cli_session_id == "claude-1" and "codex answer 1" in req.preamble


async def test_a_copy_can_be_rewound_past_where_it_was_copied(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    await _say(svc, sid, "two")
    copy = (await svc.timeline.copy(sid))["id"]
    two = next(m for m in svc.messages(copy) if m["content"] == "two")["id"]
    res = await svc.timeline.rewind(copy, two)
    assert res["text"] == "two"
    await _say(svc, copy, "other")
    req = engines["claude"].reqs[-1]
    assert (req.cli_session_id, req.resume_at) == ("claude-1", "claude-at-1")
    assert _roles(svc, sid)[2:] == [("user", "two"), ("assistant", "claude answer 2")]


async def test_a_copy_has_its_own_files_and_stands_without_the_original(stack):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp)
    att = await _attach(svc, sid, "mine.txt", b"hello")
    await _attach(svc, sid, "not-sent-yet.txt")
    await _say(svc, sid, "with a file", attachment_ids=[att["id"]])
    made = await svc._attachments.save_bytes(sid, "tool.png", "image/png", b"\x89PNG", tag="artifact:t1")
    svc._add_event(sid, ProviderEvent(type="tool.result", data={"id": "t1", "images": [made]}))

    copy = (await svc.timeline.copy(sid))["id"]

    theirs = [m for m in svc.messages(copy) if m["role"] == "user"][0]["attachments"]
    assert len(theirs) == 1 and theirs[0]["id"] != att["id"] and theirs[0]["name"] == "mine.txt"
    new_row = svc._attachments.get(theirs[0]["id"])
    assert new_row["session_id"] == copy and open(new_row["path"], "rb").read() == b"hello"
    assert os.path.dirname(new_row["path"]).startswith(str(svc._attachments.session_dir(copy)))
    # the picture a tool made: the copy's event names the copy's file
    result = next(e for e in svc.events(copy) if e["type"] == "tool.result" and e["data"].get("images"))
    assert result["data"]["images"][0]["id"] != made["id"]
    assert svc._attachments.get(result["data"]["images"][0]["id"])["session_id"] == copy
    # what wasn't sent yet belongs to the original's composer
    assert not svc._db.query_one("SELECT 1 FROM attachments WHERE session_id = ? AND message_id IS NULL", (copy,))

    svc.delete(sid)
    assert open(new_row["path"], "rb").read() == b"hello"


async def test_copying_doesnt_count_on_the_usage_page_twice(stack):
    svc, _engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    before = UsageService(svc._db).summary()["total"]
    copy = (await svc.timeline.copy(sid))["id"]
    assert UsageService(svc._db).summary()["total"] == before
    assert week(svc._db)["total"]["turns"] == 1
    # what the copy itself spends counts, also if rewound
    two = await _say(svc, copy, "two")
    assert UsageService(svc._db).summary()["total"]["turns"] == 2
    await svc.timeline.rewind(copy, two)
    assert UsageService(svc._db).summary()["total"]["turns"] == 2
    one = next(m for m in svc.messages(copy) if m["content"] == "one")["id"]
    await svc.timeline.rewind(copy, one)  # (the copied turn was never the copy's to count)
    assert UsageService(svc._db).summary()["total"]["turns"] == 2


async def test_a_running_turn_isnt_copied(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    await _say(svc, sid, "one")
    engines["claude"].hold = asyncio.Event()
    svc.start_turn(sid, "working on it")
    for _ in range(100):
        if any(e["type"] == "tool.use" and e["data"]["id"] == "t2" for e in svc.events(sid)):
            break
        await asyncio.sleep(0.01)

    copy = await svc.timeline.copy(sid)

    assert _roles(svc, copy["id"]) == [("user", "one"), ("assistant", "claude answer 1")]
    assert not any(e["type"] == "tool.use" and e["data"]["id"] == "t2" for e in svc.events(copy["id"]))
    assert copy["cli_sessions"]["claude"]["at"] == "claude-at-1"
    assert svc.is_running(sid) and not copy["running"]
    engines["claude"].hold.set()
    await svc._tasks[sid]


async def test_an_older_chat_without_positions_can_be_copied_too(stack):
    svc, engines, tmp = stack
    sid = _new(svc, tmp)
    svc.seed_message(sid, "user", "old")
    svc._db.execute("UPDATE sessions SET context_floor = NULL WHERE id = ?", (sid,))
    copy = (await svc.timeline.copy(sid))["id"]
    await _say(svc, copy, "new")
    req = engines["claude"].reqs[-1]
    assert req.cli_session_id is None and "old" in req.preamble


# ---- the engines' side ----


def test_claude_is_told_to_continue_from_a_copy_at_that_point():
    req = TurnRequest(messages=[], model="sonnet", cwd="/x", cli_session_id="S")
    provider = ClaudeCodeProvider(binary="/bin/true")
    argv = provider._build_argv(req)
    assert "--fork-session" not in argv and "--resume-session-at" not in argv
    fork = TurnRequest(messages=[], model="sonnet", cwd="/x", cli_session_id="S", fork_session=True)
    argv = provider._build_argv(fork)
    assert argv[argv.index("--resume") + 1] == "S" and "--fork-session" in argv and "--resume-session-at" not in argv
    at = TurnRequest(messages=[], model="sonnet", cwd="/x", cli_session_id="S", fork_session=True, resume_at="U")
    argv = provider._build_argv(at)
    assert argv[argv.index("--resume-session-at") + 1] == "U"
    # (it isn't another engine: the next turns don't restart it)
    assert provider.engine_fingerprint(at) == provider.engine_fingerprint(req)


def test_a_turn_records_where_the_claude_session_stands():
    acc = StreamJsonAccumulator()
    list(acc.feed({"type": "system", "subtype": "init", "session_id": "S"}))
    list(acc.feed({"type": "assistant", "uuid": "U1", "message": {"content": []}}))
    list(acc.feed({"type": "assistant", "uuid": "SUB", "parent_tool_use_id": "t", "message": {"content": []}}))
    list(acc.feed({"type": "assistant", "uuid": "U2", "message": {"content": []}}))
    list(acc.feed({"type": "assistant", "uuid": "SUB2", "parent_tool_use_id": "t", "message": {"content": []}}))
    done = list(acc.feed({"type": "result", "subtype": "success", "session_id": "S", "result": "ok", "usage": {}}))
    assert done[-1].type == "turn.complete"
    assert done[-1].data["cli_session_id"] == "S" and done[-1].data["cli_at"] == "U2"
