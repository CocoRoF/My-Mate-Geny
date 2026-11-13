"""Phone calls with a mate (app/mate/calls.py, docs/mate-calls.md): the call's lifecycle over its line, no tools during a call
(Claude Code sealed, the Messages API without tools), the call in her conversation and her own engine's turn on it, when she
calls the user (by day, not while they chat, a connected phone app that lets her speak first, a cooldown), and what a call
turned down or missed does to her. Her own engine is the fake Claude CLI of test_engine; the call's engine a stand-in (or the
real CLI engine against the fake CLI, the real API engine against the fake vendors)."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from app.mate import calls as calls_mod
from app.mate import state as S
from app.mate.calls import ApiEngine, CallError, CallService, CliEngine, cooldown, spoken
from app.providers.claude_code import ClaudeCodeProvider
from tests.test_engine import _until
from tests.test_mate_delegation import _setup


class FakeLine:
    """The call's engine: answers each message, records what it was told."""

    kind = "fake"

    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.closed = False
        self.tool_attempts = 0
        self.hold: asyncio.Event | None = None

    async def start(self) -> None:
        return None

    async def reply(self, prompt, on_delta):
        self.prompts.append(prompt)
        hold = self.hold
        text = "[joy] 여보세요? 응, 나야." if prompt.startswith("[") and "pick up" in prompt else f"그렇구나. {prompt.splitlines()[-1]}"
        await on_delta(text[:5])
        if hold is not None:
            await hold.wait()  # (still being made…)
        await asyncio.sleep(0)
        await on_delta(text[5:])
        return text

    async def close(self) -> None:
        self.closed = True


async def _wait(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out")


def _stack(db, tmp_path, monkeypatch, *, clock=None, rng=None):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    store.update_settings({"timezone": "Asia/Seoul"})
    calls = CallService(mates, clock=clock or time.time, rng=rng or (lambda: 0.0))
    line = FakeLine()

    async def make_engine(call, system):
        line.system = system
        return line

    calls.make_engine = make_engine
    return svc, store, mates, calls, line


def _ended(m):
    return m["type"] == "run.state" and not m["data"]["running"]


def _phone(mates, mate_id, *, device="phone-1", native="android", on=True, mate=None):
    out: list = []
    broker = mates.capture
    conn = broker.connect(out.append)
    broker.hello(conn, {"type": "client", "device": device, "native": native, "calls": 1, "surface": "console",
                        "screen_policy": {"enabled": on, "interval": 60, "mate_id": mate if mate is not None else mate_id,
                                          "fixed": True}})
    return out


# ---- the lifecycle ----

async def test_a_call_from_the_user_greets_talks_and_ends_in_her_conversation_with_her_own_turn(db, tmp_path, monkeypatch):
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    sent_envelopes: list[str] = []
    real = ClaudeCodeProvider._build_stdin

    def capture(self, req):
        out = real(self, req)
        sent_envelopes.append(json.loads(out)["message"]["content"])
        return out

    monkeypatch.setattr(ClaudeCodeProvider, "_build_stdin", capture)
    mate = store.create(name="하루", persona={"language": "ko", "description": "a friend"}, llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    q = svc.subscribe(sid)
    try:
        call = await calls.dial(mate["id"], "phone-1")
        assert call.status == "dialing" and call.direction == "outgoing"
        with pytest.raises(CallError) as busy:  # one call at a time
            await calls.dial(mate["id"], "phone-1")
        assert busy.value.code == "busy" and busy.value.status == 409
        sent: list = []
        calls.attach(call, sent.append)
        await _wait(lambda: any(m["type"] == "done" for m in sent))
        # her hello on the lightest model, her prompt of the call (no tools to name)
        assert line.prompts[0].startswith("[The phone rings")
        assert call.status == "active" and call.answered_at
        assert "On the phone" in line.system and "send_to_session" not in line.system and "하루" in line.system
        assert "Always reply in Korean" in line.system
        done = next(m for m in sent if m["type"] == "done")
        assert done["ttft_ms"] is not None and any(m["type"] == "delta" for m in sent)

        await calls.receive(call, {"type": "say", "text": "오늘 프로젝트 검토 좀 해 줘"})
        await calls.settle(call)
        await _wait(lambda: sum(m["type"] == "done" for m in sent) == 2)
        assert line.prompts[-1] == "오늘 프로젝트 검토 좀 해 줘"
        await calls.receive(call, {"type": "metric", "rid": [m for m in sent if m["type"] == "done"][-1]["rid"],
                                   "first_audio_ms": 900, "stt": "realtime"})
        await calls.receive(call, {"type": "hangup"})
        assert any(m["type"] == "ended" and m["reason"] == "hangup" for m in sent)
        assert line.closed and calls.active() is None

        # one call entry (its message is what they said), then her own engine's turn on the whole call
        seen = await _until(q, _ended)
        um = next(m for m in seen if m["type"] == "user.message")
        assert um["data"]["kind"] == "call" and um["data"]["call"]["status"] == "talked"
        assert um["data"]["text"] == "오늘 프로젝트 검토 좀 해 줘"
        card = um["data"]["call"]
        assert [x["who"] for x in card["transcript"]] == ["mate", "user", "mate"]
        assert card["transcript"][0]["text"] == "여보세요? 응, 나야."  # (emotion tags are not words)
        assert card["latency"]["first_audio_ms"] == 900 and card["model"] == "claude-haiku-5-5"
        stored = [m for m in svc.messages(sid) if m["role"] == "user"][-1]
        assert stored["meta"]["kind"] == "call" and not stored["meta"].get("internal")
        envelope = sent_envelopes[-1]
        assert "<phone_call caller=\"user\"" in envelope and "User: 오늘 프로젝트 검토 좀 해 줘" in envelope
        assert "하루: 여보세요? 응, 나야." in envelope and "with your tools" in envelope
        # talking on the phone warmed her
        log = store.state_doc(mate["id"])["log"]
        assert any((e.get("why") or {}).get("code") == "call_talked" for e in log)
        row = db.query_one("SELECT status, engine FROM mate_calls WHERE id=?", (call.id,))
        assert row["status"] == "talked" and row["engine"] == "fake"
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_a_screen_that_connects_while_her_reply_is_being_made_gets_all_of_it(db, tmp_path, monkeypatch):
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    gate = asyncio.Event()
    real = line.reply

    async def slow(prompt, on_delta):
        await gate.wait()  # (nothing of it yet when the screen connects)
        return await real(prompt, on_delta)

    line.reply = slow
    mate = store.create(name="Haru", persona={"language": "en"}, llm={"model": "m1"})
    try:
        call = await calls.dial(mate["id"])
        await _wait(lambda: len(call.replies) == 1)
        sent: list = []
        calls.attach(call, sent.append)
        gate.set()
        await _wait(lambda: any(m["type"] == "done" for m in sent))
        kinds = [m["type"] for m in sent if m["type"] in ("reply", "delta", "done")]
        assert kinds[0] == "reply" and kinds[-1] == "done" and "delta" in kinds
        # (back after a drop: what it missed comes again, whole)
        sock2: list = []
        call.replies[next(iter(call.replies))]["delivered"] = False
        calls.attach(call, sock2.append)
        assert [m["type"] for m in sock2] == ["state", "reply", "delta", "done"]
        assert sock2[2]["text"] == "[joy] 여보세요? 응, 나야."
        await calls.hangup(call.id)
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_a_barge_in_stops_her_and_the_next_message_says_what_was_heard(db, tmp_path, monkeypatch):
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", persona={"language": "en"}, llm={"model": "m1"})
    try:
        call = await calls.dial(mate["id"])
        sent: list = []
        calls.attach(call, sent.append)
        await _wait(lambda: any(m["type"] == "done" for m in sent))
        line.hold = asyncio.Event()  # (her next reply is still being made…)
        await calls.receive(call, {"type": "say", "text": "tell me a long story"})
        await _wait(lambda: len(line.prompts) == 2)
        rid = [m for m in sent if m["type"] == "reply"][-1]["rid"]
        await calls.receive(call, {"type": "barge", "rid": rid, "heard": "Once upon"})
        line.hold = None
        await calls.receive(call, {"type": "say", "text": "actually never mind"})
        await calls.settle(call)
        await _wait(lambda: len(line.prompts) == 3)
        assert line.prompts[-1].startswith("[They talked over you") and "Once upon" in line.prompts[-1]
        assert line.prompts[-1].endswith("actually never mind")
        lines = [x for x in call.transcript if x["who"] == "mate"]
        assert any(x.get("cut") and x["text"] == "Once upon…" for x in lines)
        await calls.hangup(call.id)
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_a_dropped_line_ends_the_call_and_her_turn_still_comes(db, tmp_path, monkeypatch):
    monkeypatch.setattr(calls_mod, "RESUME_S", 0.05)
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", persona={"language": "en"}, llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    q = svc.subscribe(sid)
    try:
        call = await calls.dial(mate["id"])
        sent: list = []
        sock = calls.attach(call, sent.append)
        await _wait(lambda: any(m["type"] == "done" for m in sent))
        await calls.receive(call, {"type": "say", "text": "remember to call mom"})
        await calls.settle(call)
        await _wait(lambda: sum(m["type"] == "done" for m in sent) == 2)
        calls.detach(call, sock)
        await _wait(lambda: call.status == "ended")
        assert call.end_reason == "network"
        seen = await _until(q, _ended)
        um = next(m for m in seen if m["type"] == "user.message")
        assert um["data"]["call"]["end_reason"] == "network" and um["data"]["text"] == "remember to call mom"
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_a_call_nobody_picked_up_is_only_a_card_and_she_still_knows_it_happened(db, tmp_path, monkeypatch):
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", persona={"language": "en"}, llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    try:
        call = await calls.dial(mate["id"])
        await calls.hangup(call.id)  # (gone before she picked up)
        msgs = [m for m in svc.messages(sid) if (m.get("meta") or {}).get("kind") == "call"]
        assert len(msgs) == 1 and msgs[0]["meta"]["internal"] is True and msgs[0]["meta"]["call"]["status"] == "cancelled"
        assert not svc.is_running(sid)  # (nothing was said: no turn of hers)
        # …but her next turn on a fresh engine knows there was a call (and the next call's prompt too)
        _resume, preamble, kind, n = svc._context_for(svc.get(sid), "claude", "none")
        assert kind == "handoff" and n == 1
        assert "[Phone call — They phoned you at " in preamble and "they hung up before you picked up." in preamble
        assert "[User]" not in preamble
        assert any("They phoned you" in x for x in calls.recent(sid))
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_she_remembers_calling_them_when_they_picked_up_and_said_nothing(db, tmp_path, monkeypatch):
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    sent_envelopes: list[str] = []
    real = ClaudeCodeProvider._build_stdin

    def capture(self, req):
        out = real(self, req)
        sent_envelopes.append(json.loads(out)["message"]["content"])
        return out

    monkeypatch.setattr(ClaudeCodeProvider, "_build_stdin", capture)
    mate = store.create(name="서아", persona={"language": "ko"}, llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    q = svc.subscribe(sid)
    try:
        call = await calls.ring(mate["id"], "phone-1", "question", "저녁 뭐 드실 거예요?")
        await calls.accept(call.id, "phone-1")
        sent: list = []
        calls.attach(call, sent.append)
        await _wait(lambda: any(m["type"] == "done" for m in sent))  # (her hello…)
        await calls.receive(call, {"type": "hangup"})  # (…and they hung up without a word)
        seen = await _until(q, _ended)
        um = next(m for m in seen if m["type"] == "user.message")
        assert um["data"]["kind"] == "call" and um["data"]["call"]["status"] == "talked" and not um["data"].get("internal")
        assert um["data"]["call"]["about"] == "저녁 뭐 드실 거예요?"
        # her own engine took the call in: that she called, why, what she said, that they said nothing
        env = sent_envelopes[-1]
        assert '<phone_call caller="you"' in env and "You phoned them at " in env
        assert "still waiting for the answer: “저녁 뭐 드실 거예요?”" in env and "they picked up and you talked for 0:" in env
        assert "서아: 그렇구나." in env and "(They didn't say a word, and the call ended.)" in env
        assert "never said a word" in env and "[SILENT]" in env
        # a later handoff tells it as the call it was, not as an empty message of theirs
        _resume, preamble, _kind, _n = svc._context_for(svc.get(sid), "codex", "none", fresh=True)
        assert "[Phone call — You phoned them at " in preamble and "You: 그렇구나." in preamble
    finally:
        await calls.stop()
        await svc.shutdown()


def test_a_call_as_she_remembers_it():
    base = {"direction": "incoming", "reason": "lonely", "about": "", "started_at": "2026-11-13T08:02:01+00:00",
            "duration_s": 0, "transcript": [], "end_reason": ""}
    seoul = timezone(timedelta(hours=9))
    d = calls_mod.describe({**base, "status": "missed"}, seoul)
    assert d == ("[Phone call — You phoned them at 2026-11-13 17:02 (you missed them and wanted to hear their voice); "
                 "they didn't pick up (a missed call).]")
    assert "they turned the call down" in calls_mod.describe({**base, "status": "declined"}, seoul)
    talked = {**base, "status": "talked", "duration_s": 75, "end_reason": "network",
              "transcript": [{"who": "mate", "text": "여보세요"}, {"who": "user", "text": "응", "cut": False},
                             {"who": "mate", "text": "있잖아", "cut": True}]}
    out = calls_mod.describe(talked, seoul, name="하루")
    assert "they picked up and you talked for 1:15" in out and "하루: 있잖아 (cut off)" in out
    assert "User: 응" in out and out.endswith("(The line dropped at the end.)")
    theirs = calls_mod.describe({**base, "direction": "outgoing", "status": "talked", "duration_s": 5,
                                 "transcript": [{"who": "mate", "text": "여보세요"}]}, seoul)
    assert theirs.startswith("[Phone call — They phoned you at 2026-11-13 17:02; you picked up")
    assert "(They didn't say a word, and the call ended.)" in theirs


# ---- no tools during a call ----

async def test_the_cli_line_is_sealed_haiku_with_no_tools_and_a_tool_call_is_never_run(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    from app.services import session_service as ss

    prompt = tmp_path / "call.md"
    prompt.write_text("You are on the phone.")
    engine = CliEngine(ss.get_provider("claude"), str(prompt), str(tmp_path))
    argv = engine.argv()
    assert argv[argv.index("--model") + 1] == "claude-haiku-5-5"
    assert argv[argv.index("--tools") + 1] == "" and "--allowedTools" not in argv
    assert json.loads(argv[argv.index("--mcp-config") + 1]) == {"mcpServers": {}} and "--strict-mcp-config" in argv
    assert "--no-session-persistence" in argv and "--disable-slash-commands" in argv
    assert argv[argv.index("--effort") + 1] == "low" and argv[argv.index("--system-prompt-file") + 1] == str(prompt)
    await engine.start()
    try:
        got: list[str] = []

        async def on(t):
            got.append(t)

        assert await engine.reply("hello there", on) == "echo[claude-haiku-5-5]: hello there"
        assert await engine.reply("and again", on) == "echo[claude-haiku-5-5]: and again"
        pids = {json.loads(x)["pid"] for x in open(tmp_path / "calls.log")}
        assert len(pids) == 1  # ONE process for the whole call
        # the model reaching for a tool: the reply ends there, nothing runs
        await engine.reply("LONG", on)
        assert engine.tool_attempts == 1
        assert await engine.reply("still there?", on) == "echo[claude-haiku-5-5]: still there?"
    finally:
        await engine.close()
        await svc.shutdown()


@pytest.fixture
def vendors(monkeypatch):
    from tests.fake_vendors import Server
    from app.harness.llm import anthropic_api

    s = Server().start()
    monkeypatch.setenv("HRH_ANTHROPIC_BASE_URL", s.urls()["anthropic"])
    anthropic_api._clients.clear()
    yield s.fake
    anthropic_api._clients.clear()
    s.stop()


async def test_the_api_line_streams_haiku_without_tools_or_thinking(vendors):
    vendors.script("anthropic", {"blocks": [{"type": "text", "text": "응, 여보세요?"}]},
                   {"blocks": [{"type": "text", "text": "잠깐만"}, {"type": "tool_use", "name": "send_to_session", "input": {}}]})
    engine = ApiEngine("sk-ant-test", "You are on the phone.")
    got: list[str] = []

    async def on(t):
        got.append(t)

    assert await engine.reply("[pick up]", on) == "응, 여보세요?" and "".join(got) == "응, 여보세요?"
    body = vendors.requests["anthropic"][-1]
    assert body["model"] == "claude-haiku-5-5" and "tools" not in body
    assert body["thinking"] == {"type": "disabled"} and body["output_config"] == {"effort": "low"}
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert await engine.reply("뭐 해 줄 수 있어?", on) == "잠깐만" and engine.tool_attempts == 1
    assert [m["role"] for m in engine.messages] == ["user", "assistant", "user", "assistant"]


async def test_an_anthropic_key_takes_the_api_line_else_the_warm_cli(db, tmp_path, monkeypatch):
    from app.providers.accounts import AccountPool, AccountStore
    from app.vault import SecretVault

    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    pool = AccountPool(AccountStore(db, SecretVault(db)))
    svc._pool = pool
    calls = CallService(mates)
    mate = store.create(name="Haru", llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    call = calls_mod.Call(id="c1", mate_id=mate["id"], name="Haru", session_id=sid, direction="outgoing", status="dialing")
    try:
        engine = await calls.make_engine(call, "prompt")
        assert isinstance(engine, CliEngine)
        await engine.close()
        pool._store.create("anthropic", label="Key", auth_mode="api_key", api_key="sk-ant-1")
        engine = await calls.make_engine(call, "prompt")
        assert isinstance(engine, ApiEngine) and engine.key == "sk-ant-1" and engine.model == "claude-haiku-5-5"
        await engine.close()
    finally:
        await calls.stop()
        await svc.shutdown()


# ---- she calls them ----

async def test_she_calls_only_by_day_not_while_they_chat_and_only_a_phone_that_lets_her(db, tmp_path, monkeypatch):
    monkeypatch.setattr(calls_mod, "CALL_HOURS", (0, 24))
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", persona={"language": "en"}, llm={"model": "m1"})
    other = store.create(name="Other", llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    try:
        assert await calls.consider(mate["id"]) == "no_phone"
        _phone(mates, mate["id"], device="laptop", native="desktop-linux")  # (only the phone app rings)
        assert await calls.consider(mate["id"]) == "no_phone"
        _phone(mates, mate["id"], device="phone-off", on=False)  # (speaking first is off there)
        assert await calls.consider(mate["id"]) == "no_phone"
        _phone(mates, mate["id"], device="phone-2", mate=other["id"])  # (set to another mate)
        assert await calls.consider(mate["id"]) == "no_phone"
        rings = _phone(mates, mate["id"], device="phone-1")
        assert await calls.consider(mate["id"]) == "nothing"  # (no reason of hers yet)
        doc = store.state_doc(mate["id"])
        doc["feelings"]["lonely"] = {"v": 0.9, "at": datetime.now(timezone.utc).isoformat(), "why": {"code": "wants_affection"}}
        store.save_state(mate["id"], doc)
        svc._add_message(sid, "user", "hey", meta=None)  # (they wrote to her just now: they're talking)
        assert await calls.consider(mate["id"]) == "chatting"
        db.execute("UPDATE messages SET created_at=? WHERE session_id=? AND role='user'",
                   ((datetime.now(timezone.utc) - timedelta(hours=4)).isoformat(), sid))
        assert await calls.consider(mate["id"]) == "ringing"
        call = calls.active()
        assert call.direction == "incoming" and call.reason == "lonely" and call.device == "phone-1"
        assert any(m["type"] == "call.ring" and m["data"]["id"] == call.id for m in rings)
        assert await calls.consider(other["id"]) == "line_busy"
        await calls.decline(call.id)
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_with_the_app_closed_her_call_still_rings_the_phone_through_its_background_link(db, tmp_path, monkeypatch):
    monkeypatch.setattr(calls_mod, "CALL_HOURS", (0, 24))
    monkeypatch.setattr(calls_mod, "RING_S", 0.2)
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", persona={"language": "en"}, llm={"model": "m1"})
    other = store.create(name="Other", llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    broker = mates.capture
    try:
        # the app's page said it lets her speak first; then it went away (the app closed), its service stayed
        _phone(mates, mate["id"], device="phone-1")
        page = broker.clients()[-1]
        calls.saw(page)
        broker.disconnect(page.conn)
        assert calls.phones["phone-1"]["enabled"] is True and calls.phones["phone-1"]["mate_id"] == mate["id"]
        assert calls.phone(mate) is None  # (no link yet: nothing to ring)
        heard: list = []
        lk = calls.link("phone-1", heard.append)
        assert heard[0] == {"type": "hello", "calls": True, "mate": "Haru", "ring": None}
        assert calls.phone(mate) == "phone-1" and calls.phone(store.get(other["id"])) is None
        # what the page said is kept: a restarted server still knows the phone
        assert CallService(mates).phones["phone-1"]["mate_id"] == mate["id"]
        mates.calls = calls

        doc = store.state_doc(mate["id"])
        doc["feelings"]["lonely"] = {"v": 0.9, "at": datetime.now(timezone.utc).isoformat(), "why": {"code": "wants_affection"}}
        store.save_state(mate["id"], doc)
        assert await calls.consider(mate["id"]) == "ringing"
        call = calls.active()
        assert any(m["type"] == "call.ring" and m["data"]["id"] == call.id for m in heard)
        # picked up on the phone's ringing: it holds while the app comes up (no missed call meanwhile)…
        await asyncio.sleep(0.15)
        await calls.answering(call.id)
        await asyncio.sleep(0.1)  # (past the ring's own RING_S)
        assert call.status == "ringing"
        # …and the page takes it
        await calls.accept(call.id, "phone-1")
        assert any(m["type"] == "call.update" and m["data"]["status"] == "active" for m in heard)
        await calls.hangup(call.id)
        assert any(m["type"] == "call.update" and m["data"]["status"] == "ended" for m in heard)

        # a page turning speaking-first off there tells the link (its notification says so)
        _phone(mates, mate["id"], device="phone-1", on=False)
        calls.saw(broker.clients()[-1])
        assert heard[-1] == {"type": "policy", "calls": False, "mate": ""}
        assert calls.phone(mate) is None
        calls.unlink(lk.id)
        assert calls.links == {}
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_a_ring_picked_up_on_the_phone_that_the_app_never_takes_is_still_missed(db, tmp_path, monkeypatch):
    monkeypatch.setattr(calls_mod, "RING_S", 0.05)
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", llm={"model": "m1"})
    mates.conversation(mate["id"])
    try:
        heard: list = []
        calls.link("phone-1", heard.append)
        call = await calls.ring(mate["id"], "phone-1", "lonely")
        await calls.answering(call.id)
        await _wait(lambda: call.status == "ended")
        assert call.end_reason == "missed"
        with pytest.raises(CallError):
            await calls.answering(call.id)
        # a link that connects while she rings hears it at once
        late: list = []
        call2 = await calls.ring(mate["id"], "phone-1", "lonely")
        calls.link("phone-1", late.append)
        assert late[0]["ring"]["id"] == call2.id
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_no_calls_at_night_in_the_users_time(db, tmp_path, monkeypatch):
    night = datetime(2026, 11, 12, 23, 30, tzinfo=timezone(timedelta(hours=9))).timestamp()  # 23:30 in Seoul
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch, clock=lambda: night)
    mate = store.create(name="Haru", llm={"model": "m1"})
    mates.conversation(mate["id"])
    try:
        _phone(mates, mate["id"])
        assert await calls.consider(mate["id"]) == "quiet_hours"
        assert calls_mod.by_day(10) and calls_mod.by_day(20) and not calls_mod.by_day(21) and not calls_mod.by_day(9)
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_a_declined_call_hurts_a_little_and_the_wait_grows_until_she_is_answered(db, tmp_path, monkeypatch):
    monkeypatch.setattr(calls_mod, "CALL_HOURS", (0, 24))
    now = [time.time()]
    # (rng 1: she doesn't call on her own here — only the calls this test makes)
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch, clock=lambda: now[0], rng=lambda: 1.0)
    mate = store.create(name="Haru", persona={"language": "en"}, llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    try:
        assert cooldown(0) == timedelta(hours=6) and cooldown(1) == timedelta(hours=12) and cooldown(2) == timedelta(hours=24)
        assert cooldown(9) == timedelta(days=7)
        _phone(mates, mate["id"])
        before = S.levels(store.state_doc(mate["id"]), store.state_who(mate["id"]), datetime.now(timezone.utc), store.tz())
        call = await calls.ring(mate["id"], "phone-1", "lonely")
        await calls.decline(call.id)
        doc = store.state_doc(mate["id"])
        after = S.levels(doc, store.state_who(mate["id"]), datetime.now(timezone.utc), store.tz())
        assert after["sad"]["v"] > before["sad"]["v"] and after["lonely"]["v"] > before["lonely"]["v"]
        assert after["sad"]["why"]["code"] == "declined_call"
        assert calls.unanswered_in_a_row(mate["id"]) == 1
        card = [m for m in svc.messages(sid) if (m.get("meta") or {}).get("kind") == "call"][-1]["meta"]["call"]
        assert card["status"] == "declined" and card["direction"] == "incoming"
        assert await calls.consider(mate["id"]) == "cooldown"
        # what she is told with their next message (once)
        lines, told = calls.notes(mate["id"])
        assert "turned the call down" in lines[0]
        told()
        assert calls.notes(mate["id"])[0] == []

        now[0] += timedelta(hours=7).total_seconds()  # (past 6 h, but one in a row: 12 h)
        assert await calls.consider(mate["id"]) == "cooldown"
        now[0] += timedelta(hours=6).total_seconds()
        assert await calls.consider(mate["id"]) != "cooldown"
        # a second one in a row: sulking a little, and a longer wait
        call = await calls.ring(mate["id"], "phone-1", "lonely")
        await calls.decline(call.id)
        assert calls.unanswered_in_a_row(mate["id"]) == 2
        lv = S.levels(store.state_doc(mate["id"]), store.state_who(mate["id"]), datetime.now(timezone.utc), store.tz())
        assert lv["angry"]["v"] > 0 and lv["angry"]["why"]["code"] == "declined_call"
        now[0] += timedelta(hours=13).total_seconds()
        assert await calls.consider(mate["id"]) == "cooldown"  # (24 h now)
        # picked up: the count starts over
        call = await calls.ring(mate["id"], "phone-1", "lonely")
        await calls.accept(call.id, "phone-1")
        sent: list = []
        calls.attach(call, sent.append)
        await _wait(lambda: any(m["type"] == "done" for m in sent))
        await calls.hangup(call.id)
        assert calls.unanswered_in_a_row(mate["id"]) == 0
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_an_unanswered_call_is_a_missed_call(db, tmp_path, monkeypatch):
    monkeypatch.setattr(calls_mod, "RING_S", 0.05)
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    try:
        call = await calls.ring(mate["id"], "phone-1", "question", "Did you eat?")
        await _wait(lambda: call.status == "ended")
        assert call.end_reason == "missed"
        card = [m for m in svc.messages(sid) if (m.get("meta") or {}).get("kind") == "call"][-1]["meta"]["call"]
        assert card["status"] == "missed" and card["transcript"] == []  # (her hello, made while it rang, was never heard)
        assert store.state_doc(mate["id"])["feelings"]["lonely"]["why"]["code"] == "missed_call"
        assert "didn't pick up" in calls.notes(mate["id"])[0][0]
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_her_reasons_to_call(db, tmp_path, monkeypatch):
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    now = datetime.now(timezone.utc)
    try:
        assert calls.why(store.get(mate["id"]), sid, now) is None
        svc._add_message(sid, "assistant", "[smile] Did you finish the report?", provider="claude")
        doc = store.state_doc(mate["id"])
        doc["spoke"] = {"n": 1, "at": (now - timedelta(hours=1)).isoformat(), "asked": True}
        store.save_state(mate["id"], doc)
        assert calls.why(store.get(mate["id"]), sid, now) == ("question", "Did you finish the report?")
        doc["spoke"] = None
        store.save_state(mate["id"], doc)
        svc._add_message(sid, "user", "<delegation_result …>", meta={"internal": True, "kind": "delegation_result",
                                                                        "delegations": [{"title": "Tests", "status": "ok"}]})
        svc._add_message(sid, "assistant", "The tests all pass now.", provider="claude")
        db.execute("UPDATE messages SET created_at=? WHERE session_id=?", ((now - timedelta(minutes=30)).isoformat(), sid))
        assert calls.why(store.get(mate["id"]), sid, now) == ("work", "The tests all pass now.")
    finally:
        await calls.stop()
        await svc.shutdown()


# ---- while a call is on ----

async def test_while_on_the_phone_results_wait_and_come_after(db, tmp_path, monkeypatch):
    svc, store, mates, calls, line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", llm={"model": "m1"})
    sid = mates.conversation(mate["id"])["session_id"]
    q = svc.subscribe(sid)
    try:
        call = await calls.dial(mate["id"])
        mates._pending[sid] = [{"session_id": "w", "title": "Work", "status": "ok", "text": "done", "depth": 0}]
        mates._flush(sid)
        assert not svc.is_running(sid) and mates._pending.get(sid)
        await calls.hangup(call.id)
        seen = await _until(q, _ended)
        assert any(m["type"] == "user.message" and m["data"].get("kind") == "delegation_result" for m in seen)
    finally:
        await calls.stop()
        await svc.shutdown()


async def test_her_note_after_a_call_streams_and_silent_is_nothing():
    from app.mate.trigger.silence import deliver_quiet
    from app.providers.base import ProviderEvent

    def ev(t, **d):
        return ProviderEvent(type=t, data=d)

    async def stream(*evs):
        for e in evs:
            yield e

    out = [e async for e in deliver_quiet(stream(ev("text.delta", text="[SIL"), ev("text.delta", text="ENT]"),
                                                ev("turn.complete", text="[SILENT]")))]
    assert [e.type for e in out] == ["turn.complete"] and out[0].data["silent"] is True and out[0].data["text"] == ""
    out = [e async for e in deliver_quiet(stream(ev("text.delta", text="[smile] "), ev("tool.use", name="send_to_session"),
                                                ev("text.delta", text="통화 정리: 내일 배포 체크리스트."),
                                                ev("turn.complete", text="통화 정리: 내일 배포 체크리스트.")))]
    assert [e.type for e in out] == ["text.delta", "tool.use", "text.delta", "turn.complete"]
    assert out[0].data["text"] == "[smile] " and not out[-1].data.get("silent")


def test_spoken_words_leave_tags_out():
    assert spoken("[joy] 응! [laugh:0.8] 그래") == "응! 그래"
    assert spoken("[SILENT]") == ""
