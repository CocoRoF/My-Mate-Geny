"""The Mate Create studio (docs/avatar-create.md §11): a draft mate (hidden until finished) with the creation agent's
project; the agent's update_mate_draft (validated, never voice / model / avatar), the user's edits on the right and
what the agent hears about them (<studio_update>, once), per-field undo, finish → a mate in the list, discard →
everything gone, a new mate's avatar applied by itself when ready — and the credit gate exactly as before."""

from __future__ import annotations

import pytest

from app.avatar import plan as PL
from app.avatar import service as S
from app.avatar import studio as ST
from app.mate.store import MateError
from app.providers.base import TurnRequest
from tests.test_avatar import _services, _settle

CONCEPT = {"fields": {
    "name": "하린",
    "persona": {"description": "You are Harin, the user's calm older-sister secretary.",
                "personality": "Calm, attentive, a little teasing.", "speech": "Gentle 해요체.",
                "address": "주인님", "greeting": "오늘도 같이 해 봐요, 주인님."},
    "prefs": {"formality": "haeyo", "tone": {"warmth": "high"}},
    "concept": {"pitch": "A calm older-sister secretary who keeps your day in order.", "voice": "soft, warm, low",
                "palette": "#2B2D42, #F4C7D0, #EDF2F4"},
}}


def _ctx(av, pid):
    return {"project_id": pid, "session_id": av.doc(pid)["session_id"]}


def _turn(av, svc, pid) -> str:
    """The preamble the agent's next turn gets (configure_engine is what SessionService calls)."""
    req = TurnRequest(messages=[], model="", cwd="/tmp")
    av.configure_engine(svc.get(av.doc(pid)["session_id"]), req)
    return req.preamble


async def test_draft_lifecycle_hidden_until_finished(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    events = []
    monkeypatch.setattr(av, "_event", lambda pid, kind, text: events.append((kind, text)))
    before = [m["id"] for m in mates.list()]
    view = av.studio_open(language="ko")
    pid, st = view["id"], view["studio"]
    draft = st["mate"]
    assert st["kind"] == "new" and draft["draft"] is True and draft["name"] == ""
    assert view["brief"]["target"] == {"mode": "existing", "mate_id": draft["id"], "name": ""}
    assert events[0][0] == "start" and "concept" in events[0][1]
    # hidden: not in the mate list (nor made the default), but it can be read and edited
    assert [m["id"] for m in mates.list()] == before
    assert mates.get(draft["id"])["is_default"] is False
    assert [d["mate_id"] for d in av.drafts()] == [draft["id"]] and av.drafts()[0]["project_id"] == pid
    with pytest.raises(MateError):
        mates.conversation(draft["id"])  # (no chat with a mate that doesn't exist yet)
    # opening the draft again: the same project
    assert av.studio_open(mate_id=draft["id"])["id"] == pid
    # finish needs a name and who she is
    with pytest.raises(Exception) as exc:
        await av.studio_finish(pid)
    assert "name" in str(exc.value)
    text, err, _ = await av.call_tool(_ctx(av, pid), "update_mate_draft", CONCEPT)
    assert not err, text
    out = await av.studio_finish(pid)
    assert out["mate"]["draft"] is False and out["mate"]["name"] == "하린"
    assert out["mate"]["id"] in [m["id"] for m in mates.list()] and av.drafts() == []
    assert out["project"]["studio"]["finished_at"]
    assert events[-1][0] == "mate_created"
    with pytest.raises(Exception):
        av.studio_discard(pid)  # (a mate now, not a draft)


async def test_first_real_mate_becomes_the_default(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(av, "_event", lambda *a: None)
    for m in mates.store.list():
        mates.delete(m["id"])
    pid = av.studio_open()["id"]
    assert mates.store.list() == []  # (a draft doesn't count: no "Geny" in its place yet either)
    await av.call_tool(_ctx(av, pid), "update_mate_draft", CONCEPT)
    mate = (await av.studio_finish(pid))["mate"]
    assert mate["is_default"] is True


async def test_agent_fields_are_validated_and_never_touch_voice_model_or_avatar(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(av, "_event", lambda *a: None)
    pid = av.studio_open()["id"]
    ctx = _ctx(av, pid)
    mid = av.doc(pid)["studio"]["mate_id"]
    voice = mates.get(mid)["voice"]
    for bad, why in (({"fields": {"voice": {"tts": {"engine": "openai"}}}}, "unknown field"),
                     ({"fields": {"llm": {"model": "x"}}}, "unknown field"),
                     ({"fields": {"avatar": {"kind": "none"}}}, "unknown field"),
                     ({"fields": {"prefs": {"formality": "rude"}}}, "formality"),
                     ({"fields": {"prefs": {"tone": {"warmth": "very"}}}}, "tone"),
                     ({"fields": {"prefs": {"memory": {"recall": "off"}}}}, "unknown prefs"),
                     ({"fields": {"persona": {"description": "x" * 5000}}}, "too long"),
                     ({"fields": {"persona": {"mood": "x"}}}, "unknown persona"),
                     ({"fields": {"name": ""}}, "empty"),
                     ({"fields": {}}, "nothing to write")):
        text, err, _ = await av.call_tool(ctx, "update_mate_draft", bad)
        assert err and why in text, (bad, text)
    m = mates.get(mid)
    assert m["voice"] == voice and m["avatar"] == {"kind": "none"} and m["name"] == ""
    assert av.doc(pid)["studio"]["filled"] == {}
    text, err, _ = await av.call_tool(ctx, "update_mate_draft", CONCEPT)
    assert not err and "missing_to_create" in text
    m = mates.get(mid)
    assert m["name"] == "하린" and m["persona"]["address"] == "주인님" and m["prefs"]["formality"] == "haeyo"
    assert m["prefs"]["tone"]["warmth"] == "high" and m["prefs"]["tone"]["humor"] == "auto"
    assert m["voice"] == voice
    doc = av.doc(pid)
    assert doc["studio"]["concept"]["voice"] == "soft, warm, low"
    assert doc["title"] == "하린" and doc["brief"]["target"]["name"] == "하린"
    filled = doc["studio"]["filled"]
    assert {"name", "persona.description", "persona.address", "prefs.formality", "prefs.tone.warmth",
            "concept.pitch"} <= set(filled)
    assert filled["name"]["prev"] == ""
    # get_project tells the agent the draft and what is still missing
    text, err, _ = await av.call_tool(ctx, "get_project", {})
    assert '"kind": "new"' in text and "하린" in text and '"missing_to_create": []' in text


async def test_user_edits_reach_the_agent_once_and_undo(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(av, "_event", lambda *a: None)
    pid = av.studio_open()["id"]
    await av.call_tool(_ctx(av, pid), "update_mate_draft", CONCEPT)
    assert "<studio_update>" not in _turn(av, svc, pid)  # (what the agent wrote itself is no news)
    # the user changes the personality and the speech level on the right, and the voice
    view = await av.studio_fields(pid, {"persona": {"personality": "Cheerful and blunt."},
                                        "prefs": {"formality": "banmal"},
                                        "voice": {"tts": {"engine": "off"}}})
    filled = view["studio"]["filled"]
    assert "persona.personality" not in filled and "prefs.formality" not in filled  # (theirs now: no badge)
    assert "persona.description" in filled and view["studio"]["voice_ok"] is True
    note = _turn(av, svc, pid)
    assert note.startswith("<studio_update>")
    assert "persona.personality: Calm, attentive, a little teasing. → Cheerful and blunt." in note
    assert "prefs.formality: haeyo → banmal" in note and "voice: browser → off" in note
    assert "persona.description" not in note
    assert _turn(av, svc, pid) == ""  # once
    # undo the agent's name: back to empty (a draft may be nameless); the agent hears of it
    view = await av.studio_undo(pid, "name")
    assert view["studio"]["mate"]["name"] == "" and "name" not in view["studio"]["filled"]
    assert "name: 하린 → (empty)" in _turn(av, svc, pid)
    with pytest.raises(Exception):
        await av.studio_undo(pid, "persona.personality")  # (the user's own value: nothing to undo)
    # undo a concept note
    await av.studio_undo(pid, "concept.voice")
    assert "voice" not in av.view(pid)["studio"]["concept"]
    # a template: another mate's profile/style/voice (not its name or avatar)
    src = mates.create({"name": "Src", "persona": {"description": "Template mate.", "speech": "Dry."}})
    view = await av.studio_template(pid, src["id"])
    m = view["studio"]["mate"]
    assert m["persona"]["description"] == "Template mate." and m["name"] == ""


async def test_discard_removes_the_draft_and_untouched_drafts_are_dropped(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(av, "_event", lambda *a: None)
    first = av.studio_open()
    mid, pid, sid = first["studio"]["mate_id"], first["id"], first["session_id"]
    # an untouched draft (nothing written, nothing answered) goes when a new one starts
    second = av.studio_open()
    assert second["id"] != pid
    with pytest.raises(KeyError):
        mates.get(mid)
    assert not av.dir(pid).exists()
    with pytest.raises(KeyError):
        svc.get(sid)
    # a draft with work in it stays…
    await av.call_tool(_ctx(av, second["id"]), "update_mate_draft", {"fields": {"concept": {"pitch": "x"}}})
    third = av.studio_open()
    assert {d["project_id"] for d in av.drafts()} == {second["id"], third["id"]}
    # …until discarded
    mid2 = second["studio"]["mate_id"]
    av.studio_discard(second["id"])
    with pytest.raises(KeyError):
        mates.get(mid2)
    assert not av.dir(second["id"]).exists()
    assert [d["project_id"] for d in av.drafts()] == [third["id"]]


async def test_the_gate_is_unchanged_in_the_studio_and_the_avatar_lands_on_the_new_mate(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(av, "_event", lambda *a: None)
    pid = av.studio_open()["id"]
    ctx = _ctx(av, pid)
    mid = av.doc(pid)["studio"]["mate_id"]
    await av.call_tool(ctx, "update_mate_draft", CONCEPT)
    # the brief's target is the draft whatever the agent says
    text, err, _ = await av.call_tool(ctx, "update_brief", {"patch": {
        "design": {"prompt": "A calm young woman with a navy cardigan."}, "preset": "minimal", "candidates": 2,
        "target": {"mode": "new", "name": "Other"}}})
    assert not err, text
    assert av.doc(pid)["brief"]["target"]["mate_id"] == mid
    text, err, _ = await av.call_tool(ctx, "estimate", {})
    assert not err
    doc = av.doc(pid)
    # nothing spends before the user's Confirm: not the agent's redo, not a wrong total, not finishing the mate
    text, err, _ = await av.call_tool(ctx, "regenerate", {"item": "design"})
    assert err and "not_confirmed" in text
    with pytest.raises(PL.GateError):
        await av.confirm(pid, doc["plan"]["id"], doc["plan"]["total"] - 1)
    await av.call_tool(ctx, "update_mate_draft", {"fields": {"persona": {"speech": "Soft."}}})
    assert av.gen.created == [] and av.doc(pid)["confirmation"] is None
    assert av.doc(pid)["status"] == "estimate"  # (the mate's fields don't touch the plan)
    # finishing the mate while the avatar waits for Confirm: still nothing spent
    await av.studio_finish(pid)
    assert av.gen.created == [] and av.doc(pid)["status"] == "estimate"
    await av.confirm(pid, doc["plan"]["id"], doc["plan"]["total"])
    await _settle(av, pid)
    await av.checkpoint(pid, "pick", candidate="c1")
    await _settle(av, pid)
    await av.checkpoint(pid, "approve")
    await _settle(av, pid)
    await av.checkpoint(pid, "approve")
    await _settle(av, pid, ("ready", "applied"))
    for _ in range(100):
        if av.doc(pid)["status"] == "applied":
            break
        await S.asyncio.sleep(0.02)
    assert av.doc(pid)["applied"]["mate_id"] == mid
    assert mates.get(mid)["avatar"]["kind"] == "video"


async def test_existing_mate_studio_reuses_its_project_and_asks_concepts(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(av, "_event", lambda *a: None)
    mate = mates.create({"name": "Mina"})
    old = av.create(mate_id=mate["id"])  # (a project from before the studio)
    view = av.studio_open(mate_id=mate["id"])
    assert view["id"] == old["id"] and view["studio"]["kind"] == "existing"
    assert av.studio_open(mate_id=mate["id"], fresh=True)["id"] != old["id"]
    with pytest.raises(Exception):
        await av.studio_finish(view["id"])  # (she exists)
    with pytest.raises(Exception):
        av.studio_discard(view["id"])
    with pytest.raises(Exception):
        await av.studio_fields(view["id"], {"name": " "})
    # the agent's prompt knows whose avatar it is; the concepts card
    req = TurnRequest(messages=[], model="", cwd="/tmp")
    av.configure_engine(svc.get(view["session_id"]), req)
    prompt = open(req.system_prompt_file, encoding="utf-8").read()
    assert "studio for the existing mate “Mina”" in prompt and "update_mate_draft" in prompt
    ctx = _ctx(av, view["id"])
    q = {"question": "Which direction?", "kind": "concepts", "options": [
        {"value": "a", "label": "Calm", "description": "A calm one.", "palette": ["#112233", "red", "#AABBCC"]},
        {"value": "b", "label": "Bright", "description": "A bright one."}]}
    text, err, _ = await av.call_tool(ctx, "ask_user", q)
    assert not err, text
    card = av.doc(view["id"])["question"]
    assert card["kind"] == "concepts" and card["options"][0]["palette"] == ["#112233", "#AABBCC"]
    assert card["allow_other"] is True
    text, err, _ = await av.call_tool(ctx, "ask_user", {**q, "options": q["options"][:1]})
    assert err and "2 to 4" in text


def test_the_new_mate_prompt_starts_with_the_concept():
    from app.avatar.prompt import system_prompt

    p = system_prompt(language="ko", state="S", emotions=["joy"], studio="new")
    assert p.startswith("You are the Mate Create agent") and "Always reply in Korean" in p
    assert p.index("Part 1 — the concept") < p.index("## Credits") < p.index("## The interview")
    assert "goes on the new mate by itself" in p and "press Apply" not in p
    assert "update_mate_draft" in p and "Which mate gets it" not in p and 'kind "concepts"' in p
    plain = system_prompt(language="en", state="S", emotions=["joy"])
    assert "update_mate_draft" not in plain and "Which mate gets it" in plain


def test_studio_helpers():
    seen = ST.snapshot({"name": "A", "persona": {"speech": "x"}, "prefs": {}}, {})
    now = ST.snapshot({"name": "B", "persona": {"speech": "x"}, "prefs": {}}, {"pitch": "p"})
    note = ST.update_note(seen, now)
    assert "- name: A → B" in note and "- concept.pitch: (empty) → p" in note and "speech" not in note
    assert ST.update_note(None, now) == "" and ST.update_note(now, now) == ""
    assert ST.patch_for("prefs.tone.humor", "high") == ({"prefs": {"tone": {"humor": "high"}}}, {})
    assert ST.missing({"name": " ", "persona": {}}) == ["name", "persona.description or persona.personality"]
    assert ST.missing({"name": "A", "persona": {"personality": "kind"}}) == []
