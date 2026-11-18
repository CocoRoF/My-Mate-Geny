"""Little games with her (app/mate/games.py, docs/mate-games.md): the rules, whose turn it is, the score and her secrets are kept
by the app; she plays as herself, the user by talking (or with buttons for 가위바위보)."""

from __future__ import annotations

import random
from datetime import datetime, timezone

import pytest

from app.mate import games as GM

NOW = datetime(2026, 11, 21, 15, tzinfo=timezone.utc)


def test_the_head_of_a_word_follows_the_initial_sound_rule():
    assert GM.heads("과") == ["과"]
    assert GM.heads("력") == ["력", "역"] and GM.heads("리") == ["리", "이"] and GM.heads("녀") == ["녀", "여"]
    assert GM.heads("락") == ["락", "낙"] and GM.heads("료") == ["료", "요"]
    assert GM.chosung("떡볶이") == "ㄸㅂㅇ" and GM.chosung("사과") == "ㅅㄱ"
    assert GM.clean_word(" “사과!” ㅋㅋ") == "사과"


def test_word_chain_she_opens_they_answer_and_the_rules_hold():
    doc = GM.start("wordchain", "ko", NOW)
    assert doc["turn"] == "mate" and "you open with any word" in GM.told(doc)
    assert "Played “기차”" in GM.act(doc, "move", {"word": "기차"}, NOW)
    with pytest.raises(ValueError, match="their turn"):
        GM.act(doc, "move", {"word": "차표"}, NOW)
    assert GM.heard(doc, "기차 다음은 뭐로 할까?", "m0", NOW) is None, "a sentence is talk, not a word"
    bad = GM.heard(doc, "사과", "m1", NOW)
    assert bad["what"] == "user_word_bad" and "starting with 차" in bad["why"] and doc["turn"] == "user"
    assert GM.heard(doc, "차표", "m1", NOW) is None, "once per message"
    assert GM.heard(doc, "차표", "m2", NOW)["what"] == "user_word" and doc["turn"] == "mate"
    with pytest.raises(ValueError, match="starting with 표"):
        GM.act(doc, "move", {"word": "사과"}, NOW)
    GM.act(doc, "move", {"word": "표류"}, NOW)
    assert GM.next_heads(doc) == ["류", "유"]
    assert GM.heard(doc, "유리", "m3", NOW)["what"] == "user_word", "두음법칙"
    assert "Rejected" in GM.act(doc, "reject", {"reason": "없는 말"}, NOW) and doc["turn"] == "user"
    assert GM.heard(doc, "졌어", "m4", NOW)["what"] == "user_gave_up"
    assert doc["status"] == "done" and doc["result"] == "mate" and "you won" in GM.told(doc)


def test_word_chain_no_word_twice():
    doc = GM.start("wordchain", "ko", NOW)
    GM.act(doc, "move", {"word": "기차"}, NOW)
    GM.heard(doc, "차기", "m1", NOW)
    with pytest.raises(ValueError, match="nobody has said"):
        GM.act(doc, "move", {"word": "기차"}, NOW)
    assert "they win" in GM.act(doc, "give_up", {}, NOW) and doc["result"] == "user"


def test_twenty_questions_her_secret_is_fixed_and_hidden_until_the_end():
    doc = GM.start("twenty", "ko", NOW)
    assert GM.heard(doc, "동물이야?", "m1", NOW) is None, "nothing to ask about yet"
    GM.act(doc, "secret", {"answer": "펭귄", "category": "동물"}, NOW)
    with pytest.raises(ValueError, match="can't change"):
        GM.act(doc, "secret", {"answer": "고양이"}, NOW)
    assert GM.heard(doc, "날 수 있어?", "m2", NOW)["what"] == "question" and doc["asked"] == 1
    assert "“펭귄”" in GM.told(doc) and "truthfully" in GM.told(doc)
    view = GM.view(doc, [])["game"]
    assert view["answer"] == "" and view["category"] == "동물" and "펭귄" not in str(view)
    assert GM.heard(doc, "혹시 펭귄?", "m3", NOW)["what"] == "user_guessed"
    assert doc["result"] == "user" and GM.view(doc, [])["game"]["answer"] == "펭귄"


def test_twenty_questions_runs_out():
    doc = GM.start("twenty", "ko", NOW)
    GM.act(doc, "secret", {"answer": "우산", "category": "물건"}, NOW)
    for i in range(GM.TWENTY_MAX):
        last = GM.heard(doc, f"질문 {i}", f"m{i}", NOW)
    assert last["what"] == "twenty_out" and doc["result"] == "mate"


def test_the_initials_quiz_five_rounds_with_hints_and_passes():
    doc = GM.start("chosung", "ko", NOW)
    with pytest.raises(ValueError, match="Hangul"):
        GM.act(doc, "secret", {"answer": "apple"}, NOW)
    for r in range(GM.CHOSUNG_ROUNDS):
        GM.act(doc, "secret", {"answer": ["떡볶이", "사과", "고양이", "바다", "기차"][r]}, NOW)
        assert GM.view(doc, [])["game"]["initials"]
        if r == 0:
            for i in range(GM.CHOSUNG_HINT_AFTER):
                GM.heard(doc, "떡국", f"w{i}", NOW)
            assert "Give them a hint" in GM.told(doc)
            GM.act(doc, "hint", {"text": "매운 음식"}, NOW)
            assert GM.view(doc, [])["game"]["hint"] == "매운 음식"
            assert GM.heard(doc, "떡볶이!", "right", NOW)["what"] == "user_correct"
        elif r == 1:
            assert GM.give_up_user(doc, NOW)["what"] == "user_passed"
        else:
            GM.heard(doc, ["", "", "고양이", "바다", "기차"][r], f"r{r}", NOW)
    assert doc["status"] == "done" and doc["score"] == {"user": 4, "mate": 1} and doc["result"] == "user"
    with pytest.raises(ValueError, match="Korean"):
        GM.start("chosung", "en", NOW)


def test_rock_paper_scissors_first_to_three():
    doc = GM.start("rps", "ko", NOW)
    rng = random.Random(7)
    while doc["status"] == "on":
        GM.throw(doc, "rock", rng, NOW)
    assert max(doc["score"].values()) == GM.RPS_TO and doc["result"] in ("user", "mate")
    with pytest.raises(ValueError):
        GM.throw(doc, "rock", rng, NOW)
    assert GM.view(doc, [{"game": "rps", "result": doc["result"]}])["record"]["rps"][doc["result"]] == 1


async def test_she_plays_it_through_the_service(db, tmp_path, monkeypatch):
    from tests.test_mate_life_service import _mate, _service

    _, store, mates = _service(db, monkeypatch, tmp_path)
    mate = store.get(_mate(store, "chaerin")["id"])
    text = await mates._tool_play_game(mate, "sid", {"action": "start", "game": "wordchain"})
    assert text.startswith("Started.") and "Your move" in text
    assert "Played" in await mates._tool_play_game(mate, "sid", {"action": "move", "word": "사과"})
    monkeypatch.setattr(mates, "_users_latest", lambda sid: {"id": "u1", "content": "과자"})
    line, told = mates._game_lines(mate["id"], "sid")
    assert "과자" in line and "starting with 자" in line
    view = mates.game_view(mate["id"])
    assert [w["w"] for w in view["game"]["words"]] == ["사과", "과자"] and "chosung" in view["games"]
    await mates._tool_play_game(mate, "sid", {"action": "give_up"})
    view = mates.game_view(mate["id"])
    assert view["game"]["result"] == "user" and view["record"]["wordchain"]["user"] == 1
    assert store.relation_doc(mate["id"])["played"], "a game played to the end counts for them"
    assert mates.game_close(mate["id"])["game"] is None
