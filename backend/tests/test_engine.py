"""Persistent Claude engine: multi-turn reuse, background tasks + auto turns,
interrupt, live model switch, restart on launch-setting change, shutdown."""
import asyncio
import json
import os
import stat
import sys
import textwrap

from app.providers.claude_code import ClaudeCodeProvider
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

FAKE = r'''
import json, os, queue, sys, threading, time
q = queue.Queue()
def reader():
    for line in sys.stdin:
        line = line.strip()
        if line:
            q.put(json.loads(line))
    q.put(None)
threading.Thread(target=reader, daemon=True).start()
lock = threading.Lock()
def emit(o):
    with lock:
        sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
args = sys.argv[1:]
model = args[args.index("--model") + 1]
SID = "fake-cli-session"
FAKE_DIR = "__FAKE_DIR__"
log = open(FAKE_DIR + "/calls.log", "a")
log.write(json.dumps({"pid": os.getpid(), "argv": args}) + "\n"); log.flush()
def init(): emit({"type": "system", "subtype": "init", "session_id": SID, "model": model, "permissionMode": "bypassPermissions"})
def say(t): emit({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": t}]}})
def result(t, sub="success"): emit({"type": "result", "subtype": sub, "is_error": sub != "success", "result": t, "session_id": SID, "total_cost_usd": 0.001, "usage": {"input_tokens": 5, "output_tokens": 3}})
pending = []
while True:
    try:
        msg = q.get(timeout=0.1)
    except queue.Empty:
        for bg in list(pending):
            if time.time() >= bg:
                pending.remove(bg)
                out = FAKE_DIR + "/t1.output"
                open(out, "w").write("bg output line\n")
                emit({"type": "system", "subtype": "task_updated", "task_id": "t1", "patch": {"status": "completed", "end_time": int(time.time() * 1000)}})
                emit({"type": "system", "subtype": "task_notification", "task_id": "t1", "tool_use_id": "tu1", "status": "completed", "output_file": out, "summary": "bg job completed"})
                init(); say("bg done"); result("bg done")   # Claude reacts on its own
        continue
    if msg is None:
        break
    if msg["type"] == "control_request":
        req = msg["request"]
        if req["subtype"] == "set_model":
            model = req["model"]
        emit({"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"], "response": {}}})
        continue
    content = msg["message"]["content"]
    text = content if isinstance(content, str) else content[-1]["text"]
    text = text.strip().splitlines()[-1]  # the new message (after any context preamble)
    init()
    if "LONG" in text:
        emit({"type": "assistant", "message": {"model": model, "content": [{"type": "tool_use", "id": "tl", "name": "Bash", "input": {"command": "sleep 99"}}]}})
        end = time.time() + 20
        while time.time() < end:
            try:
                m2 = q.get(timeout=0.1)
            except queue.Empty:
                continue
            if m2 and m2.get("type") == "control_request" and m2["request"]["subtype"] == "interrupt":
                emit({"type": "control_response", "response": {"subtype": "success", "request_id": m2["request_id"], "response": {}}})
                emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "tl", "content": "rejected"}]}})
                result("", sub="error_during_execution")
                break
        continue
    if "BG" in text:
        emit({"type": "assistant", "message": {"model": model, "content": [{"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "sleep 1", "run_in_background": True, "description": "bg job"}}]}})
        emit({"type": "system", "subtype": "task_started", "task_id": "t1", "tool_use_id": "tu1", "description": "bg job", "task_type": "local_bash", "is_backgrounded": True})
        emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "running in background"}]}})
        say("started"); result("started")
        pending.append(time.time() + 1.0)
        continue
    say(f"echo[{model}]: {text}"); result(f"echo[{model}]: {text}")
'''


def _svc(db, tmp_path, monkeypatch):
    fake = tmp_path / "claude"
    fake.write_text(f"#!{sys.executable}\n" + textwrap.dedent(FAKE).replace("__FAKE_DIR__", str(tmp_path)))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: ClaudeCodeProvider(binary=str(fake)))
    vault = SecretVault(db)
    return SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))


def _pids(tmp_path):
    return [json.loads(l)["pid"] for l in open(tmp_path / "calls.log")]


async def _until(q, pred, timeout=10):
    seen = []
    while True:
        m = await asyncio.wait_for(q.get(), timeout)
        seen.append(m)
        if pred(m):
            return seen


async def _turn(svc, q, sid, text):
    svc.start_turn(sid, text)
    return await _until(q, lambda m: m["type"] == "run.state" and not m["data"]["running"])


async def test_engine_persists_across_turns_and_handles_tasks(db, tmp_path, monkeypatch):
    svc = _svc(db, tmp_path, monkeypatch)
    sid = svc.create(provider="claude", model="m1", workspace_path=str(tmp_path))["id"]
    q = svc.subscribe(sid)
    try:
        seen = await _turn(svc, q, sid, "hello")
        assert any(m["type"] == "turn.complete" and m["data"]["text"] == "echo[m1]: hello" for m in seen)
        await _turn(svc, q, sid, "again")
        assert len(set(_pids(tmp_path))) == 1  # same process served both turns

        svc.update(sid, model="m2")  # live switch, no restart
        seen = await _turn(svc, q, sid, "third")
        assert any(m["type"] == "turn.complete" and m["data"]["text"] == "echo[m2]: third" for m in seen)
        assert len(set(_pids(tmp_path))) == 1

        # background task -> finishes while idle -> Claude's own (auto) turn
        await _turn(svc, q, sid, "start BG work")
        auto = await _until(q, lambda m: m["type"] == "run.state" and not m["data"]["running"])
        starts = [m for m in auto if m["type"] == "session.start"]
        assert starts and starts[0]["data"]["trigger"] == "background"
        assert any(m["type"] == "turn.complete" and m["data"]["text"] == "bg done" for m in auto)
        tasks = svc.list_tasks(sid)
        assert tasks[0]["task_id"] == "t1" and tasks[0]["status"] == "completed" and tasks[0]["is_backgrounded"]
        assert "output_file" not in tasks[0]  # never exposed
        assert svc.task_output(sid, "t1")["output"] == "bg output line\n"
        assert [m["role"] for m in svc.messages(sid)][-2:] == ["assistant", "assistant"]  # 'started' + 'bg done'

        # stop = interrupt: the turn ends, the engine survives
        svc.start_turn(sid, "LONG job")
        await _until(q, lambda m: m["type"] == "tool.use")
        assert svc.stop(sid)
        seen = await _until(q, lambda m: m["type"] == "run.state" and not m["data"]["running"])
        err = [m for m in seen if m["type"] == "error"]
        assert err and err[0]["data"]["code"] == "turn.interrupted"
        seen = await _turn(svc, q, sid, "after stop")
        assert len(set(_pids(tmp_path))) == 1
        assert not any(m["type"] == "notice" and "context" in m["data"].get("code", "") for m in seen)  # no self-handoff

        # a launch setting (effort) changes -> fresh process, resuming the CLI session
        svc.update(sid, effort="high")
        await _turn(svc, q, sid, "with effort")
        calls = [json.loads(l) for l in open(tmp_path / "calls.log")]
        assert len({c["pid"] for c in calls}) == 2
        assert calls[-1]["argv"][calls[-1]["argv"].index("--resume") + 1] == "fake-cli-session"
        assert svc.engines() and svc.engines()[0]["session_id"] == sid
    finally:
        await svc.shutdown()
    pid = _pids(tmp_path)[-1]
    await asyncio.sleep(0.2)
    assert not os.path.exists(f"/proc/{pid}") or open(f"/proc/{pid}/stat").read().split()[2] == "Z"
