"""The wardrobe (docs/mate.md "Outfits", docs/avatar-create.md §12): whole avatar sets, her default set always kept."""

import asyncio
import json

import pytest
from test_avatar import FakeDeps, FakeGen, _services, _settle

from app.avatar import presets as P
from app.avatar.prompt import system_prompt
from app.avatar.store import AvatarError
from app.mate import files
from app.mate.prompt import context_block
from app.mate.store import DEFAULT_OUTFIT, MateError


def _rig(name, *, clips=("idle_a",), disabled=()):
    return {"kind": "video", "rig": {"aspect": [10, 12], "home": f"/x/{name}.webp", "stills": {"neutral": f"/x/{name}.webp"},
                                     "clips": [{"id": c, "kind": "idle", "src": f"/x/{name}-{c}.mp4",
                                                **({"disabled": True} if c in disabled else {})} for c in clips]}}


def _mate(mates, name="Haru", avatar=None):
    return mates.create({"name": name, "avatar": avatar or _rig("base")})


@pytest.mark.asyncio
async def test_wearing_swaps_the_whole_set_and_her_default_stays(db, tmp_path, monkeypatch):
    _svc, mates, _av = _services(db, tmp_path, monkeypatch)
    m = _mate(mates)
    assert m["outfits"]["worn"] == DEFAULT_OUTFIT and [c["id"] for c in m["outfits"]["items"]] == [DEFAULT_OUTFIT]
    oid = mates.add_outfit(m["id"], name="잠옷", avatar=_rig("pajamas"), preset="pajamas", note="pajamas")
    # (added, not put on)
    assert mates.get(m["id"])["avatar"] == _rig("base") and mates.get(m["id"])["outfits"]["worn"] == DEFAULT_OUTFIT

    worn = mates.wear_outfit(m["id"], oid)
    assert worn["avatar"]["rig"]["home"] == "/x/pajamas.webp"
    assert worn["outfits"]["worn"] == oid
    assert [c["home"] for c in worn["outfits"]["items"]] == ["/x/base.webp", "/x/pajamas.webp"]
    assert mates.store.base_avatar(m["id"])["rig"]["home"] == "/x/base.webp"

    # an edit made while wearing it stays with that set
    edited = _rig("pajamas", clips=("idle_a", "idle_b"), disabled=("idle_b",))
    mates.update(m["id"], {"avatar": edited})
    back = mates.wear_outfit(m["id"], DEFAULT_OUTFIT)
    assert back["avatar"] == _rig("base") and back["outfits"]["items"][1]["clips"] == 2
    assert mates.wear_outfit(m["id"], oid)["avatar"]["rig"]["clips"][1].get("disabled") is True

    # deleting what she has on puts her default set back; the default set can't go
    assert mates.delete_outfit(m["id"], oid)["avatar"] == _rig("base")
    with pytest.raises(MateError):
        mates.delete_outfit(m["id"], DEFAULT_OUTFIT)
    with pytest.raises(KeyError):
        mates.wear_outfit(m["id"], "nope")


@pytest.mark.asyncio
async def test_a_builtin_stays_uncustomized_and_bundle_updates_reach_her_default_set(db, tmp_path, monkeypatch):
    _svc, mates, _av = _services(db, tmp_path, monkeypatch)
    m = _mate(mates)
    db.execute("UPDATE mates SET builtin = 'chaerin' WHERE id = ?", (m["id"],))
    oid = mates.add_outfit(m["id"], name="잠옷", avatar=_rig("pajamas"))
    mates.wear_outfit(m["id"], oid)
    mates.update(m["id"], {"avatar": _rig("pajamas", clips=("idle_a", "idle_b"))})
    assert not mates.get(m["id"])["customized"]
    # a bundle update while she wears an outfit: her default set changes, what she has on doesn't
    mates.store.update(m["id"], {"avatar": _rig("bundle-2"), "_sync": True})
    assert mates.get(m["id"])["avatar"]["rig"]["home"] == "/x/pajamas.webp"
    assert mates.store.base_avatar(m["id"])["rig"]["home"] == "/x/bundle-2.webp"
    assert mates.wear_outfit(m["id"], DEFAULT_OUTFIT)["avatar"]["rig"]["home"] == "/x/bundle-2.webp"


@pytest.mark.asyncio
async def test_the_packs_of_the_whole_wardrobe_survive_an_avatar_edit(db, tmp_path, monkeypatch):
    _svc, mates, _av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(files.settings, "data_home", str(tmp_path / "home"), raising=False)
    m = _mate(mates)
    assets = files.assets_dir(m["id"])
    url = lambda pack: f"/api/mates/{m['id']}/assets/{pack}/n.webp"  # noqa: E731
    pack = lambda name: {"kind": "video", "rig": {"aspect": [1, 1], "home": url(name), "stills": {}, "clips": []}}  # noqa: E731
    a, b, c = "pack-" + "a" * 12, "pack-" + "b" * 12, "pack-" + "c" * 12
    for name in (a, b, c):
        (assets / name).mkdir(parents=True)
    mates.update(m["id"], {"avatar": pack(a)})
    oid = mates.add_outfit(m["id"], name="잠옷", avatar=pack(b))
    mates.update(m["id"], {"avatar": pack(c)})  # (a goes: nothing uses it; b is in the wardrobe)
    assert sorted(p.name for p in assets.iterdir() if p.is_dir()) == [b, c]
    mates.delete_outfit(m["id"], oid)
    assert sorted(p.name for p in assets.iterdir() if p.is_dir()) == [c]


def test_presets_stay_ordinary_clothes_and_swimwear_is_for_stated_adults():
    for key, entry in P.OUTFITS.items():
        text = entry["prompt"].lower()
        assert text.count("wearing") == 1, key
        assert not any(w in text for w in ("underwear", "lingerie", "bikini", "school", "one-piece")), key
    assert "swimwear" in [p["id"] for p in P.outfit_presets("chaerin")]
    for who in (None, "mao", "someone"):
        assert "swimwear" not in [p["id"] for p in P.outfit_presets(who)]
        assert "pajamas" in [p["id"] for p in P.outfit_presets(who)]


def test_outfit_brief_starts_from_her_set_without_the_clips_switched_off():
    base = _rig("base", clips=("idle_a", "talk_b"), disabled=("talk_b",))
    b = P.outfit_brief("casual", base, ["ref-1.webp"], {"mode": "existing", "mate_id": "m", "name": "Haru"})
    assert b["reference"] == {"mode": "redraw", "files": ["ref-1.webp"]}
    assert "talk_b" not in [c["id"] for c in b["clips"]] and "talk_a" in [c["id"] for c in b["clips"]]
    assert b["design"]["prompt"] == P.OUTFITS["casual"]["prompt"] and not P.problems(b)
    swim = P.outfit_brief("swimwear", base, ["r.webp"], {"mode": "existing", "mate_id": "m", "name": "Haru"})
    assert swim["preset"] == "minimal" and "shy" not in [c["id"] for c in swim["clips"]]
    free = P.outfit_brief(None, base, ["r.webp"], {"mode": "existing", "mate_id": "m", "name": "Haru"})
    assert P.problems(free)  # (the conversation writes what she wears)


def test_outfit_prompts_keep_her_and_change_only_the_clothes():
    text = P.design_prompt("Wearing pajamas.", redraw=True, outfit=True)
    assert text.startswith(P.OUTFIT) and "exactly the same face" in text and text.endswith(P.OUTFIT_CROP)
    assert "outfit, colours" not in text  # (the normal redraw keeps the clothes)
    assert P.OUTFIT_CLOTHES_REFS in P.design_prompt("Wearing x.", redraw=True, outfit=True, clothes_refs=True)
    assert P.design_prompt("Wearing x.", redraw=False, outfit=True).startswith("Wearing x.")  # (no picture of her)


def test_the_agent_is_told_the_limits_and_only_the_outfit_interview():
    args = dict(language="ko", state="Project p.", emotions=["joy"], studio="outfit", mate="한채린")
    yes, no = system_prompt(**args, swimwear=True), system_prompt(**args, swimwear=False)
    for text in (yes, no):
        assert "Wardrobe agent" in text and "한채린" in text and "Korean" in text
        assert "Never underwear or lingerie" in text and "school" in text
        assert "The outfit interview" in text and "## The interview" not in text
        assert "## Your tools" in text and "## Credits" in text and "## While it runs" in text
        assert "update_mate_draft" not in text and "Which mate gets it" not in text
    assert "rash guard" in yes and "No swimwear for this mate" in no


def test_the_mate_knows_what_she_has_on():
    from datetime import datetime, timezone

    now = datetime(2026, 11, 6, tzinfo=timezone.utc)
    assert "outfit" not in context_block(now, "UTC")
    line = context_block(now, "UTC", outfit={"name": "잠옷", "note": "soft pajamas"})
    assert "“잠옷”: soft pajamas" in line and "replaces the clothes your profile describes" in line


def _with_picture(mates, tmp_path):
    m = _mate(mates)
    pic = files.assets_dir(m["id"]) / "pack-abc" / "n.webp"
    pic.parent.mkdir(parents=True)
    pic.write_bytes(b"webp")
    url = f"/api/mates/{m['id']}/assets/pack-abc/n.webp?v=1"
    mates.update(m["id"], {"avatar": {"kind": "video", "rig": {"aspect": [10, 12], "home": url, "stills": {"neutral": url},
                                                               "clips": []}}})
    return mates.get(m["id"])


@pytest.mark.asyncio
async def test_a_preset_project_runs_behind_the_gate_and_lands_in_the_wardrobe(db, tmp_path, monkeypatch):
    gen, deps = FakeGen(), FakeDeps()
    _svc, mates, av = _services(db, tmp_path, monkeypatch, gen=gen, deps=deps)
    monkeypatch.setattr(files.settings, "data_home", str(tmp_path / "home"), raising=False)
    m = _with_picture(mates, tmp_path)
    p = av.studio_open(mate_id=m["id"], language="ko", outfit={"preset": "casual"})
    pid = p["id"]
    assert p["outfit"]["name"] == "데일리 캐주얼" and p["title"] == f"{m['name']} · 데일리 캐주얼"
    assert p["brief"]["reference"]["mode"] == "redraw" and (av.dir(pid) / "ref" / "ref-1.webp").is_file()
    assert p["studio"]["kind"] == "existing"
    # the same choice, nothing done yet: the same project; her normal avatar studio doesn't open it
    assert av.studio_open(mate_id=m["id"], language="ko", outfit={"preset": "casual"})["id"] == pid
    assert av.studio_open(mate_id=m["id"], language="ko")["id"] != pid

    # the agent names it; it can't move the reference; the gate is the same: nothing without the user's confirmation
    await av._tool_update_brief(pid, {"patch": {"outfit_name": "편한 옷", "reference": {"mode": "none"}}})
    doc = av.doc(pid)
    assert doc["outfit"]["name"] == "편한 옷" and doc["brief"]["reference"]["mode"] == "redraw"
    assert doc["title"].endswith("· 편한 옷")
    assert not gen.created
    plan = await av._estimate(doc)
    await av.confirm(pid, plan["id"], plan["total"])
    doc = await _settle(av, pid)
    assert doc["checkpoint"]["stage"] == "pick" and len(gen.created) == 3

    # candidates came from her flattened picture with the keep-her prompt
    flat = str(av.dir(pid) / "ref" / "her-flat.jpg")
    assert all(P.OUTFIT in " ".join(flags) and flat in flags for _jt, flags in gen.created)
    assert ("flatten", [str(av.dir(pid) / "ref" / "ref-1.webp"), flat]) in deps.calls

    await av.checkpoint(pid, "pick", candidate="c1")
    await _settle(av, pid)
    await av.checkpoint(pid, "approve")
    await _settle(av, pid)
    await av.checkpoint(pid, "approve")
    doc = await _settle(av, pid)
    assert doc["status"] == "ready", doc.get("error")
    for _ in range(100):
        if av.doc(pid)["outfit"].get("id"):
            break
        await asyncio.sleep(0.02)
    doc = av.doc(pid)
    oid = doc["outfit"]["id"]
    mate = mates.get(m["id"])
    assert oid and mate["outfits"]["worn"] == DEFAULT_OUTFIT  # (in the wardrobe, not on her)
    card = next(c for c in mate["outfits"]["items"] if c["id"] == oid)
    assert card["name"] == "편한 옷" and card["preset"] == "casual" and card["note"]

    # Wear: on her, no backup, nothing imported twice
    packs = {d.name for d in files.assets_dir(m["id"]).iterdir() if d.name.startswith("pack-")}
    res = await av.apply(pid, mate_id=m["id"])
    assert res["mate"]["outfits"]["worn"] == oid and res["project"]["applied"]["backup"] is None
    assert {d.name for d in files.assets_dir(m["id"]).iterdir() if d.name.startswith("pack-")} == packs
    assert res["mate"]["avatar"]["rig"]["home"] != m["avatar"]["rig"]["home"]
    assert mates.store.base_avatar(m["id"])["rig"]["home"] == m["avatar"]["rig"]["home"]


@pytest.mark.asyncio
async def test_swimwear_preset_is_refused_for_a_mate_without_a_stated_adult_age(db, tmp_path, monkeypatch):
    _svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(files.settings, "data_home", str(tmp_path / "home"), raising=False)
    m = _with_picture(mates, tmp_path)
    with pytest.raises(AvatarError) as err:
        av.studio_open(mate_id=m["id"], language="ko", outfit={"preset": "swimwear"})
    assert err.value.status == 409
    db.execute("UPDATE mates SET builtin = 'chaerin' WHERE id = ?", (m["id"],))
    p = av.studio_open(mate_id=m["id"], language="ko", outfit={"preset": "swimwear"})
    assert p["brief"]["preset"] == "minimal" and p["brief"]["candidates"] == 3


@pytest.mark.asyncio
async def test_a_new_avatar_goes_on_her_default_set_not_on_the_outfit(db, tmp_path, monkeypatch):
    _svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(files.settings, "data_home", str(tmp_path / "home"), raising=False)
    m = _mate(mates)
    oid = mates.add_outfit(m["id"], name="잠옷", avatar=_rig("pajamas"))
    mates.wear_outfit(m["id"], oid)
    p = av.create(mate_id=m["id"], language="ko")
    pid = p["id"]
    exp = av.dir(pid) / "export"
    exp.mkdir(parents=True)
    (exp / "neutral.webp").write_bytes(b"w")
    (exp / "rig.json").write_text(json.dumps({"aspect": [1, 1], "home": "asset:x/neutral.webp",
                                              "stills": {"neutral": "asset:x/neutral.webp"}, "clips": []}))
    res = await av.apply(pid, mate_id=m["id"])
    assert res["mate"]["outfits"]["worn"] == DEFAULT_OUTFIT
    assert next(c for c in res["mate"]["outfits"]["items"] if c["id"] == oid)["home"] == "/x/pajamas.webp"
