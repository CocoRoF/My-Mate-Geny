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
TEXT_FIELDS = ("description", "personality", "instructions")


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
    for key in [k for k in ("chaerin", "mao") if k in files.builtin_keys()]:
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
    p, s = cha["persona"], cha["prefs"]
    # the bundled reply language is unchanged (Korean), so are her name and greeting
    assert p["language"] == "ko" and cha["name"] == "한채린"
    assert p["greeting"] == "...안녕하세요. 한채린이에요. 말은 잘 못하는데, 메시지는 괜찮아요. 오늘 어땠어요?"
    assert "QA (quality assurance) engineer" in p["description"] and "Your relationship with the user:" in p["description"]
    assert "Things you like to talk about" in p["description"]
    # how she talks is her conversation style: habits in speech_style, her speech level and address as data
    assert "speech" not in p and "address" not in p
    assert "What are the repro steps?" in s["speech_style"] and "재현 경로가 어떻게 돼요?" in s["speech_style"]
    assert "Example exchanges:" in s["speech_style"] and "When you first meet the user" in s["speech_style"]
    assert s["defaults"] == {"formality": "haeyo", "address": "{name} 님", "self_ref": ""}
    assert s["formality"] == "auto" and s["address"] == ""  # the user's own fields: untouched (= her way)
    for m in listed:
        for k in TEXT_FIELDS:
            assert not m["persona"][k] or _mostly_english(m["persona"][k]), (m["builtin"], k)
            assert len(m["persona"][k]) < MAX_FIELD
        assert _mostly_english(m["prefs"]["speech_style"]), m["builtin"]
        assert mates.store.by_builtin(m["builtin"])["builtin_snapshot"]["names"]["en"]
    prompt = system_prompt(cha["name"], p, [], s)
    assert "Always reply in Korean, whatever language the rest of this prompt is written in" in prompt


def test_bundles_keep_speech_level_and_address_out_of_the_free_text():
    """The bundles' free text keeps habits only: the speech level and the address are structured data."""
    for key in ("chaerin",):
        st = files.builtin_bundle(key)["style"]
        assert st["defaults"]["formality"] in ("haeyo", "banmal") and st["defaults"]["address"]
        text = st["speech_style"]
        for rule in ("반말", "존댓말", "-nim", "calls the user", "Call the user", "politely by name", "by their name"):
            assert rule not in text, (key, rule)
    assert files.style_defaults(files.builtin_bundle("chaerin"), "en")["address"] == "{name}"


def test_every_bundle_has_both_languages():
    for key in files.builtin_keys():
        b = files.builtin_bundle(key)
        assert set(b["names"]) == {"en", "ko"} and set(b["greetings"]) == {"en", "ko"}, key
        assert not HANGUL.search(b["names"]["en"] + b["greetings"]["en"]), key
        assert HANGUL.search(b["names"]["ko"] + b["greetings"]["ko"]), key
        # the Korean greeting is the author's original line
        _name, legacy = files.legacy_persona(files.builtin_doc(key))
        assert b["greetings"]["ko"] == legacy["greeting"], key
    assert files.builtin_bundle("chaerin")["names"] == {"en": "Han Chaerin", "ko": "한채린"}


def test_default_geny_persona_is_english():
    for k in ("description", "personality"):
        assert _mostly_english(DEFAULT_PERSONA[k])
    assert "speech" not in DEFAULT_PERSONA and "address" not in DEFAULT_PERSONA
    assert DEFAULT_PERSONA["greeting"] == DEFAULT_GREETINGS["ko"] and DEFAULT_PERSONA["language"] == "ko"


def test_migration_of_an_unedited_builtin(db):
    store, ids = _seed_legacy(db)
    store.update(ids["chaerin"], {"voice": {"tts": {"engine": "elevenlabs", "voice": "v1"}}, "_sync": True})
    store.add_memory(ids["chaerin"], "likes tea")
    before = store.get(ids["chaerin"])
    mates = _service(db)  # startup: the sync migrates
    cha = mates.get(ids["chaerin"])
    new = files.builtin_bundle("chaerin")
    for k in TEXT_FIELDS:
        assert cha["persona"][k] == new["persona"][k]
    assert cha["persona"]["description"] != before["persona"]["description"]
    assert cha["prefs"]["speech_style"] == new["style"]["speech_style"] != before["prefs"]["speech_style"]
    assert cha["prefs"]["defaults"]["formality"] == "haeyo"
    assert "QA" in cha["persona"]["description"]
    # language, name and greeting stay Korean; voice, memories, default untouched
    assert cha["persona"]["language"] == "ko" and cha["name"] == "한채린"
    assert cha["persona"]["greeting"] == before["persona"]["greeting"]
    assert cha["voice"] == before["voice"] and cha["is_default"] and not cha["customized"]
    assert [m["text"] for m in mates.store.memories(cha["id"])] == ["likes tea"]
    row = mates.store.by_builtin("chaerin")
    assert row["builtin_hash"] == files.builtin_hash("chaerin") and row["builtin_snapshot"]["persona"] == new["persona"]
    # Mao's bundled name is now per language: the Korean one for a Korean-replying mate
    if "mao" in ids:  # (Mao is only on installs that added the Live2D sample)
        assert mates.get(ids["mao"])["name"] == "마오"
    # idempotent: a restart changes nothing
    _service(db)
    assert mates.get(ids["chaerin"]) == cha


def test_migration_of_an_edited_builtin_keeps_the_users_fields(db):
    store, ids = _seed_legacy(db)
    cid = ids["chaerin"]
    legacy = store.get(cid)
    store.update(cid, {"prefs": {"address": "하렴"}, "persona": {"personality": "my own words"},
                       "voice": {"tts": {"engine": "elevenlabs", "voice": "Mi0l"}}, "is_default": True})
    assert store.get(cid)["customized"]
    # the conversation last ran with the old Korean persona (speech and address still in it)
    applied = files.home_dir(cid) / ".applied-persona.json"
    applied.parent.mkdir(parents=True, exist_ok=True)
    old = store.get(cid)
    _n, old_persona = files.legacy_persona(files.builtin_doc("chaerin"))
    old_persona = {**old_persona, "address": "하렴", "personality": "my own words"}
    applied.write_text(json.dumps({"name": old["name"], "persona": old_persona, "prefs": {}}, ensure_ascii=False),
                       "utf-8")

    mates = _service(db)
    cha = mates.get(cid)
    new = files.builtin_bundle("chaerin")
    p, s = cha["persona"], cha["prefs"]
    assert s["address"] == "하렴" and p["personality"] == "my own words"       # the user's
    assert p["description"] == new["persona"]["description"]                     # untouched -> English
    assert s["speech_style"] == new["style"]["speech_style"]
    assert p["instructions"] == new["persona"]["instructions"]
    assert p["greeting"] == legacy["persona"]["greeting"] and p["language"] == "ko" and cha["name"] == "한채린"
    assert cha["is_default"] and cha["customized"] and cha["voice"]["tts"]["voice"] == "Mi0l"
    # the engine restarts (new prompt key) and the next message carries a settings note
    assert prompt_key(cha["name"], p, 0, s) != prompt_key(old["name"], old_persona, 0, {})
    note = mates._settings_note(cid, cha)
    assert "Who you are was updated" in note and "Your speech habits were updated" in note
    assert "Speech level: polite 해요체" in note                                 # her own level, now as data
    assert "Reply language" not in note and "Call the user" not in note        # (the address didn't change)
    assert mates._settings_note(cid, cha) == ""  # only once


def test_later_bundle_updates_merge_against_the_snapshot(db):
    mates = _service(db)
    cha = mates.store.by_builtin("chaerin")
    snap = cha["builtin_snapshot"]
    old_snap = {**snap, "persona": {**snap["persona"], "description": "old bundled text"},
                "style": {**snap["style"], "speech_style": "old speech", "address": "",
                          "defaults": {"formality": "banmal", "address": {"ko": "{name}"}, "self_ref": {}}},
                "greetings": {"en": "old hi", "ko": "옛 인사"}}
    mates.store.update(cha["id"], {"persona": {"description": "old bundled text", "greeting": "옛 인사"},
                                    "prefs": {"speech_style": "user speech", "formality": "hapsyo",
                                              "defaults": {"formality": "banmal", "address": "{name}"}},
                       "_sync": True})
    mates.store.mark_builtin(cha["id"], "chaerin", "older", old_snap)
    mates.sync_builtins()
    m = mates.get(cha["id"])
    p, s = m["persona"], m["prefs"]
    assert p["description"] == snap["persona"]["description"]   # was bundled -> refreshed
    assert s["speech_style"] == "user speech"                    # the user's -> kept
    assert s["formality"] == "hapsyo"                            # the user's speech level -> kept
    assert s["defaults"] == files.style_defaults(files.builtin_bundle("chaerin"), "ko") and s["defaults"]["formality"] == "haeyo"  # bundle data -> follows
    assert p["greeting"] == snap["greetings"]["ko"]              # an old bundled greeting -> today's (ko)
    # a bundled speech text (still as bundled) follows the bundle
    mates.store.update(cha["id"], {"prefs": {"speech_style": "old speech"}, "_sync": True})
    mates.store.mark_builtin(cha["id"], "chaerin", "older", old_snap)
    mates.sync_builtins()
    assert mates.get(cha["id"])["prefs"]["speech_style"] == snap["style"]["speech_style"]


def test_old_snapshot_shape_is_read_as_today(db):
    """A snapshot from before the conversation style (speech/address in its persona) still tells the user's
    edits from bundled text."""
    mates = _service(db)
    cha = mates.store.by_builtin("chaerin")
    snap = cha["builtin_snapshot"]
    old_shape = {**{k: v for k, v in snap.items() if k != "style"},
                 "persona": {**snap["persona"], "speech": "bundled long ago", "address": ""}}
    mates.store.update(cha["id"], {"prefs": {"speech_style": "bundled long ago"}, "_sync": True})
    mates.store.mark_builtin(cha["id"], "chaerin", "older", old_shape)
    mates.sync_builtins()
    assert mates.get(cha["id"])["prefs"]["speech_style"] == snap["style"]["speech_style"]


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
