"""The Geny-State-System's newer layers (docs/geny-state-system.md): a model's reading of a message and what it changes,
the bonds beside affinity, promises, not repeating herself, rupture and repair both ways, a temperament for every mate,
the journal and the simulator."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.mate import affinity as A
from app.mate import state as S
from app.mate.gss import appraisal as R
from app.mate.gss import echo
from app.mate.gss import episodes as E
from app.mate.gss import promises as P
from app.mate.gss import simulate as SIM
from app.mate.gss import temperament as T

TZ = timezone.utc
NOON = datetime(2026, 11, 16, 12, 0, tzinfo=TZ)


def reading(**kw):
    base = {"aimed_at_her": True, "acts": [], "intensity": 0.5, "owns_it": False, "sarcastic": False, "promise": None,
            "her_promise": None, "fulfills": [], "note": ""}
    import json
    return R.parse(json.dumps({**base, **kw}))


# ---- reading a message ----

def test_a_reading_is_parsed_clean_and_means_what_the_words_cues_mean():
    assert R.parse("no json here") is None
    r = R.parse('Sure: {"aimed_at_her": true, "acts": ["insult", "nonsense"], "intensity": 3, "sarcastic": true}')
    assert r["acts"] == ["insult"] and r["intensity"] == 1.0 and r["by"] == "model"
    c = R.cues(r)
    assert c["rude"] and not c["hostile"] and not c["warm"]
    assert R.cues(reading(acts=["threat"], intensity=0.8))["hostile"] == "threat"
    assert R.cues(reading(acts=["threat"], aimed_at_her=False))["hostile"] is None  # (a monster in a game)
    sorry = R.cues(reading(acts=["apology"], owns_it=True, aimed_at_her=False))
    assert sorry["apology"] and sorry["owned"]


def test_sarcasm_the_words_miss_lands_and_venting_they_took_for_an_insult_doesnt():
    w = S.who(name="한채린")
    # (sarcasm: no rude word in it)
    words, model = S.new(), S.new()
    S.hear(words, w, "와 진짜 대단하시네요 ㅎㅎ", "a", NOON, TZ)
    S.hear(model, w, "와 진짜 대단하시네요 ㅎㅎ", "a", NOON, TZ, reading(acts=["insult"], sarcastic=True, intensity=0.6))
    assert S.levels(words, w, NOON, TZ)["angry"]["v"] == 0 < S.levels(model, w, NOON, TZ)["angry"]["v"]
    # (venting about a boss isn't aimed at her even by the words; teasing the words took for an insult: read later, set right)
    vent = S.new()
    S.hear(vent, w, "팀장 진짜 병신같아", "v", NOON, TZ)
    assert S.levels(vent, w, NOON, TZ)["angry"]["v"] == 0
    doc, w = S.new(), S.who(name="한채린", closeness=0.0)  # (strangers: the words take it at face value)
    S.hear(doc, w, "너 진짜 멍청하다 ㅋㅋㅋ", "b", NOON, TZ)
    assert S.levels(doc, w, NOON, TZ)["angry"]["v"] > 0 and doc["heard_by"] == "words"
    S.report(doc, w, "sad", "moderate", "my own reason", NOON, TZ)  # (something of hers in between: it stays)
    assert S.reappraise(doc, w, "너 진짜 멍청하다 ㅋㅋㅋ", "b", reading(acts=["teasing"], intensity=0.2), NOON, TZ)
    assert S.levels(doc, w, NOON, TZ)["angry"]["v"] == 0 and doc["heard_by"] == "model"
    assert S.levels(doc, w, NOON, TZ)["sad"]["v"] == pytest.approx(S.STRENGTHS["moderate"], abs=0.02)
    assert not S.reappraise(doc, w, "너 진짜 멍청하다 ㅋㅋㅋ", "b", reading(acts=["teasing"]), NOON, TZ)


def test_the_relationship_counts_by_the_reading_too():
    r, s = A.new(), A.new()
    for x in (r, s):
        A.credit_turn(x, NOON, TZ, "hi")
        A.set_value(x, 50, NOON, TZ)
    A.credit_turn(r, NOON + timedelta(minutes=1), TZ, "와 진짜 대단하시네요", "", "", reading(acts=["insult"], sarcastic=True))
    A.credit_turn(s, NOON + timedelta(minutes=1), TZ, "와 진짜 대단하시네요", "")
    assert r["affinity"] < s["affinity"] == 50


def test_worth_a_look_spares_small_talk_on_the_slow_way():
    assert not R.worth_a_look("ㅇㅇ 밥 먹었어", {}, False)
    assert R.worth_a_look("이따 전화할게", {}, False) and R.worth_a_look("ㅇㅇ", {}, True)
    assert R.worth_a_look("whatever", {}, False) and R.worth_a_look("x", {"rude": True}, False)


# ---- the bonds ----

def test_trust_grows_with_days_and_falls_hard_when_she_is_hurt():
    r = A.new()
    for d in range(10):
        A.advance(r, NOON + timedelta(days=d), TZ)
        A.credit_turn(r, NOON + timedelta(days=d), TZ, "hi")
    assert r["trust"] == pytest.approx(A.BONDS["trust"] + 10 * A.TRUST_DAY)
    before = dict(trust=r["trust"], respect=r["respect"])
    A.credit_turn(r, NOON + timedelta(days=9, hours=1), TZ, "(때린다)")
    assert r["trust"] == pytest.approx(before["trust"] - A.TRUST_HURT["violence"])
    assert r["respect"] < before["respect"]
    assert any(e["bond"] == "trust" and e["why"] == "hostile_violence" for e in r["bonds_log"])


def test_romance_grows_only_on_trust_and_closeness():
    r = A.new()
    A.credit_turn(r, NOON, TZ, "사랑해", "[shy] 헤헤")
    assert r["romance"] == 0  # (strangers: nothing romantic grows, however often it is said)
    A.set_value(r, 60, NOON, TZ)
    r["trust"] = 60.0
    A.credit_turn(r, NOON + timedelta(minutes=1), TZ, "사랑해", "[shy] 헤헤")
    assert r["romance"] == pytest.approx(A.ROMANCE_ANSWERED)
    for k in range(5):
        A.credit_turn(r, NOON + timedelta(minutes=2 + k), TZ, "사랑해", "[shy] 헤헤")
    assert r["romance"] == pytest.approx(A.ROMANCE_CAP)  # (a day's at most)
    assert A.bond_words(r)["romance"] == "none" and A.bond_words({**r, "romance": 60})["romance"] == "mutual"


def test_promises_and_making_up_move_trust_and_a_recount_keeps_them():
    r = A.new()
    A.credit_turn(r, NOON, TZ, "hi")
    t0 = r["trust"]
    A.cost(r, "promise_kept", NOON + timedelta(hours=1), TZ)
    A.cost(r, "promise_broken", NOON + timedelta(hours=2), TZ)
    A.cost(r, "made_up", NOON + timedelta(hours=3), TZ)
    assert r["trust"] == pytest.approx(t0 + 1.5 - 3 + 2)
    events = [(NOON, "turn", ("hi", ""))] + [(A._t(c["at"]), "cost", c["code"]) for c in r["costs"]]
    again = A.replay(events, NOON + timedelta(hours=4), TZ)
    assert again["trust"] == pytest.approx(r["trust"])


# ---- promises ----

def test_a_promise_to_be_in_touch_is_kept_by_their_word_in_time_and_broken_by_one_too_late():
    doc = S.new()
    p = P.add(doc, "user", "이따 밤에 전화할게", "contact", NOON, 6)
    assert p and P.add(doc, "user", "이따 밤에 전화할게", "contact", NOON, 6) is None  # (the same, while it is open)
    assert P.heard_from_them(doc, NOON + timedelta(minutes=10)) == []  # (a word right after isn't keeping it)
    assert [x["status"] for x in P.heard_from_them(doc, NOON + timedelta(hours=3))] == ["kept"]
    late = S.new()
    P.add(late, "user", "내일 또 올게", "contact", NOON, 24)
    assert [x["status"] for x in P.heard_from_them(late, NOON + timedelta(days=3))] == ["broken"]


def test_other_promises_are_kept_by_doing_it_and_she_is_told_when_overdue():
    doc = S.new()
    p = P.add(doc, "user", "파일 보내줄게", "task", NOON, 2)
    assert P.tick(doc, NOON + timedelta(hours=3)) == []
    assert [x["status"] for x in P.tick(doc, NOON + timedelta(hours=5))] == ["overdue"]
    told = P.lines(doc, NOON + timedelta(hours=5))
    assert told and "파일 보내줄게" in told[0] and P.lines(doc, NOON + timedelta(hours=5)) == []  # (told once)
    assert [x["status"] for x in P.fulfil(doc, [p["id"]], NOON + timedelta(hours=6))] == ["kept"]
    her = S.new()
    P.add(her, "her", "끊고 바로 볼게", "task", NOON, 0.5)
    assert "You promised them" in P.lines(her, NOON + timedelta(minutes=40))[0]


def test_a_broken_promise_stings_and_stays_a_little():
    w, doc = S.who(name="한채린"), S.new()
    S.broken_promise(doc, w, "내일 또 올게", NOON, TZ)
    assert S.grudge(doc, w, NOON) > 0 and "didn't do what they promised" in S.why_for_her(doc["grudge"]["why"])


# ---- not repeating herself ----

def test_what_she_said_twice_she_is_told_not_to_say_again():
    doc = S.new()
    echo.note(doc, "(채린이 레이드 화면에서 잠깐 손을 멈추고, 굳은 표정으로 답장을 보낸다.) [angry] 그런 말은 다시 하지 마세요.")
    assert echo.repeats(doc) == []
    echo.note(doc, "(채린이 레이드 화면에서 잠깐 손을 멈추고, 굳은 표정으로 답장을 보낸다.) 그 말은 고마워요. 그런 말은 다시 하지 마세요.")
    rep = echo.repeats(doc)
    assert rep[0].startswith("채린이 레이드 화면에서") and "그런 말은 다시 하지 마세요." in rep
    assert "say something new" in echo.line(doc)


# ---- repair, both ways ----

def test_a_hurt_owned_and_passed_is_made_up_once():
    w, doc = S.who(name="한채린"), S.new()
    S.hear(doc, w, "(한채린을 때린다)", "a", NOON, TZ)
    S.hear(doc, w, "내가 잘못했어, 다시는 안 그럴게", "b", NOON + timedelta(minutes=30), TZ)
    assert S.made_up(doc, w, NOON + timedelta(hours=1)) is None  # (not passed yet)
    m = S.made_up(doc, w, NOON + timedelta(days=3))
    assert m and m["why"]["code"] == "hostile" and S.made_up(doc, w, NOON + timedelta(days=4)) is None
    bare = S.new()
    S.hear(bare, w, "(한채린을 때린다)", "a", NOON, TZ)
    S.hear(bare, w, "미안", "b", NOON + timedelta(minutes=30), TZ)
    assert S.made_up(bare, w, NOON + timedelta(days=5)) is None  # (it passed, but they never owned it)


def test_an_apology_right_after_something_done_to_her_lands_less():
    w = S.who(name="한채린")

    def left(minutes):
        doc = S.new()
        S.hear(doc, w, "(한채린을 때린다)", "a", NOON, TZ)
        at = NOON + timedelta(minutes=minutes)
        before = S.grudge(doc, w, at)
        S.hear(doc, w, "내가 잘못했어", "b", at, TZ)
        return S.grudge(doc, w, at) / before

    assert left(5) > left(40)


def test_she_owns_snapping_at_them_when_it_was_her_day():
    w = S.who(life={"needs": {"hunger": 1.0}, "feel": {}, "doing": "", "asleep": False}, name="한채린")
    doc = S.new()
    S.hear(doc, w, "뭐해?", "a", NOON, TZ)
    S.reply(doc, w, "[angry:0.7] 아 몰라요, 배고파 죽겠어요.", "뭐해?", NOON, TZ)
    assert doc["unfair"]["code"] == "hungry"
    fed = S.who(name="한채린")
    assert S.unfair_line(doc, fed, NOON + timedelta(minutes=10), TZ) == ""  # (too soon)
    assert S.unfair_line(doc, fed, NOON + timedelta(hours=1), TZ) == ""  # (still cross from it)
    line = S.unfair_line(doc, fed, NOON + timedelta(hours=3), TZ)
    assert "because you were hungry" in line and S.unfair_line(doc, fed, NOON + timedelta(hours=4), TZ) == ""


# ---- temperament ----

def test_a_temperament_is_cleaned_merged_and_changes_how_she_fights_and_holds_on():
    t = T.clean({"forgives": 9, "conflict": "shout", "attachment": "anxious", "rise": {"angry": 1.5, "joy": 2}, "loves": ["게임", 3]})
    assert t == {"forgives": 1.6, "attachment": "anxious", "rise": {"angry": 1.5}, "loves": ["게임"]}
    m = T.merged(S.TEMPERAMENTS["chaerin"], {"forgives": 1.2, "rise": {"angry": 1.4}})
    assert m["forgives"] == 1.2 and m["rise"] == {"shy": 1.2, "excited": 1.3, "angry": 1.4} and "게임" in m["loves"]
    # (how she fights: said first, the other way still hers)
    for style, word in (("confront", "say it to their face"), ("withdraw", "go quiet")):
        w, doc = S.who(name="X", temperament={"conflict": style}), S.new()
        for i in range(3):
            S.hear(doc, w, "(X를 때린다)", f"m{i}", NOON, TZ)
        assert word in S.line(S.summary(doc, w, NOON, TZ))
    # (anxious: being left unanswered gets to her sooner)
    calm, anxious = S.who(), S.who(temperament={"attachment": "anxious"})
    doc = S.new()
    for _ in range(3):
        S.spoke(doc, "저기요", NOON)
    later = NOON + timedelta(hours=2)
    assert S.levels(doc, anxious, later, TZ)["lonely"]["v"] > S.levels(doc, calm, later, TZ)["lonely"]["v"]


# ---- episodes, the simulator ----

def test_moments_between_them_are_remembered_in_her_words():
    ko = E.text("hurt", {"kind": "threat", "quote": "죽여버린다"}, NOON, "ko", "장하렴")
    assert ko.startswith("[우리 사이] 11월 16일, 장하렴이 나를 위협했다")
    assert "they threatened me" in E.text("hurt", {"kind": "threat"}, NOON, "en")
    assert E.pattern_line(1) == "" and "3 times" in E.pattern_line(3)


def test_the_simulator_runs_the_same_engine_and_the_same_script_gives_the_same_curves():
    w = S.who(builtin="chaerin", name="한채린")
    a = SIM.run(w, SIM.PRESETS["threat_sorry_love"])
    assert a == SIM.run(w, SIM.PRESETS["threat_sorry_love"])
    pts = a["points"]
    assert pts[0]["grudge"] > 0 and pts[-1]["grudge"] < pts[0]["grudge"] and pts[-1]["label"] == "+48 h"
    assert pts[2]["feelings"]["angry"] > pts[1]["feelings"]["angry"]  # ("사랑해" over it, with no apology that owns it)
    seoa = SIM.run(S.who(builtin="seoa", name="서아"), SIM.PRESETS["threat_sorry_love"])["points"]
    assert seoa[-2]["grudge"] < pts[-2]["grudge"]  # (a day on: 서아 has let go more)


def test_a_judgement_is_parsed_clean_and_exchanges_are_hers_to_them():
    from app.mate.gss import evaluate as EV

    assert EV.parse("nothing") is None
    r = EV.parse('{"scores": {"persona": 4, "variety": 9, "address": "x"}, "findings": [{"turn": 2, "criterion": "address", '
                 '"quote": "자기야는 뭐 했어?", "issue": "a particle on the calling form"}], "summary": "ok"}')
    assert r["scores"]["variety"] == 5 and r["scores"]["address"] == 5 and r["scores"]["limits"] == 5
    assert r["findings"][0]["criterion"] == "address" and 1 <= r["overall"] <= 5
    system, user = EV.request("서아", {"description": "a streamer"}, {"user_name": "장하렴", "address": "자기야"},
                              [{"user": "미안", "her": "[angry] 흥.", "refused": False}])
    assert "calls them: 자기야" in system and "[1] 서아: 흥." in user


def test_reading_again_never_owes_twice_and_one_fight_is_one_memory():
    w, doc = S.who(name="한채린"), S.new()
    for _ in range(3):
        S.spoke(doc, "저기요", NOON)
    later = NOON + timedelta(hours=3)
    S.hear(doc, w, "됐어", "m1", later, TZ)
    assert [e["code"] for e in S.take_owed(doc)] == ["ignored"]  # (counted when she heard it)
    S.reappraise(doc, w, "됐어", "m1", reading(acts=["venting"], aimed_at_her=False), later, TZ)
    assert [e["code"] for e in S.take_owed(doc)] == []  # (not again)
    fight = S.new()
    S.hear(fight, w, "(한채린을 때린다)", "a", NOON, TZ)
    fight["grudge"]["remembered"] = True
    S.hear(fight, w, "(한채린을 또 때린다)", "b", NOON + timedelta(minutes=5), TZ)
    assert fight["grudge"].get("remembered")  # (the same stretch: already remembered)
    S.hear(fight, w, "(한채린을 때린다)", "c", NOON + timedelta(days=2), TZ)
    assert not fight["grudge"].get("remembered")  # (another day, another fight)
