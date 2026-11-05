"""Mid-turn steering through the real provider code, against fake CLIs."""
import asyncio
import json
import os
import stat
import sys
import textwrap

from app.providers.base import SteerMessage, TurnInbox, TurnRequest
from app.providers.claude_code import ClaudeCodeProvider
from app.providers.codex import CodexProvider

FAKE_CLAUDE = r'''
import json, sys, time
first = json.loads(sys.stdin.readline())
print(json.dumps({"type": "system", "subtype": "init", "session_id": "s1", "model": "fake"}), flush=True)
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "sleep"}}]}}), flush=True)
line = sys.stdin.readline()          # the steering message arrives while "working"
extra = json.loads(line)["message"]["content"] if line else ""
print(json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}), flush=True)
text = "done; also: " + (extra if isinstance(extra, str) else json.dumps(extra))
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}), flush=True)
print(json.dumps({"type": "result", "subtype": "success", "result": text, "session_id": "s1"}), flush=True)
rest = sys.stdin.read()              # stdin must be closed after the result
print(json.dumps({"type": "system", "subtype": "eof", "rest": rest}), flush=True)
'''

FAKE_CODEX = r'''
import json, sys, time
args = sys.argv[1:]
prompt = sys.stdin.read()
log = open(sys.argv[0] + ".log", "a"); log.write(json.dumps(args) + "\n"); log.close()
if args[:2] == ["exec", "resume"]:
    print(json.dumps({"type": "item.completed", "item": {"id": "m1", "type": "agent_message", "text": "resumed with: " + prompt.strip().splitlines()[-1]}}), flush=True)
    print(json.dumps({"type": "turn.completed", "usage": {}}), flush=True)
else:
    print(json.dumps({"type": "thread.started", "thread_id": "th-42"}), flush=True)
    print(json.dumps({"type": "item.started", "item": {"id": "c1", "type": "command_execution", "command": "sleep 30"}}), flush=True)
    time.sleep(30)
'''


def _fake(tmp_path, name, body):
    p = tmp_path / name
    p.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body))
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


async def _drive(provider, req, steer_text, when):
    events = []
    async def run():
        async for ev in provider.run_turn_stream(req):
            events.append(ev)
            if when(ev) and not getattr(run, "sent", False):
                run.sent = True
                fut = asyncio.get_running_loop().create_future()
                assert req.inbox.offer(SteerMessage(text=steer_text, delivered=fut))
                asyncio.get_running_loop().create_task(_await(fut, events))
    await asyncio.wait_for(run(), timeout=20)
    return events


async def _await(fut, events):
    events.append(("delivered", await fut))


async def test_claude_steering_is_injected_into_the_running_turn(tmp_path):
    p = ClaudeCodeProvider(binary=_fake(tmp_path, "claude", FAKE_CLAUDE))
    req = TurnRequest(messages=[{"role": "user", "content": "start"}], model="m", cwd=str(tmp_path), inbox=TurnInbox())
    events = await _drive(p, req, "also check disk", lambda ev: ev.type == "tool.use")
    done = [e for e in events if not isinstance(e, tuple) and e.type == "turn.complete"]
    assert len(done) == 1 and "also check disk" in done[0].data["text"]  # same turn, one result
    assert ("delivered", True) in events
    assert req.inbox.open is False  # closed after the result: later steers bounce to the queue
    assert not req.inbox.offer(SteerMessage(text="too late"))


async def test_codex_steering_interrupts_and_resumes_the_thread(tmp_path):
    fake = _fake(tmp_path, "codex", FAKE_CODEX)
    p = CodexProvider(binary=fake, transport="exec")
    req = TurnRequest(messages=[{"role": "user", "content": "start"}], model="default", cwd=str(tmp_path), inbox=TurnInbox())
    events = await _drive(p, req, "use port 8080 instead", lambda ev: ev.type == "tool.use")
    evs = [e for e in events if not isinstance(e, tuple)]
    types = [e.type for e in evs]
    assert ("delivered", True) in events
    # the cut-off command is closed, the user is told, the same thread continues
    assert any(e.type == "tool.result" and "interrupted" in e.data["output"] for e in evs)
    assert any(e.type == "notice" and e.data["code"] == "codex.steered" for e in evs)
    assert types[-1] == "turn.complete"
    assert "use port 8080 instead" in "".join(e.data["text"] for e in evs if e.type == "text.delta")
    calls = [json.loads(l) for l in open(fake + ".log")]
    assert calls[1][:3] == ["exec", "resume", "th-42"] and calls[1][-1] == "-"
