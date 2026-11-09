"""The API-key agent loop (app.harness) against stand-ins of the three vendors' APIs (tests/fake_vendors.py): what a
turn streams, what it sends back to the model, and how it goes on, forks, retries, swaps keys, steers and stops."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import textwrap

import pytest

from app.harness import engine as engine_mod
from app.harness import runtime
from app.harness.engine import KeySource, run_turn
from app.harness.llm.base import LLMError
from app.harness.models import ModelCatalog
from app.harness.store import TranscriptStore
from app.providers.base import SteerMessage, TurnInbox, TurnRequest
from tests.fake_vendors import MODELS, Server

VENDORS = ["anthropic", "openai", "google"]
MODEL = {"anthropic": "claude-opus-5-5", "openai": "gpt-6.1-sol", "google": "gemini-3.8-flash"}


@pytest.fixture(scope="module")
def server():
    s = Server().start()
    yield s
    s.stop()


@pytest.fixture
def fake(server, monkeypatch):
    for vendor, url in server.urls().items():
        monkeypatch.setenv(f"HRH_{vendor.upper()}_BASE_URL", url)
    from app.harness.llm import anthropic_api, google_api, openai_api

    for mod in (anthropic_api, google_api, openai_api):
        mod._clients.clear()
    server.fake.reset()
    monkeypatch.setattr(engine_mod, "_pause", lambda s: asyncio.sleep(0))
    yield server.fake


@pytest.fixture
def catalog(db):
    cat = ModelCatalog(db)
    cat.merge("anthropic", [{"id": m["id"], "label": m["display_name"], "context_window": m["max_input_tokens"],
                             "max_output": m["max_tokens"]} for m in MODELS["anthropic"]])
    cat.merge("openai", [{"id": m, "label": m} for m in MODELS["openai"]])
    cat.merge("google", [{"id": m["name"].removeprefix("models/"), "label": m["displayName"],
                          "context_window": m["inputTokenLimit"], "max_output": m["outputTokenLimit"],
                          "actions": m["supportedGenerationMethods"]} for m in MODELS["google"]])
    return cat


def req(tmp_path, text="hi", **kw) -> TurnRequest:
    kw.setdefault("api_key", "key-1")
    kw.setdefault("session_id", "sess_test")
    return TurnRequest(messages=[{"role": "user", "content": text}], model=kw.pop("model", ""), cwd=str(tmp_path),
                       inbox=kw.pop("inbox", TurnInbox()), **kw)


async def turn(vendor, db, r) -> list[dict]:
    if not r.model:
        r.model = MODEL[vendor]
    return [ev.to_dict() for ev in [e async for e in run_turn(vendor, r, db)]]


def last(events, type_):
    return [e for e in events if e["type"] == type_][-1]


def text(events):
    return "".join(e["data"]["text"] for e in events if e["type"] == "text.delta")


@pytest.fixture(autouse=True)
async def _clean_runtimes():
    yield
    await runtime.shutdown_all()


# ---- the shape of a turn ----

@pytest.mark.parametrize("vendor", VENDORS)
async def test_a_turn_streams_like_a_cli_turn_and_says_where_it_stands(vendor, fake, db, catalog, tmp_path):
    fake.script(vendor, {"blocks": [{"type": "thinking", "text": "Let me think."}, {"type": "text", "text": "Hello there!"}],
                         "usage": {"input": 1200, "cached": 300, "output": 40}})
    events = await turn(vendor, db, req(tmp_path))
    types = [e["type"] for e in events]
    assert types[0] == "session.start" and types[-1] == "turn.complete"
    assert "session.info" in types and "context.update" in types
    assert text(events) == "Hello there!"
    assert "thinking.start" in types and "thinking.end" in types
    done = events[-1]["data"]
    assert done["text"] == "Hello there!" and done["model"] == MODEL[vendor]
    assert done["usage"]["output_tokens"] == 40 and done["usage"]["cache_read_input_tokens"] == 300
    assert done["usage"]["input_tokens"] == 1200
    assert done["cost_kind"] == "turn" and done["cost_usd"] > 0
    assert done["cli_session_id"].startswith("hs_") and done["cli_at"] == "2"
    info = last(events, "session.info")["data"]
    assert "Bash" in info["tools"] and "Task" in info["tools"] and info["cli_session_id"] == done["cli_session_id"]
    ctx = last(events, "context.update")["data"]
    assert ctx["tokens"] == 1500 and ctx["window"] > 0 and ctx["source"] == "cli"


@pytest.mark.parametrize("vendor", VENDORS)
async def test_tools_run_and_their_results_go_back_to_the_model(vendor, fake, db, catalog, tmp_path):
    fake.script(vendor,
                {"blocks": [{"type": "text", "text": "Running it."},
                            {"type": "tool_use", "id": "call_a", "name": "Bash",
                             "input": {"command": "echo hello > made.txt && cat made.txt", "description": "make a file"}}]},
                {"blocks": [{"type": "text", "text": "Made it."}]})
    events = await turn(vendor, db, req(tmp_path, "make a file"))
    use = last(events, "tool.use")["data"]
    assert list(use)[:2] == ["id", "name"] and use["name"] == "Bash" and use["input"]["command"].startswith("echo")
    result = last(events, "tool.result")["data"]
    assert result["id"] == use["id"] and result["output"] == "hello" and result["is_error"] is False
    assert (tmp_path / "made.txt").read_text() == "hello\n"
    assert events[-1]["data"]["text"] == "Made it." and events[-1]["data"]["num_turns"] == 2
    second = json.dumps(fake.requests[vendor][1])
    if vendor == "anthropic":
        assert '"tool_result"' in second and '"tool_use_id": "call_a"' in second
    elif vendor == "openai":
        assert '"function_call_output"' in second and '"call_id": "call_a"' in second
    else:
        assert '"functionResponse"' in second and '"name": "Bash"' in second and "hello" in second


@pytest.mark.parametrize("vendor", VENDORS)
async def test_what_the_vendor_needs_to_see_again_goes_back_unchanged(vendor, fake, db, catalog, tmp_path):
    fake.script(vendor,
                {"blocks": [{"type": "thinking", "text": "Plan: list files.", "signature": "SIG-1"},
                            {"type": "tool_use", "id": "call_b", "name": "Glob", "input": {"pattern": "*"}}]},
                {"blocks": [{"type": "text", "text": "Nothing here."}]})
    await turn(vendor, db, req(tmp_path, "what's here?"))
    second = fake.requests[vendor][1]
    if vendor == "anthropic":
        blocks = [b for m in second["messages"] if m["role"] == "assistant" for b in m["content"]]
        assert {"type": "thinking", "thinking": "Plan: list files.", "signature": "SIG-1"} in blocks
        assert second["thinking"]["type"] == "adaptive" and second["system"][0]["cache_control"]
    elif vendor == "openai":
        reasoning = [i for i in second["input"] if i.get("type") == "reasoning"]
        assert reasoning and reasoning[0]["encrypted_content"] == "enc-0"
        assert second["store"] is False and "reasoning.encrypted_content" in second["include"]
        assert second["prompt_cache_key"].startswith("hs_")
    else:
        model_parts = [p for c in second["contents"] if c["role"] == "model" for p in c["parts"]]
        assert any(p.get("functionCall") and p.get("thoughtSignature") for p in model_parts)


async def test_after_a_model_switch_each_vendor_gets_what_it_can_take(fake, db, catalog, tmp_path):
    # Claude: thinking goes back unchanged (the API drops what the new model can't read; leaving it out is an edit)
    fake.script("anthropic", {"blocks": [{"type": "thinking", "text": "x", "signature": "S"}, {"type": "text", "text": "a"}]},
                {"blocks": [{"type": "text", "text": "b"}]})
    first = await turn("anthropic", db, req(tmp_path, "one"))
    done = first[-1]["data"]
    await turn("anthropic", db, req(tmp_path, "two", model="claude-sonnet-5-5", cli_session_id=done["cli_session_id"]))
    blocks = [b for m in fake.requests["anthropic"][1]["messages"] for b in m["content"]]
    assert {"type": "thinking", "thinking": "x", "signature": "S"} in blocks
    # OpenAI: another model's encrypted reasoning stays behind
    fake.script("openai", {"blocks": [{"type": "thinking", "text": "r"}, {"type": "text", "text": "a"}]},
                {"blocks": [{"type": "text", "text": "b"}]})
    one = (await turn("openai", db, req(tmp_path, "one")))[-1]["data"]
    await turn("openai", db, req(tmp_path, "two", model="gpt-6.1-terra", cli_session_id=one["cli_session_id"]))
    assert not any(i.get("type") == "reasoning" for i in fake.requests["openai"][1]["input"])
    # Gemini: another model's calls go with the validator's skip signature
    fake.script("google", {"blocks": [{"type": "tool_use", "name": "Glob", "input": {"pattern": "*"}}]},
                {"blocks": [{"type": "text", "text": "a"}]}, {"blocks": [{"type": "text", "text": "b"}]})
    g = (await turn("google", db, req(tmp_path, "one")))[-1]["data"]
    await turn("google", db, req(tmp_path, "two", model="gemini-4-argon", cli_session_id=g["cli_session_id"]))
    calls = [p for c in fake.requests["google"][2]["contents"] for p in c["parts"] if p.get("functionCall")]
    import base64

    assert base64.b64decode(calls[0]["thoughtSignature"]) == b"skip_thought_signature_validator"


# ---- going on, forking ----

@pytest.mark.parametrize("vendor", VENDORS)
async def test_the_next_turn_continues_and_a_fork_stops_at_its_point(vendor, fake, db, catalog, tmp_path):
    fake.script(vendor, {"blocks": [{"type": "text", "text": "PLUM noted."}]},
                {"blocks": [{"type": "text", "text": "KIWI noted."}]}, {"blocks": [{"type": "text", "text": "PLUM."}]})
    one = (await turn(vendor, db, req(tmp_path, "remember PLUM")))[-1]["data"]
    two = (await turn(vendor, db, req(tmp_path, "remember KIWI", cli_session_id=one["cli_session_id"])))[-1]["data"]
    assert two["cli_session_id"] == one["cli_session_id"] and two["cli_at"] == "4"
    assert "remember PLUM" in json.dumps(fake.requests[vendor][1])
    fork = (await turn(vendor, db, req(tmp_path, "what do you remember?", cli_session_id=one["cli_session_id"],
                                       fork_session=True, resume_at=one["cli_at"])))[-1]["data"]
    sent = json.dumps(fake.requests[vendor][2])
    assert fork["cli_session_id"] != one["cli_session_id"]
    assert "remember PLUM" in sent and "remember KIWI" not in sent
    store = TranscriptStore(db)
    assert store.count(one["cli_session_id"]) == 4  # (the original is left alone)


async def test_a_conversation_that_is_gone_says_so_like_a_cli(fake, db, catalog, tmp_path):
    events = await turn("openai", db, req(tmp_path, cli_session_id="hs_missing"))
    assert events[-1]["type"] == "error" and "no conversation found" in events[-1]["data"]["message"]


# ---- keys, retries ----

class TwoKeys(KeySource):
    def __init__(self):
        self.key, self.label, self.account_id = "key-1", "first", "a1"
        self.failed: list[str] = []

    async def failover(self, err: LLMError) -> bool:
        self.failed.append(err.kind)
        if self.key == "key-2":
            return False
        self.key, self.label, self.account_id = "key-2", "second", "a2"
        return True


@pytest.mark.parametrize("vendor", VENDORS)
async def test_a_rate_limited_key_hands_the_turn_to_the_next(vendor, fake, db, catalog, tmp_path):
    fake.script(vendor, {"error": {"status": 429, "message": "rate limited", "type": "rate_limit_error", "retry_after": 30}},
                {"blocks": [{"type": "text", "text": "Fine."}]})
    keys = TwoKeys()
    events = await turn(vendor, db, req(tmp_path, key_source=keys))
    assert keys.failed == ["rate_limit"] and fake.keys[vendor][-1] == "key-2"
    assert last(events, "notice")["data"]["code"] == "account.failover"
    assert events[-1]["type"] == "turn.complete" and events[-1]["data"]["account"] == "second"


async def test_a_refused_key_with_no_other_ends_the_turn_with_why(fake, db, catalog, tmp_path):
    fake.bad_keys.add("key-1")
    events = await turn("anthropic", db, req(tmp_path))
    err = events[-1]["data"]
    assert events[-1]["type"] == "error" and err["code"] == "exec.api.auth"
    assert err["api_error"]["outcome"] == "provider_auth"


@pytest.mark.parametrize("vendor", VENDORS)
async def test_an_overloaded_vendor_is_retried(vendor, fake, db, catalog, tmp_path):
    fake.script(vendor, {"error": {"status": 529 if vendor == "anthropic" else 503, "message": "overloaded",
                                   "type": "overloaded_error"}},
                {"blocks": [{"type": "text", "text": "Back."}]})
    events = await turn(vendor, db, req(tmp_path))
    assert any(e["type"] == "notice" and e["data"]["code"] == "api.retrying" for e in events)
    assert events[-1]["data"]["text"] == "Back."


# ---- steering, stopping ----

async def test_a_message_added_mid_turn_reaches_the_model_at_the_next_step(fake, db, catalog, tmp_path):
    fake.script("anthropic",
                {"blocks": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "sleep 0.5; echo done"}}]},
                {"blocks": [{"type": "text", "text": "Also done."}]})
    inbox = TurnInbox()
    r = req(tmp_path, "start", inbox=inbox)
    delivered = []

    async def steer():
        await asyncio.sleep(0.2)
        loop = asyncio.get_running_loop()
        inbox.offer(SteerMessage(text="and also check the logs", delivered=loop.create_future(),
                                 on_delivered=lambda: delivered.append(True)))

    task = asyncio.create_task(steer())
    events = await turn("anthropic", db, r)
    await task
    assert delivered == [True]
    assert "and also check the logs" in json.dumps(fake.requests["anthropic"][1]["messages"])
    assert events[-1]["data"]["text"] == "Also done." and not inbox.open


async def test_stop_kills_what_runs_and_leaves_the_conversation_consistent(fake, db, catalog, tmp_path):
    fake.script("openai", {"blocks": [{"type": "tool_use", "id": "t9", "name": "Bash",
                                       "input": {"command": "sleep 30; echo never > late.txt"}}]})
    spent = []
    r = req(tmp_path, "long job", on_usage=spent.append)
    r.model = MODEL["openai"]
    seen = []

    async def run():
        async for ev in run_turn("openai", r, db):
            seen.append(ev.to_dict())

    task = asyncio.create_task(run())
    for _ in range(100):
        if any(e["type"] == "tool.use" for e in seen):
            break
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.1)
    assert not (tmp_path / "late.txt").exists()
    hs = last(seen, "session.info")["data"]["cli_session_id"]
    entries = TranscriptStore(db).load(hs)
    assert entries[-2]["content"][0]["type"] == "tool_result" and entries[-2]["content"][0]["is_error"]
    assert entries[-1]["content"][0]["text"] == "[Request interrupted by user]"
    assert spent and spent[-1]["usage"]["output_tokens"] > 0
    fake.script("openai", {"blocks": [{"type": "text", "text": "ok"}]})
    events = await turn("openai", db, req(tmp_path, "go on", cli_session_id=hs))
    assert events[-1]["type"] == "turn.complete"


# ---- context ----

async def test_compact_replaces_the_conversation_with_a_summary(fake, db, catalog, tmp_path):
    fake.script("google", {"blocks": [{"type": "text", "text": "Answer one."}]},
                {"blocks": [{"type": "text", "text": "SUMMARY: the user said hi."}]},
                {"blocks": [{"type": "text", "text": "Continuing."}]})
    one = (await turn("google", db, req(tmp_path, "hi")))[-1]["data"]
    events = await turn("google", db, req(tmp_path, "/compact", cli_session_id=one["cli_session_id"]))
    note = last(events, "notice")["data"]
    assert note["code"] == "context.compacted" and note["trigger"] == "manual"
    await turn("google", db, req(tmp_path, "next", cli_session_id=one["cli_session_id"]))
    sent = json.dumps(fake.requests["google"][2]["contents"])
    assert "SUMMARY: the user said hi." in sent and "Answer one." not in sent


async def test_a_conversation_near_its_window_compacts_by_itself(fake, db, catalog, tmp_path):
    catalog.update("anthropic", "claude-haiku-5-5", {"context_window": 10_000})
    fake.script("anthropic",
                {"blocks": [{"type": "tool_use", "id": "t1", "name": "Glob", "input": {"pattern": "*"}}],
                 "usage": {"input": 9_500, "output": 10}},
                {"blocks": [{"type": "text", "text": "SUMMARY"}]},
                {"blocks": [{"type": "text", "text": "Done after compaction."}]})
    events = await turn("anthropic", db, req(tmp_path, "go", model="claude-haiku-5-5"))
    assert any(e["type"] == "notice" and e["data"]["code"] == "context.compacted" for e in events)
    assert events[-1]["data"]["text"] == "Done after compaction."


# ---- subagents, background work ----

async def test_a_subagent_works_under_its_call_and_reports_back(fake, db, catalog, tmp_path):
    fake.script("anthropic",
                {"blocks": [{"type": "tool_use", "id": "task_1", "name": "Task",
                             "input": {"description": "Look around", "prompt": "List the files and report."}}]},
                {"blocks": [{"type": "text", "text": "Checking."},
                            {"type": "tool_use", "id": "sub_1", "name": "Glob", "input": {"pattern": "*"}}]},
                {"blocks": [{"type": "text", "text": "REPORT: empty folder."}]},
                {"blocks": [{"type": "text", "text": "The folder is empty."}]})
    events = await turn("anthropic", db, req(tmp_path, "what's in the folder?"))
    nested = [e for e in events if e["type"] == "tool.use" and e["data"].get("parent") == "task_1"]
    assert nested and nested[0]["data"]["name"] == "Glob"
    assert any(e["type"] == "subagent.text" and e["data"]["parent"] == "task_1" for e in events)
    result = [e for e in events if e["type"] == "tool.result" and e["data"]["id"] == "task_1"][0]["data"]
    assert result["output"] == "REPORT: empty folder." and result["agent"]["status"] == "completed"
    assert result["agent"]["tool_uses"] == 1
    assert "Task" not in json.dumps([t["name"] for t in fake.requests["anthropic"][1]["tools"]])
    assert events[-1]["data"]["text"] == "The folder is empty."


async def test_background_work_shows_as_a_task_and_the_model_hears_when_it_ends(fake, db, catalog, tmp_path):
    fake.script("openai",
                {"blocks": [{"type": "tool_use", "id": "bg", "name": "Bash",
                             "input": {"command": "sleep 0.3; echo built", "run_in_background": True}}]},
                {"blocks": [{"type": "tool_use", "id": "wait", "name": "Bash", "input": {"command": "sleep 0.8"}}]},
                {"blocks": [{"type": "text", "text": "Started."}]},
                {"blocks": [{"type": "text", "text": "It finished."}]})
    events = await turn("openai", db, req(tmp_path, "build in the background"))
    tasks = [e["data"] for e in events if e["type"] == "task.update"]
    assert tasks[0]["status"] == "running" and tasks[0]["task_type"] == "local_bash"
    assert "task-notification" in json.dumps(fake.requests["openai"][2]["input"])


# ---- what a turn may use ----

async def test_plan_mode_keeps_only_what_changes_nothing(fake, db, catalog, tmp_path):
    fake.script("anthropic", {"blocks": [{"type": "text", "text": "Plan: …"}]})
    await turn("anthropic", db, req(tmp_path, "plan it", mode="plan"))
    names = {t["name"] for t in fake.requests["anthropic"][0]["tools"]}
    assert {"Read", "Grep", "Glob"} <= names and not names & {"Bash", "Write", "Edit", "MultiEdit", "Task"}
    assert "plan mode" in fake.requests["anthropic"][0]["system"][0]["text"].lower()


async def test_an_input_cut_off_by_the_output_limit_is_not_run(fake, db, catalog, tmp_path):
    fake.script("anthropic",
                {"blocks": [{"type": "tool_use", "id": "w1", "name": "Write",
                             "input": {"file_path": str(tmp_path / "big.txt"), "content": "partial"}}],
                 "stop": "max_tokens"},
                {"blocks": [{"type": "text", "text": "I'll write it in parts."}]})
    events = await turn("anthropic", db, req(tmp_path, "write a big file"))
    assert last(events, "tool.result")["data"]["is_error"] and not (tmp_path / "big.txt").exists()


async def test_an_mcp_server_s_tools_are_the_model_s_tools(fake, db, catalog, tmp_path):
    script = tmp_path / "echo_server.py"
    script.write_text(textwrap.dedent("""
        from mcp.server.fastmcp import FastMCP
        app = FastMCP("demo")

        @app.tool()
        def shout(text: str) -> str:
            \"\"\"Say it louder.\"\"\"
            return text.upper() + "!"

        app.run()
    """))
    fake.script("google", {"blocks": [{"type": "tool_use", "name": "mcp__demo__shout", "input": {"text": "hey"}}]},
                {"blocks": [{"type": "text", "text": "Shouted."}]})
    events = await turn("google", db, req(tmp_path, "shout hey", mcp_config={"mcpServers": {
        "demo": {"type": "stdio", "command": sys.executable, "args": [str(script)]}}}))
    info = last(events, "session.info")["data"]
    assert info["mcp_servers"][0]["status"] == "connected" and "mcp__demo__shout" in info["tools"]
    assert last(events, "tool.result")["data"]["output"] == "HEY!"


async def test_a_mate_gets_its_own_prompt_and_only_its_tools(fake, db, catalog, tmp_path):
    prompt = tmp_path / "mate.md"
    prompt.write_text("You are Mio, a friendly mate.")
    fake.script("anthropic", {"blocks": [{"type": "text", "text": "Hi!"}]})
    await turn("anthropic", db, req(tmp_path, "hello", system_prompt_file=str(prompt), tools=[],
                                    allowed_tools=["mcp__mate"], sealed=True))
    body = fake.requests["anthropic"][0]
    assert body["system"][0]["text"].startswith("You are Mio") and "tools" not in body


async def test_reading_an_image_shows_it_to_the_model(fake, db, catalog, tmp_path):
    from PIL import Image

    Image.new("RGB", (40, 30), "red").save(tmp_path / "pic.png")
    fake.script("anthropic", {"blocks": [{"type": "tool_use", "id": "r1", "name": "Read",
                                          "input": {"file_path": str(tmp_path / "pic.png")}}]},
                {"blocks": [{"type": "text", "text": "A red square."}]})
    events = await turn("anthropic", db, req(tmp_path, "look"))
    assert last(events, "tool.result")["data"]["images"][0]["media_type"] == "image/png"
    result = [b for m in fake.requests["anthropic"][1]["messages"] for b in m["content"] if b["type"] == "tool_result"][0]
    assert any(c["type"] == "image" for c in result["content"])


def test_no_key_and_no_model_say_where_to_fix_it(fake, db, tmp_path):
    async def go():
        no_model = [e.to_dict() async for e in run_turn("openai", req(tmp_path), db)]
        ModelCatalog(db).add("openai", "gpt-6.1-sol")
        no_key = [e.to_dict() async for e in run_turn("openai", req(tmp_path, api_key=""), db)]
        return no_model, no_key

    no_model, no_key = asyncio.run(go())
    assert no_model[-1]["data"]["code"] == "exec.api.no_model" and "Models" in no_model[-1]["data"]["message"]
    assert no_key[-1]["data"]["code"] == "exec.api.no_key"


def test_tool_names_and_inputs_match_claude_code():
    from app.harness.tools import builtin

    names = [t.name for t in builtin()]
    assert names[:4] == ["Bash", "BashOutput", "KillShell", "Read"] and "TodoWrite" in names and "Task" in names
    for t in builtin():
        assert t.schema["type"] == "object" and t.description
    assert os.path.basename(__file__)
