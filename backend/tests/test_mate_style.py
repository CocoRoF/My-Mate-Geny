"""How the mate talks lives in one place — the conversation style (mate.prefs) — and she edits it herself
(docs/mate.md "Prompt composition"): the migration out of the persona, the prompt's single "How you talk" section,
update_conversation_style (validation, push, record, undo, the permission setting), the Memory tab's style hints,
the settings note and the prompt key."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

import pytest

from app.mate import files, mcp_bridge
from app.mate import style as STY
from app.mate.prompt import base_prompt, prompt_key, settings_change_note, system_prompt
from app.mate.service import MateService
from app.mate.store import MateStore, normalize_prefs
from app.providers.base import TurnRequest
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

LEVEL_WORDS = ("반말", "존댓말", "해요체", "합쇼체", "하십시오체")


class _Logs:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, dict]] = []

    def record(self, level, source, message, **kw):
        self.rows.append((level, message, kw))


def _service(db, logs=None):
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    return MateService(svc, MateStore(db, vault), logs)


def _turn(mates, mate_id, text="hi"):
    session = mates.conversation(mate_id)["session"]
    req = TurnRequest(messages=[{"role": "user", "content": text}], model="", cwd="/tmp")
    mates.configure_engine(session, req)
    return req, open(req.system_prompt_file, encoding="utf-8").read()


def _old_row(db, mid, name, persona, prefs, *, builtin=None, snapshot=None, customized=0, version="old"):
    """A mate row exactly as the version before the move wrote it (persona with speech/address)."""
    db.execute("INSERT INTO mates (id, name, is_default, persona, avatar, llm, voice, prefs, builtin, builtin_hash, "
               "builtin_snapshot, customized, created_at, updated_at) VALUES (?, ?, 0, ?, '{\"kind\": \"none\"}', "
               "'{}', '{}', ?, ?, ?, ?, ?, '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00')",
               (mid, name, json.dumps(persona, ensure_ascii=False), json.dumps(prefs, ensure_ascii=False), builtin,
                version if builtin else None, json.dumps(snapshot, ensure_ascii=False) if snapshot else None,
                customized))


def _old_chaerin(db):
    """한채린 as the live install had her on 2026-11-02: the bundled persona of before (speech with its 해요체 rule and
    “<이름> 님”), customized on, the user's own conversation settings (name 장하렴, speech level "auto" = as her
    character, no address of their own)."""
    _n, legacy = files.legacy_persona(files.builtin_doc("chaerin"))
    src = json.loads((files.BUILTIN_DIR / "personas" / "chaerin.json").read_text("utf-8"))
    old_speech = "\n".join([
        "- Short and polite. “...Yes.” “No.” “That's a bug.” The ends of her sentences fade out quietly.",
        "- She calls the user politely by name: “<their name> 님”.",
        "When you speak Korean: short 존댓말 (해요체) with the user — never 반말. Call the user “<이름> 님”. "
        "Your catchphrases are exactly “공략이 필요해요.”, “재현 경로가 어떻게 돼요?”.",
    ])
    persona = {"description": "old bundled description", "personality": "old bundled personality",
               "speech": old_speech, "greeting": src["greetings"]["ko"], "address": "", "language": "ko",
               "instructions": "old bundled instructions"}
    snapshot = {"language": "ko", "names": src["names"], "greetings": src["greetings"],
                "persona": {k: persona[k] for k in ("description", "personality", "speech", "address", "instructions")},
                "avatar": {"kind": "none"}}
    prefs = {"user_name": "장하렴", "self_ref": "", "formality": "auto", "length": "normal", "emotion": 2,
             "tone": {"warmth": "auto", "humor": "auto", "initiative": "auto"}, "avoid": "",
             "memory": {"recall": "normal", "self_save": True}}
    _old_row(db, "mate_c4a0000000000001", "한채린", persona, prefs, builtin="chaerin", snapshot=snapshot, customized=1)
    return persona, prefs


# ---- the migration ----

def test_migration_moves_speech_and_address_keeps_what_the_user_set_and_backs_up(db):
    _old_row(db, "mate_0a40000000000001", "Own", {"description": "a fox", "speech": "Says ‘kon’.", "address": "boss",
                                                  "language": "en"}, {"user_name": "Kim"})
    # the style already has an address (set after an earlier version): it stays, the persona's goes to the backup
    _old_row(db, "mate_5e70000000000001", "Set", {"speech": "", "address": "주인님", "language": "ko"},
             {"address": "", "formality": "banmal"})
    store = MateStore(db, SecretVault(db))
    report = {r["id"]: r for r in store.migrate_style()}
    own = store.get("mate_0a40000000000001")
    assert own["persona"] == {"description": "a fox", "personality": "", "greeting": "", "language": "en",
                              "instructions": ""}
    assert own["prefs"]["speech_style"] == "Says ‘kon’." and own["prefs"]["address"] == "boss"
    assert own["prefs"]["user_name"] == "Kim"
    assert store.persona_legacy(own["id"])["speech"] == "Says ‘kon’." and store.persona_legacy(own["id"])["address"] == "boss"
    s = store.get("mate_5e70000000000001")
    assert s["prefs"]["address"] == "" and s["prefs"]["formality"] == "banmal"  # (the user's cleared address stays)
    assert report["mate_5e70000000000001"]["kept"] == ["address"]
    assert store.persona_legacy(s["id"])["address"] == "주인님"
    # idempotent
    assert store.migrate_style() == []
    assert store.get(own["id"]) == own


def test_live_chaerin_migrates_with_the_users_settings_untouched(db):
    persona, prefs = _old_chaerin(db)
    logs = _Logs()
    mates = _service(db, logs)
    cha = mates.get("mate_c4a0000000000001")
    p, s = cha["persona"], cha["prefs"]
    # the user's own choices exactly as they were
    assert s["user_name"] == "장하렴" and s["formality"] == "auto" and s["address"] == "" and s["self_ref"] == ""
    # the bundled text (never edited) follows today's bundle; her own speech level / address are data now
    new = files.builtin_bundle("chaerin")
    assert p["description"] == new["persona"]["description"] and s["speech_style"] == new["style"]["speech_style"]
    assert s["defaults"] == {"formality": "haeyo", "address": "{name} 님", "self_ref": ""}
    assert "speech" not in p and "address" not in p
    assert mates.store.persona_legacy(cha["id"]) == persona  # nothing lost
    assert any("conversation style of “한채린”" in m for _l, m, _k in logs.rows)
    # a second start changes nothing
    _service(db)
    assert mates.get(cha["id"]) == cha


def _level_lines(prompt: str) -> list[str]:
    return [ln for ln in prompt.splitlines() if any(w in ln for w in LEVEL_WORDS)]


@pytest.mark.parametrize("formality,expect", [("auto", "해요체"), ("banmal", "반말"), ("hapsyo", "합쇼체"),
                                              ("haeyo", "해요체")])
def test_chaerins_full_prompt_has_one_speech_level_and_no_contradiction(db, formality, expect):
    """한채린's whole system prompt after the migration: exactly one line sets the speech level — the style's — and
    nothing else (persona, habits, sample-line notes, relationship guide) names another one."""
    _old_chaerin(db)
    mates = _service(db)
    cid = "mate_c4a0000000000001"
    mates.update(cid, {"prefs": {"formality": formality}})
    _req, prompt = _turn(mates, cid)
    assert prompt.count("## How you talk") == 1 and "## Conversation settings" not in prompt
    lines = _level_lines(prompt)
    assert len(lines) == 1 and lines[0].startswith("- Speech level") and expect in lines[0], lines
    who = prompt[prompt.index("## Who you are"):prompt.index("## How you talk")]
    assert "Speaking style" not in who and "Call the user" not in who and "님”" not in who
    assert prompt.count("Call the user") == 1 and "Call the user by their name, as “<name> 님”." in prompt
    assert "The user's name is 장하렴." in prompt
    if formality == "auto":
        assert "Speech level (your character's own)" in prompt


def test_users_address_and_name_win_and_stay_plain(db):
    _old_chaerin(db)
    mates = _service(db)
    cid = "mate_c4a0000000000001"
    mates.update(cid, {"prefs": {"address": "하렴", "formality": "banmal"}})
    _req, prompt = _turn(mates, cid)
    assert prompt.count("Call the user") == 1 and "Call the user “하렴”." in prompt and "<name> 님" not in prompt
    for grammar in ("하렴아", "하렴이가", "particle"):
        assert grammar not in prompt


def test_the_reply_language_switch_takes_the_characters_address_for_that_language(db):
    mates = _service(db)
    cha = mates.store.by_builtin("chaerin")
    m = mates.update(cha["id"], {"persona": {"language": "en"}})
    assert m["prefs"]["defaults"]["address"] == "{name}" and "Call the user by their name." in system_prompt(
        m["name"], m["persona"], [], m["prefs"])
    m = mates.update(cha["id"], {"persona": {"language": "ko"}})
    assert m["prefs"]["defaults"]["address"] == "{name} 님"


def test_a_page_from_before_the_move_does_not_undo_it(db):
    """A browser tab still running the old settings page sends the old persona (speech, address) with every save:
    values the migration already moved are no change; a value the user really typed there still lands."""
    persona, _prefs = _old_chaerin(db)
    mates = _service(db)
    cid = "mate_c4a0000000000001"
    before = mates.get(cid)["prefs"]
    m = mates.update(cid, {"persona": {**persona, "personality": "edited in an old tab"}})
    assert m["prefs"]["speech_style"] == before["speech_style"] and m["prefs"]["address"] == ""
    assert m["persona"]["personality"] == "edited in an old tab"
    m = mates.update(cid, {"persona": {**persona, "address": "하렴"}})
    assert m["prefs"]["address"] == "하렴"


# ---- her own tool ----

async def _ctx(mates, mid):
    sid = mates.conversation(mid)["session_id"]
    return mates.token_info(mates._token(mid, sid)), sid


async def test_update_conversation_style_applies_records_pushes_and_undoes(db):
    logs = _Logs()
    mates = _service(db, logs)
    cha = mates.store.by_builtin("chaerin")
    mates.update(cha["id"], {"prefs": {"user_name": "장하렴"}})
    ctx, sid = await _ctx(mates, cha["id"])
    pushed = []
    mates.store.on_change = lambda reason, mid: pushed.append((reason, mid))
    req1, _ = _turn(mates, cha["id"])
    text, err = await mates.call_tool(ctx, "update_conversation_style", {"formality": "banmal",
                                                                         "reason": "앞으로 반말로 해 달래"})
    assert not err and "speech level: auto → banmal" in text and "Talk this way from this reply on" in text
    cid = re.search(r"\[(stc_\w+)\]", text).group(1)
    m = mates.get(cha["id"])
    assert m["prefs"]["formality"] == "banmal" and m["prefs"]["user_name"] == "장하렴"
    assert ("updated", cha["id"]) in pushed and ("style", cha["id"]) in pushed  # every window refetches
    rec = mates.style_changes(cha["id"])[0]
    assert rec["id"] == cid and rec["actor"] == "mate" and rec["status"] == "applied"
    assert rec["changes"] == {"formality": {"from": "auto", "to": "banmal"}} and rec["reason"] == "앞으로 반말로 해 달래"
    assert rec["session_id"] == sid
    assert any(k.get("code") == "mate.style_changed" for _l, _m, k in logs.rows)  # the audit log
    # her next message: the new system prompt (a new key: the engine resumes with it) and the note
    req2, prompt2 = _turn(mates, cha["id"])
    assert req2.prompt_key != req1.prompt_key and "Speech level: In Korean always use 반말" in prompt2
    assert "<settings_update>" in req2.preamble and "Speech level: 반말 in Korean" in req2.preamble
    assert "update_conversation_style" in req2.preamble  # (the note says she may have done it herself)
    # the address too
    text, err = await mates.call_tool(ctx, "update_conversation_style", {"address": "하렴", "reason": "하렴이라고 불러"})
    assert not err and "what you call the user: (empty) → “하렴”" in text
    # nothing new: no record
    n = len(mates.style_changes(cha["id"]))
    text, err = await mates.call_tool(ctx, "update_conversation_style", {"formality": "banmal", "reason": "again"})
    assert not err and "Nothing to change" in text and len(mates.style_changes(cha["id"])) == n
    # undo the speech level: back to "auto" (her own); the address change stays
    out = mates.resolve_style_change(cha["id"], cid, "undo")
    assert out["mate"]["prefs"]["formality"] == "auto" and out["mate"]["prefs"]["address"] == "하렴"
    assert out["change"]["status"] == "undone" and out["skipped"] == []
    with pytest.raises(Exception):
        mates.resolve_style_change(cha["id"], cid, "undo")  # (once)


async def test_undo_keeps_a_field_changed_again_since(db):
    mates = _service(db)
    m = mates.create({"name": "Rin"})
    ctx, _sid = await _ctx(mates, m["id"])
    text, _ = await mates.call_tool(ctx, "update_conversation_style", {"length": "short", "tone": {"humor": "high"},
                                                                       "reason": "shorter, funnier"})
    cid = re.search(r"\[(stc_\w+)\]", text).group(1)
    mates.update(m["id"], {"prefs": {"length": "long"}})  # the user changed it again in the settings
    out = mates.resolve_style_change(m["id"], cid, "undo")
    assert out["skipped"] == ["length"] and out["mate"]["prefs"]["length"] == "long"
    assert out["mate"]["prefs"]["tone"]["humor"] == "auto"


async def test_the_tool_validates_like_the_settings(db):
    mates = _service(db)
    m = mates.create({"name": "Rin"})
    ctx, _sid = await _ctx(mates, m["id"])
    for bad, why in (({"formality": "rude", "reason": "x"}, "unknown speech level"),
                     ({"length": "huge", "reason": "x"}, "reply length"),
                     ({"emotion": 9, "reason": "x"}, None),
                     ({"tone": {"warmth": "max"}, "reason": "x"}, "tone.warmth"),
                     ({"language": "klingon", "reason": "x"}, "unknown language"),
                     ({"reason": "nothing"}, "nothing to change")):
        text, err = await mates.call_tool(ctx, "update_conversation_style", bad)
        if why is None:  # (emotion is clamped, as in the settings)
            assert not err and mates.get(m["id"])["prefs"]["emotion"] == 3
        else:
            assert err and why in text, (bad, text)
    assert mates.style_changes(m["id"])[0]["changes"] == {"emotion": {"from": 2, "to": 3}}
    # the reply language: persona.language (the name/greeting localization follows, as in the settings)
    text, err = await mates.call_tool(ctx, "update_conversation_style", {"language": "en", "reason": "in English"})
    assert not err and mates.get(m["id"])["persona"]["language"] == "en"


async def test_ask_first_proposes_and_off_refuses(db):
    mates = _service(db)
    m = mates.create({"name": "Rin", "prefs": {"self_edit": "ask"}})
    ctx, _sid = await _ctx(mates, m["id"])
    _req, prompt = _turn(mates, m["id"])
    assert "propose it with update_conversation_style" in prompt
    text, err = await mates.call_tool(ctx, "update_conversation_style", {"formality": "banmal", "reason": "반말로"})
    assert not err and "Proposed" in text
    cid = re.search(r"\[(stc_\w+)\]", text).group(1)
    assert mates.get(m["id"])["prefs"]["formality"] == "auto"  # nothing changed yet
    out = mates.resolve_style_change(m["id"], cid, "apply")
    assert out["mate"]["prefs"]["formality"] == "banmal" and out["change"]["status"] == "applied"
    text, _ = await mates.call_tool(ctx, "update_conversation_style", {"length": "short", "reason": "짧게"})
    cid2 = re.search(r"\[(stc_\w+)\]", text).group(1)
    assert mates.resolve_style_change(m["id"], cid2, "dismiss")["change"]["status"] == "dismissed"
    assert mates.get(m["id"])["prefs"]["length"] == "normal"
    # off: the bridge doesn't list the tool, the prompt says she can't, a call anyway is refused
    mates.update(m["id"], {"prefs": {"self_edit": "off"}})
    req, prompt = _turn(mates, m["id"])
    assert "HRH_MATE_STYLE" not in req.mcp_config["mcpServers"]["mate"]["env"]
    assert "you cannot change it" in prompt and "- update_conversation_style:" not in prompt
    text, err = await mates.call_tool(ctx, "update_conversation_style", {"formality": "haeyo", "reason": "x"})
    assert err and "switched off" in text
    mates.update(m["id"], {"prefs": {"self_edit": "auto"}})
    req, _ = _turn(mates, m["id"])
    assert req.mcp_config["mcpServers"]["mate"]["env"]["HRH_MATE_STYLE"] == "auto"


def test_bridge_lists_the_style_tool_unless_off():
    for env_value, listed in ((None, False), ("auto", True), ("ask", True)):
        env = {"PATH": os.environ.get("PATH", ""), "HRH_MATE_API": "http://127.0.0.1:9", "HRH_MATE_TOKEN": "t"}
        if env_value:
            env["HRH_MATE_STYLE"] = env_value
        proc = subprocess.Popen([sys.executable, "-I", mcp_bridge.__file__], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, text=True, env=env)
        try:
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}) + "\n")
            proc.stdin.flush()
            tools = json.loads(proc.stdout.readline())["result"]["tools"]
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)
        names = [t["name"] for t in tools]
        assert ("update_conversation_style" in names) is listed and "remember" in names
        remember = next(t for t in tools if t["name"] == "remember")
        assert "conversation style" in remember["description"]  # (style preferences are not memories)


# ---- prompt key and note ----

def test_style_changes_change_the_key_and_the_note_spells_them_out():
    base = normalize_prefs({"defaults": {"formality": "haeyo", "address": "{name} 님"}, "user_name": "장하렴"})
    keys = {prompt_key("한채린", {"language": "ko"}, 0, base)}
    for patch in ({"formality": "banmal"}, {"address": "하렴"}, {"self_ref": "나"}, {"speech_style": "x"},
                  {"self_edit": "off"}, {"tone": {"humor": "high"}}, {"avoid": "politics"}):
        keys.add(prompt_key("한채린", {"language": "ko"}, 0, normalize_prefs(patch, base)))
    assert len(keys) == 8
    # the recall level is per turn: no restart
    assert prompt_key("한채린", {}, 0, normalize_prefs({"memory": {"recall": "rich"}}, base)) == prompt_key(
        "한채린", {}, 0, base)
    new = normalize_prefs({"formality": "banmal", "address": "하렴", "self_ref": "나", "tone": {"humor": "high"},
                           "speech_style": "y", "self_edit": "ask"}, base)
    note = settings_change_note("한채린", {}, "한채린", {}, base, new)
    for line in ("- Speech level: 반말 in Korean", "- Call the user “하렴”.", "- Refer to yourself as “나”.",
                 "- Humor: playful", "- Your speech habits were updated", "proposals the user confirms"):
        assert line in note, line
    # back to her own way: the character's level and address are named, not just "updated"
    back = settings_change_note("한채린", {}, "한채린", {}, new, base)
    assert "- Speech level: polite 해요체" in back and "- Call the user by their name, as “<name> 님”." in back


def test_an_old_applied_persona_is_compared_as_style():
    """The first message after the update: the conversation last ran with speech/address in the persona."""
    old = {"language": "ko", "speech": "- Short and polite.", "address": ""}
    new_prefs = normalize_prefs({"speech_style": "- Short and quiet.", "defaults": {"formality": "haeyo"}})
    note = settings_change_note("한채린", old, "한채린", {"language": "ko"}, {}, new_prefs)
    assert "Your speech habits were updated" in note and "Speech level: polite 해요체" in note
    assert "Who you are" not in note


def test_memory_rules_send_style_requests_to_the_tool():
    p = base_prompt("G", {"language": "ko"}, normalize_prefs({}))
    assert "Never save it with remember" in p and "update_conversation_style changes it" in p
    q = base_prompt("G", {"language": "ko"}, normalize_prefs({"self_edit": "off"}))
    assert "Never save it with remember" in q and "the user sets it in the app" in q


# ---- memories that are really style rules ----

def test_memory_style_flags_and_move_to_style(db):
    mates = _service(db)
    m = mates.create({"name": "Rin", "prefs": {"formality": "haeyo"}})
    a = mates.store.add_memory(m["id"], "사용자는 반말로 대화하는 걸 좋아한다", kind="preference")
    b = mates.store.add_memory(m["id"], "Call me Harry from now on", kind="profile")
    c = mates.store.add_memory(m["id"], "The repo uses FastAPI", kind="fact")
    d = mates.store.add_memory(m["id"], "노래 부르는 걸 좋아함", kind="preference")
    flags = mates.memory_style_flags(m["id"])
    assert flags[a["id"]] == {"reason": "formality", "level": "banmal", "conflict": True}
    assert flags[b["id"]]["reason"] == "address"
    assert c["id"] not in flags and d["id"] not in flags
    # dismissed: no hint any more (nothing else changes)
    mates.store.dismiss_style_flag(m["id"], b["id"])
    assert b["id"] not in mates.memory_style_flags(m["id"])
    assert mates.store.memory(m["id"], b["id"])["status"] == "active"
    # moved by the user: the text joins the speech habits, the memory is archived (not deleted)
    out = mates.memory_to_style(m["id"], a["id"])
    assert "- 사용자는 반말로 대화하는 걸 좋아한다" in out["mate"]["prefs"]["speech_style"]
    assert out["memory"]["status"] == "archived" and a["id"] not in mates.memory_style_flags(m["id"])


# ---- pure helpers ----

def test_flat_paths_round_trip():
    mate = {"persona": {"language": "ko"}, "prefs": normalize_prefs({"tone": {"humor": "high"}})}
    v = STY.values(mate)
    assert v["tone.humor"] == "high" and v["language"] == "ko"
    assert STY.patch_of({"tone.humor": "low", "language": "en", "formality": "banmal"}) == {
        "persona": {"language": "en"}, "prefs": {"tone": {"humor": "low"}, "formality": "banmal"}}
    assert STY.flat_args({"tone": {"warmth": "high"}, "reason": "x", "address": ""}) == {"tone.warmth": "high",
                                                                                         "address": ""}
