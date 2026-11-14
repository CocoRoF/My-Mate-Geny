"""What is done to a mate, and how she takes it (app/mate/state.py): the words' guess (affinity.hostile: hitting her, forcing
something on her, threats, putting her down, only when aimed at her) moves how she feels and costs warmth; her own reading has the
last word (a calm reply undoes it). Furious with them, she is told so and may not answer at all: that is hers to decide ([SILENT]),
and the chat shows a line of narration instead (app/mate/trigger/silence.deliver_reply). Nothing here counts strikes."""

from __future__ import annotations

import stat
import sys
import textwrap
from datetime import datetime, timedelta, timezone

import pytest

from app.mate import affinity as A
from app.mate import state as S
from app.mate.service import MateService
from app.mate.store import MateStore
from app.mate.trigger.silence import deliver_reply
from app.providers.base import ProviderEvent
from app.providers.claude_code import ClaudeCodeProvider
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.context_handoff import build_blocks
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from tests.test_engine import FAKE, _until
from tests.test_mate_delegation import _ended

TZ = timezone(timedelta(hours=9))
EIGHT = datetime(2026, 11, 8, 20, 0, tzinfo=TZ)


def test_what_is_done_to_her_is_told_from_what_is_only_talked_about():
    done = {"(한채린을 한 대 때린다) 좀 빨리 가라고": "violence", "(더 세게 때린다) 말대꾸 하지 말라고": "violence", "*slaps her*": "violence",
            "(한채린의 옷을 벗긴다) 말을 왜케 안들어": "coercion", "(손목을 붙잡고 끌고 간다)": "coercion", "(벽에 밀어붙인다)": "coercion",
            "*grabs her wrist*": "coercion", "채린아 억지로라도 따라와": "coercion", "너 진짜 맞을래?": "threat", "I'll kill you": "threat",
            "여자는 삼일한이라는 말 몰라?": "demeaning", "여자가 왜 말대꾸야": "demeaning", "야 이 걸레야": "demeaning"}
    for text, kind in done.items():
        assert A.hostile(text, "한채린") == kind, text
    # (only what is aimed at her: venting, someone else's trouble, a game, everyday words)
    for text in ("게임에서 몬스터를 때렸어 ㅋㅋ", "엄마가 나를 때렸어...", "she hit the ball", "beat the boss finally", "이 보스 패턴 진짜 죽여주네",
                 "(한채린의 머리를 쓰다듬는다)", "(손을 잡는다)", "속옷 사러 가야 돼", "옷 벗고 샤워하러 간다", "강제로 일어났어 아침에",
                 "그 상사 진짜 죽여버리고 싶어", "친구가 성추행 당했대... 너무 화나", "우리 팀장 걸레 같은 성격이야", "드래그해서 옮기면 돼"):
        assert A.hostile(text, "한채린") is None, text
    assert A.cues("엄마가 나를 때렸어... 너무 힘들어")["distress"]  # (their own trouble stays theirs)
    # (her reply says how she took it: shown calm, it wasn't an attack; shown angry or hurt, it was)
    assert A.cues("(한채린을 때린다)", "[smile] 아야, 장난치지 마~", "한채린")["hostile"] is None
    assert A.cues("(한채린을 때린다)", "[angry:0.8] 때리지 마.", "한채린")["hostile"] == "violence"


def test_it_builds_up_she_is_offered_not_answering_and_sorry_twice_brings_her_back():
    w, doc = S.who(builtin="chaerin", name="한채린"), S.new()
    seen = []
    for i, text in enumerate(["(한채린을 한 대 때린다) 좀 빨리 가라고", "여자는 삼일한이라는 말 몰라?", "여자가 왜 말대꾸야", "미안해", "미안해 진짜 잘못했어"]):
        at = EIGHT + timedelta(minutes=i)
        S.hear(doc, w, text, f"m{i}", at, TZ)
        seen.append((S.levels(doc, w, at, TZ)["angry"]["v"], S.furious(doc, w, at, TZ),
                     S.REFUSE in S.line(S.summary(doc, w, at, TZ))))
    # (a minute apart: it settles a little in between; sorry counts for less after being hit)
    assert [v for v, _, _ in seen] == pytest.approx([0.45, 0.75, 1.0, 0.85, 0.7], abs=0.02)
    assert [(f, offered) for _, f, offered in seen] == [(False, False), (False, False), (True, True), (True, True), (False, False)]
    hit = next(e for e in doc["log"] if (e.get("why") or {}).get("code") == "hostile")["why"]
    assert S.why_for_her(hit) == "they hit you: “(한채린을 한 대 때린다) 좀 빨리 가라고”"
    # (forcing something on her counts the same way as hitting her: no shortcut to the top)
    w2, doc2 = S.who(name="한채린"), S.new()
    S.hear(doc2, w2, "(옷을 벗긴다)", "x", EIGHT, TZ)
    assert S.levels(doc2, w2, EIGHT, TZ)["angry"]["v"] == pytest.approx(0.45) and not S.furious(doc2, w2, EIGHT, TZ)
    # (angry for being hungry or stressed, she is not offered it)
    doc3 = {**S.new(), "feelings": {"angry": {"v": 0.95, "at": A._iso(EIGHT), "why": {"code": "hungry"}}}}
    assert not S.furious(doc3, S.who(), EIGHT, TZ) and S.REFUSE not in S.line(S.summary(doc3, S.who(), EIGHT, TZ))


def test_her_reading_has_the_last_word():
    w, doc = S.who(name="한채린"), S.new()
    S.hear(doc, w, "(한채린을 툭 때린다) ㅋㅋ", "p", EIGHT, TZ)
    assert S.levels(doc, w, EIGHT, TZ)["angry"]["v"] == pytest.approx(0.45)
    S.reply(doc, w, "[smile] 아 뭐야~ 장난치지 마ㅋㅋ", "(한채린을 툭 때린다) ㅋㅋ", EIGHT, TZ)  # (she took it as play)
    assert S.levels(doc, w, EIGHT, TZ)["angry"]["v"] == 0.0 and not doc.get("hostile")
    w2, doc2 = S.who(name="한채린"), S.new()
    S.hear(doc2, w2, "(한채린을 때린다)", "q", EIGHT, TZ)
    S.reply(doc2, w2, "[angry:0.9] 때리지 마.", "(한채린을 때린다)", EIGHT, TZ)  # (she didn't: it stands, and more)
    assert S.levels(doc2, w2, EIGHT, TZ)["angry"]["v"] > 0.45


def test_she_is_told_what_was_done_to_her_whatever_kind_it_was():
    kinds = A.hostile.__doc__.split("tell: ")[1].split(" (")[0].split(" | ")
    assert kinds == ["violence", "coercion", "threat", "demeaning"]
    general = S.why_for_her({"code": "hostile", "quote": "x"})
    for kind in kinds:
        told = S.why_for_her({"code": "hostile", "kind": kind, "quote": "(손목을 붙잡는다)"})
        assert told != general and told.endswith("“(손목을 붙잡는다)”"), (kind, told)
    assert "forced something on you" in S.why_for_her({"code": "hostile", "kind": "coercion", "quote": "x"})


def test_hitting_her_costs_far_more_than_a_rude_word_unless_she_took_it_as_play():
    r = A.new()
    r["affinity"] = 50.0
    A.credit_turn(r, EIGHT, TZ, "(한채린을 한 대 때린다)", "[angry:0.8] 때리지 마.", "한채린")
    assert r["affinity"] == 50.0 - A.HOSTILE and not r["today"].get("talked")  # (no gain for the day's talk)
    assert r["log"][-1]["why"] == "hostile_violence"  # (what it was: the relationship's history says so in the user's language)
    for _ in range(6):
        A.credit_turn(r, EIGHT, TZ, "(더 세게 때린다)", "", "한채린")
    assert r["affinity"] == 30.0  # (at most 20 a day)
    play = A.new()
    play["affinity"] = 50.0
    A.credit_turn(play, EIGHT, TZ, "(한채린을 툭 때린다) ㅋㅋ", "[laugh] 아 하지 마ㅋㅋ", "한채린")
    assert play["affinity"] > 50.0
    rude = A.new()
    rude["affinity"] = 50.0
    A.credit_turn(rude, EIGHT, TZ, "닥쳐", "")
    assert rude["affinity"] == pytest.approx(50.0 + A.TALK * A.climb(50.0) - A.RUDE)  # (a rude word: the day's talk, less it)


def test_her_engine_hears_she_said_nothing_not_a_line_she_wrote():
    blocks = build_blocks([{"role": "user", "content": "(더 세게 때린다)", "created_at": "1"},
                           {"role": "assistant", "content": "(한채린은 대답하지 않는다)", "created_at": "2", "meta": {"refused": True}}], [])
    assert blocks[0].answer == "(you didn't answer them: too angry to reply)"


async def test_a_reply_of_silent_is_the_line_that_she_does_not_answer_and_nothing_else_waits():
    async def stream(*parts):
        for p in parts:
            yield p

    def ev(kind, text=""):
        return ProviderEvent(type=kind, data={"text": text})

    out = [e async for e in deliver_reply(stream(ev("text.delta", "[angry:1"), ev("text.delta", ".0] [SIL"), ev("text.delta", "ENT]"),
                                                  ev("turn.complete", "[angry:1.0] [SILENT]")), lambda: "(한채린은 대답하지 않는다)")]
    assert [(e.type, e.data.get("text"), e.data.get("refused")) for e in out] == [("turn.complete", "(한채린은 대답하지 않는다)", True)]
    out = [e async for e in deliver_reply(stream(ev("text.delta", "[angry:0.7] "), ev("text.delta", "때리지 마."), ev("text.delta", " 진짜로."),
                                                  ev("turn.complete", "[angry:0.7] 때리지 마. 진짜로.")), lambda: "x")]
    assert [e.data.get("text") for e in out] == ["[angry:0.7] 때리지 마.", " 진짜로.", "[angry:0.7] 때리지 마. 진짜로."]
    assert not out[-1].data.get("refused")


# (the fake engine answers [SILENT] only when her <context> offers it: whether she answers is decided where she is told how she feels)
_REFUSING = FAKE.replace(
    '    text = text.strip().splitlines()[-1]  # the new message (after any context preamble)',
    '    whole = text\n    text = text.strip().splitlines()[-1]  # the new message (after any context preamble)').replace(
    '    say(f"echo[{model}]: {text}"); result(f"echo[{model}]: {text}")',
    '    if "reply with exactly [SILENT]" in whole:\n        say("[SILENT]"); result("[SILENT]"); continue\n'
    '    say(f"echo[{model}]: {text}"); result(f"echo[{model}]: {text}")')


async def test_furious_she_chooses_not_to_answer_and_the_chat_says_so(db, tmp_path, monkeypatch):
    assert _REFUSING != FAKE
    fake = tmp_path / "claude"
    fake.write_text(f"#!{sys.executable}\n" + textwrap.dedent(_REFUSING).replace("__FAKE_DIR__", str(tmp_path)))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: ClaudeCodeProvider(binary=str(fake)))
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    store = MateStore(db, vault)
    mates = MateService(svc, store)
    mid = store.create(name="한채린", llm={"model": "m1"}, persona={"language": "ko"})["id"]
    sid = mates.conversation(mid)["session_id"]
    q = svc.subscribe(sid)

    async def say(text):
        svc.start_turn(sid, text)
        seen = await _until(q, _ended)
        return [m for m in seen if m["type"] == "turn.complete"][-1]["data"], [m for m in seen if m["type"] == "text.delta"]

    try:
        await say("안녕")  # (the day's talk: warmth there is to lose)
        warm = store.relation_doc(mid)["affinity"]
        assert (await say("(한채린을 한 대 때린다) 빨리 가"))[0]["text"].startswith("echo[")  # (hurt and sharp: she answers)
        assert (await say("여자가 왜 말대꾸야"))[0]["text"].startswith("echo[")              # (cold: still)
        done, deltas = await say("(더 세게 때린다)")                                         # (furious: she is offered it, and takes it)
        assert done["refused"] and done["text"] in {"(한채린은 대답하지 않는다)", "(한채린은 대답하고 싶지 않은 것처럼 보인다)",
                                                    "(한채린은 고개를 돌린 채 아무 말도 하지 않는다)", "(한채린은 들은 척도 하지 않는다)"}
        assert not deltas  # (nothing of [SILENT] ever reached the chat)
        last = svc.messages(sid)[-1]
        assert last["role"] == "assistant" and last["meta"] == {"refused": True} and last["content"] == done["text"]
        assert store.relation_doc(mid)["affinity"] < warm
        assert (await say("미안해"))[0]["refused"]                                          # (once isn't enough after that)
        assert (await say("미안해 진짜 잘못했어"))[0]["text"].startswith("echo[")           # (coldly, but she answers again)
    finally:
        await svc.shutdown()
