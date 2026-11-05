"""Installed Codex 0.166 protocol fixtures + a real stdio process, no model calls."""

import asyncio
import json
import sys
from datetime import datetime

import pytest

from app.providers._codex_app_server import CodexAppAccumulator
from app.providers._stream_json import StreamJsonAccumulator
from app.providers.base import SteerMessage, TurnInbox, TurnRequest
from app.providers.codex import CodexProvider


def notify(acc, method, **params):
    return list(
        acc.feed_notification(
            {"method": method, "params": {"threadId": "root", "turnId": "turn", **params}}
        )
    )


def accumulator():
    acc = CodexAppAccumulator()
    acc.thread_id, acc.turn_id = "root", "turn"
    return acc


def test_reasoning_lifecycle_exists_before_text_and_uses_engine_time():
    acc = accumulator()
    item = {"type": "reasoning", "id": "r", "summary": []}
    start = notify(acc, "item/started", item=item, startedAtMs=1800000000000)
    assert [e.type for e in start] == ["thinking.start"]
    delta = notify(
        acc, "item/reasoning/summaryTextDelta", itemId="r", summaryIndex=0, delta="Investigating"
    )
    end = notify(
        acc,
        "item/completed",
        item={**item, "summary": ["Investigating"]},
        completedAtMs=1800000008500,
    )
    assert [e.type for e in end] == ["thinking.end"]  # no repeated summary
    assert delta[0].data == {"id": "root:r", "text": "Investigating"}
    assert (
        datetime.fromisoformat(end[0].timestamp) - datetime.fromisoformat(start[0].timestamp)
    ).total_seconds() == 8.5
    assert not notify(acc, "item/completed", item=item, completedAtMs=1800000008500)


def test_hidden_reasoning_is_measured_but_late_history_has_no_invented_start():
    acc = accumulator()
    item = {"type": "reasoning", "id": "r"}
    assert notify(acc, "item/started", item=item)[0].type == "thinking.start"
    assert notify(acc, "item/completed", item=item)[0].type == "thinking.end"
    late = notify(acc, "item/completed", item={**item, "id": "late", "summary": ["Finished"]})
    assert [e.type for e in late] == ["thinking.delta", "thinking.end"]


def test_hidden_reasoning_delivered_at_once_does_not_claim_zero_ms_thinking():
    acc = accumulator()
    started = notify(acc, "turn/started", turn={"id": "turn"})
    assert started[0].data["scope"] == "response"
    item = {"type": "reasoning", "id": "hidden"}
    begin = notify(acc, "item/started", item=item, startedAtMs=1800000004000)
    assert begin[0].type == "thinking.end" and begin[0].data["scope"] == "response"
    ended = notify(acc, "item/completed", item=item, completedAtMs=1800000004000)
    assert ended[0].data["timing_known"] is False


def test_tool_runtime_is_not_included_in_response_generation():
    acc = accumulator()
    notify(acc, "turn/started", turn={"id": "turn"})
    command = {"id": "c", "type": "commandExecution", "command": "sleep 5", "status": "inProgress"}
    started = notify(acc, "item/started", item=command, startedAtMs=1800000001000)
    assert started[0].type == "thinking.end" and started[0].data["scope"] == "response"
    done = notify(
        acc,
        "item/completed",
        item={**command, "status": "completed", "exitCode": 0},
        completedAtMs=1800000006000,
    )
    assert done[-1].type == "thinking.start" and done[-1].data["scope"] == "response"


def test_codex_child_agent_steps_results_and_failures_are_nested():
    acc = accumulator()
    spawn = {
        "type": "collabAgentToolCall",
        "id": "spawn",
        "tool": "spawnAgent",
        "senderThreadId": "root",
        "receiverThreadIds": [],
        "agentsStates": {},
        "status": "inProgress",
        "prompt": "Review code",
        "model": "gpt-6.1-sol",
    }
    start = notify(acc, "item/started", item=spawn)
    assert start[0].type == "tool.use" and start[0].data["name"] == "Agent"
    notify(acc, "thread/started", thread={"id": "child", "parentThreadId": "root"})
    done = notify(
        acc,
        "item/completed",
        item={
            **spawn,
            "status": "completed",
            "receiverThreadIds": ["child"],
            "agentsStates": {"child": {"status": "running"}},
        },
    )
    assert any(e.type == "task.update" and e.data["status"] == "running" for e in done)
    assert next(e for e in done if e.type == "tool.result").data["agent"]["is_async"] is True
    child = notify(
        acc,
        "item/started",
        threadId="child",
        item={
            "id": "cmd",
            "type": "commandExecution",
            "command": "git status",
            "status": "inProgress",
        },
    )
    assert child[0].data["parent"] == "root:spawn" and child[0].data["id"] == "child:cmd"
    think = notify(acc, "item/started", threadId="child", item={"id": "r", "type": "reasoning"})
    assert think[0].data["parent"] == "root:spawn"
    prose = notify(
        acc,
        "item/completed",
        threadId="child",
        item={"id": "answer", "type": "agentMessage", "text": "Child report"},
    )
    assert prose[0].type == "subagent.text" and acc.final_text == ""
    wait = {
        "type": "collabAgentToolCall",
        "id": "wait",
        "tool": "wait",
        "status": "completed",
        "receiverThreadIds": ["child"],
        "agentsStates": {"child": {"status": "errored", "message": "Child failed"}},
        "senderThreadId": "root",
    }
    evs = notify(acc, "item/completed", item=wait)
    assert any(e.type == "task.update" and e.data["status"] == "failed" for e in evs)
    assert any(e.type == "subagent.text" and e.data["text"] == "Child failed" for e in evs)
    assert not notify(
        acc,
        "item/completed",
        threadId="unknown",
        item={"id": "a", "type": "agentMessage", "text": "Must not leak"},
    )


def test_agent_activity_lifecycle_without_child_thread_subscription():
    acc = accumulator()
    item = {
        "type": "subAgentActivity",
        "id": "activity",
        "agentThreadId": "child",
        "agentPath": "reviewer",
        "kind": "started",
    }
    started = notify(acc, "item/started", item=item)
    assert any(e.type == "tool.use" and e.data["name"] == "Agent" for e in started)
    completed = notify(acc, "item/completed", item={**item, "id": "end", "kind": "completed"})
    assert completed[-1].type == "task.update" and completed[-1].data["status"] == "completed"


def test_parallel_spawn_race_buffers_child_steps_until_the_right_parent_is_known():
    acc = accumulator()
    spawn = {
        "type": "collabAgentToolCall",
        "tool": "spawnAgent",
        "status": "inProgress",
        "senderThreadId": "root",
        "receiverThreadIds": [],
        "agentsStates": {},
    }
    notify(acc, "item/started", item={**spawn, "id": "a"})
    notify(acc, "item/started", item={**spawn, "id": "b"})
    notify(acc, "thread/started", thread={"id": "child-a", "parentThreadId": "root"})
    assert not notify(
        acc,
        "item/started",
        threadId="child-a",
        item={"type": "reasoning", "id": "reason"},
        startedAtMs=1800000001000,
    )
    replay = notify(
        acc,
        "item/completed",
        item={**spawn, "id": "a", "status": "completed", "receiverThreadIds": ["child-a"]},
    )
    child = next(
        e for e in replay if e.type == "thinking.start" and e.data.get("id") == "child-a:reason"
    )
    assert child.data["parent"] == "root:a"
    assert child.timestamp.startswith("2027-01-15T08:00:01")


def test_child_interrupt_is_stopped_not_failed():
    acc = accumulator()
    acc.parents["child"] = "spawn"
    events = notify(
        acc, "turn/completed", threadId="child", turn={"id": "child-turn", "status": "interrupted"}
    )
    assert next(e for e in events if e.type == "task.update").data["status"] == "stopped"


def test_usage_is_this_turn_not_thread_total_and_deltas_do_not_duplicate_answer():
    acc = accumulator()
    notify(
        acc,
        "thread/tokenUsage/updated",
        turnId="previous",
        tokenUsage={"total": {"inputTokens": 1000, "outputTokens": 100}},
    )
    usage = {
        "total": {"inputTokens": 1030, "outputTokens": 110, "cachedInputTokens": 5},
        "last": {"inputTokens": 30},
        "modelContextWindow": 500000,
    }
    evs = notify(acc, "thread/tokenUsage/updated", tokenUsage=usage)
    notify(acc, "thread/tokenUsage/updated", tokenUsage=usage)
    assert acc.usage == {
        "input_tokens": 30,
        "output_tokens": 10,
        "cached_input_tokens": 5,
        "reasoning_output_tokens": 0,
    }
    assert evs[0].data["window"] == 500000
    a = notify(acc, "item/agentMessage/delta", itemId="a", delta="Hello ")
    b = notify(
        acc, "item/completed", item={"id": "a", "type": "agentMessage", "text": "Hello world"}
    )
    assert "".join(e.data["text"] for e in a + b if e.type == "text.delta") == "Hello world"
    assert acc.final_text == "Hello world"


def test_claude_reasoning_starts_without_waiting_for_text_and_closes_on_stop():
    acc = StreamJsonAccumulator()

    def event(kind, **data):
        return list(acc.feed({"type": "stream_event", "event": {"type": kind, **data}}))

    event("message_start")
    begin = event(
        "content_block_start", index=1, content_block={"type": "thinking", "thinking": ""}
    )
    text = event(
        "content_block_delta", index=1, delta={"type": "thinking_delta", "thinking": "Inspecting"}
    )
    end = event("content_block_stop", index=1)
    assert [e.type for e in begin + text + end] == [
        "thinking.start",
        "thinking.delta",
        "thinking.end",
    ]
    assert begin[0].data["id"] == end[0].data["id"]
    assert not event("message_stop")


FAKE = r"""
import json, os, sys, time
def out(obj): print(json.dumps(obj), flush=True)
def event(method, **p): out({"method": method, "params": {"threadId": "root", "turnId": "turn", **p}})
for line in sys.stdin:
    msg = json.loads(line)
    with open(sys.argv[0]+".log", "a") as f: f.write(json.dumps(msg)+"\n")
    method, p = msg.get("method"), msg.get("params", {})
    if method == "initialize": out({"id": msg["id"], "result": {"userAgent": "codex/0.166.0"}})
    elif method in ("thread/start", "thread/resume"):
        # the real server returns the whole history on resume unless told not to (one line, 17 MB seen)
        turns = [{"id": "old", "items": ["x" * (17 * 1024 * 1024)]}] if method == "thread/resume" and not p.get("excludeTurns") else []
        out({"id": msg["id"], "result": {"thread": {"id": "root", "turns": turns}}})
    elif method == "turn/start":
        out({"id": msg["id"], "result": {"turn": {"id": "turn", "status": "inProgress"}}})
        event("turn/started", turn={"id": "turn", "status": "inProgress"})
        event("item/started", item={"id": "r", "type": "reasoning"})
        if os.environ.get("FAKE_DIE"): sys.exit(2)
        if os.environ.get("FAKE_STALL"): continue
    elif method == "turn/steer":
        if os.environ.get("FAKE_REJECT"):
            out({"id": msg["id"], "error": {"message": "Turn already completed"}})
        else:
            out({"id": msg["id"], "result": {"turnId": "turn"}})
        event("item/completed", item={"id": "r", "type": "reasoning", "summary": ["Done"]})
        event("item/completed", item={"id": "answer", "type": "agentMessage", "text": "One answer"})
        event("turn/completed", turn={"id": "turn", "status": "completed", "items": []})
"""


def fake_cli(tmp_path):
    script = tmp_path / "codex"
    script.write_text(f"#!{sys.executable}\n" + FAKE)
    script.chmod(0o755)
    return script


@pytest.mark.parametrize("reject", [False, True])
async def test_real_stdio_same_turn_steering_and_rejection_are_acknowledged(tmp_path, reject):
    script = fake_cli(tmp_path)
    req = TurnRequest(
        messages=[{"role": "user", "content": "Inspect"}],
        model="default",
        cwd=str(tmp_path),
        mode="plan",
        effort="high",
        inbox=TurnInbox(),
        extra_env={"FAKE_REJECT": "1"} if reject else {},
    )
    events = []
    delivered = asyncio.get_running_loop().create_future()

    async def run():
        async for ev in CodexProvider(binary=str(script)).run_turn_stream(req):
            events.append(ev)
            if ev.type == "thinking.start":
                assert req.inbox.offer(SteerMessage(text="also review tests", delivered=delivered))

    await asyncio.wait_for(run(), 10)
    assert await delivered is not reject
    assert [e.type for e in events][-1] == "turn.complete"
    assert sum(e.type == "turn.complete" for e in events) == 1
    assert not req.inbox.open
    messages = [json.loads(x) for x in script.with_suffix(".log").read_text().splitlines()]
    assert sum(m.get("method") == "turn/start" for m in messages) == 1
    assert (
        next(m for m in messages if m.get("method") == "thread/start")["params"]["sandbox"]
        == "read-only"
    )
    steer = next(m for m in messages if m.get("method") == "turn/steer")["params"]
    assert steer["expectedTurnId"] == "turn" and "also review tests" in steer["input"][0]["text"]


async def test_resuming_a_long_conversation_does_not_load_its_history(tmp_path):
    """A resume reply with the history is one JSON line over the reader's limit: every message of a long Codex chat
    ended in "connection closed"."""
    script = fake_cli(tmp_path)
    req = TurnRequest(messages=[{"role": "user", "content": "Go on"}], model="default", cwd=str(tmp_path),
                      cli_session_id="root", inbox=TurnInbox())
    events = []
    delivered = asyncio.get_running_loop().create_future()

    async def run():
        async for ev in CodexProvider(binary=str(script)).run_turn_stream(req):
            events.append(ev)
            if ev.type == "thinking.start":
                assert req.inbox.offer(SteerMessage(text="next", delivered=delivered))

    await asyncio.wait_for(run(), 15)
    assert events[-1].type == "turn.complete" and not any(e.type == "error" for e in events)
    messages = [json.loads(x) for x in script.with_suffix(".log").read_text().splitlines()]
    resume = next(m for m in messages if m.get("method") == "thread/resume")["params"]
    assert resume["threadId"] == "root" and resume["excludeTurns"] is True


async def test_dead_process_does_not_leave_thinking_or_wait_forever(tmp_path):
    script = fake_cli(tmp_path)
    req = TurnRequest(messages=[], model="default", cwd=str(tmp_path), extra_env={"FAKE_DIE": "1"})

    async def run():
        return [e async for e in CodexProvider(binary=str(script)).run_turn_stream(req)]

    events = await asyncio.wait_for(run(), 10)
    assert events[-1].type == "error"
    assert any(e.type == "thinking.end" for e in events)


async def test_stop_closes_process_and_rejects_undelivered_steering(tmp_path):
    script = fake_cli(tmp_path)
    req = TurnRequest(
        messages=[],
        model="default",
        cwd=str(tmp_path),
        inbox=TurnInbox(),
        extra_env={"FAKE_STALL": "1"},
    )
    stream = CodexProvider(binary=str(script)).run_turn_stream(req)
    async for ev in stream:
        if ev.type == "thinking.start":
            break
    await asyncio.wait_for(stream.aclose(), 10)
    assert not req.inbox.open
