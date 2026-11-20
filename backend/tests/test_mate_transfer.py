"""A mate as a file (app/mate/transfer.py): out goes everything that makes her who she is — the character, how she talks, her
temperament, avatar, wardrobe, profile picture, voice — with her files, and nothing of what is between her and this user; in
comes a new mate of her own, her files in her own folder, her voice as far as it can work here."""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import files, transfer
from app.mate.store import MateError
from test_mate_affinity import _svc


def _own_mate(store, mates):
    m = store.create(name="하린", persona={"language": "ko", "description": "하린.", "personality": "직설적이다.", "gender": "female"},
                     prefs={"user_name": "장하렴", "address": "자기야", "formality": "banmal", "speech_style": "- 짧게.",
                            "temperament": {"forgives": 0.7, "conflict": "confront"}},
                     voice={"tts": {"engine": "elevenlabs", "voice": "v123", "ref": "voice/ref.wav", "ref_text": "안녕"},
                            "stt": {"engine": "browser"}})
    mid = m["id"]
    base = files.assets_dir(mid)
    for rel, data in (("pack-0123abcd/neutral.webp", b"N"), ("pack-0123abcd/smile.webp", b"S"), ("pack-0123abcd/rig.json", b"{}"),
                      ("pack-9999ffff/old.webp", b"OLD"),  # (an import folder no avatar of hers uses any more)
                      ("outfits/o1/neutral.webp", b"O"), ("profile/me.png", b"P"), ("voice/ref.wav", b"W")):
        (base / rel).parent.mkdir(parents=True, exist_ok=True)
        (base / rel).write_bytes(data)
    url = lambda rel: files.asset_url(mid, rel)  # noqa: E731
    rig = {"kind": "photo", "rig": {"aspect": [3, 4], "home": url("pack-0123abcd/neutral.webp") + "?v=3",
                                    "stills": {"neutral": url("pack-0123abcd/neutral.webp"), "smile": url("pack-0123abcd/smile.webp")},
                                    "clips": []}}
    mates.update(mid, {"avatar": rig})
    oid = mates.add_outfit(mid, "외출복")
    mates.set_outfit_avatar(mid, oid, {"kind": "photo", "rig": {"aspect": [3, 4], "home": url("outfits/o1/neutral.webp"),
                                                               "stills": {"neutral": url("outfits/o1/neutral.webp")}, "clips": []}})
    store.set_icon(mid, url("profile/me.png"))
    return store.get(mid)


def _package(mates, mid, tmp_path):
    dest, name = mates.export_mate(mid, tmp_path / "out.zip")
    zf = zipfile.ZipFile(dest)
    return zf, json.loads(zf.read("mate.json")), name


def test_out_goes_who_she_is_with_her_files_and_nothing_of_this_user(db, tmp_path):
    svc, store, mates = _svc(db)
    m = _own_mate(store, mates)
    store.add_memory(m["id"], "사용자는 고양이를 키운다", kind="fact")
    zf, manifest, name = _package(mates, m["id"], tmp_path)
    assert name == "하린.mate.zip" and manifest["format"] == transfer.FORMAT and manifest["version"] == transfer.VERSION
    doc = manifest["mate"]
    assert doc["name"] == "하린" and doc["persona"]["personality"] == "직설적이다."
    assert doc["prefs"]["address"] == "자기야" and doc["prefs"]["temperament"]["conflict"] == "confront"
    assert "user_name" not in doc["prefs"]  # (the user's name is theirs)
    blob = json.dumps(doc)
    assert f"/api/mates/{m['id']}" not in blob and "?v=" not in blob  # (no URL of this installation)
    assert doc["avatar"]["rig"]["stills"]["neutral"] == "asset:pack-0123abcd/neutral.webp" and doc["icon"] == "asset:profile/me.png"
    assert doc["outfits"]["items"][0]["avatar"]["rig"]["home"] == "asset:outfits/o1/neutral.webp"
    assert doc["voice"]["tts"]["engine"] == "elevenlabs" and doc["voice"]["tts"]["ref"] == "voice/ref.wav"
    names = set(zf.namelist())
    assert {"assets/pack-0123abcd/neutral.webp", "assets/pack-0123abcd/rig.json", "assets/outfits/o1/neutral.webp",
            "assets/profile/me.png", "assets/voice/ref.wav"} <= names
    assert "assets/pack-9999ffff/old.webp" not in names
    assert "고양이" not in zf.read("mate.json").decode()  # (her memories of this user stay here)


def test_in_comes_a_new_mate_of_her_own_and_her_voice_only_as_far_as_it_works_here(db, tmp_path):
    svc, store, mates = _svc(db)
    m = _own_mate(store, mates)
    dest, _ = mates.export_mate(m["id"], tmp_path / "out.zip")
    out = mates.import_mate(str(dest), transfer.usable_here(store, None))
    new = out["mate"]
    assert new["id"] != m["id"] and new["name"] == "하린" and not new.get("builtin")
    assert new["persona"]["personality"] == "직설적이다." and new["prefs"]["address"] == "자기야"
    assert new["prefs"]["temperament"]["forgives"] == 0.7
    stills = new["avatar"]["rig"]["stills"]
    assert stills["neutral"] == files.asset_url(new["id"], "pack-0123abcd/neutral.webp")
    assert files.resolve_asset(new["id"], "pack-0123abcd/neutral.webp").read_bytes() == b"N"
    assert files.resolve_asset(new["id"], "voice/ref.wav").read_bytes() == b"W"
    item = next(it for it in new["outfits"]["items"] if it["name"] == "외출복")
    assert store.outfit_avatar(new["id"], item["id"])["rig"]["home"] == files.asset_url(new["id"], "outfits/o1/neutral.webp")
    assert new["icon"] == files.asset_url(new["id"], "profile/me.png")
    # (no ElevenLabs key here: the default voice, and it says so; the rest of her voice stays for when it is set up)
    assert new["voice"]["tts"]["engine"] == "browser" and new["voice"]["tts"]["ref"] == "voice/ref.wav"
    assert "voice:tts:elevenlabs" in out["notes"]
    with_key = mates.import_mate(str(dest), lambda engine: True)
    assert with_key["mate"]["voice"]["tts"]["engine"] == "elevenlabs" and with_key["mate"]["voice"]["tts"]["voice"] == "v123"
    assert with_key["notes"] == []
    # (and the original is untouched)
    assert store.get(m["id"])["avatar"]["rig"]["stills"]["neutral"].startswith(f"/api/mates/{m['id']}/")


def test_a_built_in_goes_out_without_her_bundled_art_which_stays_in_the_app_but_what_was_added_to_her_goes(db, tmp_path):
    svc, store, mates = _svc(db)
    m = store.create(name="한채린", persona={"language": "ko"})
    mid = m["id"]
    db.execute("UPDATE mates SET builtin = 'chaerin' WHERE id = ?", (mid,))
    bundled = {"kind": "photo", "rig": {"aspect": [3, 4], "home": "/api/mates/builtin/chaerin/neutral.webp",
                                        "stills": {"neutral": "/api/mates/builtin/chaerin/neutral.webp"}, "clips": []}}
    mates.update(mid, {"avatar": bundled})
    # (what was added to her: an outfit made for her, in her own folder — and her profile picture, cut from her bundled art)
    (files.assets_dir(mid) / "outfits/o9").mkdir(parents=True)
    (files.assets_dir(mid) / "outfits/o9/neutral.webp").write_bytes(b"MINE")
    oid = mates.add_outfit(mid, "새로 만든 옷")
    mates.set_outfit_avatar(mid, oid, {"kind": "photo", "rig": {"aspect": [3, 4], "home": files.asset_url(mid, "outfits/o9/neutral.webp"),
                                                               "stills": {"neutral": files.asset_url(mid, "outfits/o9/neutral.webp")},
                                                               "clips": []}})
    (files.assets_dir(mid) / "profile").mkdir(parents=True)
    (files.assets_dir(mid) / "profile/face.png").write_bytes(b"FACE")
    store.set_icon(mid, files.asset_url(mid, "profile/face.png"))
    # (her bundled voice clip, copied into her folder when she was made)
    mates.update(mid, {"voice": files.ailism_voice({"doc": {}}, files.builtin_voice_dir("chaerin"), mid)})
    clip = store.get(mid)["voice"]["tts"]["ref"]
    assert clip.startswith("voice/")

    zf, manifest, _ = _package(mates, mid, tmp_path)
    doc, names = manifest["mate"], set(zf.namelist())
    assert doc["avatar"]["rig"]["home"] == "builtin:chaerin/neutral.webp"  # (named, not packed)
    assert not any(n.startswith("assets/builtin/") for n in names) and f"assets/{clip}" not in names
    assert "assets/profile/face.png" not in names and doc["icon"] == ""
    assert doc["voice"]["tts"]["ref"] == "builtin-voice:chaerin"
    assert "assets/outfits/o9/neutral.webp" in names  # (what was added to her goes)
    t = doc["prefs"]["temperament"]  # (her bundled temperament, written out: a copy is no built-in)
    assert t["conflict"] == "withdraw" and t["holds"] == 1.4 and "게임" in t["loves"]

    # (an app with the bundle: its own copy, pictures and voice clip alike)
    out = mates.import_mate(str(tmp_path / "out.zip"), lambda e: True)
    new = out["mate"]
    assert new["avatar"]["rig"]["home"] == "/api/mates/builtin/chaerin/neutral.webp" and out["notes"] == []
    added = next(it for it in new["outfits"]["items"] if it["name"] == "새로 만든 옷")
    assert store.outfit_avatar(new["id"], added["id"])["rig"]["home"] == files.asset_url(new["id"], "outfits/o9/neutral.webp")
    assert new["voice"]["tts"]["ref"] == clip and (files.assets_dir(new["id"]) / clip).is_file()

    # (an app without it: those sets are left empty, the voice clip with them, and the import says so)
    gone = tmp_path / "gone.zip"
    with zipfile.ZipFile(tmp_path / "out.zip") as src, zipfile.ZipFile(gone, "w") as dst:
        for info in src.infolist():
            data = src.read(info)
            if info.filename == "mate.json":
                data = data.decode().replace("builtin:chaerin/", "builtin:nobody/").replace("builtin-voice:chaerin", "builtin-voice:nobody").encode()
            dst.writestr(info, data)
    out = mates.import_mate(str(gone), lambda e: True)
    assert out["mate"]["avatar"]["kind"] == "none" and "builtin" in out["notes"] and "voice:clip" in out["notes"]
    added = next(it for it in out["mate"]["outfits"]["items"] if it["name"] == "새로 만든 옷")
    assert store.outfit_avatar(out["mate"]["id"], added["id"])["kind"] == "photo"  # (what was added to her still came)


def test_what_is_no_mate_file_is_turned_away_and_leaves_nothing_behind(db, tmp_path):
    svc, store, mates = _svc(db)
    before = {x["id"] for x in store.list()}

    def zipped(entries):
        p = tmp_path / f"z{len(entries)}-{abs(hash(json.dumps(sorted(entries))))}.zip"
        with zipfile.ZipFile(p, "w") as zf:
            for name, data in entries.items():
                zf.writestr(name, data)
        return str(p)

    (tmp_path / "plain.txt").write_text("x")
    good = {"format": transfer.FORMAT, "version": 1, "mate": {"name": "X", "persona": {}, "avatar": {"kind": "none"}}}
    cases = [str(tmp_path / "plain.txt"), zipped({"x.txt": "x"}), zipped({"mate.json": "not json"}),
             zipped({"mate.json": json.dumps({**good, "format": "other"})}),
             zipped({"mate.json": json.dumps({**good, "version": 99})}),
             zipped({"mate.json": json.dumps(good), "assets/../escape.txt": "x"})]
    for path in cases:
        with pytest.raises(MateError):
            mates.import_mate(path, lambda e: True)
    assert {x["id"] for x in store.list()} == before  # (a failed import leaves no half-made mate)
    assert mates.import_mate(zipped({"mate.json": json.dumps(good)}), lambda e: True)["mate"]["name"] == "X"


def test_over_http_her_package_downloads_and_comes_back_as_a_new_mate():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        m = c.post("/api/mates", json={"name": "내보낼메이트", "persona": {"personality": "조용하다."}}).json()
        r = c.get(f"/api/mates/{m['id']}/export")
        assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
        assert "filename*=UTF-8''" in r.headers["content-disposition"] and ".mate.zip" in r.headers["content-disposition"]
        assert json.loads(zipfile.ZipFile(io.BytesIO(r.content)).read("mate.json"))["mate"]["persona"]["personality"] == "조용하다."
        got = c.post("/api/mates/import", files={"file": ("x.mate.zip", r.content, "application/zip")})
        assert got.status_code == 200 and got.json()["mate"]["name"] == "내보낼메이트" and got.json()["mate"]["id"] != m["id"]
        assert c.post("/api/mates/import", files={"file": ("x.zip", b"nope", "application/zip")}).status_code == 400
        assert c.get("/api/mates/mate_nobody/export").status_code == 404
