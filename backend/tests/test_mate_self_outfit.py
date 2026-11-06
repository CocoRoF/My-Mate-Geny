"""She changes her clothes herself, because the user asked (docs/mate.md "Outfits"): the tool checks that they really said
it, that the outfit can be worn and that she is up for it; the model only says how it went."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from test_mate_outfits import _filled, _mate, _rig
from test_mate_style import _ctx, _Logs, _service, _turn

from app.mate import affinity as A
from app.mate import mcp_bridge
from app.mate import wardrobe as W
from app.mate.prompt import base_prompt, context_block, prompt_key, settings_change_note
from app.mate.store import DEFAULT_OUTFIT

NOW = datetime(2026, 11, 6, 12, tzinfo=timezone.utc)


def _haru(db, monkeypatch, *, mood="calm", stage="trusted", enabled=True, paused=False, logs=None):
    """A mate with a pajama set to change into, feeling a known way."""
    mates = _service(db, logs)
    m = _mate(mates)
    oid = _filled(mates, m, "잠옷", _rig("pj"))
    monkeypatch.setattr(A, "mood", lambda r, now, tz: {"label": mood})
    real = mates.relation_doc
    monkeypatch.setattr(mates, "_advanced", lambda mid, now, tz: {**real(mid), "stage": stage, "enabled": enabled,
                                                                  "paused": paused})
    return mates, m["id"], oid


def _says(mates, sid, text, **meta):
    return mates._svc.seed_message(sid, "user", text, provider="claude", meta=meta or None)


async def _ask(mates, mid, oid, text="잠옷으로 갈아입어", asked=None):
    """The user writes ``text``, and she calls the tool with it."""
    ctx, sid = await _ctx(mates, mid)
    if text is not None:
        _says(mates, sid, text)
    return await mates.call_tool(ctx, "change_outfit", {"outfit": oid, "asked": text if asked is None else asked})


def _worn(mates, mid):
    return mates.get(mid)["outfits"]["worn"]


async def test_asked_in_a_good_mood_she_changes_and_every_window_hears(db, monkeypatch):
    logs = _Logs()
    mates, mid, oid = _haru(db, monkeypatch, logs=logs)
    pushed = []
    mates.store.on_change = lambda reason, m: pushed.append((reason, m))
    text, err = await _ask(mates, mid, oid)
    assert not err and text.startswith("Changed to “잠옷”")
    assert _worn(mates, mid) == oid and mates.get(mid)["avatar"]["rig"]["home"] == "/x/pj.webp"
    assert ("updated", mid) in pushed
    assert any(kw.get("code") == "mate.outfit_changed" for _lv, _msg, kw in logs.rows)
    # back and forth doesn't leave the asks behind, and no client sees them
    assert "asks" not in mates.store.outfit_self(mid) and "self" not in mates.get(mid)["outfits"]


async def test_out_of_sorts_it_takes_asking_again(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch, mood="concerned")
    for n in (1, 2):
        text, err = await _ask(mates, mid, oid, f"잠옷 입어줘 {n}")
        assert not err and text.startswith("Not yet") and _worn(mates, mid) == DEFAULT_OUTFIT
        assert not any(c.isdigit() for c in text)  # (nothing she could repeat)
    text, _ = await _ask(mates, mid, oid, "잠옷 입어줘 3")
    assert text.startswith("Changed") and _worn(mates, mid) == oid


async def test_trying_again_in_one_turn_is_not_asking_again(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch, mood="focused")
    await _ask(mates, mid, oid, "잠옷 입어")
    for _ in range(3):
        text, _err = await _ask(mates, mid, oid, None, asked="잠옷 입어")
        assert text.startswith("Not yet")
    assert _worn(mates, mid) == DEFAULT_OUTFIT
    assert (await _ask(mates, mid, oid, "잠옷 입어 제발"))[0].startswith("Changed")


async def test_the_asks_are_for_one_outfit_and_go_stale(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch, mood="focused")
    other = _filled(mates, mates.get(mid), "여름옷", _rig("sm"))
    assert (await _ask(mates, mid, oid, "잠옷 입어"))[0].startswith("Not yet")
    assert (await _ask(mates, mid, other, "여름옷 입어"))[0].startswith("Not yet")  # (another one starts over)
    state = mates.store.outfit_self(mid)
    assert state["asks"]["outfit"] == other and len(state["asks"]["messages"]) == 1
    state["asks"]["at"] = A._iso(datetime.now(timezone.utc) - W.ASK_WINDOW - timedelta(minutes=1))
    mates.store.set_outfit_self(mid, state)
    assert (await _ask(mates, mid, other, "여름옷 입어봐"))[0].startswith("Not yet")  # (too long ago: starts over)
    assert (await _ask(mates, mid, other, "여름옷 입어봐봐"))[0].startswith("Changed")
    assert _worn(mates, mid) == other


async def test_the_asks_outlive_other_wardrobe_writes(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch, mood="focused")
    await _ask(mates, mid, oid, "잠옷 입어")
    mates.rename_outfit(mid, oid, "파자마")
    assert len(mates.store.outfit_self(mid)["asks"]["messages"]) == 1
    assert (await _ask(mates, mid, "파자마", "파자마 입어"))[0].startswith("Changed")


@pytest.mark.parametrize(("mood", "stage", "changed", "need"), [
    ("cheerful", "trusted", None, 1), ("content", "companion", None, 1), ("calm", "familiar", None, 1),
    ("focused", "trusted", None, 2), ("sleepy", "trusted", None, 2), ("concerned", "trusted", None, 3),
    ("calm", "new", None, 2), ("calm", "trusted", NOW - timedelta(minutes=9), 2),
    ("calm", "trusted", NOW - timedelta(minutes=11), 1), ("concerned", "new", NOW, 4), (None, None, None, 1),
])
def test_how_many_asks_it_takes(mood, stage, changed, need):
    assert W.asks_needed(mood, stage, changed, NOW) == need


async def test_with_the_relationship_off_or_paused_nothing_holds_her_back(db, monkeypatch):
    for kw in ({"enabled": False}, {"paused": True}):
        mates, mid, oid = _haru(db, monkeypatch, mood="concerned", stage="new", **kw)
        assert (await _ask(mates, mid, oid))[0].startswith("Changed")


async def test_having_just_changed_takes_one_more(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch)
    other = _filled(mates, mates.get(mid), "여름옷", _rig("sm"))
    assert (await _ask(mates, mid, oid))[0].startswith("Changed")
    assert (await _ask(mates, mid, other, "여름옷 입어"))[0].startswith("Not yet")
    assert (await _ask(mates, mid, other, "여름옷 입어줘"))[0].startswith("Changed")


async def test_nobody_asked_means_no_change(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch)
    ctx, sid = await _ctx(mates, mid)
    args = {"outfit": oid, "asked": "갈아입어"}
    # no message of theirs at all, then one started by something else, then words they didn't write
    for prepare in (lambda: None,
                    lambda: _says(mates, sid, "갈아입어", internal=True, kind="delegation_result"),
                    lambda: _says(mates, sid, "오늘 날씨 좋다")):
        prepare()
        text, err = await mates.call_tool(ctx, "change_outfit", args)
        assert err and "own words" in text
        assert _worn(mates, mid) == DEFAULT_OUTFIT
    assert (await mates.call_tool(ctx, "change_outfit", {"outfit": oid, "asked": "  "}))[1]
    assert (await mates.call_tool(ctx, "change_outfit", {"outfit": oid}))[1]
    assert _worn(mates, mid) == DEFAULT_OUTFIT


async def test_an_old_request_does_not_carry_over_an_internal_turn(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch, mood="focused")
    ctx, sid = await _ctx(mates, mid)
    assert (await _ask(mates, mid, oid, "잠옷 입어"))[0].startswith("Not yet")
    _says(mates, sid, "[screen]", internal=True, kind="screen_observation")
    _text, err = await mates.call_tool(ctx, "change_outfit", {"outfit": oid, "asked": "잠옷 입어"})
    assert err and _worn(mates, mid) == DEFAULT_OUTFIT


def test_the_quote_ignores_only_case_spacing_and_punctuation():
    assert W.said_it("갈아 입어!", "그 옷으로 갈아입어.")
    assert W.said_it("PUT IT ON", "please put it on")
    assert W.said_it("응", "응 그래")
    assert not W.said_it("잠옷 입어", "잠옷은 안 입어도 돼")
    assert not W.said_it("!!", "갈아입어!!") and not W.said_it("", "갈아입어") and not W.said_it(None, "갈아입어")


async def test_a_rude_message_is_not_an_ask(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch)
    text, err = await _ask(mates, mid, oid, "잠옷 입어 멍청아")
    assert not err and text.startswith("Not yet") and _worn(mates, mid) == DEFAULT_OUTFIT
    assert "asks" not in mates.store.outfit_self(mid)


async def test_closed_empty_and_already_on_change_nothing(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch)
    w = mates.store._wardrobe(mid)
    w["items"][0]["unlock"] = {"affinity": 60}
    mates.store._save_wardrobe(mid, w)
    text, err = await _ask(mates, mid, oid)
    assert not err and text.startswith("Closed") and "60" not in text and _worn(mates, mid) == DEFAULT_OUTFIT
    assert "asks" not in mates.store.outfit_self(mid)
    empty = mates.add_outfit(mid, "빈 옷")
    assert (await _ask(mates, mid, empty, "빈 옷 입어"))[0].startswith("Empty")
    assert (await _ask(mates, mid, DEFAULT_OUTFIT, "평소 옷 입어"))[0].startswith("Already")
    assert _worn(mates, mid) == DEFAULT_OUTFIT


async def test_back_to_her_usual_clothes_always_works(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch, mood="concerned")
    mates.wear_outfit(mid, oid)
    text, err = await _ask(mates, mid, DEFAULT_OUTFIT, "그거 벗고 평소 옷 입어 멍청아")
    assert not err and text.startswith("Changed back") and _worn(mates, mid) == DEFAULT_OUTFIT


async def test_she_can_only_name_what_she_has(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch)
    text, err = await _ask(mates, mid, "수영복", "수영복 입어")
    assert err and f"{oid} “잠옷”" in text and "default" in text and _worn(mates, mid) == DEFAULT_OUTFIT
    assert (await _ask(mates, mid, " 잠 옷 ", "잠옷 입어"))[0].startswith("Changed")  # (by name is fine too)


async def test_the_setting_takes_tool_and_rules_away(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch)
    req, prompt = _turn(mates, mid)
    assert "## Your clothes" in prompt and req.mcp_config["mcpServers"]["mate"]["env"]["HRH_MATE_OUTFIT"] == "1"
    on = prompt_key("Haru", {}, 0, {"self_outfit": "auto"})
    assert on != prompt_key("Haru", {}, 0, {"self_outfit": "off"})  # (the engine resumes with the new rules)
    mates.update(mid, {"prefs": {"self_outfit": "off"}})
    assert mates.get(mid)["prefs"]["self_outfit"] == "off"
    req, prompt = _turn(mates, mid)
    assert "## Your clothes" not in prompt and "change_outfit" not in prompt
    assert "HRH_MATE_OUTFIT" not in req.mcp_config["mcpServers"]["mate"]["env"]
    text, err = await _ask(mates, mid, oid)  # (an engine still running with the tool)
    assert err and "switched off" in text and _worn(mates, mid) == DEFAULT_OUTFIT
    mates.wear_outfit(mid, oid)  # (the user's own button is another matter)
    assert _worn(mates, mid) == oid
    note = lambda old, new: settings_change_note("Haru", {}, "Haru", {}, old, new)
    assert "no longer change your clothes" in note({"self_outfit": "auto"}, {"self_outfit": "off"})
    assert "change_outfit" in note({"self_outfit": "off"}, {"self_outfit": "auto"})
    assert note({}, {"self_outfit": "auto"}) == ""


def test_the_bridge_offers_the_tool_only_while_she_may(monkeypatch):
    monkeypatch.delenv("HRH_MATE_OUTFIT", raising=False)
    assert "change_outfit" not in [t["name"] for t in mcp_bridge.tools()]
    monkeypatch.setenv("HRH_MATE_OUTFIT", "1")
    tool = next(t for t in mcp_bridge.tools() if t["name"] == "change_outfit")
    assert tool["inputSchema"]["required"] == ["outfit", "asked"]


def test_the_rules_say_never_on_a_whim_and_let_the_tool_decide():
    text = base_prompt("Haru", {}, {})
    rules = text.split("## Your clothes")[1]
    assert "never on a whim" in rules and "it decides" in rules and "Never say you changed unless it says Changed" in rules
    assert "- change_outfit:" in text
    assert "Your clothes" not in base_prompt("Haru", {}, {"self_outfit": "off"})


def test_her_context_lists_the_wardrobe_only_when_it_is_news(db, monkeypatch):
    mates, mid, oid = _haru(db, monkeypatch)
    mate, prefs = mates.get(mid), {}
    st = {}
    line = mates._wardrobe_line(mate, prefs, st, 1)
    assert f"{oid} “잠옷”" in line and "default (your usual clothes)" in line
    assert "Your wardrobe, for change_outfit" in context_block(NOW, "UTC", wardrobe=line)
    assert mates._wardrobe_line(mate, prefs, st, 2) == ""
    assert mates._wardrobe_line(mate, prefs, st, 31) != ""  # (reminded now and then)
    mates.rename_outfit(mid, oid, "파자마")
    assert "“파자마”" in mates._wardrobe_line(mates.get(mid), prefs, st, 32)  # (told when it changed)
    assert mates._wardrobe_line(mates.get(mid), {"self_outfit": "off"}, {}, 1) == ""


def test_the_listing_hides_what_is_closed_and_skips_what_is_empty():
    cards = [{"id": DEFAULT_OUTFIT, "name": "", "kind": "video"},
             {"id": "a", "name": "잠옷", "kind": "photo", "note": "soft\n  pajamas"},
             {"id": "b", "name": "드레스", "kind": "none", "note": "", "locked": {"affinity": 60}},
             {"id": "c", "name": "빈 옷", "kind": "none", "note": ""}]
    line = W.listing(cards)
    assert "a “잠옷” (soft pajamas)" in line and "Not open to you yet: “드레스”" in line and "빈 옷" not in line
    assert "60" not in line and "b “" not in line  # (no id to try, no number to repeat)
    assert W.listing(cards[:1]) == "" and W.listing([cards[0], cards[3]]) == ""
    assert W.find(cards, "default")["id"] == DEFAULT_OUTFIT and W.find(cards, "잠 옷")["id"] == "a"
    assert W.find(cards, "") is None and W.find(cards, "없는 옷") is None
