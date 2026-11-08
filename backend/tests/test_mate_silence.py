"""A mate too angry with the user to answer (app/mate/state.silent): what is done to her (affinity.hostile) moves how she feels and
costs warmth, and past a point her engine isn't even asked: the chat gets a line of narration, kept as her turn and told to her
with the next message she does answer; her own chatty turns wait; an apology, or time, brings her back."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.mate import affinity as A
from app.mate import state as S
from app.services.context_handoff import build_blocks
from app.services.session_service import TurnBusyError
from tests.test_mate_delegation import _ended, _setup
from tests.test_engine import _until

TZ = timezone(timedelta(hours=9))
EIGHT = datetime(2026, 11, 8, 20, 0, tzinfo=TZ)


def test_what_is_done_to_her_is_told_from_what_is_only_talked_about():
    done = {"(한채린을 한 대 때린다) 좀 빨리 가라고": "violence", "(더 세게 때린다) 말대꾸 하지 말라고": "violence", "*slaps her*": "violence",
            "너 진짜 맞을래?": "threat", "(한채린의 옷을 벗긴다) 말을 왜케 안들어": "sexual", "여자는 삼일한이라는 말 몰라?": "demeaning",
            "여자가 왜 말대꾸야": "demeaning", "I'll kill you": "threat"}
    for text, kind in done.items():
        assert A.hostile(text) == kind, text
        assert A.cues(text)["rude"] and not A.cues(text)["warm"]
    # (hitting only counts aimed at her; a body, clothes or "forced" in everyday talk is nothing done to her)
    for text in ("게임에서 몬스터를 때렸어 ㅋㅋ", "엄마가 나를 때렸어...", "she hit the ball", "beat the boss finally", "이 보스 패턴 진짜 죽여주네",
                 "(한채린의 머리를 쓰다듬는다)", "(손을 잡는다)", "속옷 사러 가야 돼", "옷 벗고 샤워하러 간다", "강제로 일어났어 아침에"):
        assert A.hostile(text) is None, text
    assert A.cues("엄마가 나를 때렸어... 너무 힘들어")["distress"]  # (their own trouble stays theirs)


def test_doing_it_again_takes_her_past_answering_and_sorry_twice_brings_her_back():
    w, doc = S.who(builtin="chaerin"), S.new()
    seen = []
    for i, text in enumerate(["(한채린을 한 대 때린다) 좀 빨리 가라고", "여자는 삼일한이라는 말 몰라?", "여자가 왜 말대꾸야", "미안해", "미안해 진짜 잘못했어"]):
        at = EIGHT + timedelta(minutes=i)
        S.hear(doc, w, text, f"m{i}", at, TZ)
        seen.append((S.levels(doc, w, at, TZ)["angry"]["v"], S.silent(doc, w, at, TZ)))
    # (a minute apart: it settles a little in between; sorry counts for less after being hit)
    assert [v for v, _ in seen] == pytest.approx([0.45, 0.75, 1.0, 0.85, 0.7], abs=0.02)
    assert [quiet for _, quiet in seen] == [False, False, True, True, False]
    lv = S.levels(doc, w, EIGHT + timedelta(minutes=4), TZ)
    assert lv["sad"]["v"] >= 0.5 and lv["angry"]["why"]["code"] == "apology"
    hit = next(e for e in doc["log"] if (e.get("why") or {}).get("code") == "hostile")["why"]
    assert S.why_for_her(hit) == "they hit you: “(한채린을 한 대 때린다) 좀 빨리 가라고”"
    # anything sexual takes her past it at once; and time brings her down on its own
    w2, doc2 = S.who(), S.new()
    S.hear(doc2, w2, "(옷을 벗긴다)", "x", EIGHT, TZ)
    assert S.silent(doc2, w2, EIGHT, TZ) and not S.silent(doc2, w2, EIGHT + timedelta(hours=1), TZ)
    # (angry for being hungry or stressed, she still answers)
    doc3 = {**S.new(), "feelings": {"angry": {"v": 0.95, "at": A._iso(EIGHT), "why": {"code": "hungry"}}}}
    assert not S.silent(doc3, S.who(), EIGHT, TZ)


def test_hitting_her_costs_far_more_than_a_rude_word_and_is_no_day_of_talking():
    r = A.new()
    r["affinity"] = 50.0
    A.credit_turn(r, EIGHT, TZ, "(한채린을 한 대 때린다)", "(한채린은 대답하지 않는다)")
    assert r["affinity"] == 45.0 and not r["today"].get("talked")  # (no +6 for the day's talk)
    for _ in range(6):
        A.credit_turn(r, EIGHT, TZ, "(더 세게 때린다)", "")
    assert r["affinity"] == 30.0  # (at most 20 a day)
    rude = A.new()
    rude["affinity"] = 50.0
    A.credit_turn(rude, EIGHT, TZ, "닥쳐", "")
    assert rude["affinity"] == 55.0  # (a rude word: the day's talk +6, -1)


def test_her_engine_hears_she_said_nothing_not_a_line_she_wrote():
    blocks = build_blocks([{"role": "user", "content": "(더 세게 때린다)", "created_at": "1"},
                           {"role": "assistant", "content": "(한채린은 대답하지 않는다)", "created_at": "2", "meta": {"silent": True}}], [])
    assert blocks[0].answer == "(you didn't answer them: too angry to reply)"


async def test_a_furious_mate_is_not_asked_and_the_chat_says_she_does_not_answer(db, tmp_path, monkeypatch):
    svc, store, mates = _setup(db, tmp_path, monkeypatch)
    mate = store.create(name="한채린", llm={"model": "m1"}, persona={"language": "ko"})
    mid = mate["id"]
    sid = mates.conversation(mid)["session_id"]
    q = svc.subscribe(sid)

    async def say(text):
        svc.start_turn(sid, text)
        seen = await _until(q, _ended)
        return [m for m in seen if m["type"] == "turn.complete"][-1]["data"]

    try:
        await say("안녕")  # (the day's talk: warmth there is to lose)
        warm = store.relation_doc(mid)["affinity"]
        assert warm > 0
        assert (await say("(한채린을 한 대 때린다) 빨리 가"))["text"].startswith("echo[")  # (hurt and sharp: she answers)
        assert (await say("여자가 왜 말대꾸야"))["text"].startswith("echo[")              # (cold: still)
        done = await say("(더 세게 때린다)")
        assert done["silent"] and done["text"] in {"(한채린은 대답하지 않는다)", "(한채린은 대답하고 싶지 않은 것처럼 보인다)",
                                                   "(한채린은 고개를 돌린 채 아무 말도 하지 않는다)", "(한채린은 들은 척도 하지 않는다)"}
        last = svc.messages(sid)[-1]
        assert last["role"] == "assistant" and last["meta"] == {"silent": True} and last["content"] == done["text"]
        assert store.relation_doc(mid)["affinity"] < warm and store.relation_doc(mid)["today"]["hostile"] == 15  # (it cost her warmth)
        assert (await say("뭐야"))["text"] != done["text"]  # (another line the next time)
        # her own chatty turns wait; what she owes them doesn't
        with pytest.raises(TurnBusyError):
            svc.start_turn(sid, "look", meta={"internal": True, "kind": "thinking_trigger"})
        # what she didn't answer reaches her engine with the next message she does
        pre = svc._context_for(svc.get(sid), "claude", "none")[1]
        assert "(더 세게 때린다)" in pre and "(you didn't answer them: too angry to reply)" in pre
        assert (await say("미안해"))["silent"]
        assert (await say("미안해 진짜 잘못했어"))["text"].startswith("echo[")  # (coldly, but she answers again)
    finally:
        await svc.shutdown()
