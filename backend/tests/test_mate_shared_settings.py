"""What every mate shares, set once (docs/settings.md): the user's name (one for all mates, read once from the
mates' own old values) and an OpenAI / Google key of the language-model providers standing in for the voice
services' own (said in the settings, never hidden; a key of its own wins)."""

from __future__ import annotations

from app.mate.store import MateStore
from app.vault import SecretVault


def test_the_name_is_one_for_every_mate(db):
    store = MateStore(db, SecretVault(db))
    a = store.create(name="A", persona={"language": "ko"}, prefs={"user_name": "현석"})
    b = store.create(name="B", persona={"language": "ko"})
    assert store.get(b["id"])["prefs"]["user_name"] == "현석", "a new mate's name became everyone's"
    # Settings → Account
    store.update_settings({"user_name": "  하렴 "})
    assert store.settings()["user_name"] == "하렴"
    assert {store.get(x["id"])["prefs"]["user_name"] for x in (a, b)} == {"하렴"}
    # a mate changing it (her own style tool, her settings) changes it for all of them
    store.update(b["id"], {"prefs": {"user_name": "Alex", "length": "short"}})
    assert store.get(a["id"])["prefs"]["user_name"] == "Alex"
    assert store.get(b["id"])["prefs"]["length"] == "short", "the rest of the patch still applies"
    store.update_settings({"user_name": ""})
    assert store.get(a["id"])["prefs"]["user_name"] == ""


def test_the_name_is_read_once_from_the_mates_old_values(db):
    store = MateStore(db, SecretVault(db))
    import json

    # (from before the name was one: each mate had its own; the default mate's wins, else the most common)
    rows = [("m1", "현석", 0), ("m2", "하렴", 1), ("m3", "현석", 0)]
    for mid, name, default in rows:
        m = store.create(name=mid, persona={"language": "ko"})
        db.execute("UPDATE mates SET prefs = ?, is_default = ? WHERE id = ?", (json.dumps({"user_name": name}), default, m["id"]))
    db.execute("DELETE FROM mate_settings WHERE key = 'user_name'")
    assert store.user_name() == "하렴"
    db.execute("UPDATE mates SET prefs = ? WHERE prefs LIKE '%하렴%'", (json.dumps({"user_name": "현석"}),))
    assert store.user_name() == "하렴", "read once, then it is the user's"
    db.execute("DELETE FROM mate_settings WHERE key = 'user_name'")
    db.execute("UPDATE mates SET is_default = 0")
    assert store.user_name() == "현석"


def test_a_providers_key_stands_in_and_says_so(db):
    store = MateStore(db, SecretVault(db))
    store.shared_key = lambda name: "sk-shared" if name == "openai_key" else ""
    s = store.settings()
    assert s["openai_key_set"] is False and s["openai_key_shared"] is True
    assert s["google_key_shared"] is False and s["elevenlabs_key_shared"] is False
    assert store.secret("openai_key") == "sk-shared"
    store.update_settings({"openai_key": "sk-own"})
    s = store.settings()
    assert s["openai_key_set"] is True and s["openai_key_shared"] is False
    assert store.secret("openai_key") == "sk-own", "a key of its own wins"
    store.update_settings({"openai_key": None})
    assert store.secret("openai_key") == "sk-shared"
    store.shared_key = None
    assert store.secret("openai_key") == "" and store.settings()["openai_key_shared"] is False
