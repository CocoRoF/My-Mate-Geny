"""The wardrobe (docs/mate.md "Outfits", docs/avatar-create.md §12): a mate has her default set and the outfits the user
added; an outfit starts empty and is filled like any avatar."""

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


def _filled(mates, m, name, rig):
    oid = mates.add_outfit(m["id"], name)
    mates.set_outfit_avatar(m["id"], oid, rig)
    return oid


@pytest.mark.asyncio
async def test_a_mate_only_has_what_was_added_and_an_added_outfit_starts_empty(db, tmp_path, monkeypatch):
    _svc, mates, _av = _services(db, tmp_path, monkeypatch)
    m, other = _mate(mates), _mate(mates, "Other")
    assert [c["id"] for c in m["outfits"]["items"]] == [DEFAULT_OUTFIT] and m["outfits"]["worn"] == DEFAULT_OUTFIT
    oid = mates.add_outfit(m["id"], " 잠옷 ")
    mate = mates.get(m["id"])
    card = mate["outfits"]["items"][1]
    assert card["id"] == oid and card["name"] == "잠옷" and card["kind"] == "none" and not card["home"]
    assert mate["avatar"] == _rig("base")  # (what she has on doesn't change)
    assert [c["id"] for c in mates.get(other["id"])["outfits"]["items"]] == [DEFAULT_OUTFIT]
    with pytest.raises(MateError, match="empty"):
        mates.wear_outfit(m["id"], oid)
    with pytest.raises(MateError, match="name"):
        mates.add_outfit(m["id"], "  ")


@pytest.mark.asyncio
async def test_filling_and_wearing_swaps_the_whole_set_and_her_default_stays(db, tmp_path, monkeypatch):
    _svc, mates, _av = _services(db, tmp_path, monkeypatch)
    m = _mate(mates)
    oid = _filled(mates, m, "잠옷", _rig("pajamas"))
    # (filled, not put on)
    assert mates.get(m["id"])["avatar"] == _rig("base") and mates.get(m["id"])["outfits"]["worn"] == DEFAULT_OUTFIT
    assert mates.outfit(m["id"], oid)["avatar"] == _rig("pajamas")

    worn = mates.wear_outfit(m["id"], oid)
    assert worn["avatar"]["rig"]["home"] == "/x/pajamas.webp" and worn["outfits"]["worn"] == oid
    assert [c["home"] for c in worn["outfits"]["items"]] == ["/x/base.webp", "/x/pajamas.webp"]
    assert mates.outfit(m["id"], DEFAULT_OUTFIT)["avatar"] == _rig("base")

    # an edit made while wearing it stays with that set; her default can be edited meanwhile
    edited = _rig("pajamas", clips=("idle_a", "idle_b"), disabled=("idle_b",))
    mates.update(m["id"], {"avatar": edited})
    mates.set_outfit_avatar(m["id"], DEFAULT_OUTFIT, _rig("base2"))
    assert mates.get(m["id"])["avatar"] == edited
    back = mates.wear_outfit(m["id"], DEFAULT_OUTFIT)
    assert back["avatar"] == _rig("base2") and back["outfits"]["items"][1]["clips"] == 2
    assert mates.wear_outfit(m["id"], oid)["avatar"]["rig"]["clips"][1].get("disabled") is True
    # filling the set she has on changes her at once
    mates.set_outfit_avatar(m["id"], oid, _rig("pajamas3"))
    assert mates.get(m["id"])["avatar"] == _rig("pajamas3")

    # deleting what she has on puts her default set back; the default set can't go
    assert mates.delete_outfit(m["id"], oid)["avatar"] == _rig("base2")
    with pytest.raises(MateError):
        mates.delete_outfit(m["id"], DEFAULT_OUTFIT)
    with pytest.raises(KeyError):
        mates.wear_outfit(m["id"], "nope")


@pytest.mark.asyncio
async def test_a_builtin_stays_uncustomized_and_bundle_updates_reach_her_default_set(db, tmp_path, monkeypatch):
    _svc, mates, _av = _services(db, tmp_path, monkeypatch)
    m = _mate(mates)
    db.execute("UPDATE mates SET builtin = 'chaerin' WHERE id = ?", (m["id"],))
    oid = _filled(mates, m, "잠옷", _rig("pajamas"))
    mates.wear_outfit(m["id"], oid)
    mates.update(m["id"], {"avatar": _rig("pajamas", clips=("idle_a", "idle_b"))})
    assert not mates.get(m["id"])["customized"]
    # a bundle update while she wears an outfit: her default set changes, what she has on doesn't
    mates.store.update(m["id"], {"avatar": _rig("bundle-2"), "_sync": True})
    assert mates.get(m["id"])["avatar"]["rig"]["home"] == "/x/pajamas.webp"
    assert mates.store.base_avatar(m["id"])["rig"]["home"] == "/x/bundle-2.webp"
    # (editing her default set from here is the user's own version, like any avatar edit)
    mates.set_outfit_avatar(m["id"], DEFAULT_OUTFIT, _rig("mine"))
    assert mates.get(m["id"])["customized"]
    assert mates.wear_outfit(m["id"], DEFAULT_OUTFIT)["avatar"]["rig"]["home"] == "/x/mine.webp"


@pytest.mark.asyncio
async def test_the_files_of_the_whole_wardrobe_survive_and_go_with_their_outfit(db, tmp_path, monkeypatch):
    _svc, mates, _av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(files.settings, "data_home", str(tmp_path / "home"), raising=False)
    m = _mate(mates)
    assets = files.assets_dir(m["id"])
    url = lambda pack: f"/api/mates/{m['id']}/assets/{pack}/n.webp"  # noqa: E731
    pack = lambda name: {"kind": "video", "rig": {"aspect": [1, 1], "home": url(name), "stills": {}, "clips": []}}  # noqa: E731
    a, b, c = "pack-" + "a" * 12, "pack-" + "b" * 12, "pack-" + "c" * 12
    (assets / a).mkdir(parents=True)
    mates.update(m["id"], {"avatar": pack(a)})
    (assets / b).mkdir()
    oid = _filled(mates, m, "잠옷", pack(b))
    upload = files.outfit_upload_dir(m["id"], oid) / "stills"
    upload.mkdir(parents=True)
    (assets / c).mkdir()
    mates.update(m["id"], {"avatar": pack(c)})  # (a goes: nothing uses it; b is in the wardrobe)
    assert sorted(p.name for p in assets.iterdir() if p.name.startswith("pack-")) == [b, c]
    mates.delete_outfit(m["id"], oid)
    assert sorted(p.name for p in assets.iterdir() if p.name.startswith("pack-")) == [c]
    assert not upload.exists()


def test_outfit_brief_starts_from_her_set_without_the_clips_switched_off():
    base = _rig("base", clips=("idle_a", "talk_b"), disabled=("talk_b",))
    b = P.outfit_brief(base, ["ref-1.webp"], {"mode": "existing", "mate_id": "m", "name": "Haru"})
    assert b["reference"] == {"mode": "redraw", "files": ["ref-1.webp"]} and b["candidates"] == 3
    assert "talk_b" not in [c["id"] for c in b["clips"]] and "talk_a" in [c["id"] for c in b["clips"]]
    assert P.problems(b)  # (the conversation writes what she wears)
    assert P.outfit_brief({"kind": "none"}, [], b["target"])["reference"]["mode"] == "none"


def test_an_outfit_image_prompt_is_only_her_the_clothes_and_the_framing():
    text = P.design_prompt("Wearing pajamas.", redraw=True, outfit=True)
    assert text == f"{P.OUTFIT} Wearing pajamas. {P.FRAMING} {P.OUTFIT_CROP}"
    for word in ("sexual", "adult", "modest", "appropriate", "safe"):
        assert word not in text.lower()
    assert P.OUTFIT_CLOTHES_REFS in P.design_prompt("Wearing x.", redraw=True, outfit=True, clothes_refs=True)
    assert P.design_prompt("Wearing x.", redraw=False, outfit=True).startswith("Wearing x.")  # (no picture of her)


def test_the_outfit_agent_has_its_own_short_interview():
    text = system_prompt(language="ko", state="Project p.", emotions=["joy"], studio="outfit", mate="한채린")
    assert "Wardrobe agent" in text and "한채린" in text and "Korean" in text
    assert "The outfit interview" in text and "## The interview" not in text
    assert "## Your tools" in text and "## Credits" in text and "## While it runs" in text
    assert "update_mate_draft" not in text and "Which mate gets it" not in text
    assert "{" not in text.split("## The outfit interview")[1]  # (nothing left unfilled)
    assert "What you may make" not in text  # (its model's own judgment and the image model's own filter decide)


def test_the_mate_knows_what_she_has_on():
    from datetime import datetime, timezone

    now = datetime(2026, 11, 6, tzinfo=timezone.utc)
    assert "outfit" not in context_block(now, "UTC")
    line = context_block(now, "UTC", outfit={"name": "잠옷", "note": "soft pajamas"})
    assert "“잠옷”: soft pajamas" in line and "replaces the clothes your profile describes" in line
    assert "“잠옷”." in context_block(now, "UTC", outfit={"name": "잠옷", "note": ""})


def _with_picture(mates):
    m = _mate(mates)
    pic = files.assets_dir(m["id"]) / "pack-abc" / "n.webp"
    pic.parent.mkdir(parents=True)
    pic.write_bytes(b"webp")
    url = f"/api/mates/{m['id']}/assets/pack-abc/n.webp?v=1"
    mates.update(m["id"], {"avatar": {"kind": "video", "rig": {"aspect": [10, 12], "home": url, "stills": {"neutral": url},
                                                               "clips": []}}})
    return mates.get(m["id"])


@pytest.mark.asyncio
async def test_ai_fills_its_outfit_behind_the_gate(db, tmp_path, monkeypatch):
    gen, deps = FakeGen(), FakeDeps()
    _svc, mates, av = _services(db, tmp_path, monkeypatch, gen=gen, deps=deps)
    monkeypatch.setattr(files.settings, "data_home", str(tmp_path / "home"), raising=False)
    m = _with_picture(mates)
    oid = mates.add_outfit(m["id"], "편한 옷")
    p = av.studio_open(mate_id=m["id"], language="ko", outfit={"id": oid})
    pid = p["id"]
    assert p["outfit"]["id"] == oid and p["outfit"]["name"] == "편한 옷" and p["title"] == f"{m['name']} · 편한 옷"
    assert p["brief"]["reference"]["mode"] == "redraw" and (av.dir(pid) / "ref" / "ref-1.webp").is_file()
    assert p["studio"]["kind"] == "existing"
    # the same outfit: the same project; her normal avatar studio doesn't open it
    assert av.studio_open(mate_id=m["id"], language="ko", outfit={"id": oid})["id"] == pid
    assert av.studio_open(mate_id=m["id"], language="ko")["id"] != pid
    with pytest.raises(AvatarError):
        av.studio_open(mate_id=m["id"], language="ko", outfit={"id": DEFAULT_OUTFIT})
    with pytest.raises(AvatarError):
        av.studio_open(mate_id=m["id"], language="ko", outfit={"id": "nope"})

    # the agent writes the clothes; it can't move the reference; the gate is the same: nothing without the user's OK
    await av._tool_update_brief(pid, {"patch": {"design": {"prompt": "Wearing a soft sweater."}, "reference": {"mode": "none"}}})
    doc = av.doc(pid)
    assert doc["brief"]["reference"]["mode"] == "redraw" and doc["outfit"]["note"] == "Wearing a soft sweater."
    assert doc["title"].endswith("· 편한 옷")
    assert not gen.created
    plan = await av._estimate(doc)
    await av.confirm(pid, plan["id"], plan["total"])
    doc = await _settle(av, pid)
    assert doc["checkpoint"]["stage"] == "pick" and len(gen.created) == 3

    # candidates came from her flattened picture; the prompt is her, the clothes and the framing
    flat = str(av.dir(pid) / "ref" / "her-flat.jpg")
    for _jt, flags in gen.created:
        assert flat in flags
        assert flags[flags.index("--prompt") + 1] == f"{P.OUTFIT} Wearing a soft sweater. {P.FRAMING} {P.OUTFIT_CROP}"
    assert ("flatten", [str(av.dir(pid) / "ref" / "ref-1.webp"), flat]) in deps.calls

    await av.checkpoint(pid, "pick", candidate="c1")
    await _settle(av, pid)
    await av.checkpoint(pid, "approve")
    await _settle(av, pid)
    await av.checkpoint(pid, "approve")
    doc = await _settle(av, pid)
    assert doc["status"] == "ready", doc.get("error")
    for _ in range(100):
        if av.doc(pid)["outfit"].get("stored"):
            break
        await asyncio.sleep(0.02)
    # in its own place in the wardrobe, not on her
    mate = mates.get(m["id"])
    assert mate["outfits"]["worn"] == DEFAULT_OUTFIT and len(mate["outfits"]["items"]) == 2
    card = next(c for c in mate["outfits"]["items"] if c["id"] == oid)
    assert card["name"] == "편한 옷" and card["kind"] == "video" and card["note"] == "Wearing a soft sweater."

    # Wear: on her, no backup, nothing imported twice
    packs = {d.name for d in files.assets_dir(m["id"]).iterdir() if d.name.startswith("pack-")}
    res = await av.apply(pid, mate_id=m["id"])
    assert res["mate"]["outfits"]["worn"] == oid and res["project"]["applied"]["backup"] is None
    assert {d.name for d in files.assets_dir(m["id"]).iterdir() if d.name.startswith("pack-")} == packs
    assert mates.store.base_avatar(m["id"])["rig"]["home"] == m["avatar"]["rig"]["home"]


@pytest.mark.asyncio
async def test_a_new_avatar_goes_on_her_default_set_not_on_the_outfit(db, tmp_path, monkeypatch):
    _svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(files.settings, "data_home", str(tmp_path / "home"), raising=False)
    m = _mate(mates)
    oid = _filled(mates, m, "잠옷", _rig("pajamas"))
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
