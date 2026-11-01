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


@pytest.mark.parametrize("address,must,must_not", [
    ("하렴", ["“하렴아”", "하렴이가", "하렴이는", "“하렴 님”", "하렴 님이"], ["하렴야", "하렴가"]),
    ("지수", ["“지수야”", "지수가", "지수를", "지수 님은"], ["지수아", "지수이가"]),
    ("주인님", ["주인님이", "주인님은", "주인님을"], ["주인님아", "반말"]),
    ("선배", ["선배가", "선배는"], ["선배야"]),
])
def test_address_line_korean(address, must, must_not):
    line = address_line(address, korean=True)
    assert line.startswith(f"Call the user “{address}”")
    for m in must:
        assert m in line, (m, line)
    for m in must_not:
        assert m not in line, (m, line)


def test_address_line_is_one_line_and_plain_outside_korean():
    assert "\n" not in address_line("하렴", korean=True)
    assert address_line("하렴", korean=False) == "Call the user “하렴” (if earlier messages did otherwise, switch now)."
    assert "particles" not in address_line("Sam", korean=False)


def test_system_prompt_carries_the_forms_and_changes_the_engine_key():
    p = {"address": "하렴", "language": "ko"}
    sp = system_prompt("한채린", p, [])
    assert "“하렴아”" in sp and "하렴이가" in sp
    assert "“하렴아”" not in system_prompt("한채린", {**p, "language": "en"}, [])
    assert prompt_key("한채린", p, 0) != prompt_key("한채린", {**p, "address": "지수"}, 0)
