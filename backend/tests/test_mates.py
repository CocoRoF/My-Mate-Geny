"""Mates API: CRUD + default mate, settings (write-only keys), assets
(safe paths, types, cache, Range), avatar zip imports (ailism pack, Live2D
+ geny-avatar sidecar), import-local (ailism Estelle, Geny mao_pro), the
Live2D core, mate sessions hidden from the chat list, the internal gate."""

from __future__ import annotations

import io
import json
import shutil
import stat
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.mate import netio

ESTELLE_JSON = Path("/home/workspace_app/ailism-mate/apps/api/mate_api/content/mates/estelle.json")
ESTELLE_ASSETS = Path("/home/workspace_app/ailism-mate/apps/api/mate_api/content/assets/estelle")
LIVE2D_ROOT = Path("/home/workspace/project_geny_workspace/Geny/backend/static/live2d-models")
MAO = LIVE2D_ROOT / "mao_pro" / "runtime"

needs_estelle = pytest.mark.skipif(not ESTELLE_JSON.is_file(), reason="ailism sample not on this host")
needs_mao = pytest.mark.skipif(not MAO.is_dir(), reason="Geny mao_pro sample not on this host")


@pytest.fixture
def client():
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        yield c


def _new(client, name="Test", **kw):
    r = client.post("/api/mates", json={"name": name, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def test_default_mate_and_crud(client):
    mates = client.get("/api/mates").json()
    geny = next(m for m in mates if m["name"] == "Geny")  # created on first list
    assert geny["avatar"] == {"kind": "none"} and geny["voice"]["tts"]["engine"] == "browser"
    assert geny["persona"]["language"] == "ko" and geny["persona"]["greeting"]
    assert len([m for m in client.get("/api/mates").json() if m["name"] == "Geny"]) == 1  # only once

    m = _new(client, "Estelle", persona={"personality": "lazy"}, llm={"model": "haiku"})
    assert m["persona"]["personality"] == "lazy" and m["persona"]["speech"] == ""
    assert m["llm"] == {"provider": "claude", "model": "haiku", "effort": "low"}
    assert m["session_id"] is None
    r = client.patch(f"/api/mates/{m['id']}", json={"persona": {"speech": "drawls"}, "voice": {"tts": {"engine": "openai", "voice": "nova"}}})
    m2 = r.json()
    assert m2["persona"] == {**m["persona"], "speech": "drawls"}  # merged, not replaced
    assert m2["voice"]["tts"]["engine"] == "openai" and m2["voice"]["stt"]["engine"] == "browser"
    assert client.patch(f"/api/mates/{m['id']}", json={"voice": {"tts": {"engine": "nope"}}}).status_code == 400
    assert client.patch(f"/api/mates/{m['id']}", json={"llm": {"provider": "codex"}}).status_code == 400
    assert client.patch(f"/api/mates/{m['id']}", json={"avatar": {"kind": "live2d"}}).status_code == 400
    assert client.post("/api/mates", json={"name": " "}).status_code == 400

    client.patch(f"/api/mates/{m['id']}", json={"is_default": True})
    ms = client.get("/api/mates").json()
    assert ms[0]["id"] == m["id"] and [x["is_default"] for x in ms].count(True) == 1
    assert client.delete(f"/api/mates/{m['id']}").status_code == 200
    assert client.get(f"/api/mates/{m['id']}").status_code == 404
    assert [x["is_default"] for x in client.get("/api/mates").json()].count(True) == 1  # promoted


def test_settings_keys_are_write_only(client):
    r = client.put("/api/mates/settings", json={"openai_key": "sk-secret", "elevenlabs_key": None,
                                               "omnivoice_url": "http://omni:8000/"})
    s = r.json()
    assert s["openai_key_set"] is True and s["elevenlabs_key_set"] is False
    assert s["omnivoice_url"] == "http://omni:8000"
    assert "sk-secret" not in json.dumps(client.get("/api/mates/settings").json())
    assert app.state.mate_service.store.secret("openai_key") == "sk-secret"
    assert client.put("/api/mates/settings", json={"openai_key": ""}).json()["openai_key_set"] is False
    assert client.put("/api/mates/settings", json={"whisper_url": "ftp://x"}).status_code == 400


def test_assets_upload_serve_and_traversal(client):
    m = _new(client)
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 100
    r = client.post(f"/api/mates/{m['id']}/assets", files={"file": ("a.png", png, "image/png")},
                    data={"path": "body/still.png"})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    assert url.startswith(f"/api/mates/{m['id']}/assets/body/still.png?v=")
    g = client.get(url)
    assert g.status_code == 200 and g.content == png and g.headers["content-type"] == "image/png"
    assert "immutable" in g.headers["cache-control"] and g.headers["x-content-type-options"] == "nosniff"
    assert "no-cache" in client.get(url.split("?")[0]).headers["cache-control"]
    part = client.get(url, headers={"Range": "bytes=0-7"})
    assert part.status_code == 206 and part.content == png[:8]
    # an HTML file is never served as HTML
    client.post(f"/api/mates/{m['id']}/assets", files={"file": ("x.html", b"<script>", "text/html")}, data={"path": "x.html"})
    assert client.get(f"/api/mates/{m['id']}/assets/x.html").headers["content-type"] == "application/octet-stream"
    for bad in ("../evil.png", "/abs.png", ".hidden/x.png", "a/../../b.png", "pack-0123456789ab/x.png"):
        r = client.post(f"/api/mates/{m['id']}/assets", files={"file": ("a.png", png, "image/png")}, data={"path": bad})
        assert r.status_code == 400, bad
    for bad in ("..%2f..%2fapp.db", "%2e%2e/%2e%2e/x", "body/../../../etc/passwd"):
        assert client.get(f"/api/mates/{m['id']}/assets/{bad}").status_code == 404, bad
    assert client.get("/api/mates/../../etc/assets/x").status_code == 404


def _zip(entries: dict[str, bytes], *, symlink: str | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
        if symlink:
            info = zipfile.ZipInfo(symlink)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, "/etc/passwd")
    return buf.getvalue()


def _import(client, mid, data: bytes):
    return client.post(f"/api/mates/{mid}/avatar/import", files={"file": ("a.zip", data, "application/zip")})


@needs_estelle
def test_import_ailism_pack_zip(client):
    m = _new(client)
    rig = json.loads((ESTELLE_ASSETS / "rig.json").read_text())
    entries = {"estelle/rig.json": json.dumps(rig).encode()}
    for f in ("neutral.webp", "smile.webp", "blink.webp", "idle_a.lg.mp4", "idle_a.sm.mp4", "laugh.lg.mp4"):
        entries[f"estelle/{f}"] = (ESTELLE_ASSETS / f).read_bytes()
    r = _import(client, m["id"], _zip(entries))
    assert r.status_code == 200, r.text
    av = r.json()["mate"]["avatar"]
    assert av["kind"] == "video" and av["rig"]["packing"] == "stacked-alpha"
    assert av["rig"]["aspect"] == [1020, 1298]
    assert set(av["rig"]["stills"]) == {"neutral", "smile", "blink"}  # refs to missing files dropped
    assert [c["id"] for c in av["rig"]["clips"]] == ["idle_a", "laugh"]
    assert av["rig"]["emotions"] == {"joy": ["laugh"]}
    clip = av["rig"]["clips"][0]
    assert "/assets/pack-" in clip["src"] and clip["small"].endswith("idle_a.sm.mp4")
    v = client.get(clip["src"])
    assert v.status_code == 200 and v.headers["content-type"] == "video/mp4" and "immutable" in v.headers["cache-control"]
    assert client.get(clip["src"], headers={"Range": "bytes=0-99"}).status_code == 206
    # re-import: the old pack folder is cleaned up
    old_dir = clip["src"].split("/assets/")[1].split("/")[0]
    r2 = _import(client, m["id"], _zip({"rig.json": json.dumps({"stills": {"neutral": "n.webp"}}).encode(),
                                       "n.webp": entries["estelle/neutral.webp"]}))
    assert r2.json()["avatar"]["kind"] == "photo"
    from app.mate import files
    assert not (files.assets_dir(m["id"]) / old_dir).exists()


def test_zip_rejects_traversal_symlinks_and_junk(client):
    m = _new(client)
    rig = json.dumps({"stills": {"neutral": "n.png"}}).encode()
    for entries, sym in (({"rig.json": rig, "../evil.png": b"x"}, None),
                         ({"rig.json": rig, "/abs/evil.png": b"x"}, None),
                         ({"rig.json": rig}, "link.png"),
                         ({"readme.txt": b"hi"}, None)):
        r = _import(client, m["id"], _zip(entries, symlink=sym))
        assert r.status_code == 400, (entries.keys(), r.text)
    assert _import(client, m["id"], b"not a zip").status_code == 400
    from app.mate import files
    assert not any(files.assets_dir(m["id"]).glob("pack-*")) if files.assets_dir(m["id"]).exists() else True


@needs_mao
def test_import_live2d_zip_with_sidecar(client, tmp_path):
    m = _new(client)
    entries = {}
    for p in MAO.rglob("*"):
        if p.is_file():
            entries[f"mao/runtime/{p.relative_to(MAO)}"] = p.read_bytes()
    entries["mao/avatar-editor.json"] = json.dumps({"schemaVersion": 2, "animationConfig": {
        "display": {"kScale": 0.8, "initialXshift": 10, "initialYshift": -5},
        "idleMotionGroupName": "Idle",
        "emotionMap": {"joy": "exp_04", "anger": "exp_03"},
        "tapMotions": {"HitAreaHead": {"group": "", "index": 2}},
    }}).encode()
    r = _import(client, m["id"], _zip(entries))
    assert r.status_code == 200, r.text
    l2d = r.json()["avatar"]["live2d"]
    assert l2d["model"].endswith("/runtime/mao_pro.model3.json") and "/assets/l2d-" in l2d["model"]
    assert l2d["scale"] == 0.8 and l2d["x"] == 10 and l2d["y"] == -5 and l2d["idle_group"] == "Idle"
    assert l2d["emotions"] == {"joy": "exp_04", "angry": "exp_03"}
    assert l2d["tap_motions"] == {"HitAreaHead": {"group": "Motion", "index": 2}}  # "" group renamed
    model = client.get(l2d["model"]).json()
    assert set(model["FileReferences"]["Motions"]) == {"Idle", "Motion"}
    tex = client.get(l2d["model"].rsplit("/", 1)[0] + "/mao_pro.4096/texture_00.png")
    assert tex.status_code == 200 and tex.headers["content-type"] == "image/png"


@needs_estelle
def test_import_local_ailism_content_mate(client, tmp_path):
    content = tmp_path / "content"
    (content / "mates").mkdir(parents=True)
    shutil.copy(ESTELLE_JSON, content / "mates" / "estelle.json")
    shutil.copytree(ESTELLE_ASSETS, content / "assets" / "estelle")
    r = client.post("/api/mates/import-local", json={"path": str(content / "mates" / "estelle.json")})
    assert r.status_code == 200, r.text
    m = r.json()["mate"]
    assert m["name"] == "에스텔 루미나르" and r.json()["imported"] == "ailism"
    p = m["persona"]
    assert p["language"] == "ko" and p["greeting"].startswith("음~") and "게으르다" in p["personality"]
    assert "{{user}}" not in json.dumps(p, ensure_ascii=False) and "Example exchanges" in p["speech"]
    rig = m["avatar"]["rig"]
    assert m["avatar"]["kind"] == "video" and len(rig["clips"]) == 13 and len(rig["stills"]) == 12
    assert "asset:" not in json.dumps(m["avatar"])
    assert client.get(rig["home"]).status_code == 200
    # a content folder without picking the file: tells which files there are
    r = client.post("/api/mates/import-local", json={"path": str(content)})
    assert r.status_code == 400 and "estelle.json" in r.json()["detail"]
    assert client.post("/api/mates/import-local", json={"path": str(tmp_path / "nope")}).status_code == 404


@needs_mao
def test_import_local_live2d_folder_from_geny(client, tmp_path):
    root = tmp_path / "live2d-models"
    shutil.copytree(MAO, root / "mao_pro" / "runtime")
    shutil.copy(LIVE2D_ROOT / "model_registry.json", root / "model_registry.json")
    r = client.post("/api/mates/import-local", json={"path": str(root / "mao_pro")})
    assert r.status_code == 200, r.text
    m = r.json()["mate"]
    assert m["name"] == "mao_pro" and m["avatar"]["kind"] == "live2d"
    l2d = m["avatar"]["live2d"]
    assert l2d["scale"] == 0.85 and l2d["emotions"]["joy"] == 3 and l2d["emotions"]["angry"] == 2
    assert l2d["tap_motions"]["HitAreaHead"] == {"group": "Motion", "index": 1}
    # into an existing mate: only the avatar changes
    other = _new(client, "Keeps name")
    r = client.post("/api/mates/import-local", json={"path": str(root / "mao_pro" / "runtime"), "mate_id": other["id"]})
    assert r.json()["mate"]["name"] == "Keeps name" and r.json()["mate"]["avatar"]["kind"] == "live2d"


def test_live2d_core_install_and_serve(client, monkeypatch):
    from app.mate import files
    if files.core_path().exists():
        files.core_path().unlink()
    assert client.get("/api/mates/live2d/core").json()["installed"] is False
    assert client.get("/api/mates/live2d/core.js").status_code == 404
    calls = []

    async def fake(method, url, **kw):
        calls.append((method, url))
        return netio.Response(200, b"/* Live2DCubismCore */ var Live2DCubismCore = {};" + b" " * 20000,
                              {"content-type": "application/javascript"})

    monkeypatch.setattr(netio, "request", fake)
    r = client.post("/api/mates/live2d/core/install", json={"accept_license": True})
    assert r.status_code == 200 and r.json()["installed"] is True
    assert calls == [("GET", "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js")]
    js = client.get("/api/mates/live2d/core.js")
    assert js.status_code == 200 and js.headers["content-type"].startswith("application/javascript")

    async def bad(method, url, **kw):
        return netio.Response(200, b"<html>not it</html>", {})

    monkeypatch.setattr(netio, "request", bad)
    assert client.post("/api/mates/live2d/core/install").status_code == 502


def test_mate_conversation_is_hidden_from_chat_list(client, tmp_path):
    with client.websocket_connect("/ws/sessions") as ws:
        v0 = ws.receive_json()["data"]["version"]
        m = _new(client, "Hidden", persona={"greeting": "Hi there"})
        conv = client.post(f"/api/mates/{m['id']}/conversation").json()
        sid = conv["session_id"]
        assert conv["session"]["kind"] == "mate" and conv["session"]["mate_id"] == m["id"]
        assert client.post(f"/api/mates/{m['id']}/conversation").json()["session_id"] == sid  # same one
        assert client.get(f"/api/mates/{m['id']}").json()["session_id"] == sid
        lst = client.get("/api/sessions")
        assert sid not in [s["id"] for s in lst.json()]
        assert int(lst.headers["X-Sessions-Version"]) == v0  # the chat list didn't change
        hist = client.get(f"/api/history/{sid}").json()
        assert hist["session"]["kind"] == "mate"
        greet = hist["messages"][0]
        assert greet["role"] == "assistant" and greet["content"] == "Hi there" and greet["meta"]["kind"] == "greeting"
        # a real chat still announces itself
        s = client.post("/api/sessions", json={"provider": "claude", "workspace_path": str(tmp_path), "title": "w"}).json()
        ev = ws.receive_json()
        assert ev["data"]["sid"] == s["id"] and ev["data"]["version"] > v0
        assert client.post(f"/api/mates/{m['id']}/conversation/reset").status_code == 200
        client.delete(f"/api/mates/{m['id']}")
        assert client.get(f"/api/sessions/{sid}").status_code == 404


def _mate_token(name: str) -> tuple[dict, str]:
    svc = app.state.mate_service
    m = svc.create({"name": name})
    conv = svc.conversation(m["id"])
    return m, svc._token(m["id"], conv["session_id"])


def test_internal_api_gate(tmp_path):
    body = {"name": "list_sessions", "arguments": {}}
    with TestClient(app) as c:
        _, token = _mate_token("Gate")
        # not loopback (TestClient's peer is "testclient")
        assert c.post("/api/internal/mate/call", json=body, headers={"X-Mate-Token": token}).status_code == 404
        # a logged-in user (cookie) gets nothing either
        c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"})
        assert c.post("/api/internal/mate/call", json=body).status_code == 404
    with TestClient(app, client=("127.0.0.1", 40001)) as lc:
        svc = app.state.mate_service
        m, token = _mate_token("Gate2")
        assert lc.post("/api/internal/mate/call", json=body).status_code == 401
        assert lc.post("/api/internal/mate/call", json=body, headers={"X-Mate-Token": "forged"}).status_code == 401
        # a proxy on this host forwarding an outside request
        r = lc.post("/api/internal/mate/call", json=body, headers={"X-Mate-Token": token, "X-Forwarded-For": "1.2.3.4"})
        assert r.status_code == 404
        r = lc.post("/api/internal/mate/call", json=body, headers={"X-Mate-Token": token})
        assert r.status_code == 200 and r.json()["is_error"] is False
        r = lc.post("/api/internal/mate/call", json={"name": "remember", "arguments": {"text": "likes tea"}},
                    headers={"X-Mate-Token": token})
        assert r.json()["text"].startswith("Remembered [mem_")
        assert [x["text"] for x in svc.store.memories(m["id"])] == ["likes tea"]
        r = lc.post("/api/internal/mate/call", json={"name": "rm_rf", "arguments": {}}, headers={"X-Mate-Token": token})
        assert r.json()["is_error"] is True
