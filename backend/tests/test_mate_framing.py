"""Every set of a mate stands in the same place at the same size (docs/mate.md "Outfits"): each set says where her face sits
(``rig.frame``): measured with a face detector when the pipeline makes it, from the outline when it comes from elsewhere."""

from __future__ import annotations

from PIL import Image
from test_mate_outfits import _filled, _mate, _rig
from test_mate_style import _service

from app.mate import files
from app.mate.store import DEFAULT_OUTFIT, takes_frame


def _cutout(path, size=(400, 500), body=(100, 50, 300, 500)):
    """A transparent picture with a figure in it."""
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    im.paste((200, 100, 100, 255), body)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)
    return path


def _asset_set(mates, mid, name, **cut):
    pic = _cutout(files.assets_dir(mid) / "pack-a" / name, **cut)
    url = files.asset_url(mid, f"pack-a/{pic.name}")
    return {"kind": "photo", "rig": {"aspect": [400, 500], "home": url, "stills": {"neutral": url}, "clips": []}}


def test_the_outline_says_where_her_head_is(tmp_path):
    f = files.outline_frame(_cutout(tmp_path / "a.png"))
    assert f["how"] == "outline" and f["top"] == 0.1
    assert f["face"][0] == 0.5  # (in the middle of what is there, not of the picture)
    side = files.outline_frame(_cutout(tmp_path / "b.png", body=(0, 50, 200, 500)))
    assert side["face"][0] == 0.25


def test_a_picture_with_nothing_to_go_by_says_nothing(tmp_path):
    opaque = tmp_path / "c.png"
    Image.new("RGB", (100, 100), (9, 9, 9)).save(opaque)
    assert files.outline_frame(opaque) is None
    empty = tmp_path / "d.png"
    Image.new("RGBA", (100, 100), (0, 0, 0, 0)).save(empty)
    assert files.outline_frame(empty) is None
    (tmp_path / "e.png").write_bytes(b"not a picture")
    assert files.outline_frame(tmp_path / "e.png") is None
    assert files.outline_frame(tmp_path / "missing.png") is None


def test_a_set_keeps_its_measurement_only_while_it_is_about_its_picture(db):
    mates = _service(db)
    mid = _mate(mates)["id"]
    avatar = _asset_set(mates, mid, "n.png")
    out = files.framed(avatar, mid)
    assert out["rig"]["frame"]["how"] == "outline" and out["rig"]["frame"]["for"] == "n.png"
    measured = {"face": [0.1, 0.2, 0.3], "top": 0.0, "how": "face", "for": "n.png"}
    kept = {**avatar, "rig": {**avatar["rig"], "frame": measured}}
    assert files.framed(kept, mid) == kept
    other = {**kept, "rig": {**kept["rig"], **_asset_set(mates, mid, "o.png")["rig"], "frame": measured}}
    assert files.framed(other, mid)["rig"]["frame"]["for"] == "o.png"
    gone = {"kind": "photo", "rig": {"aspect": [1, 1], "home": files.asset_url(mid, "nope.png"), "stills": {}, "clips": []}}
    assert "frame" not in files.framed(gone, mid)["rig"]
    for other_kind in ({"kind": "none"}, {"kind": "live2d", "live2d": {}}, "nonsense", None):
        assert files.framed(other_kind, mid) == other_kind


def test_every_way_in_measures_it(db):
    mates = _service(db)
    mid = _mate(mates)["id"]
    oid = mates.add_outfit(mid, "잠옷")
    mates.set_outfit_avatar(mid, oid, _asset_set(mates, mid, "o.png"))
    card = next(c for c in mates.get(mid)["outfits"]["items"] if c["id"] == oid)
    assert card["frame"]["how"] == "outline"
    mates.update(mid, {"avatar": _asset_set(mates, mid, "d.png")})
    assert mates.get(mid)["avatar"]["rig"]["frame"]["for"] == "d.png"
    base = next(c for c in mates.get(mid)["outfits"]["items"] if c["id"] == DEFAULT_OUTFIT)
    assert base["frame"]["for"] == "d.png"  # (what a set is lined up to)


def test_a_pack_keeps_its_own_measurement_and_a_bad_one_is_dropped(tmp_path):
    _cutout(tmp_path / "n.webp")
    raw = {"aspect": [400, 500], "home": "n.webp", "stills": {"neutral": "n.webp"}, "clips": [],
           "frame": {"face": [0.5, 0.3, 0.2], "top": 0.1, "how": "face", "for": "n.webp"}}
    assert files.rig_avatar(raw, tmp_path, lambda rel: f"/x/{rel}")["rig"]["frame"]["face"] == [0.5, 0.3, 0.2]
    both = {**raw, "frame": {**raw["frame"], "outline": [0.5, 0.2, 0.25]}}
    assert files.rig_avatar(both, tmp_path, lambda rel: f"/x/{rel}")["rig"]["frame"]["outline"] == [0.5, 0.2, 0.25]
    junk = {**raw, "frame": {**raw["frame"], "outline": "x"}}
    assert "outline" not in files.rig_avatar(junk, tmp_path, lambda rel: f"/x/{rel}")["rig"]["frame"]
    for bad in ("x", {"face": [1, 2]}, {"face": ["a", "b", "c"]}, {"face": [0.5, 0.5, 0]}):
        assert "frame" not in files.rig_avatar({**raw, "frame": bad}, tmp_path, lambda rel: f"/x/{rel}")["rig"]


def test_sets_from_before_are_measured_once_and_nothing_else_moves(db):
    mates = _service(db)
    m = _mate(mates)
    mid = m["id"]
    oid = mates.add_outfit(mid, "잠옷")
    old = _asset_set(mates, mid, "o.png")
    mates.store.set_outfit_avatar(mid, oid, old)  # (past the measuring: as it was stored before)
    assert "frame" not in mates.store.outfit_avatar(mid, oid)["rig"]
    worn = mates.get(mid)["outfits"]["worn"]
    mates.store.fill_frames(mid, files.framed)
    got = mates.store.outfit_avatar(mid, oid)["rig"]
    assert got["frame"]["how"] == "outline" and got["home"] == old["rig"]["home"]
    assert mates.get(mid)["outfits"]["worn"] == worn
    pushed = []
    mates.store.on_change = lambda reason, who: pushed.append(reason)
    mates.store.fill_frames(mid, files.framed)
    assert not pushed  # (nothing new: nobody has to refetch)


def test_one_she_has_on_is_measured_too_and_stays_on(db):
    mates = _service(db)
    mid = _mate(mates)["id"]
    oid = _filled(mates, mates.get(mid), "잠옷", _rig("pj"))
    mates.wear_outfit(mid, oid)
    assert mates.get(mid)["outfits"]["worn"] == oid
    mates.store.fill_frames(mid, lambda avatar, _mid: {**avatar, "rig": {**avatar["rig"], "frame": {"face": [0.5, 0.3, 0.2]}}})
    assert mates.get(mid)["avatar"]["rig"]["frame"]["face"] == [0.5, 0.3, 0.2]
    assert mates.get(mid)["outfits"]["worn"] == oid


def test_an_edited_set_takes_the_bundles_measurement_of_the_same_picture():
    frame = {"face": [0.5, 0.3, 0.3], "how": "face", "for": "n.webp"}
    new = {"kind": "video", "rig": {"home": "/a/n.webp", "frame": frame}}
    edited = {"kind": "video", "rig": {"home": "/a/n.webp", "clips": [{"id": "talk_b", "disabled": True}]}}
    got = takes_frame(edited, new)
    assert got["rig"]["frame"] == frame and got["rig"]["clips"] == edited["rig"]["clips"]
    theirs = {"kind": "video", "rig": {"home": "/mine/n.webp"}}
    assert takes_frame(theirs, new) == theirs  # (another picture: not about this one)


def test_a_bundle_update_brings_the_measurement_to_an_edited_body():
    frame = {"face": [0.5, 0.3, 0.3], "how": "face", "for": "n.webp"}
    prev = {"persona": {}, "style": {}, "names": {}, "greetings": {}, "avatar": {"kind": "video", "rig": {"home": "/a/n.webp"}}}
    new = {**prev, "avatar": {"kind": "video", "rig": {"home": "/a/n.webp", "frame": frame}}}
    edited = {"kind": "video", "rig": {"home": "/a/n.webp", "clips": [{"id": "x", "disabled": True}]}}
    patch = files.merge_builtin({"name": "", "persona": {"language": "ko"}, "prefs": {}, "avatar": edited}, prev, new)
    assert patch["avatar"]["rig"]["frame"] == frame and patch["avatar"]["rig"]["clips"] == edited["rig"]["clips"]


def test_the_real_sets_are_measured_and_line_up():
    usual = files.builtin_avatar("chaerin", files.builtin_doc("chaerin"))["rig"]["frame"]
    for outfit in files.builtin_outfits("chaerin"):
        worn = outfit["avatar"]["rig"]["frame"]
        assert usual["how"] == worn["how"] == "face" and usual["for"] == worn["for"] == "neutral.webp"
        assert 0.2 < usual["face"][1] < 0.4 and 0.2 < worn["face"][1] < 0.4  # (her face, not the chest a detector once took for it)
        assert abs(usual["face"][2] / worn["face"][2] - 1) < 0.1  # (lining them up hardly has to scale her)
