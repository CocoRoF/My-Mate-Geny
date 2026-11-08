"""LivLiv bodies (docs/mate.md "Avatar kinds"): a ``.livliv`` package (a zip: model.json + textures/) imported into the mate's
assets and played by LivLiv Player in the browser. Checked as the player would before it draws; what the package says about
itself (name, expressions, author, licence, its mark, cover and avatar pictures) is kept, and the user's own choices survive."""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import files
from app.mate.store import MateError, normalize_avatar

PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


def _model(**over) -> dict:
    m = {
        "format": "livliv-model", "version": 4, "name": "Rin",
        "meta": {"generator": {"name": "livliv.ai"}, "author": {"name": "Mira"},
                 "license": {"id": "LicenseRef-LivLiv-Terms", "url": "https://livliv.ai/terms"}, "watermark": {"kind": "text", "text": "rin"}},
        "files": {"cover": "cover.webp", "avatar": "avatar.webp"},
        "canvas": [256, 384],
        "anchors": {"head": {"cx": 128, "cy": 96, "rx": 60, "ry": 70}, "face": [80, 60, 176, 160], "neck_y": 170, "top_y": 10,
                    "bottom_y": 383, "hair_root_y": 40},
        "expressions": [{"id": "smile"}, {"id": "shy"}, {"id": "x_star"}, {"id": "Bad Id"}],
        "layers": [
            {"id": "body", "texture": "textures/body.png", "x": 0, "y": 150, "w": 256, "h": 234, "group": "body"},
            {"id": "face", "texture": "textures/face.png", "x": 70, "y": 40, "w": 116, "h": 130, "group": "head"},
            {"id": "mouth", "texture": "textures/mouth_f0.png", "frames": ["textures/mouth_f0.png", "textures/mouth_f1.png",
             "textures/mouth_f2.png"], "visemes": ["closed", "half", "open"], "x": 110, "y": 130, "w": 36, "h": 20, "group": "head",
             "role": "mouth"},
        ],
    }
    m.update(over)
    return m


def _package(model: dict | None = None, *, drop: str | None = None, extra: dict[str, bytes] | None = None) -> bytes:
    entries = {"model.json": json.dumps(model or _model()).encode()}
    for name in ("textures/body.png", "textures/face.png", "textures/mouth_f0.png", "textures/mouth_f1.png", "textures/mouth_f2.png",
                 "cover.webp", "avatar.webp"):
        entries[name] = PNG
    entries.pop(drop or "", None)
    entries.update(extra or {})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


def _import(client, mid, data: bytes, name: str = "rin.livliv"):
    return client.post(f"/api/mates/{mid}/avatar/import", files={"file": (name, data, "application/vnd.livliv.model+zip")})


def test_a_livliv_package_comes_in_and_plays_from_the_mates_assets(client):
    mid = client.post("/api/mates", json={"name": "Rin"}).json()["id"]
    r = _import(client, mid, _package())
    assert r.status_code == 200, r.text
    av = r.json()["mate"]["avatar"]
    assert av["kind"] == "livliv"
    lv = av["livliv"]
    assert "/assets/lv-" in lv["model"] and lv["model"].endswith("/model.json")
    assert lv["name"] == "Rin" and lv["canvas"] == [256, 384] and lv["expressions"] == ["smile", "shy", "x_star"]
    assert lv["author"] == "Mira" and lv["license"] == {"id": "LicenseRef-LivLiv-Terms", "url": "https://livliv.ai/terms"}
    assert lv["watermark"] == "text" and lv["cover"].endswith("/cover.webp") and lv["avatar"].endswith("/avatar.webp")
    # (what the player fetches: the model, its textures, as files of the mate, kept for good under their URL)
    model = client.get(lv["model"])
    assert model.status_code == 200 and model.json()["name"] == "Rin" and "immutable" in model.headers["cache-control"]
    tex = client.get(lv["model"].rsplit("/", 1)[0] + "/textures/mouth_f2.png")
    assert tex.status_code == 200 and tex.headers["content-type"] == "image/png"
    # (her wardrobe's card shows its cover and its shape)
    card = r.json()["mate"]["outfits"]["items"][0]
    assert card["kind"] == "livliv" and card["home"] == lv["cover"] and card["aspect"] == [256, 384]
    # the user's choices are kept; another import replaces the folder
    saved = client.patch(f"/api/mates/{mid}", json={"avatar": {"kind": "livliv", "livliv": {**lv, "emotions": {"joy": "x_star", "sad": ""},
                                                                                          "follow": "off"}}})
    assert saved.json()["avatar"]["livliv"]["emotions"] == {"joy": "x_star", "sad": ""} and saved.json()["avatar"]["livliv"]["follow"] == "off"
    old = lv["model"].split("/assets/")[1].split("/")[0]
    assert _import(client, mid, _package(_model(name="Rin 2"))).status_code == 200
    assert not (files.assets_dir(mid) / old).exists()


def test_a_package_from_before_format_4_still_comes_in():
    m = _model()
    for k in ("format", "version", "meta", "files"):
        m.pop(k)
    mid = "mate_0123456789abcdef"
    path = files.assets_dir(mid)
    path.mkdir(parents=True, exist_ok=True)
    zp = path.parent / "old.livliv"
    zp.write_bytes(_package(m))
    try:
        av = files.import_zip(mid, str(zp))
        assert av["kind"] == "livliv" and av["livliv"]["cover"] == "" and av["livliv"]["watermark"] == ""
    finally:
        zp.unlink()


@pytest.mark.parametrize(("data", "says"), [
    (lambda: _package(_model(version=5)), "newer than this app reads"),
    (lambda: _package(drop="textures/mouth_f1.png"), "mouth_f1.png"),
    (lambda: _package(_model(canvas=[9000, 384])), "canvas"),
    (lambda: _package(_model(layers=[])), "layers"),
    (lambda: _package({"hello": "world"}), "LivLiv model.json"),
    (lambda: _package(extra={"../evil.png": PNG}), ".."),
])
def test_what_the_player_would_refuse_is_refused_here(client, data, says):
    mid = client.post("/api/mates", json={"name": "X"}).json()["id"]
    r = _import(client, mid, data())
    assert r.status_code == 400 and says in r.text, r.text
    assert not list(files.assets_dir(mid).glob("lv-*")) if files.assets_dir(mid).exists() else True


def test_the_body_keeps_what_it_is_and_the_users_choices_only():
    av = normalize_avatar({"kind": "livliv", "livliv": {"model": "/m/model.json", "canvas": [1024, 1536], "expressions": ["smile", 3],
                                                         "emotions": {"joy": "laugh", "sad": None}, "follow": "sideways", "junk": 1}})
    assert av == {"kind": "livliv", "livliv": {"model": "/m/model.json", "canvas": [1024, 1536], "expressions": ["smile"],
                                                "emotions": {"joy": "laugh", "sad": ""}}}
    with pytest.raises(MateError):
        normalize_avatar({"kind": "livliv", "livliv": {"model": ""}})


def test_a_folder_or_a_livliv_file_on_the_server_comes_in(client, tmp_path):
    folder = tmp_path / "rin"
    folder.mkdir()
    with zipfile.ZipFile(io.BytesIO(_package())) as zf:
        zf.extractall(folder)
    r = client.post("/api/mates/import-local", json={"path": str(folder)})
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == "livliv" and r.json()["mate"]["name"] == "Rin"
    assert r.json()["mate"]["avatar"]["livliv"]["expressions"] == ["smile", "shy", "x_star"]
    pkg = tmp_path / "rin.livliv"
    pkg.write_bytes(_package(_model(name="Rin Packed")))
    mid = r.json()["mate"]["id"]
    r2 = client.post("/api/mates/import-local", json={"path": str(pkg), "mate_id": mid})
    assert r2.status_code == 200, r2.text
    assert r2.json()["mate"]["avatar"]["livliv"]["name"] == "Rin Packed" and r2.json()["mate"]["id"] == mid
