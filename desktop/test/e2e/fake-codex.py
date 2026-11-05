#!/usr/bin/env python3
"""Deterministic app-server fixture for the real UI; never calls a model/tool."""
import json
import sys
import threading
import time
import uuid

if "--version" in sys.argv:
    print("codex-cli 0.166.0")
    raise SystemExit
if "login" in sys.argv:
    print("Logged in using ChatGPT")
    raise SystemExit

lock = threading.Lock()
stopped = threading.Event()
TURN_ID = "ui-turn-" + uuid.uuid4().hex
CHILD_ID = "ui-child-" + uuid.uuid4().hex


def send(obj):
    with lock:
        print(json.dumps(obj), flush=True)


def event(method, *, thread="ui-root", **params):
    if "itemId" in params:
        params["itemId"] = TURN_ID + "-" + params["itemId"]
    send({"method": method, "params": {"threadId": thread, "turnId": TURN_ID, **params}})


def item(kind, iid, fields, *, thread="ui-root", stamp=None):
    name = "startedAtMs" if kind == "started" else "completedAtMs"
    event("item/" + kind, thread=thread, item={"id": TURN_ID + "-" + iid, **fields},
          **{name: int(time.time()*1000) if stamp is None else stamp})


def perform(text):
    event("turn/started", turn={"id": TURN_ID, "status": "inProgress"})
    if "hidden" in text:
        time.sleep(2)
        at = int(time.time()*1000)
        item("started", "hidden", {"type": "reasoning"}, stamp=at)
        item("completed", "hidden", {"type": "reasoning"}, stamp=at)
    else:
        item("started", "thinking", {"type": "reasoning"})
        time.sleep(3)
        event("item/reasoning/summaryTextDelta", itemId="thinking", summaryIndex=0, delta="Inspecting the session and child-agent lifecycle.")
        time.sleep(1)
        item("completed", "thinking", {"type": "reasoning", "summary": ["Inspecting the session and child-agent lifecycle."]})
        call = {"type": "collabAgentToolCall", "tool": "spawnAgent", "status": "inProgress",
                "senderThreadId": "ui-root", "receiverThreadIds": [], "agentsStates": {},
                "prompt": "Review the timing records", "model": "gpt-6.1-sol"}
        item("started", "spawn", call)
        send({"method": "thread/started", "params": {"thread": {"id": CHILD_ID, "parentThreadId": "ui-root"}}})
        item("completed", "spawn", {**call, "status": "completed", "receiverThreadIds": [CHILD_ID], "agentsStates": {CHILD_ID: {"status": "running"}}})
        event("turn/started", thread=CHILD_ID, turn={"id": "child-" + TURN_ID, "status": "inProgress"})
        wait = {"type": "collabAgentToolCall", "tool": "wait", "status": "inProgress",
                "senderThreadId": "ui-root", "receiverThreadIds": [CHILD_ID], "agentsStates": {CHILD_ID: {"status": "running"}}}
        item("started", "wait", wait)
        item("started", "child-thinking", {"type": "reasoning"}, thread=CHILD_ID)
        time.sleep(2)
        item("completed", "child-thinking", {"type": "reasoning", "summary": ["Child timing checked."]}, thread=CHILD_ID)
        item("completed", "child-report", {"type": "agentMessage", "text": "CHILD_REPORT_ONLY"}, thread=CHILD_ID)
        event("turn/completed", thread=CHILD_ID, turn={"id": "child-" + TURN_ID, "status": "completed"})
        item("completed", "wait", {**wait, "status": "completed", "agentsStates": {CHILD_ID: {"status": "completed", "message": "CHILD_REPORT_ONLY"}}})
    if not stopped.is_set():
        item("completed", "answer", {"type": "agentMessage", "text": "검증 완료", "phase": "final_answer"})
        event("thread/tokenUsage/updated", tokenUsage={"total": {"inputTokens": 100, "cachedInputTokens": 20, "outputTokens": 10},
              "last": {"inputTokens": 100, "cachedInputTokens": 20, "outputTokens": 10}, "modelContextWindow": 500000})
        event("turn/completed", turn={"id": TURN_ID, "status": "completed", "items": []})


for line in sys.stdin:
    msg = json.loads(line)
    method, p = msg.get("method"), msg.get("params", {})
    if method == "initialize":
        send({"id": msg["id"], "result": {"userAgent": "codex/0.166.0 fixture"}})
    elif method in ("thread/start", "thread/resume"):
        send({"id": msg["id"], "result": {"thread": {"id": "ui-root"}}})
    elif method == "turn/start":
        send({"id": msg["id"], "result": {"turn": {"id": TURN_ID, "status": "inProgress"}}})
        threading.Thread(target=perform, args=(str(p["input"]),), daemon=True).start()
    elif method == "turn/steer":
        send({"id": msg["id"], "result": {"turnId": TURN_ID}})
    elif method == "turn/interrupt":
        stopped.set()
        send({"id": msg["id"], "result": {}})
        event("turn/completed", thread=p["threadId"], turn={"id": p["turnId"], "status": "interrupted"})
