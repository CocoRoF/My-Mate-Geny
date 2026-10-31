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
    # everything the author wrote comes along
    assert "Your world:" in p["description"] and "Appearance:" in p["description"]
    assert "Things you like to talk about" in p["instructions"] and "comes back" in p["instructions"]
    # the whole content folder: every character; one already imported is updated, not duplicated
    before = len(client.get("/api/mates").json())
    r = client.post("/api/mates/import-local", json={"path": str(content)})
    assert r.status_code == 200, r.text
    assert [x["name"] for x in r.json()["mates"]] == ["에스텔 루미나르"]
    assert len(client.get("/api/mates").json()) == before
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


def _ndjson(resp):
    return [json.loads(x) for x in resp.text.splitlines() if x.strip()]


CORE_JS = b"/* Live2DCubismCore */ var Live2DCubismCore = {};" + b" " * 200_000


def test_live2d_core_install_streams_progress_and_serves(client, monkeypatch):
    from app.mate import files, live2d_core
    if files.core_path().exists():
        files.core_path().unlink()
    st = client.get("/api/mates/live2d/core").json()
    assert st["installed"] is False and st["installing"] is False
    js404 = client.get("/api/mates/live2d/core.js")
    assert js404.status_code == 404 and js404.headers["cache-control"] == "no-store"
    calls = []

    def fake(url, progress):
        calls.append(url)
        for n in range(0, len(CORE_JS) + 1, 50_000):
            progress(n, len(CORE_JS))
        progress(len(CORE_JS), len(CORE_JS))
        return CORE_JS

    monkeypatch.setattr(live2d_core, "fetch", fake)
    r = client.post("/api/mates/live2d/core/install", json={"accept_license": True})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
    lines = _ndjson(r)
    assert calls == ["https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"]
    assert lines[0] == {"phase": "downloading", "received": 0, "total": lines[0]["total"]}
    assert any(x.get("total") == len(CORE_JS) for x in lines)
    assert all(x["phase"] == "downloading" for x in lines[:-2])
    assert [x["phase"] for x in lines[-2:]] == ["verifying", "done"]
    assert lines[-1]["installed"] is True and lines[-1]["size"] == len(CORE_JS)
    received = [x["received"] for x in lines if x["phase"] == "downloading"]
    assert received == sorted(received)
    st = client.get("/api/mates/live2d/core").json()
    assert st["installed"] is True and st["installing"] is False and st["size"] == len(CORE_JS)
    js = client.get("/api/mates/live2d/core.js")
    assert js.status_code == 200 and js.headers["content-type"].startswith("application/javascript")

    # not the core (an HTML error page, say): an error line, the installed copy stays
    monkeypatch.setattr(live2d_core, "fetch", lambda url, progress: b"<html>not it</html>")
    lines = _ndjson(client.post("/api/mates/live2d/core/install"))
    assert lines[-1]["phase"] == "error" and "not the Live2D Cubism Core" in lines[-1]["error"]
    assert client.get("/api/mates/live2d/core").json()["installed"] is True

    def unreachable(url, progress):
        raise RuntimeError("cannot reach cubism.live2d.com: timed out")

    files.core_path().unlink()
    monkeypatch.setattr(live2d_core, "fetch", unreachable)
    lines = _ndjson(client.post("/api/mates/live2d/core/install"))
    assert lines[-1] == {"phase": "error", "error": "cannot reach cubism.live2d.com: timed out"}
    st = client.get("/api/mates/live2d/core").json()
    assert st["installed"] is False and st["error"].startswith("cannot reach")
    assert client.post("/api/mates/live2d/core/install", json={"accept_license": False}).status_code == 400


def test_live2d_core_concurrent_installs_share_one_download(client, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from app.mate import files, live2d_core
    if files.core_path().exists():
        files.core_path().unlink()
    calls = []
    release = threading.Event()

    def slow(url, progress):
        calls.append(url)
        progress(0, len(CORE_JS))
        progress(len(CORE_JS) // 2, len(CORE_JS))
        assert release.wait(10)
        progress(len(CORE_JS), len(CORE_JS))
        return CORE_JS

    monkeypatch.setattr(live2d_core, "fetch", slow)

    def install():
        return _ndjson(client.post("/api/mates/live2d/core/install", json={"accept_license": True}))

    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(install)
        for _ in range(100):  # the download is under way
            st = client.get("/api/mates/live2d/core").json()
            if st["installing"] and st.get("received"):
                break
            threading.Event().wait(0.02)
        assert st["installing"] is True and st["received"] == len(CORE_JS) // 2 and st["total"] == len(CORE_JS)
        second = pool.submit(install)
        threading.Event().wait(0.3)
        release.set()
        a, b = first.result(10), second.result(10)
    assert len(calls) == 1  # one download for both
    assert a[-1]["phase"] == b[-1]["phase"] == "done" and b[-1]["installed"] is True
    assert any(x["phase"] == "downloading" for x in b)
    assert client.get("/api/mates/live2d/core").json()["installed"] is True


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


DESKTOP_CONTENT = Path("/home/workspace_app/ailism-desktop-mate/content")


@pytest.mark.skipif(not (DESKTOP_CONTENT / "mates").is_dir(), reason="ailism-desktop-mate not on this machine")
def test_import_all_ailism_desktop_mates_with_voices(client, tmp_path):
    root = tmp_path / "desktop-mate"
    shutil.copytree(DESKTOP_CONTENT, root / "content")
    shutil.copytree(DESKTOP_CONTENT.parent / "voices", root / "voices")
    r = client.post("/api/mates/import-local", json={"path": str(root / "content")})
    assert r.status_code == 200, r.text
    mates = {m["name"]: m for m in r.json()["mates"]}
    assert len(mates) == 3
    for m in mates.values():
        assert m["avatar"]["kind"] == "video"
    # a new mate talks on Sonnet by default
    assert _new(client, "Fresh")["llm"]["model"] == "claude-sonnet-5-5"
    tts = {name: m["voice"]["tts"] for name, m in mates.items()}
    cloned = [t for t in tts.values() if t["ref"]]
    designed = [t for t in tts.values() if t["instruct"]]
    assert len(cloned) == 1 and cloned[0]["ref_text"] and len(designed) == 2
    assert all(t["engine"] == "browser" for t in tts.values())  # engine untouched until the user picks one
