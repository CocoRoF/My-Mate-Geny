"""Korean particles: the cases shared with the frontend (frontend/test/fixtures/josa-cases.json)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.mate.josa import address_forms, final_sound, is_bare_korean_name, josa, particle

CASES = json.loads((Path(__file__).resolve().parents[2] / "frontend/test/fixtures/josa-cases.json").read_text("utf-8"))


@pytest.mark.parametrize("word,p,expected", CASES["josa"])
def test_josa_shared_cases(word, p, expected):
    assert josa(word, p) == expected


@pytest.mark.parametrize("address,casual,expected", CASES["forms"])
def test_address_forms_shared_cases(address, casual, expected):
    assert address_forms(address, casual=casual) == expected


def test_final_sound_and_bare_names():
    assert final_sound("현석") == "batchim" and final_sound("지수") == "none" and final_sound("서울") == "rieul"
    assert final_sound("") is None and final_sound("さくら") is None
    assert particle("현석", "(으)로") == "으로" and particle("서울", "(으)로") == "로"
    assert particle("x", "까지") == "까지"  # not a pair: as written
    assert is_bare_korean_name("현석", "현석") and not is_bare_korean_name("현석님", "현석")
    assert not is_bare_korean_name("주인님", "") and not is_bare_korean_name("Sam", "Sam")
