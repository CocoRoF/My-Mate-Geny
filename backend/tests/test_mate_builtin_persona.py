"""Built-in personas are written in English (personas/<key>.json); names and
greetings follow the mate's reply language; app updates merge field by field
and keep whatever the user changed."""

from __future__ import annotations

import json
import re

from app.mate import files
from app.mate.prompt import prompt_key, system_prompt
from app.mate.service import MateService
from app.mate.store import DEFAULT_GREETINGS, DEFAULT_PERSONA, MAX_FIELD, MateStore
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

HANGUL = re.compile(r"[가-힣]")
TEXT_FIELDS = ("description", "personality", "speech", "instructions")


def _service(db):
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    return MateService(svc, MateStore(db, vault))


def _mostly_english(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    return bool(letters) and len(HANGUL.findall(text)) / len(letters) < 0.25


def _seed_legacy(db):
    """An install from before personas/: every built-in as the old sync made it
    (persona mapped from the Korean source, no snapshot, an older bundle hash)."""
    store = MateStore(db, SecretVault(db))
    ids = {}
    for key in [k for k in ("estelle", "chaerin", "seoa", "mao") if k in files.builtin_keys()]:  # old order
        doc = files.builtin_doc(key)
        name, persona = files.legacy_persona(doc)
        m = store.create(name=name, persona=persona, avatar=files.builtin_avatar(key, doc))
        store.mark_builtin(m["id"], key, "old-hash")
        ids[key] = m["id"]
    return store, ids


def test_fresh_install_chaerin_default_with_english_persona(db):
    mates = _service(db)
    listed = mates.list()
    cha = listed[0]
    assert cha["builtin"] == "chaerin" and cha["is_default"]
    p = cha["persona"]
    # the bundled reply language is unchanged (Korean), so are her name and greeting
    assert p["language"] == "ko" and cha["name"] == "한채린"
    assert p["greeting"] == "...안녕하세요. 한채린이에요. 말은 잘 못하는데, 메시지는 괜찮아요. 오늘 어땠어요?"
    assert "QA (quality assurance) engineer" in p["description"] and "Your relationship with the user:" in p["description"]
    assert "What are the repro steps?" in p["speech"] and "재현 경로가 어떻게 돼요?" in p["speech"]
    assert "Example exchanges:" in p["speech"] and "When you first meet the user" in p["instructions"]
    for m in listed:
        for k in TEXT_FIELDS:
            assert _mostly_english(m["persona"][k]), (m["builtin"], k)
            assert len(m["persona"][k]) < MAX_FIELD
        assert mates.store.by_builtin(m["builtin"])["builtin_snapshot"]["names"]["en"]
    prompt = system_prompt(cha["name"], p, [])
    assert "Always reply in Korean, whatever language your instructions are written in" in prompt


def test_every_bundle_has_both_languages():
    for key in files.builtin_keys():
        b = files.builtin_bundle(key)
        assert set(b["names"]) == {"en", "ko"} and set(b["greetings"]) == {"en", "ko"}, key
        assert not HANGUL.search(b["names"]["en"] + b["greetings"]["en"]), key
        assert HANGUL.search(b["names"]["ko"] + b["greetings"]["ko"]), key
        # the Korean greeting is the author's original line
        _name, legacy = files.legacy_persona(files.builtin_doc(key))
        assert b["greetings"]["ko"] == legacy["greeting"], key
    assert files.builtin_bundle("estelle")["names"] == {"en": "Estelle Luminar", "ko": "에스텔 루미나르"}


def test_default_geny_persona_is_english():
    for k in ("description", "personality", "speech"):
        assert _mostly_english(DEFAULT_PERSONA[k])
    assert DEFAULT_PERSONA["greeting"] == DEFAULT_GREETINGS["ko"] and DEFAULT_PERSONA["language"] == "ko"


def test_migration_of_an_unedited_builtin(db):
    store, ids = _seed_legacy(db)
    store.update(ids["estelle"], {"voice": {"tts": {"engine": "elevenlabs", "voice": "v1"}}, "_sync": True})
    store.add_memory(ids["estelle"], "likes tea")
    before = store.get(ids["estelle"])
    mates = _service(db)  # startup: the sync migrates
    est = mates.get(ids["estelle"])
    new = files.builtin_bundle("estelle")
    for k in TEXT_FIELDS:
        assert est["persona"][k] == new["persona"][k] and est["persona"][k] != before["persona"][k]
    assert "archmage" in est["persona"]["description"] and "Your world:" in est["persona"]["description"]
    # language, name and greeting stay Korean; voice, memories, default untouched
    assert est["persona"]["language"] == "ko" and est["name"] == "에스텔 루미나르"
    assert est["persona"]["greeting"] == before["persona"]["greeting"]
    assert est["voice"] == before["voice"] and est["is_default"] and not est["customized"]
    assert [m["text"] for m in mates.store.memories(est["id"])] == ["likes tea"]
    row = mates.store.by_builtin("estelle")
    assert row["builtin_hash"] == files.builtin_hash("estelle") and row["builtin_snapshot"]["persona"] == new["persona"]
    # Mao's bundled name is now per language: the Korean one for a Korean-replying mate
    if "mao" in ids:  # (Mao is only on installs that added the Live2D sample)
        assert mates.get(ids["mao"])["name"] == "마오"
    # idempotent: a restart changes nothing
    _service(db)
    assert mates.get(ids["estelle"]) == est


def test_migration_of_an_edited_builtin_keeps_the_users_fields(db):
    store, ids = _seed_legacy(db)
    cid = ids["chaerin"]
    legacy = store.get(cid)
    store.update(cid, {"persona": {"address": "하렴", "personality": "my own words"},
                       "voice": {"tts": {"engine": "elevenlabs", "voice": "Mi0l"}}, "is_default": True})
    assert store.get(cid)["customized"]
    # the conversation last ran with the Korean persona
    applied = files.home_dir(cid) / ".applied-persona.json"
    applied.parent.mkdir(parents=True, exist_ok=True)
    old = store.get(cid)
    applied.write_text(json.dumps({"name": old["name"], "persona": old["persona"]}, ensure_ascii=False), "utf-8")

    mates = _service(db)
    cha = mates.get(cid)
    new = files.builtin_bundle("chaerin")["persona"]
    p = cha["persona"]
    assert p["address"] == "하렴" and p["personality"] == "my own words"       # the user's
    assert p["description"] == new["description"] and p["speech"] == new["speech"]  # untouched -> English
    assert p["instructions"] == new["instructions"]
    assert p["greeting"] == legacy["persona"]["greeting"] and p["language"] == "ko" and cha["name"] == "한채린"
    assert cha["is_default"] and cha["customized"] and cha["voice"]["tts"]["voice"] == "Mi0l"
    assert not mates.get(ids["estelle"])["is_default"]
    # the engine restarts (new prompt key) and the next message carries a settings note
    assert prompt_key(cha["name"], p, 0) != prompt_key(old["name"], old["persona"], 0)
    note = mates._settings_note(cid, cha)
    assert "Who you are was updated" in note and "Speaking style was updated" in note
    assert "Reply language" not in note and "Call the user" not in note
    assert mates._settings_note(cid, cha) == ""  # only once


def test_later_bundle_updates_merge_against_the_snapshot(db):
    mates = _service(db)
    seoa = mates.store.by_builtin("seoa")
    snap = seoa["builtin_snapshot"]
    old_snap = {**snap, "persona": {**snap["persona"], "description": "old bundled text", "speech": "old speech"},
                "greetings": {"en": "old hi", "ko": "옛 인사"}}
    mates.store.update(seoa["id"], {"persona": {"description": "old bundled text", "speech": "user speech",
                                                "greeting": "옛 인사"}, "_sync": True})
    mates.store.mark_builtin(seoa["id"], "seoa", "older", old_snap)
    mates.sync_builtins()
    p = mates.get(seoa["id"])["persona"]
    assert p["description"] == snap["persona"]["description"]   # was bundled -> refreshed
    assert p["speech"] == "user speech"                          # the user's -> kept
    assert p["greeting"] == snap["greetings"]["ko"]              # an old bundled greeting -> today's (ko)


def test_language_switch_swaps_bundled_name_and_greeting(db):
    mates = _service(db)
    cha = mates.store.by_builtin("chaerin")
    b = files.builtin_bundle("chaerin")
    m = mates.update(cha["id"], {"persona": {"language": "en"}})
    assert m["name"] == "Han Chaerin" and m["persona"]["greeting"] == b["greetings"]["en"]
    assert m["persona"]["description"] == b["persona"]["description"]
    # the settings form sends everything: name + whole persona with the new language
    m = mates.update(cha["id"], {"name": m["name"], "persona": {**m["persona"], "language": "ko"}})
    assert m["name"] == "한채린" and m["persona"]["greeting"] == b["greetings"]["ko"]
    # user-written name/greeting are never swapped
    mates.update(cha["id"], {"name": "채린이", "persona": {"greeting": "하이"}})
    m = mates.update(cha["id"], {"persona": {"language": "en"}})
    assert m["name"] == "채린이" and m["persona"]["greeting"] == "하이" and m["persona"]["language"] == "en"
    # the default Geny greeting follows too
    geny = mates.create({"name": "Geny", "persona": DEFAULT_PERSONA})
    assert mates.update(geny["id"], {"persona": {"language": "en"}})["persona"]["greeting"] == DEFAULT_GREETINGS["en"]
    other = mates.create({"name": "Own", "persona": {"greeting": "yo"}})
    assert mates.update(other["id"], {"persona": {"language": "en"}})["persona"]["greeting"] == "yo"
