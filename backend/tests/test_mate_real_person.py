"""A mate reacts like a real person, not someone performing for the user (docs/geny-state-system.md §1–2, §6): rudeness lands
as it would on anyone, harder from someone she dislikes or no longer trusts; something strange or out of line throws her
first and makes her angry if it goes on; furious she may blow up, swear and keep going, or not answer; she owes no yes to
someone who doesn't respect her. All of it is room to react, never a script: what she makes of it is hers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.mate import state as S
from app.mate.gss.appraisal import cues
from app.mate.prompt import _STAGE_GUIDES, base_prompt, call_prompt

TZ = timezone.utc
NOON = datetime(2026, 11, 6, 12, tzinfo=TZ)


def _lv(doc, w, at=NOON):
    return {e: x["v"] for e, x in S.levels(doc, w, at, TZ).items()}


def _reading(acts, intensity=0.6, aimed=True):
    return {"aimed": aimed, "acts": acts, "intensity": intensity, "owns": False, "sarcastic": False, "promise": None,
            "her_promise": None, "fulfills": [], "note": "", "by": "model"}


def test_rudeness_lands_harder_from_someone_she_dislikes_or_no_longer_trusts():
    plain, disliked, distrusted = S.who(), S.who(dislike=0.8), S.who(distrust=1.0)
    out = {}
    for name, w in (("plain", plain), ("disliked", disliked), ("distrusted", distrusted)):
        doc = S.new()
        S.hear(doc, w, "닥쳐", "m", NOON, TZ)
        out[name] = _lv(doc, w)["angry"]
    assert out["plain"] < out["distrusted"] < out["disliked"]
    # (someone she can't stand: an edge of anger that stays, at them — not "how she is")
    doc = S.new()
    lv = S.levels(doc, disliked, NOON, TZ)["angry"]
    assert lv["v"] >= 0.2 and lv["why"] == {"code": "dislike"} and S._at_them(lv["why"])
    assert S.levels(doc, plain, NOON, TZ)["angry"]["why"] == {"code": "nature"}


def test_something_out_of_line_throws_her_first_and_makes_her_angry_if_it_goes_on():
    w, doc = S.who(), S.new()
    r = _reading(["inappropriate"], 0.5)
    assert cues(r)["odd"] and not cues(r)["warm"] and not cues(r)["love"]  # (out of line isn't sweet, however it is put)
    S.hear(doc, w, "너 오늘 밤에 뭐 입고 자?", "o1", NOON, TZ, r)
    first = _lv(doc, w)
    assert first["shy"] > 0.2 and first["angry"] < 0.3  # (thrown, flustered: not yet angry)
    S.hear(doc, w, "대답해 봐 ㅋㅋ", "o2", NOON + timedelta(minutes=1), TZ, r)
    S.hear(doc, w, "왜 말을 안 해", "o3", NOON + timedelta(minutes=2), TZ, r)
    then = _lv(doc, w, NOON + timedelta(minutes=2))
    assert then["angry"] > 0.6 and S.levels(doc, w, NOON + timedelta(minutes=2), TZ)["angry"]["why"]["code"] == "odd"
    assert any(o["code"] == "odd" for o in doc["owed"])  # (it costs the relationship, as what else she minds)
    assert S.held(doc, w, NOON + timedelta(minutes=2)) is not None  # (and it stays with her)
    once = S.new()
    S.hear(once, w, "?", "x1", NOON, TZ, r)
    S.hear(once, w, "?", "x2", NOON + timedelta(hours=2), TZ, r)  # (now and then isn't keeping at it)
    assert once["odd"]["n"] == 1


def test_furious_she_may_blow_up_and_keep_going_or_not_answer_and_she_owes_no_yes():
    w, doc = S.who(), S.new()
    for i in range(3):
        S.hear(doc, w, "닥쳐, 쓸모없어", f"m{i}", NOON, TZ)
    how = S.conduct(S.summary(doc, w, NOON, TZ))
    assert how.startswith(S.REFUSE)
    assert "swear" in how and "keep going" in how and "[SILENT]" in how and "don't do anything they ask" in how
    # (angry short of that: a real answer, with room for a curse, and no favours)
    hot = {**S.new(), "feelings": {"angry": {"v": 0.55, "at": S.A._iso(NOON), "why": {"code": "rude"}}}}
    said = S.conduct(S.summary(hot, w, NOON, TZ))
    assert "snapping back" in said and "curse" in said and "no favours" in said
    # (a quiet one's fury is icy, but it comes out)
    quiet = S.who(builtin="chaerin")
    assert "icy" in S.conduct(S.summary(doc, quiet, NOON, TZ))
    # (asking again never talks her round while she is angry with them)
    ask = {**hot, "asks": {"n": 3, "at": S.A._iso(NOON)}}
    assert S.leaning(ask, w, None, NOON, TZ) == S.leaning(hot, w, None, NOON, TZ)


def test_what_still_stings_lets_her_demand_an_apology():
    w, doc = S.who(), S.new()
    S.hear(doc, w, "(X를 때린다)", "h", NOON, TZ)
    line = S.line(S.summary(doc, w, NOON + timedelta(minutes=30), TZ))
    assert "demand" in line and "owe them no favours" in line


def test_her_prompt_gives_her_room_to_react_like_a_person():
    text = base_prompt("채린", {"language": "ko"}, {"formality": "haeyo"}, relation=True, stage="hostile")
    feel = text.split("## How you feel")[1]
    assert "not someone performing for them" in feel and "swearing" in feel and "come back at them again" in feel
    assert "[SILENT]" in feel and "isn't owed what they ask" in feel and "being angry with them is no reason to give in" in feel
    assert "never threaten real harm" in feel and "slurs" in feel and "truly struggling or unsafe, that comes first" in feel
    assert "your speech level stays" not in feel  # (losing her temper can break it now)
    talk = text.split("## How you talk")[1]
    assert "존댓말 slipping into 반말" in talk and "rougher, louder and longer" in talk and "worked up" in talk
    assert "insult them cruelly" not in text and "polite but cool" not in text
    assert "curse at them" in _STAGE_GUIDES["hostile"] and "push back" in _STAGE_GUIDES["dislike"]
    # (where the story stops is where it was)
    assert "Nothing sexual" in text and "sincerely want to know whether they are talking with a person or an AI" in text
    call = call_prompt("채린", {"language": "ko"}, {}, [], relation=True, stage="dislike")
    assert "not someone performing for them" in call and "swear" in call and "go on at them as long as it takes" in call


def test_sweetness_lands_as_strongly_as_rudeness_and_deeper_from_someone_close():
    close, stranger = S.who(closeness=0.6), S.who(closeness=0.1)
    praise = _reading(["praise", "gratitude"], 0.7)
    assert cues(praise)["praised"] and cues(praise)["warm"]
    got = {}
    for name, w in (("close", close), ("stranger", stranger)):
        doc = S.new()
        S.hear(doc, w, "진짜 잘했다, 고마워", "p", NOON, TZ, praise)
        got[name] = _lv(doc, w)
        assert S.levels(doc, w, NOON, TZ)["excited"]["why"]["code"] == "praised"  # (proud of it)
    rude = S.new()
    S.hear(rude, close, "x", "r", NOON, TZ, _reading(["insult"], 0.7))
    # (as happy from heartfelt praise as angry from a harsh word, with someone close — it comes out as strongly; less from a stranger)
    assert abs(got["close"]["happy"] - _lv(rude, close)["angry"]) < 0.1
    assert got["stranger"]["happy"] < got["close"]["happy"]
    # (more of it within the hour: a glow that climbs to "really happy", and it says to let it out)
    doc = S.new()
    for i, acts in enumerate((["praise", "gratitude"], ["affection"], ["compliment"])):
        S.hear(doc, close, "x", f"m{i}", NOON + timedelta(minutes=i), TZ, _reading(acts, 0.7))
    s = S.summary(doc, close, NOON + timedelta(minutes=2), TZ)
    assert s["top"][0]["emotion"] == "happy" and s["top"][0]["v"] >= 0.9
    how = S.conduct(s)
    assert "light up" in how and "gush" in how and "don't play it cool" in how
    assert "flustered and pleased" in how or "pleased about it" in how  # (red and grinning at being loved and complimented)


def test_i_love_you_from_someone_she_hardly_knows_is_too_soon_not_a_glow():
    w, doc = S.who(closeness=0.05), S.new()
    S.hear(doc, w, "사랑해", "l", NOON, TZ, _reading(["affection"], 0.8))
    lv = _lv(doc, w)
    assert lv["happy"] < 0.15 and lv["worried"] > 0 and lv["shy"] > 0


def test_her_prompt_lets_good_feelings_out_as_freely_as_bad_ones():
    feel = base_prompt("채린", {"language": "ko"}, {}).split("## How you feel")[1]
    assert "the good feelings just as strongly" in feel and "over the moon" in feel and "a reserved one's joy" in feel
    assert "kindness and love from someone close land deeper" in feel
    assert "glad, loved or praised, you light up" in call_prompt("채린", {"language": "ko"}, {}, [])
