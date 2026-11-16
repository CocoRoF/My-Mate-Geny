"""How the mate calls the user: Korean particles follow the name's last sound (app/mate/josa.py), and the prompt gives the name and
the address as what they are, their use hers (prompt.address_line, ADDRESS_USE)."""

from __future__ import annotations

import pytest

from app.mate.josa import address_forms, final_sound, particle
from app.mate.prompt import ADDRESS_USE, address_line, prompt_key, system_prompt


def test_unknown_sound_falls_back_to_the_written_pair():
    assert final_sound("さくら") is None and particle("さくら", "이") == "이(가)"


def test_casual_forms_add_the_friendly_i_after_a_final_consonant():
    assert address_forms("하렴", casual=True) == {"subject": "하렴이가", "topic": "하렴이는", "object": "하렴이를",
                                                 "with": "하렴이랑", "call": "하렴아"}
    assert address_forms("지수", casual=True)["call"] == "지수야"
    assert address_forms("지수", casual=True)["subject"] == "지수가"


def test_the_name_and_what_she_calls_them_are_given_and_how_to_use_them_is_hers():
    """The user's word (2026-11-16): the name and what she calls them say who they are and how she addresses them — never a
    word forced into every sentence ("자기야는 뭐 하고 있었어?", "장하렴은 뭐 하고 있었어요?"); how she uses them is hers, as a
    native speaker's. Still no table of their own name with its particles."""
    sp = system_prompt("한채린", {"address": "하렴", "language": "ko"}, [], {"user_name": "장하렴", "formality": "banmal"})
    assert "What you call the user: “하렴”." in sp and "The user's name is 장하렴." in sp and ADDRESS_USE in sp
    assert "how you use them is yours to judge" in ADDRESS_USE and "not in every message" in ADDRESS_USE
    assert "never the calling form as if it were a name" in ADDRESS_USE and "the listener goes unsaid" in ADDRESS_USE
    for grammar in ("하렴아", "하렴이가", "하렴이는", "Call the user"):
        assert grammar not in sp, grammar
    assert address_line("주인님") == "What you call the user: “주인님”."
    assert ADDRESS_USE not in system_prompt("한채린", {"language": "ko"}, [], {})  # (no name, no address: nothing to use)
    assert prompt_key("한채린", {"address": "하렴"}, 0) != prompt_key("한채린", {"address": "지수"}, 0)
