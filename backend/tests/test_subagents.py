"""Subagents (Agent/Task tool): their prose, reasoning and tool calls are
forwarded under the launching call, never mixed into the answer; background
subagents keep reporting after the turn without opening a turn of their own."""
import asyncio
import json
import stat
import sys
import textwrap

from app.providers._stream_json import StreamJsonAccumulator
from app.providers.claude_code import ClaudeCodeProvider
from app.providers.claude_engine import ClaudeEngine
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

AGENT = "toolu_agent"


def _assistant(content, parent=None):
    return {"type": "assistant", "parent_tool_use_id": parent,
            "message": {"model": "sub-model" if parent else "main-model", "content": content}}


def _feed(acc, *objs):
    out = []
    for o in objs:
        out += list(acc.feed(o))
    return out


def test_subagent_text_and_thinking_are_tagged_and_kept_out_of_the_answer():
    acc = StreamJsonAccumulator()
    evs = _feed(
        acc,
        _assistant([{"type": "tool_use", "id": AGENT, "name": "Agent",
                     "input": {"description": "probe", "subagent_type": "general-purpose", "prompt": "look"}}]),
        # the subagent's prompt echo, its reasoning (display omitted, then shown), a call, its prose
        {"type": "user", "parent_tool_use_id": AGENT, "message": {"content": [{"type": "text", "text": "look"}]}},
        _assistant([{"type": "thinking", "thinking": "", "signature": "x"}], AGENT),
        _assistant([{"type": "thinking", "thinking": "Need to list files."}], AGENT),
        {"type": "stream_event", "parent_tool_use_id": AGENT,
         "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "dup"}}},
        _assistant([{"type": "tool_use", "id": "toolu_ls", "name": "Bash", "input": {"command": "ls"}}], AGENT),
        {"type": "user", "parent_tool_use_id": AGENT,
         "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_ls", "content": "a.txt"}]}},
        _assistant([{"type": "text", "text": "Found a.txt."}], AGENT),
        {"type": "user", "parent_tool_use_id": None,
         "message": {"content": [{"type": "tool_result", "tool_use_id": AGENT,
                                  "content": [{"type": "text", "text": "[Subagent hand-back] …\n  Found a.txt."}]}]},
         "tool_use_result": {"status": "completed", "agentId": "a1", "agentType": "general-purpose",
                             "content": [{"type": "text", "text": "Found a.txt."}], "resolvedModel": "sub-model",
                             "totalDurationMs": 3128, "totalTokens": 20424, "totalToolUseCount": 1,
                             "usage": {"input_tokens": 2}}},
        {"type": "stream_event", "event": {"type": "content_block_delta",
                                           "delta": {"type": "text_delta", "text": "All done."}}},
        _assistant([{"type": "text", "text": "All done."}]),
        {"type": "result", "subtype": "success", "result": "All done.", "session_id": "s"},
    )
    types = [e.type for e in evs]
    assert types == ["tool.use", "subagent.thinking", "tool.use", "tool.result", "subagent.text",
                     "tool.result", "text.delta", "turn.complete"]
    by = {t: [e for e in evs if e.type == t] for t in set(types)}
    assert by["subagent.thinking"][0].data == {"parent": AGENT, "text": "Need to list files."}
    assert by["subagent.text"][0].data == {"parent": AGENT, "text": "Found a.txt."}
    nested_use, nested_res = by["tool.use"][1], by["tool.result"][0]
    assert nested_use.data["parent"] == AGENT and nested_res.data["parent"] == AGENT
    assert "parent" not in by["tool.use"][0].data
    agent = by["tool.result"][1].data["agent"]
    assert agent == {"agent_id": "a1", "status": "completed", "agent_type": "general-purpose", "model": "sub-model",
                     "duration_ms": 3128, "total_tokens": 20424, "tool_uses": 1, "result": "Found a.txt."}
    assert "agent" not in nested_res.data  # plain tool results carry no agent summary
    # the answer is the main agent's own text — the subagent's model/prose never leak into it
    done = by["turn.complete"][0].data
    assert done["text"] == "All done." and done["model"] == "main-model"
    assert "".join(e.data["text"] for e in by["text.delta"]) == "All done."


def test_subagent_text_never_becomes_the_final_answer_without_a_result_text():
    acc = StreamJsonAccumulator()
    evs = _feed(acc, _assistant([{"type": "text", "text": "sub prose"}], AGENT),
                {"type": "result", "subtype": "success", "session_id": "s"})
    assert evs[-1].type == "turn.complete" and evs[-1].data["text"] == ""


def _engine():
    return ClaudeEngine(binary="claude", argv=[], cwd="/", env_extras={}, fingerprint="f", model="m", mode="agent")


def test_task_progress_reports_activity_without_renaming_the_task():
    e = _engine()
    e._task_event("task_started", {"task_id": "t", "tool_use_id": AGENT, "description": "bg probe",
                                   "subagent_type": "general-purpose", "is_backgrounded": True,
                                   "task_type": "local_agent"})
    ev = e._task_event("task_progress", {"task_id": "t", "tool_use_id": AGENT,
                                         "description": "Running Sleep 5 seconds", "last_tool_name": "Bash",
                                         "usage": {"total_tokens": 17617, "tool_uses": 1, "duration_ms": 1649}})
    assert ev.type == "task.update"
    assert ev.data["description"] == "bg probe" and ev.data["activity"] == "Running Sleep 5 seconds"
    assert ev.data["tool_uses"] == 1 and ev.data["last_tool_name"] == "Bash" and ev.data["status"] == "running"
    assert ev.data["subagent_type"] == "general-purpose" and ev.data["event"] == "task_progress"
    ev = e._task_event("task_notification", {"task_id": "t", "tool_use_id": AGENT, "status": "completed",
                                             "summary": "printed done", "usage": {"tool_uses": 2}})
    assert ev.data["status"] == "completed" and ev.data["summary"] == "printed done" and ev.data["tool_uses"] == 2
    assert ev.data["ended_at"]


# ---- background subagent through the persistent engine ----

FAKE = r'''
import json, os, sys, threading, time
FAKE_DIR = "__FAKE_DIR__"
open(FAKE_DIR + "/env.log", "a").write(json.dumps({"forward": os.environ.get("CLAUDE_CODE_FORWARD_SUBAGENT_TEXT")}) + "\n")
lock = threading.Lock()
def emit(o):
    with lock:
        sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
SID = "fake-cli-session"
A = "toolu_bg"
def init(): emit({"type": "system", "subtype": "init", "session_id": SID, "model": "m"})
def say(t, parent=None): emit({"type": "assistant", "parent_tool_use_id": parent, "message": {"model": "m", "content": [{"type": "text", "text": t}]}})
def result(t): emit({"type": "result", "subtype": "success", "is_error": False, "result": t, "session_id": SID, "total_cost_usd": 0, "usage": {}})
def background():
    time.sleep(0.4)  # the launching turn is over: the chat is idle
    emit({"type": "system", "subtype": "task_progress", "task_id": "ta", "tool_use_id": A, "description": "Running ls", "last_tool_name": "Bash", "usage": {"tool_uses": 1, "total_tokens": 10, "duration_ms": 5}})
    emit({"type": "assistant", "parent_tool_use_id": A, "message": {"model": "m", "content": [{"type": "tool_use", "id": "toolu_ls", "name": "Bash", "input": {"command": "ls"}}]}})
    emit({"type": "user", "parent_tool_use_id": A, "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_ls", "content": "a.txt"}]}})
    say("Found a.txt.", A)
    time.sleep(0.3)
    emit({"type": "system", "subtype": "task_updated", "task_id": "ta", "patch": {"status": "completed", "end_time": int(time.time() * 1000)}})
    emit({"type": "system", "subtype": "task_notification", "task_id": "ta", "tool_use_id": A, "status": "completed", "summary": "Found a.txt.", "output_file": ""})
    init(); say("the subagent found a.txt"); result("the subagent found a.txt")  # Claude reacts on its own
for line in sys.stdin:
    if not line.strip():
        continue
    msg = json.loads(line)
    if msg.get("type") == "control_request":
        emit({"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"], "response": {}}})
        continue
    init()
    emit({"type": "assistant", "message": {"model": "m", "content": [{"type": "tool_use", "id": A, "name": "Agent", "input": {"description": "bg probe", "subagent_type": "general-purpose", "prompt": "list files", "run_in_background": True}}]}})
    emit({"type": "system", "subtype": "task_started", "task_id": "ta", "tool_use_id": A, "description": "bg probe", "subagent_type": "general-purpose", "task_type": "local_agent", "is_backgrounded": True})
    emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": A, "content": "Async agent launched successfully."}]}, "tool_use_result": {"isAsync": True, "status": "async_launched", "agentId": "ta", "prompt": "list files"}})
    say("launched"); result("launched")
    threading.Thread(target=background, daemon=True).start()
'''


async def _until(q, pred, timeout=10):
    seen = []
    while True:
        m = await asyncio.wait_for(q.get(), timeout)
        seen.append(m)
        if pred(m):
            return seen


async def test_background_subagent_reports_while_idle_without_opening_a_turn(db, tmp_path, monkeypatch):
    fake = tmp_path / "claude"
    fake.write_text(f"#!{sys.executable}\n" + textwrap.dedent(FAKE).replace("__FAKE_DIR__", str(tmp_path)))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: ClaudeCodeProvider(binary=str(fake)))
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    sid = svc.create(provider="claude", model="m", workspace_path=str(tmp_path))["id"]
    q = svc.subscribe(sid)
    try:
        svc.start_turn(sid, "launch a background subagent")
        first = await _until(q, lambda m: m["type"] == "run.state" and not m["data"]["running"])
        launch = next(m for m in first if m["type"] == "tool.result")
        assert launch["data"]["agent"]["is_async"] is True and launch["data"]["agent"]["status"] == "async_launched"

        # idle: the subagent's steps arrive on their own, then Claude's auto turn
        idle = await _until(q, lambda m: m["type"] == "run.state" and m["data"]["running"])
        sub = [m for m in idle if m["type"] in ("tool.use", "tool.result", "subagent.text")]
        assert [m["type"] for m in sub] == ["tool.use", "tool.result", "subagent.text"]
        assert all(m["data"]["parent"] == "toolu_bg" and m.get("eid") for m in sub)  # persisted, under the Agent call
        assert not any(m["type"] == "session.start" for m in idle)  # they opened no turn
        progress = [m for m in idle if m["type"] == "task.state" and m["data"].get("activity")]
        assert progress and progress[0]["data"]["activity"] == "Running ls" and progress[0]["data"]["tool_uses"] == 1
        assert progress[0]["data"]["description"] == "bg probe"

        auto = await _until(q, lambda m: m["type"] == "run.state" and not m["data"]["running"])
        assert any(m["type"] == "turn.complete" and m["data"]["text"] == "the subagent found a.txt" for m in auto)
        starts = [m for m in auto if m["type"] == "session.start"]
        assert len(starts) == 1 and starts[0]["data"]["trigger"] == "background"

        # history replay has every subagent step, in order, after the launching turn
        evs = svc.events(sid)
        kinds = [(e["type"], e["data"].get("parent")) for e in evs if e["data"].get("parent")]
        assert kinds == [("tool.use", "toolu_bg"), ("tool.result", "toolu_bg"), ("subagent.text", "toolu_bg")]
        first_done = next(i for i, e in enumerate(evs) if e["type"] == "turn.complete")
        assert all(i > first_done for i, e in enumerate(evs) if e["data"].get("parent"))
        # the answer messages are the main agent's only
        assert [m["content"] for m in svc.messages(sid) if m["role"] == "assistant"] == [
            "launched", "the subagent found a.txt"]
        assert svc.list_tasks(sid)[0]["status"] == "completed"
        assert json.loads(open(tmp_path / "env.log").readline())["forward"] == "1"
    finally:
        await svc.shutdown()
