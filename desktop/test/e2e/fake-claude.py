#!/usr/bin/env -S python3 -P
# A fake Claude CLI for the Mate e2e runs (desktop/test/e2e/mate-windows-e2e.js): run the throwaway backend with
# CLAUDE_BINARY=<this file> (executable, `python3 -P` shebang). Every message gets a reply of 5 sentences, one every
# 0.7 s, so a reply is still being written while the windows elect who reads it.
import json
import queue
import re
import sys
import threading
import time

args = sys.argv[1:]
if "--version" in args:
    print("2.0.0 (Claude Code)")
    sys.exit(0)
model = args[args.index("--model") + 1] if "--model" in args else "fake"
q: "queue.Queue[dict | None]" = queue.Queue()


def reader() -> None:
    for line in sys.stdin:
        line = line.strip()
        if line:
            q.put(json.loads(line))
    q.put(None)


threading.Thread(target=reader, daemon=True).start()


def emit(o: dict) -> None:
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


n = 0
while True:
    msg = q.get()
    if msg is None:
        break
    if msg.get("type") == "control_request":
        emit({"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"], "response": {}}})
        continue
    n += 1
    # "q<k> …" in the question names the reply "Reply <k>" (the tests count sentences per reply)
    content = msg.get("message", {}).get("content", "")
    text = content if isinstance(content, str) else " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    tag = re.search(r"\bq(\d+)\b", text.strip().splitlines()[-1] if text.strip() else "")
    k = int(tag.group(1)) if tag else n
    emit({"type": "system", "subtype": "init", "session_id": "fake-sid", "model": model, "permissionMode": "bypassPermissions"})
    full = ""
    for i in range(1, 6):
        time.sleep(0.7)
        part = f"Reply {k} sentence number {i} is here. "
        full += part
        # (like the real CLI with partial messages: text deltas, then the complete message)
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                "delta": {"type": "text_delta", "text": part}}})
    emit({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": full.strip()}]}})
    emit({"type": "result", "subtype": "success", "is_error": False, "result": full.strip(), "session_id": "fake-sid",
          "total_cost_usd": 0.01, "usage": {"input_tokens": 1, "output_tokens": 1}})
