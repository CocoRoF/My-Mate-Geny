#!/usr/bin/env -S python3 -P
# A fake Claude CLI for the Mate e2e runs (desktop/test/e2e/mate-windows-e2e.js): run the throwaway backend with
# CLAUDE_BINARY=<this file> (executable, `python3 -P` shebang). Every message gets a reply of 5 sentences, one every
# 0.7 s, so a reply is still being written while the windows elect who reads it.
# A message with "md1" gets a markdown-heavy reply instead (every element, unsafe links / HTML, long lines), streamed
# a few characters at a time with pauses in the middle of a bold word, the code block and the table (FAKE_MD_PAUSE
# seconds, default 2.5) so a test can look at the half-written state; "md2" gets a short one
# (desktop/test/e2e/mate-markdown-browser.js). A message ending in "tools1" gets an agent turn with tool calls (Bash,
# Read, Edit with a diff, a failed command, TodoWrite) and then a markdown answer with code (the theme screenshots).
# "hfcheck" runs the higgsfield CLI like an agent's Bash tool would and reports what it found (HFCHECK …); "hfdump"
# answers with the launch it got — argv, MCP config, the HIGGSFIELD_* / PATH environment (docs/higgsfield.md;
# desktop/test/e2e/higgsfield-browser.js, backend/tests/test_higgsfield.py).
# "look at my screen" lists the mate's tools through the real MCP bridge and, when see_screen is there, calls it
# (tool_use / tool_result with the image on stdout, like the real CLI) and answers SEESCREEN … with what came back
# (desktop/test/e2e/screen-capture-e2e.js).
# The Mate Create studio (desktop/test/e2e/mate-studio-browser.js): the studio's start event gets a greeting and a
# "concepts" card (three directions); picking one makes it fill the mate's settings (update_mate_draft) and ask for
# the speech level; answering that writes it and asks for a reference picture — all through the real avatar MCP
# bridge. A <studio_update> before a message (what the user changed on the right) is answered with
# "SAW studio_update: <fields>". Korean when the system prompt says so.
import json
import os
import queue
import re
import sys
import threading
import time

args = sys.argv[1:]
if "--version" in args:
    # FAKE_CLAUDE_VERSION: e.g. the registry's latest, so Settings → Providers → CLI versions has nothing to offer for
    # Claude (desktop/test/e2e/cli-versions-browser.js); the backend runs `--version` with its own environment
    print(f"{os.environ.get('FAKE_CLAUDE_VERSION', '2.0.0')} (Claude Code)")
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


def avatar_turn(lines: list[str], intro: str | None = None) -> str:
    """Avatar Create (desktop/test/e2e/avatar-create-browser.js): every `atool:<name> <json>` line is one call of the
    agent's tools through the real avatar MCP bridge, written out like the real CLI (tool_use, tool_result with its
    images); the answer lists what came back."""
    import subprocess

    cfg_arg = args[args.index("--mcp-config") + 1]
    cfg = json.load(open(cfg_arg)) if os.path.exists(cfg_arg) else json.loads(cfg_arg)
    srv = cfg["mcpServers"]["avatar"]
    proc = subprocess.Popen([srv["command"], *srv["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            env={**os.environ, **srv.get("env", {})}, text=True)

    def rpc(o: dict) -> dict | None:
        proc.stdin.write(json.dumps(o) + "\n")
        proc.stdin.flush()
        return json.loads(proc.stdout.readline()) if "id" in o else None

    said = []
    if intro:
        # (the agent's line before its cards, like a real turn: text, then the tool calls)
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                "delta": {"type": "text_delta", "text": intro}}})
        emit({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": intro}]}})
    try:
        rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})
        for k, line in enumerate(lines):
            m = re.match(r"^atool:(\w+)\s*(\{.*\})?\s*$", line.strip())
            if not m:
                continue
            name, arguments = m.group(1), json.loads(m.group(2) or "{}")
            tid = f"av{k}"
            emit({"type": "assistant", "message": {"model": model, "content": [
                {"type": "tool_use", "id": tid, "name": f"mcp__avatar__{name}", "input": arguments}]}})
            out = rpc({"jsonrpc": "2.0", "id": 10 + k, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
            res = (out or {}).get("result") or {}
            text = " ".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
            blocks = [{"type": "text", "text": text}] + [
                {"type": "image", "source": {"type": "base64", "media_type": c.get("mimeType"), "data": c.get("data")}}
                for c in res.get("content", []) if c.get("type") == "image"]
            emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": blocks,
                                                           "is_error": bool(res.get("isError"))}]}})
            said.append(f"{name}={'error' if res.get('isError') else 'ok'}")
            time.sleep(0.1)
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
    return intro if intro else "AVATAR " + " ".join(said)


def _korean() -> bool:
    if "--system-prompt-file" not in args:
        return False
    try:
        return "Always reply in Korean" in open(args[args.index("--system-prompt-file") + 1], encoding="utf-8").read()
    except OSError:
        return False


CONCEPTS = {
    "en": [
        {"value": "harin", "label": "Harin — the calm older sister",
         "description": "A composed secretary who keeps your day in order and teases you gently when you overwork.",
         "palette": ["#2B2D42", "#8D99AE", "#F4C7D0", "#EDF2F4"]},
        {"value": "bomi", "label": "Bomi — the bright junior",
         "description": "An energetic junior who cheers on every commit and turns bugs into small adventures.",
         "palette": ["#FFB703", "#FB8500", "#8ECAE6", "#FFF3E0"]},
        {"value": "yuna", "label": "Yuna — the night-owl hacker",
         "description": "A dry-witted hacker who lives in the terminal and reports with deadpan precision.",
         "palette": ["#0B132B", "#3A506B", "#5BC0BE", "#C3F0CA"]},
    ],
    "ko": [
        {"value": "harin", "label": "하린 — 차분한 누나",
         "description": "하루를 정리해 주고, 무리하면 살짝 놀리며 챙겨 주는 침착한 비서.",
         "palette": ["#2B2D42", "#8D99AE", "#F4C7D0", "#EDF2F4"]},
        {"value": "bomi", "label": "보미 — 밝은 후배",
         "description": "커밋마다 응원하고 버그도 작은 모험으로 만드는 에너지 넘치는 후배.",
         "palette": ["#FFB703", "#FB8500", "#8ECAE6", "#FFF3E0"]},
        {"value": "yuna", "label": "유나 — 올빼미 해커",
         "description": "터미널에 사는, 무심한 듯 정확하게 보고하는 건조한 유머의 해커.",
         "palette": ["#0B132B", "#3A506B", "#5BC0BE", "#C3F0CA"]},
    ],
}
FILL = {
    "harin": {"name": {"en": "Harin", "ko": "하린"},
              "persona": {"description": "You are Harin, the user's calm older-sister secretary. You keep their day in "
                                         "order, watch over their coding chats and remind them to rest. You love "
                                         "tea, film photography and quiet night walks.",
                          "personality": "Calm, attentive and warm, with a gentle teasing streak.",
                          "speech": "Soft and unhurried. In Korean: gentle 해요체, never 반말; short sentences.",
                          "address": {"en": "boss", "ko": "주인님"},
                          "greeting": {"en": "Good to see you, boss. Shall we sort out today together?",
                                       "ko": "오셨어요, 주인님. 오늘 하루도 같이 정리해 볼까요?"}},
              "prefs": {"formality": "haeyo", "tone": {"warmth": "high"}},
              "concept": {"pitch": "A calm older-sister secretary who keeps your day in order.",
                          "role": "secretary and older sister", "interests": "tea, film photography, night walks",
                          "backstory": "Former librarian who started helping a friend's startup and never left.",
                          "voice": "soft, warm, a little low", "style": "anime illustration",
                          "look": "long dark hair in a low ponytail, gentle eyes, small silver earrings",
                          "outfit": "navy cardigan over a white blouse", "palette": "#2B2D42, #8D99AE, #F4C7D0",
                          "mood": "calm, warm"}},
}
FILL["bomi"] = {**FILL["harin"], "name": {"en": "Bomi", "ko": "보미"},
                "concept": {**FILL["harin"]["concept"], "pitch": "A bright junior who cheers on every commit.",
                            "palette": "#FFB703, #FB8500, #8ECAE6", "mood": "bright, energetic"}}
FILL["yuna"] = {**FILL["harin"], "name": {"en": "Yuna", "ko": "유나"},
                "concept": {**FILL["harin"]["concept"], "pitch": "A night-owl hacker with a deadpan wit.",
                            "palette": "#0B132B, #3A506B, #5BC0BE", "mood": "cool, dry"}}


def _pick(v, lang: str):
    return v.get(lang, v.get("en")) if isinstance(v, dict) and ("en" in v or "ko" in v) else v


def studio_turn(text: str) -> str | None:
    """The Mate Create studio's scripted agent (see the header). None: not a studio moment."""
    lang = "ko" if _korean() else "en"
    ko = lang == "ko"
    saw = ""
    m = re.search(r"<studio_update>(.*?)</studio_update>", text, re.S)
    if m:
        fields = re.findall(r"^- ([\w.]+):", m.group(1), re.M)
        saw = "SAW studio_update: " + ", ".join(fields) + ". "
    if '<avatar_event kind="start">' in text and "Mate Create studio" in text:
        q = {"question": "어떤 메이트를 만들까요? 세 가지 방향을 골라 봤어요." if ko else
             "What kind of mate would you like? Here are three directions.", "kind": "concepts",
             "options": CONCEPTS[lang], "allow_other": True}
        intro = ("안녕하세요! 함께 새 메이트를 만들어 봐요. 먼저 콘셉트부터 — 마음에 드는 방향을 골라 주세요." if ko else
                 "Hi! Let's make your new mate together. Concept first — pick a direction, or describe your own.")
        return avatar_turn([f"atool:ask_user {json.dumps(q, ensure_ascii=False)}"], intro=intro)
    if '<avatar_event kind="start">' in text and "opened the studio for the mate" in text:
        q = {"question": "캐릭터 그림이 있나요?" if ko else "Do you have a picture of the character?", "kind": "upload",
             "options": [{"value": "none", "label": "참고 그림 없이 — 설명으로 디자인" if ko else
                          "No reference — design from a description"}]}
        intro = "새 아바타를 만들어 볼게요. 먼저 참고 그림부터요." if ko else "Let's make her a new avatar. First, a reference picture."
        return avatar_turn([f"atool:ask_user {json.dumps(q, ensure_ascii=False)}"], intro=intro)
    picked = next((c for c in CONCEPTS[lang] if f"→ {c['label']}" in text), None)
    if picked:
        f = FILL[picked["value"]]
        fields = {"name": _pick(f["name"], lang),
                  "persona": {k: _pick(v, lang) for k, v in f["persona"].items()},
                  "prefs": f["prefs"], "concept": f["concept"]}
        q = {"question": "말투는 어떻게 할까요?" if ko else "How should she speak to you?", "kind": "choice",
             "options": [{"value": "haeyo", "label": "해요체 (부드러운 존댓말)" if ko else "해요체 — soft and polite"},
                         {"value": "hapsyo", "label": "하십시오체 (격식)" if ko else "하십시오체 — formal"},
                         {"value": "banmal", "label": "반말 (친근하게)" if ko else "반말 — casual"}]}
        intro = saw + (f"좋아요, {fields['name']}(으)로 갈게요! 오른쪽에 프로필을 채웠어요. 말투도 정해 볼까요?" if ko else
                       f"Lovely — {fields['name']} it is! I filled in her profile on the right. How should she talk?")
        return avatar_turn([f"atool:update_mate_draft {json.dumps({'fields': fields}, ensure_ascii=False)}",
                            f"atool:ask_user {json.dumps(q, ensure_ascii=False)}"], intro=intro)
    sp = re.search(r"→ (해요체|하십시오체|반말)", text)
    if sp:
        level = {"해요체": "haeyo", "하십시오체": "hapsyo", "반말": "banmal"}[sp.group(1)]
        q = {"question": "이제 외모예요. 캐릭터 그림이 있나요?" if ko else "Now her look. Do you have a picture of her?",
             "kind": "upload", "options": [{"value": "none", "label": "참고 그림 없이 — 콘셉트로 디자인" if ko else
                                             "No reference — design from the concept"}]}
        intro = saw + ("말투를 정했어요. 이제 아바타를 만들어 봐요." if ko else "Speech level set. Now let's make her avatar.")
        return avatar_turn([f"atool:update_mate_draft {json.dumps({'fields': {'prefs': {'formality': level}}})}",
                            f"atool:ask_user {json.dumps(q, ensure_ascii=False)}"], intro=intro)
    if saw:
        return avatar_turn([ln for ln in text.strip().splitlines() if ln.strip().startswith("atool:")],
                           intro=saw.strip())
    return None


def open_mcp() -> str:
    a = args[args.index("--mcp-config") + 1]
    try:
        return open(a).read() if os.path.exists(a) else a
    except OSError:
        return ""


def see_screen_turn() -> str:
    """"look at my screen" (desktop/test/e2e/screen-capture-e2e.js): like the real CLI — the mate's tools from the real
    MCP bridge (tools/list), then a see_screen call through it; the tool_use / tool_result go out on stdout as the CLI
    writes them (the image as a base64 block, which the backend must not store a second time). The answer says what
    came back: SEESCREEN listed=yes|no error=yes|no mime=… bytes=… sha=… (sha256 of the image the model got) text=…"""
    import base64
    import hashlib
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

    try:
        rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})
        names = [t["name"] for t in (rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}) or {})["result"]["tools"]]
        if "see_screen" not in names:
            return "SEESCREEN listed=no"
        emit({"type": "assistant", "message": {"model": model, "content": [
            {"type": "tool_use", "id": "ss1", "name": "mcp__mate__see_screen", "input": {"reason": "you asked me to look"}}]}})
        out = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                   "params": {"name": "see_screen", "arguments": {"reason": "you asked me to look"}}})
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
    res = (out or {}).get("result") or {}
    text = " ".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
    imgs = [c for c in res.get("content", []) if c.get("type") == "image"]
    blocks = [{"type": "text", "text": text}] + [
        {"type": "image", "source": {"type": "base64", "media_type": c.get("mimeType"), "data": c.get("data")}} for c in imgs]
    emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "ss1", "content": blocks,
                                                   "is_error": bool(res.get("isError"))}]}})
    info = ""
    if imgs:
        raw = base64.b64decode(imgs[0].get("data") or "")
        info = f" mime={imgs[0].get('mimeType')} bytes={len(raw)} sha={hashlib.sha256(raw).hexdigest()}"
    flat = " ".join(text.split())
    return f"SEESCREEN listed=yes error={'yes' if res.get('isError') else 'no'} images={len(imgs)}{info} text={flat}"


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


def launch_info() -> dict:
    """What this engine was started with (docs/higgsfield.md checks): argv, the MCP config and the environment the
    agent's tools see — values of credential-ish variables are left out, only whether they are set."""
    mcp = None
    if "--mcp-config" in args:
        raw = args[args.index("--mcp-config") + 1]
        try:
            mcp = json.load(open(raw)) if os.path.exists(raw) else json.loads(raw)
        except (OSError, ValueError):
            mcp = raw
    env = {k: os.environ[k] for k in sorted(os.environ) if k.startswith("HIGGSFIELD_") or k in ("PATH", "HOME")}
    return {"argv": args, "mcp": mcp, "env": env}


def hf_check(live_call: bool = False) -> str:
    """A turn that uses Higgsfield like an agent's Bash tool would: is `higgsfield` on PATH, which credentials file
    does it get, and what does the CLI itself say (`higgsfield auth token`, which reads the file without any network
    call; only a hash of the token is reported)."""
    import hashlib
    import shutil
    import subprocess

    exe = shutil.which("higgsfield")
    creds = os.environ.get("HIGGSFIELD_CREDENTIALS_PATH")
    keys = "-"
    if creds and os.path.exists(creds):
        try:
            keys = ",".join(sorted(json.load(open(creds))))
        except (OSError, ValueError):
            keys = "unreadable"
    token = "-"
    if exe:
        r = subprocess.run([exe, "auth", "token"], capture_output=True, text=True, timeout=20)
        out = (r.stdout or "").strip()
        token = hashlib.sha256(out.encode()).hexdigest()[:12] if r.returncode == 0 and out else f"rc{r.returncode}"
    live = ""
    if exe and live_call:
        # a READ-ONLY call to Higgsfield itself with the server-written credentials (the account's balance)
        r = subprocess.run([exe, "account", "status", "--json"], capture_output=True, text=True, timeout=40)
        try:
            data = json.loads(r.stdout)
            live = f" live=rc{r.returncode} credits={'yes' if isinstance(data.get('credits'), (int, float)) else 'no'} " \
                   f"plan={'yes' if data.get('subscription_plan_type') else 'no'}"
        except ValueError:
            live = f" live=rc{r.returncode} not-json"
    real = os.path.expanduser("~/.config/higgsfield/credentials.json")
    return (f"HFCHECK cli={'yes' if exe else 'no'} creds={'yes' if creds and os.path.exists(creds) else 'no'} "
            f"keys={keys} token={token} user_file={'used' if creds == real else 'untouched'} "
            f"note={'yes' if 'is connected for this chat' in ' '.join(args) else 'off' if 'switched off for this chat' in ' '.join(args) else 'no'}{live}")


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
    atools = [ln for ln in text.strip().splitlines() if ln.strip().startswith("atool:")]
    studio = studio_turn(text) if "--mcp-config" in args and '"avatar"' in open_mcp() else None
    if studio is not None:
        emit({"type": "result", "subtype": "success", "is_error": False, "result": studio, "session_id": "fake-sid",
              "total_cost_usd": 0.01, "usage": {"input_tokens": 1, "output_tokens": 1}})
        continue
    if atools:
        full = avatar_turn(atools)
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                "delta": {"type": "text_delta", "text": full}}})
        emit({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": full}]}})
        emit({"type": "result", "subtype": "success", "is_error": False, "result": full, "session_id": "fake-sid",
              "total_cost_usd": 0.01, "usage": {"input_tokens": 1, "output_tokens": 1}})
        continue
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
    if re.search(r"look at my screen", last, re.I):
        full = see_screen_turn()
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                "delta": {"type": "text_delta", "text": full}}})
        emit({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": full}]}})
        emit({"type": "result", "subtype": "success", "is_error": False, "result": full, "session_id": "fake-sid",
              "total_cost_usd": 0.01, "usage": {"input_tokens": 1, "output_tokens": 1}})
        continue
    if re.search(r"\btools1\b", last):
        tool_turn()
        continue
    if re.search(r"\bhf(check|live|dump)\b", last):
        # hfcheck: run the higgsfield CLI like a Bash tool call would; hfdump: the launch (argv / MCP / env) as JSON
        full = "HFDUMP " + json.dumps(launch_info()) if "hfdump" in last else hf_check(live_call="hflive" in last)
        emit({"type": "assistant", "message": {"model": model, "content": [{"type": "tool_use", "id": "hf1", "name": "Bash",
                                                                            "input": {"command": "higgsfield auth token"}}]}})
        emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "hf1", "content": "(token)", "is_error": False}]}})
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": full}}})
        emit({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": full}]}})
        emit({"type": "result", "subtype": "success", "is_error": False, "result": full, "session_id": "fake-sid",
              "total_cost_usd": 0.01, "usage": {"input_tokens": 1, "output_tokens": 1}})
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
