"""The story she lives in (docs/mate-memory-affinity.md §5.5): she stays in character, and how close they are, which is what the
affinity says, shapes what she is to them; what the story never overrides stays in every stage."""

from __future__ import annotations

import pytest
from test_mate_style import _service, _turn

from app.mate.prompt import _STAGE_GUIDES, base_prompt, prompt_key

GUIDES = {"new": "You have only just met", "familiar": "You know each other's rhythm", "trusted": "You trust them and they trust you",
          "companion": "They are your person"}


def test_she_is_a_character_in_a_story_not_a_service():
    text = base_prompt("채린", {}, {})
    assert text.startswith("You are 채린. You and the user share a one-to-one story")
    assert "secretary" not in text.lower()
    story = text.split("## The story you two share")[1]
    assert 'no "as an AI"' in story and "no assistant phrases" in story and "no policy voice" in story
    assert "say no as 채린, for 채린's reasons" in story
    assert "no hint that there is anything behind it" in story  # (a joke stays a joke)


@pytest.mark.parametrize("kwargs", [{}, {"relation": True, "stage": "new"}, {"relation": True, "stage": "companion"}])
def test_what_the_story_never_overrides_is_there_at_every_closeness(kwargs):
    story = base_prompt("채린", {}, {}, **kwargs).split("## The story you two share")[1]
    assert "whether they are talking with a person or an AI" in story and "tell them the truth" in story
    assert "real trouble" in story and "real people or real help" in story
    assert "Nothing sexual, at any closeness and in any story" in story


@pytest.mark.parametrize("stage", list(GUIDES))
def test_only_the_stage_they_are_at_is_in_her_prompt(stage):
    text = base_prompt("채린", {}, {}, relation=True, stage=stage)
    between = text.split("## Between you and the user")[1]
    assert [s for s, words in GUIDES.items() if words in between] == [stage]
    assert "no jealousy or possessiveness" in between and "no pressure to talk more or to stay" in between
    assert text.index("## The story you two share") < text.index("## Between you and the user") < text.index("## What you can and cannot do")
    assert set(_STAGE_GUIDES) == set(GUIDES)


def test_at_the_top_it_shows_in_every_reply_and_stays_affection():
    guide = _STAGE_GUIDES["companion"]
    assert "unmistakable in every reply" in guide and "You reach out first" in guide and "nothing sexual" in guide
    assert "you aren't there" in _STAGE_GUIDES["new"]  # (it has to be earned)


def test_with_the_relationship_off_there_is_no_closeness_but_still_the_story():
    text = base_prompt("채린", {}, {})
    assert "## Between you and the user" not in text and "## The story you two share" in text


def test_a_new_stage_reaches_the_engine_through_its_prompt():
    keys = {stage: prompt_key("채린", {}, 0, {}, relation=True, stage=stage) for stage in GUIDES}
    assert len(set(keys.values())) == 4


def test_the_affinity_decides_what_she_is_to_them(db):
    mates = _service(db)
    mid = mates.store.by_builtin("chaerin")["id"]
    _req, prompt = _turn(mates, mid)
    assert GUIDES["new"] in prompt
    for value, stage in ((30, "familiar"), (50, "trusted"), (100, "companion")):
        mates.relation_update(mid, {"affinity": value})
        assert mates.get(mid)["relation"]["stage"] == stage
        _req, prompt = _turn(mates, mid)
        assert GUIDES[stage] in prompt
    mates.relation_update(mid, {"enabled": False})
    _req, prompt = _turn(mates, mid)
    assert "## Between you and the user" not in prompt
