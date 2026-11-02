"""Conversation settings (mate.prefs, docs/mate-memory-affinity.md §3): normalized and merged, every option
changes the prompt (no fake toggles), the prompt key follows them, the next message carries a settings note,
built-in sync never touches them."""

from __future__ import annotations

import pytest

from app.mate.prompt import base_prompt, prompt_key, settings_change_note, settings_block
from app.mate.store import MateError, MateStore, default_prefs, normalize_prefs
from app.providers.base import TurnRequest
from app.vault import SecretVault

KO = {"language": "ko"}


def test_normalize_merges_and_validates():
    p = normalize_prefs({"formality": "banmal", "tone": {"humor": "high"}, "user_name": "  현석  "})
    assert p["formality"] == "banmal" and p["tone"] == {"warmth": "auto", "humor": "high", "initiative": "auto"}
    assert p["user_name"] == "현석" and p["emotion"] == 2 and p["memory"] == {"recall": "normal", "self_save": True}
    q = normalize_prefs({"length": "short", "memory": {"self_save": False}}, p)
    assert q["formality"] == "banmal" and q["length"] == "short" and q["memory"]["self_save"] is False
    assert normalize_prefs({"emotion": 9})["emotion"] == 3 and normalize_prefs({"emotion": -1})["emotion"] == 0
    for bad in ({"formality": "x"}, {"length": "huge"}, {"tone": {"warmth": "max"}}, {"emotion": True},
                {"memory": {"recall": "all"}}, {"tone": "x"}, "x"):
        with pytest.raises(MateError):
            normalize_prefs(bad)
    assert normalize_prefs(None, {"junk": 1, "formality": "zzz"}) == default_prefs()  # stored garbage → defaults


def test_defaults_give_one_plain_how_you_talk_section():
    """Defaults: the section is still there (language, length, emotion tags, the self-edit rule) — never a speech
    level, an address or a habit nobody set."""
    block = settings_block(KO, default_prefs())
    assert block.startswith("## How you talk") and "Always reply in Korean" in block and "usually one to three" in block
    for absent in ("Speech level", "Call the user", "Refer to yourself", "speech habits", "The user's name"):
        assert absent not in block, absent
    text = base_prompt("Geny", KO, default_prefs())
    assert text.count("## How you talk") == 1 and "## Conversation settings" not in text


@pytest.mark.parametrize("patch,needle", [
    ({"user_name": "현석"}, "The user's name is 현석."),
    ({"self_ref": "저"}, "Refer to yourself as “저”"),
    ({"address": "하렴"}, "Call the user “하렴”."),
    ({"speech_style": "Ends lines with ~"}, "Ends lines with ~"),
    ({"defaults": {"formality": "haeyo"}}, "Speech level (your character's own): In Korean always use polite 해요체"),
    ({"defaults": {"address": "{name} 님"}}, "Call the user by their name, as “<name> 님”."),
    ({"self_edit": "off"}, "you cannot change it"),
    ({"self_edit": "ask"}, "propose it with update_conversation_style"),
    ({"formality": "haeyo"}, "해요체"),
    ({"formality": "hapsyo"}, "합쇼체"),
    ({"formality": "banmal"}, "반말"),
    ({"length": "short"}, "one or two at most"),
    ({"length": "long"}, "up to five or six"),
    ({"emotion": 0}, "Don't use emotion tags."),
    ({"emotion": 1}, "at most one per reply"),
    ({"emotion": 3}, "[joy:0.8]"),
    ({"tone": {"warmth": "low"}}, "Warmth: kind but matter-of-fact"),
    ({"tone": {"warmth": "high"}}, "Warmth: openly warm"),
    ({"tone": {"humor": "low"}}, "Humor: none"),
    ({"tone": {"humor": "high"}}, "Humor: playful"),
    ({"tone": {"initiative": "low"}}, "Initiative: answer what was asked"),
    ({"tone": {"initiative": "high"}}, "Initiative: take it"),
    ({"avoid": "politics,  religion"}, "change the subject: politics, religion"),
    ({"memory": {"self_save": False}}, "only when the user explicitly asks"),
])
def test_every_option_changes_the_prompt_and_key(patch, needle):
    base = base_prompt("Geny", KO, default_prefs())
    prefs = normalize_prefs(patch)
    text = base_prompt("Geny", KO, prefs)
    assert needle in text and needle not in base
    assert prompt_key("Geny", KO, 0, prefs) != prompt_key("Geny", KO, 0, default_prefs())


def test_recall_level_is_per_turn_not_in_the_prompt():
    prefs = normalize_prefs({"memory": {"recall": "rich"}})
    assert prompt_key("Geny", KO, 0, prefs) == prompt_key("Geny", KO, 0, default_prefs())


def test_address_is_just_the_name_at_every_speech_level():
    """No grammar notes in the prompt (the user's decision): the same plain line whatever the speech level."""
    for f in ("auto", "banmal", "haeyo"):
        p = base_prompt("Geny", KO, normalize_prefs({"formality": f, "address": "현석"}))
        assert "Call the user “현석”." in p and "현석아" not in p and "현석이가" not in p and "현석 님이" not in p
    en = base_prompt("Geny", {"language": "en"}, normalize_prefs({"address": "boss"}))
    assert "Call the user “boss”." in en


def test_the_users_choice_wins_over_the_characters_default():
    d = {"defaults": {"formality": "haeyo", "address": "{name} 님"}}
    p = base_prompt("G", KO, normalize_prefs({**d, "formality": "banmal", "address": "하렴"}))
    assert "Speech level: In Korean always use 반말" in p and "해요체" not in p
    assert "Call the user “하렴”." in p and "<name> 님" not in p
    # "auto" and an empty address: the character's own
    q = base_prompt("G", KO, normalize_prefs(d))
    assert "Speech level (your character's own)" in q and "<name> 님" in q


def test_settings_note_lists_pref_changes():
    a, b = default_prefs(), normalize_prefs({"formality": "banmal", "user_name": "현석", "length": "short"})
    note = settings_change_note("G", KO, "G", KO, a, b)
    assert "Speech level: 반말 in Korean" in note and "The user's name is “현석”" in note and "Reply length: one or two" in note
    assert settings_change_note("G", KO, "G", KO, None, b) == ""  # the previous run didn't record prefs
    assert settings_change_note("G", KO, "G", KO, a, normalize_prefs({"memory": {"recall": "off"}})) == ""


def test_store_api_roundtrip_and_settings_note(db, tmp_path):
    from app.mate.service import MateService
    from app.services.connection_service import ConnectionService
    from app.services.provider_service import ProviderService
    from app.services.session_service import SessionService
    from app.services.workspace_service import WorkspaceService

    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    store = MateStore(db, vault)
    mates = MateService(svc, store)
    m = store.create(name="Rin", persona={"language": "ko"}, prefs={"length": "short"})
    assert m["prefs"]["length"] == "short"
    session = mates.conversation(m["id"])["session"]
    req = TurnRequest(messages=[{"role": "user", "content": "hi"}], model="", cwd=str(tmp_path))
    mates.configure_engine(session, req)
    key1 = req.prompt_key
    m2 = mates.update(m["id"], {"prefs": {"formality": "banmal"}})
    assert m2["prefs"]["formality"] == "banmal" and m2["prefs"]["length"] == "short"
    req2 = TurnRequest(messages=[{"role": "user", "content": "hi"}], model="", cwd=str(tmp_path))
    mates.configure_engine(session, req2)
    assert "Speech level: 반말" in req2.preamble and req2.prompt_key != key1
    assert "반말" in open(req2.system_prompt_file, encoding="utf-8").read()
