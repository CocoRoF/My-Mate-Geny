"""Built-in mates: the bundled ailism characters (app/mate/builtin) exist out
of the box, serve their files, survive restarts, and respect the user's
deletions and edits."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import files
from app.mate.service import MateService
from app.mate.store import MateStore
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


# Live2D's Mao sample may not be redistributed, so it is not in the repo; an
# install may add it locally (docs/mate.md). Its tests run only where it is.
HAS_MAO = (files.BUILTIN_DIR / "mates" / "mao.json").is_file()
needs_mao = pytest.mark.skipif(not HAS_MAO, reason="Live2D Mao sample not bundled on this install")
KEYS = ["chaerin", "estelle", "seoa"] + (["mao"] if HAS_MAO else [])


def _service(db):
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    return MateService(svc, MateStore(db, vault))


def test_bundled_characters_are_mates_out_of_the_box(db):
    assert files.builtin_keys() == KEYS
    mates = _service(db).list()
    by_key = {m["builtin"]: m for m in mates}
    assert set(by_key) == set(KEYS) and len(mates) == len(KEYS)  # no extra "Geny"
    # a new install: Chaerin first and the default
    assert mates[0]["builtin"] == "chaerin" and [m["is_default"] for m in mates].count(True) == 1
    assert by_key["chaerin"]["is_default"] and by_key["chaerin"]["name"] == "한채린"
    est = by_key["estelle"]
    assert not est["is_default"] and est["name"] == "에스텔 루미나르"
    assert est["avatar"]["kind"] == "video" and len(est["avatar"]["rig"]["clips"]) >= 10
    assert est["avatar"]["rig"]["home"].startswith("/api/mates/builtin/estelle/")
    assert est["llm"]["model"] == "claude-sonnet-5-5"
    assert "Your world:" in est["persona"]["description"]
    tts = {k: m["voice"]["tts"] for k, m in by_key.items()}
    assert tts["chaerin"]["ref"] and tts["chaerin"]["ref_text"] and tts["estelle"]["instruct"]


def test_sync_is_idempotent_respects_deletes_and_edits(db):
    mates = _service(db)
    est = mates.store.by_builtin("estelle")
    # a restart (new service on the same DB) creates nothing new
    _service(db)
    assert len(mates.store.list()) == len(KEYS)
    # the user edits Estelle: a newer bundle no longer overwrites her
    mates.update(est["id"], {"persona": {"greeting": "mine"}})
    mates.store.mark_builtin(est["id"], "estelle", "old-version")
    mates.sync_builtins()
    assert mates.get(est["id"])["persona"]["greeting"] == "mine"
    # an unedited one is refreshed when the bundle changes
    seoa = mates.store.by_builtin("seoa")
    mates.store.mark_builtin(seoa["id"], "seoa", "old-version")
    mates.sync_builtins()
    assert mates.store.by_builtin("seoa")["builtin_hash"] == files.builtin_hash("seoa")
    # deleting a built-in keeps it deleted across restarts, until restored
    mates.delete(seoa["id"])
    _service(db).sync_builtins()
    assert mates.store.by_builtin("seoa") is None
    restored = mates.restore_builtins()
    assert any(m["builtin"] == "seoa" for m in restored)


def test_builtin_files_are_served_and_confined():
    with TestClient(app) as client:
        assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        est = next(m for m in client.get("/api/mates").json() if m["builtin"] == "estelle")
        home = client.get(est["avatar"]["rig"]["home"])
        assert home.status_code == 200 and home.headers["content-type"] == "image/webp"
        clip = est["avatar"]["rig"]["clips"][0]["src"]
        part = client.get(clip, headers={"Range": "bytes=0-99"})
        assert part.status_code == 206 and len(part.content) == 100
        assert client.get("/api/mates/builtin/estelle/..%2F..%2Fmates%2Festelle.json").status_code == 404
        assert client.get("/api/mates/builtin/nobody/neutral.webp").status_code == 404


@needs_mao
def test_mao_is_a_builtin_live2d_mate(db):
    mao = _service(db).store.by_builtin("mao")
    assert mao["name"] == "마오" and not mao["is_default"]  # (a Korean-replying mate: the Korean name)
    p = mao["persona"]
    assert p["language"] == "ko" and "마오" in p["greeting"] and "secretary" in p["description"]
    assert "[greet]" in p["instructions"]
    assert mao["avatar"]["kind"] == "live2d"
    l2d = mao["avatar"]["live2d"]
    assert l2d["model"] == "/api/mates/builtin/mao/runtime/mao_pro.model3.json"
    assert l2d["idle_group"] == "Idle"
    # the unnamed motion group of the sample is named in our copy, and taps use real groups
    model3 = json.loads((files.BUILTIN_DIR / "assets" / "mao" / "runtime" / "mao_pro.model3.json").read_text("utf-8"))
    groups = model3["FileReferences"]["Motions"]
    assert "" not in groups and {"Idle", "Tap", "Special"} <= set(groups)
    assert l2d["tap_motions"] == {"HitAreaHead": {"group": "Tap"}, "HitAreaBody": {"group": "Tap"}}
    assert all(g in groups for g in l2d["emotion_motions"].values())
    names = {e["Name"] for e in model3["FileReferences"]["Expressions"]}
    assert l2d["emotions"]["neutral"] == "exp_01" and set(l2d["emotions"].values()) <= names
    for tag in ("joy", "smile", "sad", "shy", "surprised", "angry", "sleepy"):
        assert tag in l2d["emotions"]
    # the licence text of the sample travels with it
    assert "Free Material License" in (files.BUILTIN_DIR / "assets" / "mao" / "ReadMe.txt").read_text("utf-8")


@needs_mao
def test_builtin_hash_sees_nested_live2d_files(db, monkeypatch, tmp_path):
    import shutil

    root = tmp_path / "builtin"
    shutil.copytree(files.BUILTIN_DIR / "mates", root / "mates")
    shutil.copytree(files.BUILTIN_DIR / "assets" / "mao", root / "assets" / "mao")
    monkeypatch.setattr(files, "BUILTIN_DIR", root)
    before = files.builtin_hash("mao")
    (root / "assets" / "mao" / "runtime" / "motions" / "mtn_02.motion3.json").write_text("{}", "utf-8")
    assert files.builtin_hash("mao") != before
    # a broken bundle (model missing) is skipped, never stops the others
    (root / "assets" / "mao" / "runtime" / "mao_pro.model3.json").unlink()
    mates = _service(db)
    assert mates.store.by_builtin("mao") is None and mates.store.by_builtin("estelle") is not None


@needs_mao
def test_builtin_live2d_files_are_served():
    with TestClient(app) as client:
        assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        mao = next(m for m in client.get("/api/mates").json() if m["builtin"] == "mao")
        url = mao["avatar"]["live2d"]["model"]
        r = client.get(url)
        assert r.status_code == 200 and r.headers["content-type"] == "application/json"
        model3 = r.json()
        base = url.rsplit("/", 1)[0]
        moc = client.get(f"{base}/{model3['FileReferences']['Moc']}", headers={"Range": "bytes=0-3"})
        assert moc.status_code == 206 and moc.content == b"MOC3"
        tex = client.get(f"{base}/{model3['FileReferences']['Textures'][0]}")
        assert tex.status_code == 200 and tex.headers["content-type"] == "image/png"
        exp = client.get(f"{base}/{model3['FileReferences']['Expressions'][0]['File']}")
        assert exp.status_code == 200
        assert client.get("/api/mates/builtin/../mates/mao.json").status_code == 404
        assert client.get("/api/mates/builtin/mao/..%2Fmates%2Fmao.json").status_code == 404


def test_bundled_outfits_arrive_once_and_preserve_the_worn_set(db, monkeypatch):
    outfit = {"id": "builtin-gray-band", "name": "그레이 밴드 수영복", "note": "Gray swimsuit with plain white bands",
              "avatar": {"kind": "photo", "rig": {"home": "/swimwear.webp", "aspect": [4, 5], "stills": {"neutral": "/swimwear.webp"}, "clips": []}}}
    monkeypatch.setattr(files, "builtin_outfits", lambda key: [outfit] if key == "chaerin" else [])
    mates = _service(db)
    cha = mates.store.by_builtin("chaerin")
    mid = cha["id"]
    base = cha["avatar"]
    assert [it["id"] for it in cha["outfits"]["items"]] == ["default", outfit["id"]]
    assert cha["outfits"]["worn"] == "default" and cha["avatar"] == base
    mates.wear_outfit(mid, outfit["id"])
    mates.store.mark_builtin(mid, "chaerin", "force-version-change")
    mates.sync_builtins()
    cha = mates.get(mid)
    assert cha["outfits"]["worn"] == outfit["id"]
    assert len(cha["outfits"]["items"]) == 2
    assert not cha["customized"]
    mates.delete_outfit(mid, outfit["id"])
    mates.store.mark_builtin(mid, "chaerin", "another-version")
    mates.sync_builtins()
    assert len(mates.get(mid)["outfits"]["items"]) == 1  # deletion survives bundle updates
    assert mates.get(mid)["avatar"] == base


def test_existing_install_receives_new_bundled_outfit_without_overwriting_edits(db, monkeypatch):
    monkeypatch.setattr(files, "builtin_outfits", lambda key: [])
    mates = _service(db)
    cha = mates.store.by_builtin("chaerin")
    mid = cha["id"]
    custom = mates.add_outfit(mid, "내 의상")
    outfit = {"id": "builtin-gray-band", "name": "그레이 밴드 수영복", "note": "",
              "avatar": {"kind": "photo", "rig": {"home": "/swimwear.webp", "aspect": [4, 5], "stills": {"neutral": "/swimwear.webp"}, "clips": []}}}
    monkeypatch.setattr(files, "builtin_outfits", lambda key: [outfit] if key == "chaerin" else [])
    mates.store.mark_builtin(mid, "chaerin", "old-version")
    mates.sync_builtins()
    assert [it["id"] for it in mates.get(mid)["outfits"]["items"]] == ["default", custom, outfit["id"]]
    mates.rename_outfit(mid, outfit["id"], "내 수영복")
    mates.store.mark_builtin(mid, "chaerin", "old-version-again")
    mates.sync_builtins()
    assert mates.get(mid)["outfits"]["items"][-1]["name"] == "내 수영복"


def test_bundled_outfit_pack_uses_nested_builtin_asset_urls(tmp_path, monkeypatch):
    monkeypatch.setattr(files, "BUILTIN_DIR", tmp_path)
    root = tmp_path / "assets" / "chaerin"
    folder = root / "outfits" / "gray-band"
    folder.mkdir(parents=True)
    (folder / "neutral.webp").write_bytes(b"image")
    (folder / "rig.json").write_text(json.dumps({
        "version": 1, "aspect": [4, 5], "home": "asset:gray-band/neutral.webp",
        "stills": {"neutral": "asset:gray-band/neutral.webp"}, "clips": [],
    }))
    (root / "outfits.json").write_text(json.dumps({"items": [{
        "id": "builtin-gray-band", "name": "그레이 밴드 수영복", "rig": "outfits/gray-band/rig.json",
    }]}))
    outfits = files.builtin_outfits("chaerin")
    assert outfits[0]["avatar"]["rig"]["home"] == "/api/mates/builtin/chaerin/outfits/gray-band/neutral.webp"
    assert outfits[0]["avatar"]["rig"]["stills"]["neutral"] == outfits[0]["avatar"]["rig"]["home"]
