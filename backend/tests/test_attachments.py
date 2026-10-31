import io
import json

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.providers._attachments import Attachment
from app.providers.base import TurnRequest
from app.providers.claude_code import ClaudeCodeProvider
from app.providers.codex import CodexProvider


def _login(client: TestClient) -> None:
    r = client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"})
    assert r.status_code == 200


def _png(w: int, h: int, color=(30, 200, 60)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def _session(client: TestClient, tmp_path) -> str:
    r = client.post(
        "/api/sessions",
        json={"provider": "claude", "model": "sonnet", "connection_id": None,
              "workspace_path": str(tmp_path), "title": "t"},
    )
    assert r.status_code == 200
    return r.json()["id"]


def test_upload_image_and_file_then_serve(tmp_path):
    with TestClient(app) as client:
        _login(client)
        sid = _session(client, tmp_path)

        # A clipboard paste: generic name, no useful content-type -> sniffed.
        r = client.post(
            f"/api/sessions/{sid}/attachments",
            files={"files": ("image.png", _png(64, 48), "application/octet-stream")},
        )
        assert r.status_code == 200, r.text
        img = r.json()[0]
        assert img["kind"] == "image" and img["mime"] == "image/png"
        assert (img["width"], img["height"]) == (64, 48)
        assert "path" not in img  # never leak filesystem paths

        got = client.get(img["url"])
        assert got.status_code == 200
        assert got.headers["content-type"] == "image/png"
        assert "sandbox" in got.headers["content-security-policy"]

        r = client.post(
            f"/api/sessions/{sid}/attachments",
            files={"files": ("notes.html", b"<script>alert(1)</script>", "text/html")},
        )
        doc = r.json()[0]
        assert doc["kind"] == "file"
        served = client.get(doc["url"])
        # Active content is never rendered inline on our origin.
        assert served.headers["content-disposition"].startswith("attachment")

        # Pending attachments can be removed from the composer.
        assert client.delete(f"/api/attachments/{doc['id']}").status_code == 200
        assert client.get(doc["url"]).status_code == 404


def test_large_image_gets_model_variant(tmp_path):
    with TestClient(app) as client:
        _login(client)
        sid = _session(client, tmp_path)
        r = client.post(
            f"/api/sessions/{sid}/attachments",
            files={"files": ("shot.png", _png(3000, 1800), "image/png")},
        )
        att = r.json()[0]
        prev = client.get(att["preview_url"])
        assert prev.status_code == 200
        im = Image.open(io.BytesIO(prev.content))
        assert max(im.size) <= 1568
        row = app.state.attachment_service.get(att["id"])
        assert row["model_path"] and row["model_mime"] == "image/jpeg"


def test_empty_upload_rejected_and_logged(tmp_path):
    with TestClient(app) as client:
        _login(client)
        sid = _session(client, tmp_path)
        r = client.post(f"/api/sessions/{sid}/attachments", files={"files": ("e.txt", b"", "text/plain")})
        assert r.status_code == 400
        logs = client.get("/api/admin/logs", params={"source": "upload"}).json()["items"]
        assert any(l["code"] == "upload.rejected" for l in logs)


def test_pending_validation_rejects_other_session(tmp_path):
    with TestClient(app) as client:
        _login(client)
        a, b = _session(client, tmp_path), _session(client, tmp_path)
        att = client.post(
            f"/api/sessions/{a}/attachments", files={"files": ("x.txt", b"hi", "text/plain")}
        ).json()[0]
        svc = app.state.attachment_service
        import pytest

        from app.services.attachment_service import AttachmentError

        with pytest.raises(AttachmentError):
            svc.pending(b, [att["id"]])
        assert [r["id"] for r in svc.pending(a, [att["id"]])] == [att["id"]]


def _att(tmp_path, kind="image", name="a.png") -> Attachment:
    d = tmp_path / "sess" / "att_1"
    d.mkdir(parents=True)
    f = d / name
    f.write_bytes(_png(8, 8))
    return Attachment(id="att_1", name=name, mime="image/png", size=f.stat().st_size, kind=kind, path=str(f))


def test_claude_sends_inline_image_blocks_and_add_dir(tmp_path):
    a = _att(tmp_path)
    req = TurnRequest(messages=[{"role": "user", "content": "what is this?"}], model="sonnet",
                      cwd=str(tmp_path), attachments=[a])
    p = ClaudeCodeProvider()
    env = json.loads(p._build_stdin(req))
    content = env["message"]["content"]
    assert content[0]["type"] == "image" and content[0]["source"]["media_type"] == "image/png"
    assert content[-1]["type"] == "text" and "what is this?" in content[-1]["text"]
    assert a.path in content[-1]["text"]
    argv = p._build_argv(req)
    assert argv[argv.index("--add-dir") + 1] == str(tmp_path / "sess")


def test_claude_plain_text_unchanged_without_attachments(tmp_path):
    req = TurnRequest(messages=[{"role": "user", "content": "hi"}], model="sonnet", cwd=str(tmp_path))
    env = json.loads(ClaudeCodeProvider()._build_stdin(req))
    assert env["message"]["content"] == "hi"
    assert "--add-dir" not in ClaudeCodeProvider()._build_argv(req)


def test_codex_images_flag_and_stdin_prompt(tmp_path):
    a = _att(tmp_path)
    req = TurnRequest(messages=[{"role": "user", "content": "- starts with a dash"}], model="gpt-5",
                      cwd=str(tmp_path), attachments=[a])
    p = CodexProvider()
    argv = p._build_argv(req)
    assert argv[argv.index("--image") + 1] == a.path
    assert argv[argv.index("--image") + 2].startswith("--")  # next token is a flag, not the prompt
    assert argv[-1] == "-"  # prompt read from stdin
    prompt = p._build_prompt(req).decode()
    assert prompt.startswith("- starts with a dash") and a.path in prompt


def test_session_file_preview_is_confined_to_session_folders(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "shot.png").write_bytes(_png(10, 10))
    (ws / "notes.md").write_text("# hi\n")
    (tmp_path / "secret.txt").write_text("nope")
    (ws / "link").symlink_to(tmp_path / "secret.txt")
    with TestClient(app) as client:
        _login(client)
        sid = client.post("/api/sessions", json={"provider": "claude", "model": "sonnet", "connection_id": None,
                                                 "workspace_path": str(ws), "title": "t"}).json()["id"]
        r = client.get(f"/api/sessions/{sid}/file", params={"path": "shot.png"})
        assert r.status_code == 200 and r.headers["content-type"] == "image/png"
        t = client.get(f"/api/sessions/{sid}/file", params={"path": str(ws / "notes.md"), "text": 1}).json()
        assert t["content"] == "# hi\n"
        assert client.get(f"/api/sessions/{sid}/file", params={"path": str(tmp_path / "secret.txt")}).status_code == 403
        assert client.get(f"/api/sessions/{sid}/file", params={"path": "../secret.txt"}).status_code == 403
        assert client.get(f"/api/sessions/{sid}/file", params={"path": "link"}).status_code == 403  # symlink escape


def test_an_emptied_file_is_gone_not_a_cached_blank_image(tmp_path):
    with TestClient(app) as client:
        _login(client)
        sid = _session(client, tmp_path)
        img = client.post(f"/api/sessions/{sid}/attachments",
                          files={"files": ("shot.png", _png(32, 32), "image/png")}).json()[0]
        row = app.state.attachment_service.get(img["id"]) if hasattr(app.state, "attachment_service") else None
        path = row["path"] if row else None
        if path is None:  # locate it via the service used by the router
            from app.routers.attachments import _svc
            path = _svc(type("R", (), {"app": app})()).get(img["id"])["path"]
        open(path, "wb").close()  # the data was lost (e.g. truncated)
        got = client.get(img["preview_url"])
        assert got.status_code == 410 and got.headers.get("cache-control") == "no-store"
