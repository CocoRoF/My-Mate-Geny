"""How the mate calls the user: Korean particles follow the name's last sound (app/mate/josa.py, prompt.address_line)."""

from __future__ import annotations

import pytest

from app.mate.josa import address_forms, final_sound, josa, particle
from app.mate.prompt import address_line, prompt_key, system_prompt


@pytest.mark.parametrize("word,p,expected", [
    ("하렴", "아", "하렴아"), ("지수", "아", "지수야"), ("현석", "이", "현석이"), ("지수", "이", "지수가"),
    ("하렴", "은", "하렴은"), ("지수", "는", "지수는"), ("하렴", "를", "하렴을"), ("지수", "을", "지수를"),
    ("서울", "(으)로", "서울로"), ("부산", "(으)로", "부산으로"), ("학교", "으로", "학교로"),
    ("Sam", "이", "Sam이"), ("Kai", "이", "Kai가"), ("Bill", "(으)로", "Bill로"), ("3", "은", "3은"), ("2", "은", "2는"),
    ("하렴~", "아", "하렴~아"), ("“하렴”", "이", "“하렴”이"),
])
def test_josa(word, p, expected):
    assert josa(word, p) == expected


def test_unknown_sound_falls_back_to_the_written_pair():
    assert final_sound("さくら") is None and particle("さくら", "이") == "이(가)"


def test_casual_forms_add_the_friendly_i_after_a_final_consonant():
    assert address_forms("하렴", casual=True) == {"subject": "하렴이가", "topic": "하렴이는", "object": "하렴이를",
                                                 "with": "하렴이랑", "call": "하렴아"}
    assert address_forms("지수", casual=True)["call"] == "지수야"
    assert address_forms("지수", casual=True)["subject"] == "지수가"


def test_the_prompt_carries_only_the_name_no_grammar_notes():
    """The user's decision: the settings' name (and how to call them) is all the mate gets — no particle lists,
    no grammar rules; the model uses a Korean name naturally."""
    sp = system_prompt("한채린", {"address": "하렴", "language": "ko"}, [], {"user_name": "장하렴", "formality": "banmal"})
    assert "Call the user “하렴”." in sp and "The user's name is 장하렴." in sp
    for grammar in ("하렴아", "하렴이가", "하렴이는", "particle", "calling form", "call out"):
        assert grammar not in sp, grammar
    assert address_line("주인님") == "Call the user “주인님”."
    assert prompt_key("한채린", {"address": "하렴"}, 0) != prompt_key("한채린", {"address": "지수"}, 0)
