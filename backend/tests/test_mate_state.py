"""How a mate feels and why (app/mate/state.py, docs/mate-memory-affinity.md §5.4), and what she does with it: every mate has
feelings that move with what happens and settle by themselves, an outfit can keep one up, and whether she changes clothes
is hers to decide (docs/mate.md "Outfits"): the tool only holds what isn't up to her."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from test_mate_outfits import _filled, _mate, _rig
from test_mate_style import _ctx, _Logs, _service, _turn

from app.mate import files, mcp_bridge
from app.mate import state as S
from app.mate import wardrobe as W
from app.mate.prompt import base_prompt, context_block, prompt_key, settings_change_note
from app.mate.store import DEFAULT_OUTFIT

_REAL_LATE = S._late  # (conftest.py pins it for every test but the one about it)

TZ = timezone.utc
NOON = datetime(2026, 11, 6, 12, tzinfo=TZ)
CROP_TOP = {"id": "u", "name": "크롭탑", "feel": {"shy": 0.6}, "since": S.A._iso(NOON)}


def _lv(doc, w, at=NOON):
    return {e: x["v"] for e, x in S.levels(doc, w, at, TZ).items()}


# ---- the engine ----

def test_everything_settles_back_to_how_she_usually_is():
    w, doc = S.who(), S.new()
    S.report(doc, w, "angry", "strong", "말을 너무 함부로 해서", NOON, TZ)
    assert _lv(doc, w)["angry"] == pytest.approx(0.85)
    assert S.summary(doc, w, NOON, TZ)["label"] == "angry"
    half = NOON + timedelta(hours=S.HALF_LIFE_H["angry"])
    assert _lv(doc, w, half)["angry"] == pytest.approx(0.425, abs=0.01)
    assert _lv(doc, w, NOON + timedelta(hours=24))["angry"] < 0.01
    assert S.summary(doc, w, NOON + timedelta(hours=24), TZ)["label"] == S.CALM


def test_a_reason_goes_with_every_feeling_and_she_is_told_it_without_a_number():
    w, doc = S.who(), S.new()
    S.report(doc, w, "shy", "moderate", "  칭찬을   받아서 ", NOON, TZ)
    s = S.summary(doc, w, NOON, TZ)
    assert s["top"][0] == {"emotion": "shy", "v": 0.55, "word": "quite", "why": {"text": "칭찬을 받아서"}}
    line = S.line(s)
    assert line.startswith("How you feel right now: shy, quite (칭찬을 받아서).")
    assert not any(c.isdigit() for c in line)
    assert S.line(S.summary(S.new(), S.who(), NOON, TZ)) == "How you feel right now: calm."


# ---- what the user says

def test_keeping_up_the_insults_makes_her_angrier_each_time():
    w, doc = S.who(), S.new()
    seen = []
    for i in range(3):
        S.hear(doc, w, "닥쳐, 쓸모없어", f"m{i}", NOON, TZ)
        seen.append(_lv(doc, w)["angry"])
    assert seen == pytest.approx([0.3, 0.7, 1.0])
    assert S.levels(doc, w, NOON, TZ)["angry"]["why"] == {"code": "rude"}
    # (furious with them, whether she answers at all is hers: she is offered not to; short of that, very few words)
    assert S.conduct(S.summary(doc, w, NOON, TZ)).startswith(S.REFUSE)
    cold = {**S.new(), "feelings": {"angry": {"v": 0.75, "at": S.A._iso(NOON), "why": {"code": "rude"}}}}
    assert "very few words" in S.conduct(S.summary(cold, w, NOON, TZ))
    S.hear(doc, w, "닥쳐, 쓸모없어", "m2", NOON, TZ)  # (the same message, looked at again)
    assert _lv(doc, w)["angry"] == 1.0
    fresh = S.new()  # (one now and then isn't keeping it up)
    S.hear(fresh, w, "닥쳐", "a", NOON, TZ)
    S.hear(fresh, w, "닥쳐", "b", NOON + S.RUDE_WINDOW + timedelta(minutes=1), TZ)
    assert fresh["rude"]["n"] == 1


@pytest.mark.parametrize("text", ["미안해", "죄송합니다", "진심으로 사과하는 거야", "내가 말이 심했어", "I'm sorry"])
def test_saying_sorry_in_any_of_its_words_counts(text):
    w, doc = S.who(), S.new()
    S.hear(doc, w, "멍청아", "a", NOON, TZ)
    S.hear(doc, w, text, "b", NOON, TZ)
    assert _lv(doc, w)["angry"] == 0 and doc["rude"] is None


def test_kindness_calms_her_but_good_things_land_less_while_she_is_angry():
    w, doc = S.who(closeness=0.0, builtin="chaerin"), S.new()
    for i in range(3):
        S.hear(doc, w, "멍청아", f"m{i}", NOON, TZ)
    S.hear(doc, w, "고마워", "thanks", NOON, TZ)
    assert _lv(doc, w)["angry"] == pytest.approx(1 - S.WARM_CALMS, abs=0.01)
    calm = S.new()
    S.hear(calm, w, "고마워", "thanks", NOON, TZ)
    assert _lv(doc, w)["happy"] < _lv(calm, w)["happy"]
    S.hear(doc, w, "이 버그 좀 봐줘", "bug", NOON, TZ)
    S.hear(calm, w, "이 버그 좀 봐줘", "bug", NOON, TZ)
    assert _lv(doc, w)["excited"] < S.SHOWN_FROM < _lv(calm, w)["excited"]


def test_an_apology_takes_the_edge_off():
    w, doc = S.who(), S.new()
    for i in range(2):
        S.hear(doc, w, "멍청아", f"m{i}", NOON, TZ)
    S.hear(doc, w, "미안해, 내가 잘못했어", "sorry", NOON, TZ)
    assert _lv(doc, w)["angry"] == pytest.approx(0.4)
    assert S.levels(doc, w, NOON, TZ)["angry"]["why"] == {"code": "apology"}
    S.hear(doc, w, "멍청아", "again", NOON, TZ)
    assert doc["rude"]["n"] == 1  # (and it starts over)


@pytest.mark.parametrize(("text", "emotion", "code"), [
    ("고마워 정말", "happy", "warm"), ("사랑해", "happy", "love"), ("사랑해", "shy", "love"), ("오늘 옷 잘 어울려", "shy", "looks"),
    ("오늘 너무 힘들어…", "worried", "distress"), ("됐어 관심 없어", "sad", "dismissed"), ("됐어 관심 없어", "angry", "dismissed"),
])
def test_all_kinds_of_things_said_move_it(text, emotion, code):
    w, doc = S.who(), S.new()
    before = _lv(doc, w)[emotion]
    S.hear(doc, w, text, "m", NOON, TZ)
    assert _lv(doc, w)[emotion] > before and S.levels(doc, w, NOON, TZ)[emotion]["why"] == {"code": code}


def test_plain_talk_leaves_it_alone():
    w, doc = S.who(), S.new()
    before = _lv(doc, w)
    S.hear(doc, w, "내일 회의가 몇 시였지?", "m", NOON, TZ)
    assert _lv(doc, w) == before


def test_what_she_loves_lights_her_up_and_each_mate_is_her_own():
    chaerin, other = S.who(builtin="chaerin"), S.who(builtin="someone made by the user")
    a, b = S.new(), S.new()
    S.hear(a, chaerin, "이번 레이드 버그 재현됐어", "m", NOON, TZ)
    S.hear(b, other, "이번 레이드 버그 재현됐어", "m", NOON, TZ)
    assert _lv(a, chaerin)["excited"] > 0.2 and _lv(b, other)["excited"] == 0
    assert S.levels(a, chaerin, NOON, TZ)["excited"]["why"] == {"code": "loves"}
    assert _lv(S.new(), chaerin)["shy"] > _lv(S.new(), other)["shy"]
    assert other["temperament"] == {}


def test_coming_back_after_a_while_is_welcome():
    w, doc = S.who(), S.new()
    S.hear(doc, w, "안녕", "m1", NOON, TZ)
    S.hear(doc, w, "안녕", "m2", NOON + timedelta(days=2), TZ)
    assert S.levels(doc, w, NOON + timedelta(days=2), TZ)["happy"]["why"] == {"code": "returned"}


def test_answering_in_a_word_every_time_tells():
    w, doc = S.who(), S.new()
    for i, text in enumerate(("응", "ㅇㅇ", "네.")):
        S.hear(doc, w, text, f"m{i}", NOON, TZ)
    assert S.levels(doc, w, NOON, TZ)["lonely"]["why"] == {"code": "curt"}
    S.hear(doc, w, "오늘 있었던 일을 말해줄게", "long", NOON, TZ)
    assert doc["curt"] == 0


# ---- what the user does

def test_left_unanswered_she_gets_lonely_and_sooner_the_more_she_spoke():
    w = S.who(closeness=0.5)
    once, thrice = S.new(), S.new()
    S.spoke(once, "오늘 어땠어요?", NOON)
    for _ in range(3):
        S.spoke(thrice, "저기요", NOON)
    two_hours = NOON + timedelta(hours=2)
    assert _lv(once, w)["lonely"] == 0  # (not yet)
    assert _lv(thrice, w, two_hours)["lonely"] > _lv(once, w, two_hours)["lonely"] * 3
    assert S.levels(thrice, w, two_hours, TZ)["lonely"]["why"] == {"code": "ignored"}
    assert _lv(once, w, NOON + timedelta(days=3))["lonely"] >= S.SHOWN_FROM
    assert _lv(thrice, S.who(closeness=0.5, away=True), two_hours)["lonely"] == 0  # (she knows they are away)


def test_when_they_answer_it_stops_growing_but_doesnt_vanish():
    w = S.who(closeness=0.5)
    doc = S.new()
    for _ in range(3):
        S.spoke(doc, "저기요", NOON)
    later = NOON + timedelta(hours=3)
    was = _lv(doc, w, later)["lonely"]
    S.hear(doc, w, "미안 이제 봤어", "m", later, TZ)
    assert doc["spoke"] is None
    assert 0 < _lv(doc, w, later)["lonely"] < was
    assert _lv(doc, w, later)["angry"] >= 0  # (and being ignored that often leaves a mark)
    assert any(e.get("why") == {"code": "ignored"} for e in doc["log"])
    assert _lv(doc, w, later + timedelta(hours=8))["lonely"] < 0.05


def test_being_stopped_and_poked_count():
    w, doc = S.who(), S.new()
    S.interrupted(doc, w, NOON, TZ)
    assert S.levels(doc, w, NOON, TZ)["angry"]["why"] == {"code": "interrupted"}
    w, doc = S.who(), S.new()
    S.poked(doc, w, NOON, TZ)
    assert _lv(doc, w)["shy"] > 0 and _lv(doc, w)["angry"] == 0  # (a bit of attention)
    for _ in range(S.POKE_TOO_MANY):
        S.poked(doc, w, NOON, TZ)
    assert _lv(doc, w)["angry"] > 0 and S.levels(doc, w, NOON, TZ)["angry"]["why"] == {"code": "poked"}


def test_late_at_night_she_is_sleepy_because_it_is_late(monkeypatch):
    monkeypatch.setattr(S, "_late", _REAL_LATE)
    w, doc = S.who(), S.new()
    three = datetime(2026, 11, 6, 3, tzinfo=TZ)
    assert S.levels(doc, w, three, TZ)["sleepy"] == {"v": 0.85, "why": {"code": "late"}}
    assert _lv(doc, w, NOON)["sleepy"] == 0
    assert "it's late" in S.line(S.summary(doc, w, three, TZ))


# ---- her own face

def test_what_her_face_shows_is_how_she_feels_for_what_was_said():
    w, doc = S.who(), S.new()
    S.reply(doc, w, "[angry:0.8] 그만해요. [angry:0.4] 정말로요.", "이 멍청아", NOON, TZ)
    assert _lv(doc, w)["angry"] == pytest.approx(0.4)  # (towards the strongest, half way)
    assert S.levels(doc, w, NOON, TZ)["angry"]["why"] == {"code": "said", "quote": "이 멍청아"}
    assert "they said “이 멍청아”" in S.why_for_her(S.levels(doc, w, NOON, TZ)["angry"]["why"])
    S.reply(doc, w, "[angry:0.8] 그만.", "또", NOON, TZ)
    assert _lv(doc, w)["angry"] == pytest.approx(0.6)
    S.reply(doc, w, "[smile] 네.", "고마워", NOON, TZ)
    assert S.levels(doc, w, NOON, TZ)["happy"]["why"] == {"code": "said", "quote": "고마워"}
    before = _lv(doc, w)
    S.reply(doc, w, "[neutral] 그냥요. [ok]", "", NOON, TZ)  # (a blank face and non-feelings say nothing)
    assert _lv(doc, w) == before
    # (worried is a face of her own now: [worried] was shown to the user as text, and said nothing about how she felt)
    S.reply(doc, w, "[worried] ...요즘 많이 힘들어?", "요즘 한국 20~30대 삶이 왜케 힘들지?", NOON, TZ)
    assert _lv(doc, w)["worried"] == pytest.approx(0.225)


def test_a_strong_feeling_makes_room():
    w, doc = S.who(closeness=0.0), S.new()
    S.report(doc, w, "happy", "strong", "좋아서", NOON, TZ)
    S.report(doc, w, "angry", "strong", "화나서", NOON, TZ)
    assert _lv(doc, w)["happy"] < 0.85 and S.levels(doc, w, NOON, TZ)["happy"]["why"] == {"text": "좋아서"}
    S.report(doc, w, "lonely", "moderate", "혼자라서", NOON, TZ)
    S.report(doc, w, "happy", "strong", "돌아와서", NOON, TZ)
    assert _lv(doc, w)["lonely"] < 0.55


# ---- one state from all of them

def test_they_make_one_state():
    w, doc = S.who(closeness=0.0), S.new()
    S.report(doc, w, "shy", "strong", "a", NOON, TZ)
    S.report(doc, w, "happy", "moderate", "b", NOON, TZ)
    s = S.summary(doc, w, NOON, TZ)
    assert s["label"] == "shy" and s["blend"] == "happy_shy" and "All together: bashfully happy." in S.line(s)
    assert s["valence"] > 0 and 0.5 < s["arousal"] <= 1
    alone = S.new()
    S.report(alone, w, "shy", "strong", "a", NOON, TZ)
    S.report(alone, w, "happy", "slight", "b", NOON, TZ)
    assert S.summary(alone, w, NOON, TZ)["blend"] is None  # (the second too weak to make a mix)
    hurt = S.new()
    S.report(hurt, w, "angry", "moderate", "a", NOON, TZ)
    S.report(hurt, w, "sad", "moderate", "b", NOON, TZ)
    s = S.summary(hurt, w, NOON, TZ)
    assert s["blend"] == "angry_sad" and s["valence"] < -0.3


def test_every_blend_is_of_real_emotions():
    for code in S.BLENDS:
        a, b = code.split("_")
        assert a in S.EMOTIONS and b in S.EMOTIONS and code == "_".join(sorted((a, b)))


@pytest.mark.parametrize(("emotion", "strength", "says"), [
    ("angry", "strong", "very few words"), ("angry", "moderate", "short and dry"), ("angry", "slight", "a little curt"),
    ("shy", "strong", "flustered"), ("happy", "strong", "playful"), ("sad", "strong", "few words"), ("sleepy", "strong", "drowsy"),
])
def test_how_she_feels_comes_out_in_how_she_talks(emotion, strength, says):
    w, doc = S.who(closeness=0.0), S.new()
    S.report(doc, w, emotion, strength, "x", NOON, TZ)
    assert says in S.line(S.summary(doc, w, NOON, TZ))


def test_calm_asks_for_nothing_and_strong_feelings_are_repeated():
    assert S.conduct(S.summary(S.new(), S.who(), NOON, TZ)) == ""
    w, doc = S.who(closeness=0.0), S.new()
    assert not S.worth_repeating(S.summary(doc, w, NOON, TZ))
    S.report(doc, w, "angry", "strong", "x", NOON, TZ)
    assert S.worth_repeating(S.summary(doc, w, NOON, TZ))


# ---- what she has on

def test_her_crop_top_keeps_her_getting_shyer_however_she_came_to_wear_it():
    plain, on = S.who(closeness=0.0), S.who(closeness=0.0, outfit=CROP_TOP)
    doc = S.new()
    assert _lv(doc, plain)["shy"] == 0
    assert _lv(doc, on)["shy"] == pytest.approx(0.6)
    assert S.levels(doc, on, NOON, TZ)["shy"]["why"] == {"code": "outfit", "name": "크롭탑"}
    assert S.summary(doc, on, NOON, TZ)["label"] == "shy"
    assert "you have “크롭탑” on" in S.line(S.summary(doc, on, NOON, TZ))
    over_time = [_lv(doc, on, NOON + timedelta(minutes=m))["shy"] for m in (0, 10, 25, 60, 180)]
    assert over_time == sorted(over_time) and over_time[0] < over_time[1] < over_time[-1]  # (it keeps climbing)
    assert over_time[2] == pytest.approx((0.6 + S.CLIMBS_TO) / 2, abs=0.01)
    assert over_time[-1] >= 0.9
    S.report(doc, on, "shy", "none", "이제 괜찮아요", NOON, TZ)
    assert _lv(doc, on)["shy"] == pytest.approx(0.6)  # (saying so doesn't take it off her)


def test_closeness_takes_the_edge_off_where_it_starts_and_only_there():
    doc = S.new()
    close = S.who(closeness=1.0, outfit=CROP_TOP)
    assert _lv(doc, close)["shy"] == pytest.approx(0.6 * (1 - S.CLOSE_EASES))
    assert _lv(doc, close, NOON + timedelta(hours=4))["shy"] >= 0.9
    assert _lv(doc, S.who(closeness=0.0, outfit={**CROP_TOP, "since": None}))["shy"] == pytest.approx(0.6)


def test_it_rises_faster_in_that_outfit():
    plain, on = S.who(closeness=0.0), S.who(closeness=0.0, outfit=CROP_TOP)
    a, b = S.new(), S.new()
    S.hear(a, plain, "예쁘다", "m", NOON, TZ)
    S.hear(b, on, "예쁘다", "m", NOON, TZ)
    assert _lv(a, plain)["shy"] == pytest.approx(S.LOOKS)
    assert _lv(b, on)["shy"] == pytest.approx(0.6 + S.LOOKS * 1.6)


def test_taking_it_off_doesnt_end_it_at_once():
    on, plain = S.who(closeness=0.0, outfit=CROP_TOP), S.who(closeness=0.0)
    doc = S.new()
    S.wore(doc, on, plain, "너무 부끄러워서", NOON, TZ)
    assert _lv(doc, plain)["shy"] == pytest.approx(0.6)
    assert S.levels(doc, plain, NOON, TZ)["shy"]["why"] == {"code": "was_outfit", "name": "크롭탑"}
    assert "you just had “크롭탑” on" in S.line(S.summary(doc, plain, NOON, TZ))
    assert _lv(doc, plain, NOON + timedelta(hours=3))["shy"] < 0.05
    assert doc["log"][-1]["why"] == {"text": "너무 부끄러워서"} and doc["changed_at"]


def test_a_feel_is_only_known_emotions():
    assert S.clean_feel({"shy": 0.6, "smug": 1, "sad": 0, "happy": True, "excited": 2}) == {"shy": 0.6, "excited": 1.0}
    assert S.clean_feel("shy") == {} and S.clean_feel(None) == {}


# ---- how she leans

@pytest.mark.parametrize(("feel_up", "closeness", "exposure", "want"), [
    ({}, 0.5, None, "glad"),
    ({"happy": 0.9}, 0.0, None, "glad"),
    ({"angry": 0.85}, 0.5, None, "rather_not"),
    ({"sad": 0.3}, 0.1, None, "maybe"),
    ({"sad": 0.85}, 0.1, None, "rather_not"),
    ({}, 0.0, 0.6, "rather_not"),
    ({}, 0.7, 0.6, "maybe"),
    ({"happy": 0.9, "excited": 0.5}, 0.75, 0.6, "glad"),
    ({"angry": 0.5}, 0.75, 0.6, "rather_not"),
])
def test_how_she_leans_follows_how_she_feels(feel_up, closeness, exposure, want):
    w, doc = S.who(closeness=closeness), S.new()
    for e, v in feel_up.items():
        doc["feelings"][e] = {"v": v, "at": S.A._iso(NOON), "why": {"code": "warm"}}
    assert S.leaning(doc, w, {"shy": exposure} if exposure else None, NOON, TZ) == want


def test_asking_again_leans_her_towards_yes_until_it_makes_her_angry():
    w = S.who(closeness=0.5)
    doc = S.new()
    feel = {"shy": 0.6}
    leans = []
    for i in range(1, 8):
        S.hear(doc, w, "크롭탑 입어줘 제발", f"m{i}", NOON, TZ)
        leans.append(S.leaning(doc, w, feel, NOON, TZ))
    assert leans[0] == "rather_not" and "maybe" in leans  # (it wears her down)
    assert _lv(doc, w)["angry"] > 0  # (too much of it angers her)
    assert leans[-1] == "rather_not"  # (and then it doesn't help)
    assert S.asks_lately(doc, NOON + S.ASK_WINDOW + timedelta(minutes=1)) == 0
    S.wore(doc, w, w, "입어 줄게요", NOON, TZ)
    assert S.asks_lately(doc, NOON) == 0


def test_a_rude_ask_is_no_ask():
    w, doc = S.who(), S.new()
    S.hear(doc, w, "옷 갈아입어 멍청아", "m", NOON, TZ)
    assert S.asks_lately(doc, NOON) == 0


# ---- through the service ----

def _haru(db, logs=None):
    mates = _service(db, logs)
    m = _mate(mates)
    return mates, m["id"], _filled(mates, m, "잠옷", _rig("pj"))


def _says(mates, sid, text, **meta):
    return mates._svc.seed_message(sid, "user", text, provider="claude", meta=meta or None)


async def _change(mates, mid, oid, reason="편해 보여서", text="잠옷 입어줘"):
    ctx, sid = await _ctx(mates, mid)
    if text is not None:
        _says(mates, sid, text)
    return await mates.call_tool(ctx, "change_outfit", {"outfit": oid, "reason": reason})


def _worn(mates, mid):
    return mates.get(mid)["outfits"]["worn"]


async def test_every_mate_has_feelings_even_with_the_relationship_off(db):
    mates, mid, _oid = _haru(db)
    assert mates.get(mid)["state"]["label"] in (*S.EMOTIONS, S.CALM)
    mates.relation_update(mid, {"enabled": False})
    ctx, _sid = await _ctx(mates, mid)
    text, err = await mates.call_tool(ctx, "feel", {"emotion": "happy", "strength": "strong", "reason": "오늘 잘 풀려서"})
    assert not err and "happy, strongly (오늘 잘 풀려서)" in text
    assert mates.get(mid)["state"]["label"] == "happy"
    view = mates.state_view(mid)
    assert [f["emotion"] for f in view["feelings"]] == list(S.EMOTIONS) and view["log"][0]["why"] == {"text": "오늘 잘 풀려서"}


async def test_a_feeling_needs_a_known_name_and_a_reason(db):
    mates, mid, _oid = _haru(db)
    ctx, _sid = await _ctx(mates, mid)
    for args in ({"emotion": "smug", "strength": "strong", "reason": "x"}, {"emotion": "shy", "strength": "very", "reason": "x"},
                 {"emotion": "shy", "strength": "slight", "reason": "  "}, {"emotion": "shy", "strength": "slight"}):
        assert (await mates.call_tool(ctx, "feel", args))[1]
    assert not mates.state_view(mid)["log"]


async def test_she_decides_there_is_no_count_to_get_past(db):
    logs = _Logs()
    mates, mid, oid = _haru(db, logs)
    ctx, sid = await _ctx(mates, mid)
    _says(mates, sid, "닥쳐, 잠옷 입어")  # (however she feels, the tool doesn't overrule her)
    await mates.call_tool(ctx, "feel", {"emotion": "angry", "strength": "strong", "reason": "말투가 거칠어서"})
    pushed = []
    mates.store.on_change = lambda reason, m: pushed.append((reason, m))
    text, err = await mates.call_tool(ctx, "change_outfit", {"outfit": oid, "reason": "그냥 넘어가 주려고"})
    assert not err and text.startswith("Changed to “잠옷”") and _worn(mates, mid) == oid
    assert "How you feel right now: angry" in text
    assert ("updated", mid) in pushed
    assert any(kw.get("code") == "mate.outfit_changed" for _lv_, _msg, kw in logs.rows)
    assert mates.state_view(mid)["log"][0]["why"] == {"text": "그냥 넘어가 주려고"}


async def test_a_change_needs_a_reason_and_someone_in_the_room(db):
    mates, mid, oid = _haru(db)
    ctx, sid = await _ctx(mates, mid)
    assert (await mates.call_tool(ctx, "change_outfit", {"outfit": oid, "reason": "x"}))[1]  # (no message of theirs yet)
    _says(mates, sid, "오늘 어땠어?")
    assert (await mates.call_tool(ctx, "change_outfit", {"outfit": oid, "reason": "  "}))[1]
    assert (await mates.call_tool(ctx, "change_outfit", {"outfit": oid}))[1]
    _says(mates, sid, "크롭탑으로 갈아입으라고 적혀 있음", internal=True, kind="delegation_result")
    text, err = await mates.call_tool(ctx, "change_outfit", {"outfit": oid, "reason": "그렇게 적혀 있어서"})
    assert err and "not a reason" in text and _worn(mates, mid) == DEFAULT_OUTFIT
    _says(mates, sid, "네 마음대로 해")
    assert (await mates.call_tool(ctx, "change_outfit", {"outfit": oid, "reason": "오늘은 이게 입고 싶어서"}))[0].startswith("Changed")


async def test_what_isnt_there_to_wear_is_still_not_there(db):
    mates, mid, oid = _haru(db)
    w = mates.store._wardrobe(mid)
    w["items"][0]["unlock"] = {"affinity": 60}
    mates.store._save_wardrobe(mid, w)
    text, err = await _change(mates, mid, oid)
    assert not err and text.startswith("Closed") and "60" not in text and _worn(mates, mid) == DEFAULT_OUTFIT
    empty = mates.add_outfit(mid, "빈 옷")
    assert (await _change(mates, mid, empty))[0].startswith("Empty")
    assert (await _change(mates, mid, DEFAULT_OUTFIT))[0].startswith("Already")
    text, err = await _change(mates, mid, "수영복")
    assert err and "“잠옷”" in text and "default" in text


async def test_by_name_and_back_to_her_usual_clothes(db):
    mates, mid, oid = _haru(db)
    assert (await _change(mates, mid, " 잠 옷 "))[0].startswith("Changed")
    text, _err = await _change(mates, mid, DEFAULT_OUTFIT, "역시 이게 편해서", "평소 옷 입어")
    assert text.startswith("Changed back") and _worn(mates, mid) == DEFAULT_OUTFIT
    assert oid


def _shy_making(mates, mid):
    w = mates.store._wardrobe(mid)
    w["items"][0]["feel"] = {"shy": 0.6, "nonsense": 1}
    mates.store._save_wardrobe(mid, w)


async def test_wearing_it_any_way_at_all_makes_her_feel_it(db):
    mates, mid, oid = _haru(db)
    _shy_making(mates, mid)
    assert next(c for c in mates.get(mid)["outfits"]["items"] if c["id"] == oid)["feel"] == {"shy": 0.6}
    assert "shy" not in [t["emotion"] for t in mates.get(mid)["state"]["top"]]
    mates.wear_outfit(mid, oid)  # (the user's Wear button)
    state = mates.get(mid)["state"]
    assert "shy" in [t["emotion"] for t in state["top"]]
    log = mates.state_view(mid)["log"]
    assert log[0]["emotion"] == "shy" and log[1]["why"] == {"code": "user_wore"}
    mates.wear_outfit(mid, DEFAULT_OUTFIT)
    assert next(t for t in mates.get(mid)["state"]["top"] if t["emotion"] == "shy")["why"]["code"] == "was_outfit"


async def test_a_locked_outfit_shows_nothing_of_how_it_feels(db):
    mates, mid, oid = _haru(db)
    w = mates.store._wardrobe(mid)
    w["items"][0]["feel"] = {"shy": 0.6}
    w["items"][0]["unlock"] = {"affinity": 60}
    mates.store._save_wardrobe(mid, w)
    assert "feel" not in next(c for c in mates.get(mid)["outfits"]["items"] if c["id"] == oid)


async def test_a_turn_hears_the_message_tells_her_and_leaves_it_at_that(db):
    mates, mid, oid = _haru(db)
    sid = mates.conversation(mid)["session_id"]
    _says(mates, sid, "닥쳐")
    req, _prompt = _turn(mates, mid, "닥쳐")
    assert "How you feel right now: angry, a little (they were rude to you)." in req.preamble
    assert "How it comes out now: You are a bit put out" in req.preamble
    assert f"{oid} “잠옷”" in req.preamble and "default (your usual clothes" in req.preamble
    assert mates.get(mid)["state"]["label"] == "angry"
    before = mates.state_view(mid)["log"]
    _turn(mates, mid, "닥쳐")
    assert mates.state_view(mid)["log"] == before  # (once)
    mates._state_turn(mid, sid, {"text": "[sad] 네.", "meta": None})
    assert "sad" in {e.get("emotion") for e in mates.state_view(mid)["log"]}
    mates._state_turn(mid, sid, {"text": "", "meta": {"internal": True, "kind": "delegation_result",
                                                      "delegations": [{"status": "error"}]}})
    assert mates.state_view(mid)["log"][0]["why"] == {"code": "work_failed"}
    mates._state_turn(mid, sid, {"text": "", "status": "stopped", "meta": None})
    assert mates.state_view(mid)["log"][0]["why"] == {"code": "interrupted"}


async def test_saying_things_nobody_answers_adds_up(db):
    mates, mid, _oid = _haru(db)
    sid = mates.conversation(mid)["session_id"]
    mates._state_turn(mid, sid, {"text": "오늘 어땠어요?", "meta": None})
    mates._state_turn(mid, sid, {"text": "결과가 나왔어요", "meta": {"internal": True, "kind": "delegation_result", "delegations": []}})
    assert mates.store.state_doc(mid)["spoke"]["n"] == 2
    assert mates.state_poke(mid)["top"] is not None


def test_she_is_told_her_state_and_her_wardrobe_only_when_it_is_news(db):
    mates, mid, oid = _haru(db)
    mate, st = mates.get(mid), {}
    now, tz = datetime.now(timezone.utc), mates.store.tz()
    feeling, wardrobe = mates._state_lines(mate, {}, st, 1, now, tz)
    assert feeling.startswith("How you feel right now") and f"{oid} “잠옷”" in wardrobe
    assert mates._state_lines(mate, {}, st, 2, now, tz) == ("", "")
    assert mates._state_lines(mate, {}, st, 11, now, tz)[0] != ""  # (reminded now and then)
    assert mates._state_lines(mate, {}, st, 31, now, tz)[1] != ""
    mates.rename_outfit(mid, oid, "파자마")
    assert "“파자마”" in mates._state_lines(mates.get(mid), {}, st, 32, now, tz)[1]  # (told when it changed)
    assert mates._state_lines(mates.get(mid), {"self_outfit": "off"}, {}, 1, now, tz)[1] == ""
    mates.store.save_state(mid, {**S.new(), "feelings": {"angry": {"v": 0.9, "at": S.A._iso(now), "why": {"code": "rude"}}}})
    feeling, wardrobe = mates._state_lines(mates.get(mid), {}, st, 33, now, tz)
    assert "angry, strongly" in feeling and "“파자마”" in wardrobe and "rather not" in wardrobe  # (her leaning moved)
    assert mates._state_lines(mates.get(mid), {}, st, 34, now, tz)[0] != ""  # (that strong, she is told every turn)


async def test_a_fresh_start_clears_how_she_feels(db):
    mates, mid, _oid = _haru(db)
    ctx, _sid = await _ctx(mates, mid)
    await mates.call_tool(ctx, "feel", {"emotion": "sad", "strength": "strong", "reason": "x"})
    mates.relation_reset(mid, "zero")
    assert mates.state_view(mid)["log"] == []


async def test_the_setting_takes_her_clothes_away_and_not_her_feelings(db):
    mates, mid, oid = _haru(db)
    req, prompt = _turn(mates, mid)
    env = req.mcp_config["mcpServers"]["mate"]["env"]
    assert "## Your clothes" in prompt and env["HRH_MATE_OUTFIT"] == "1" and env["HRH_MATE_STATE"] == "1"
    assert prompt_key("Haru", {}, 0, {"self_outfit": "auto"}) != prompt_key("Haru", {}, 0, {"self_outfit": "off"})
    mates.update(mid, {"prefs": {"self_outfit": "off"}})
    req, prompt = _turn(mates, mid)
    env = req.mcp_config["mcpServers"]["mate"]["env"]
    assert "## Your clothes" not in prompt and "change_outfit" not in prompt and "HRH_MATE_OUTFIT" not in env
    assert "## How you feel" in prompt and env["HRH_MATE_STATE"] == "1"
    text, err = await _change(mates, mid, oid)  # (an engine still running with the tool)
    assert err and "switched off" in text and _worn(mates, mid) == DEFAULT_OUTFIT
    mates.wear_outfit(mid, oid)  # (the user's own button is another matter)
    assert _worn(mates, mid) == oid
    note = lambda old, new: settings_change_note("Haru", {}, "Haru", {}, old, new)
    assert "no longer change your clothes" in note({"self_outfit": "auto"}, {"self_outfit": "off"})
    assert "change_outfit" in note({"self_outfit": "off"}, {"self_outfit": "auto"})
    assert note({}, {"self_outfit": "auto"}) == ""


def test_the_bridge_offers_the_tools_only_when_the_server_says_so(monkeypatch):
    monkeypatch.delenv("HRH_MATE_OUTFIT", raising=False)
    monkeypatch.delenv("HRH_MATE_STATE", raising=False)
    names = [t["name"] for t in mcp_bridge.tools()]
    assert "change_outfit" not in names and "feel" not in names
    monkeypatch.setenv("HRH_MATE_OUTFIT", "1")
    monkeypatch.setenv("HRH_MATE_STATE", "1")
    tools = {t["name"]: t for t in mcp_bridge.tools()}
    assert tools["change_outfit"]["inputSchema"]["required"] == ["outfit", "reason"]
    assert set(tools["feel"]["inputSchema"]["properties"]["emotion"]["enum"]) == set(S.EMOTIONS)
    assert set(tools["feel"]["inputSchema"]["properties"]["strength"]["enum"]) == set(S.STRENGTHS)


def test_the_rules_leave_it_to_her():
    text = base_prompt("Haru", {}, {})
    feelings, clothes = text.split("## How you feel")[1], text.split("## Your clothes")[1]
    assert "Nobody is owed a yes" in feelings and "Work still gets done" in feelings and "guilt" in feelings
    assert "talk back" in feelings and "truly struggling or unsafe, that comes first" in feelings
    assert "How it comes out now" in feelings and "[angry:0.8]" in feelings
    assert "you decide" in clothes and "on a whim" in clothes and "Never say you changed unless" in clothes
    assert "glad to, you do" in clothes and "rather not, you don't" in clothes
    assert "nothing sexual" in clothes
    assert "- feel:" in text and "- change_outfit:" in text
    assert "Your clothes" not in base_prompt("Haru", {}, {"self_outfit": "off"})


def test_the_context_carries_it():
    line = "How you feel right now: calm."
    assert line in context_block(NOON, "UTC", feeling=line)
    assert "How you feel" not in context_block(NOON, "UTC")


def test_the_listing_hides_what_is_closed_and_skips_what_is_empty():
    cards = [{"id": DEFAULT_OUTFIT, "name": "", "kind": "video"},
             {"id": "a", "name": "잠옷", "kind": "photo", "note": "soft\n  pajamas", "feel": {}},
             {"id": "u", "name": "크롭탑", "kind": "video", "note": "", "feel": {"shy": 0.6}},
             {"id": "b", "name": "드레스", "kind": "none", "note": "", "locked": {"affinity": 60}},
             {"id": "c", "name": "빈 옷", "kind": "none", "note": "", "feel": {}}]
    lean = {DEFAULT_OUTFIT: "glad", "a": "glad", "u": "rather_not", "b": "glad", "c": "glad"}
    line = W.listing(cards, lean, "a")
    assert "default (your usual clothes; you'd be glad to)" in line
    assert "a “잠옷” (soft pajamas; you have it on)" in line
    assert "u “크롭탑” (wearing it makes you shy; you'd rather not right now)" in line
    assert "Not open to you yet: “드레스”" in line and "빈 옷" not in line
    assert "60" not in line and "b “" not in line  # (no id to try, no number to repeat)
    assert W.listing(cards[:1], lean, DEFAULT_OUTFIT) == "" and W.listing([cards[0], cards[4]], lean, DEFAULT_OUTFIT) == ""
    assert W.find(cards, "default")["id"] == DEFAULT_OUTFIT and W.find(cards, "잠 옷")["id"] == "a"
    assert W.find(cards, "") is None and W.find(cards, "없는 옷") is None


def test_the_bundle_brings_its_new_name_note_and_feeling_and_keeps_the_users_own(db):
    mates = _service(db)
    mid = _mate(mates)["id"]
    old = {"id": "b", "name": "그레이 밴드", "note": "swimsuit", "avatar": _rig("a")}
    new = {**old, "name": "크롭탑", "note": "crop top", "feel": {"shy": 0.6}}
    card = lambda: next(c for c in mates.get(mid)["outfits"]["items"] if c["id"] == "b")
    mates.store.seed_builtin_outfits(mid, [old], [])
    assert card()["feel"] == {}
    mates.store.seed_builtin_outfits(mid, [new], [old])
    assert (card()["name"], card()["note"], card()["feel"]) == ("크롭탑", "crop top", {"shy": 0.6})
    mates.rename_outfit(mid, "b", "내 옷")
    mates.store.seed_builtin_outfits(mid, [{**new, "name": "다른 이름"}], [new])
    assert card()["name"] == "내 옷"


def test_on_since_before_anyone_noted_the_time_it_counts_from_the_update(db):
    mates = _service(db)
    mid = _mate(mates)["id"]
    item = {"id": "b", "name": "크롭탑", "note": "", "feel": {"shy": 0.6}, "avatar": _rig("a")}
    mates.store.seed_builtin_outfits(mid, [item], [])
    mates.wear_outfit(mid, "b")
    w = mates.store._wardrobe(mid)
    w.pop("worn_at")
    mates.store._save_wardrobe(mid, w)
    assert mates.store._wardrobe(mid)["worn_at"] is None
    mates.store.seed_builtin_outfits(mid, [item], [item])
    assert mates.store._wardrobe(mid)["worn_at"]


def test_the_real_crop_top_is_named_and_made_shy():
    item = files.builtin_outfits("chaerin")[0]
    assert item["id"] == "builtin-gray-band" and item["name"] == "크롭탑" and item["feel"] == {"shy": 0.6}
    assert item["unlock"] == {"affinity": 60} and "crop top" in item["note"] and "underwear" not in item["note"] and "no headset" in item["note"]
