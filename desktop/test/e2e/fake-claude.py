#!/usr/bin/env -S python3 -P
# A fake Claude CLI for the Mate e2e runs (desktop/test/e2e/mate-windows-e2e.js): run the throwaway backend with
# CLAUDE_BINARY=<this file> (executable, `python3 -P` shebang). Every message gets a reply of 5 sentences, one every
# 0.7 s, so a reply is still being written while the windows elect who reads it.
# A message with "md1" gets a markdown-heavy reply instead (every element, unsafe links / HTML, long lines), streamed
# a few characters at a time with pauses in the middle of a bold word, the code block and the table (FAKE_MD_PAUSE
# seconds, default 2.5) so a test can look at the half-written state; "md2" gets a short one
# (desktop/test/e2e/mate-markdown-browser.js). A message ending in "tools1" gets an agent turn with tool calls (Bash,
# Read, Edit with a diff, a failed command, TodoWrite) and then a markdown answer with code (the theme screenshots).
import json
import os
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

# What the engine received, for desktop/test/e2e/mate-affinity-browser.js: every turn appends {"argv",
# "system_prompt", "text"} (the system prompt file and the whole message, incl. the mate's per-turn <context>
# block) to FAKE_CLAUDE_LOG — or, since the backend passes the CLI only a few variables (HOME, PATH…), to
# ~/fake-claude-turns.jsonl when that file exists (the test creates it in the throwaway HOME).
_HOME_LOG = os.path.join(os.path.expanduser("~"), "fake-claude-turns.jsonl")
LOG = os.environ.get("FAKE_CLAUDE_LOG") or (_HOME_LOG if os.path.exists(_HOME_LOG) else None)


def log_turn(text: str) -> None:
    if not LOG:
        return
    prompt = ""
    if "--system-prompt-file" in args:
        try:
            prompt = open(args[args.index("--system-prompt-file") + 1], encoding="utf-8").read()
        except OSError:
            pass
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"argv": args, "system_prompt": prompt, "text": text, "at": time.time()}, ensure_ascii=False) + "\n")


def call_tool(name: str, arguments: dict) -> str:
    """A tool call through the real mate MCP bridge (the server named "mate" in --mcp-config), like the CLI does:
    a message whose last line is `tool:<name> <json args>` makes the fake run it and answer with the result."""
    import subprocess

    cfg_arg = args[args.index("--mcp-config") + 1]
    cfg = json.load(open(cfg_arg)) if os.path.exists(cfg_arg) else json.loads(cfg_arg)
    srv = cfg["mcpServers"]["mate"]
    proc = subprocess.Popen([srv["command"], *srv["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            env={**os.environ, **srv.get("env", {})}, text=True)

    def rpc(o: dict) -> dict | None:
        proc.stdin.write(json.dumps(o) + "\n")
        proc.stdin.flush()
        return json.loads(proc.stdout.readline()) if "id" in o else None

    rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
    rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})
    out = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
    proc.stdin.close()
    proc.wait(timeout=10)
    res = (out or {}).get("result") or {}
    return " ".join(c.get("text", "") for c in res.get("content", []))


def emit(o: dict) -> None:
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


FENCE = "`" * 3
MD1 = "\n".join([
    "[smile] 좋아요! **마크다운 예시**를 보여 드릴게요. 설치는 `npm ci` 로 해요.",
    "자세한 건 [공식 문서](https://example.com/docs) 와 https://example.org/very/long/path/that/keeps/going/and/going/"
    "without/any/break/at/all/0123456789abcdefghijklmnopqrstuvwxyz0123456789 를 보세요 😀",
    "위험한 [링크](javascript:window.__xss=1) 는 링크가 아니에요. <script>window.__xss=2</script> "
    "<img src=x onerror=\"window.__xss=3\"> 태그는 글자 그대로예요.",
    "",
    "## 설치 방법",
    "",
    "1. 저장소를 받아요.",
    "2. 의존성을 설치해요:",
    "   - `npm ci`",
    "   - [ ] 테스트 실행",
    "   - [x] 빌드 확인",
    "     - 아주",
    "       - 깊은",
    "         - 중첩",
    "           - 목록",
    "",
    FENCE + "bash",
    "npm ci && npm run build   # 이건 읽으면 안 돼요.",
    "echo \"a very long line " + "." * 160 + " end\"",
    FENCE,
    "",
    "| 이름 | 값 | 비고 |",
    "|:---|---:|---|",
    "| Mr. Kim | 3.5 | 테이블은 읽지 않아요. |",
    "| **B** | `4` | [링크](https://example.com/b) |",
    "| very-long-cell-content-without-spaces-0123456789-0123456789-0123456789 | 5 | 6 |",
    "",
    "> 인용문이에요. 두 번째 문장.",
    "> > 중첩된 인용",
    "",
    "---",
    "",
    "![고양이 사진](https://images.example.net/cat.png)",
    "",
    "[thinking] 마지막으로, 질문 있으면 말씀해 주세요~",
])
MD1_PAUSES = ["**마크다운 예", "npm ci && npm run", "| Mr. Kim | 3.5 | 테이"]
MD2 = "\n".join([
    "[smile] 네! **요약**이에요:",
    "- 첫째: `make test` 를 돌려요",
    "- 둘째: [문서](https://example.com) 확인",
    FENCE + "sh",
    "make test",
    FENCE,
    "끝이에요~",
])
PAUSE = float(os.environ.get("FAKE_MD_PAUSE", "2.5"))


def stream_markdown(text: str, pauses: list[str]) -> str:
    """the reply a few characters at a time, stopping a while where `pauses` end"""
    stops = sorted(text.index(p) + len(p) for p in pauses)
    i = 0
    while i < len(text):
        j = min(len(text), i + 5)
        for s in stops:
            if i < s <= j:
                j = s
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                "delta": {"type": "text_delta", "text": text[i:j]}}})
        time.sleep(PAUSE if j in stops else 0.03)
        i = j
    return text


TOOLS_ANSWER = "\n".join([
    "Done — the greeting now says **hello** and **world**.",
    "",
    "## What changed",
    "",
    "| File | Change |",
    "|---|---|",
    "| `src/app.py` | the greeting, split in two lines |",
    "",
    "> Tests still pass; `make lint` found nothing.",
    "",
    FENCE + "python",
    "def greet(name: str) -> str:",
    "    # a friendly hello",
    "    return f\"hello, {name}!\"  # 42",
    "",
    "class Greeter:",
    "    count = 3",
    FENCE,
])


def tool_turn() -> None:
    """an agent turn with tool calls and their results, then the answer"""
    calls = [
        ("t1", "Bash", {"command": "ls -la src", "description": "List the source files"},
         "total 16\n-rw-r--r-- 1 me me  120 app.py\n-rw-r--r-- 1 me me   48 util.py", False),
        ("t2", "Read", {"file_path": "/work/demo/src/app.py"}, "     1\tprint('hi')\n     2\t", False),
        ("t3", "Edit", {"file_path": "/work/demo/src/app.py", "old_string": "print('hi')",
                        "new_string": "print('hello')\nprint('world')"},
         "The file /work/demo/src/app.py has been updated.", False),
        ("t4", "Bash", {"command": "pytset -q", "description": "Run the tests"}, "bash: pytset: command not found", True),
        ("t5", "TodoWrite", {"todos": [{"content": "Change the greeting", "status": "completed", "activeForm": "Changing"},
                                       {"content": "Run the tests", "status": "in_progress", "activeForm": "Running the tests"},
                                       {"content": "Update the docs", "status": "pending", "activeForm": "Updating"}]},
         "Todos have been modified successfully.", False),
    ]
    emit({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": "Let me look at the code first."}]}})
    for tid, name, inp, out, err in calls:
        emit({"type": "assistant", "message": {"model": model, "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}})
        time.sleep(0.15)
        emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": out, "is_error": err}]}})
    emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": TOOLS_ANSWER}}})
    emit({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": TOOLS_ANSWER}]}})
    emit({"type": "result", "subtype": "success", "is_error": False, "result": TOOLS_ANSWER, "session_id": "fake-sid",
          "total_cost_usd": 0.02, "usage": {"input_tokens": 1200, "output_tokens": 300}})


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
    last = text.strip().splitlines()[-1] if text.strip() else ""
    log_turn(text)
    tool = re.match(r"^tool:(\w+)\s*(\{.*\})?\s*$", last)
    if tool:
        result = call_tool(tool.group(1), json.loads(tool.group(2) or "{}"))
        full = f"[smile] Tool {tool.group(1)}: {result}"
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                "delta": {"type": "text_delta", "text": full}}})
        emit({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": full}]}})
        emit({"type": "result", "subtype": "success", "is_error": False, "result": full, "session_id": "fake-sid",
              "total_cost_usd": 0.01, "usage": {"input_tokens": 1, "output_tokens": 1}})
        continue
    if re.search(r"\btools1\b", last):
        tool_turn()
        continue
    md = MD1 if re.search(r"\bmd1\b", last) else MD2 if re.search(r"\bmd2\b", last) else None
    full = ""
    for i in range(1, 6 if md is None else 1):
        time.sleep(0.7)
        part = f"Reply {k} sentence number {i} is here. "
        full += part
        # (like the real CLI with partial messages: text deltas, then the complete message)
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                "delta": {"type": "text_delta", "text": part}}})
    if md is not None:
        full = stream_markdown(md, MD1_PAUSES if md is MD1 else [])
    emit({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": full.strip()}]}})
    emit({"type": "result", "subtype": "success", "is_error": False, "result": full.strip(), "session_id": "fake-sid",
          "total_cost_usd": 0.01, "usage": {"input_tokens": 1, "output_tokens": 1}})
