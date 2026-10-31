"""File explorer endpoints (/api/fs/*) — local host."""

from fastapi.testclient import TestClient

from app.main import app
from app.routers.fs import decode_text, is_secret


def _login(client: TestClient) -> None:
    assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200


def test_requires_login(tmp_path):
    with TestClient(app) as client:
        assert client.get("/api/fs/list", params={"path": str(tmp_path)}).status_code == 401


def test_list_folders_first_with_dotfiles(tmp_path):
    (tmp_path / "b.txt").write_text("x")
    (tmp_path / "A.md").write_text("# a")
    (tmp_path / "zdir").mkdir()
    (tmp_path / ".env").write_text("K=V")
    (tmp_path / "link").symlink_to(tmp_path / "zdir")
    with TestClient(app) as client:
        _login(client)
        r = client.get("/api/fs/list", params={"path": str(tmp_path)}).json()
        names = [e["name"] for e in r["entries"]]
        assert names == ["link", "zdir", ".env", "A.md", "b.txt"]
        link = r["entries"][0]
        assert link["is_dir"] and link["is_link"]
        assert client.get("/api/fs/list", params={"path": str(tmp_path / "b.txt")}).status_code == 400
        assert client.get("/api/fs/list", params={"path": str(tmp_path / "nope")}).status_code == 404


def test_stat_and_text(tmp_path):
    (tmp_path / "notes.md").write_text("# 안녕\n")
    with TestClient(app) as client:
        _login(client)
        st = client.get("/api/fs/stat", params={"path": str(tmp_path / "notes.md")}).json()
        assert st["is_dir"] is False and st["mime"] == "text/markdown" and st["size"] == len("# 안녕\n".encode())
        assert client.get("/api/fs/stat", params={"path": str(tmp_path)}).json()["is_dir"] is True
        t = client.get("/api/fs/text", params={"path": str(tmp_path / "notes.md")}).json()
        assert t["content"] == "# 안녕\n" and t["encoding"] == "utf-8" and not t["truncated"] and not t["binary"]


def test_text_truncation_keeps_split_utf8_char(tmp_path):
    (tmp_path / "k.txt").write_text("가나다라마")  # 3 bytes each
    with TestClient(app) as client:
        _login(client)
        t = client.get("/api/fs/text", params={"path": str(tmp_path / "k.txt"), "limit": 4}).json()
        assert t["truncated"] and t["encoding"] == "utf-8" and t["content"] == "가"


def test_decode_text_encodings():
    assert decode_text("이름,나이\n".encode("cp949"), False)[:2] == ("이름,나이\n", "cp949")
    assert decode_text("﻿a,b".encode("utf-8"), False)[:2] == ("a,b", "utf-8-sig")
    assert decode_text("표".encode("utf-16"), False)[:2] == ("표", "utf-16")
    assert decode_text(b"\x89PNG\x00\x00", False)[2] is True


def test_raw_inline_and_download(tmp_path):
    (tmp_path / "a.pdf").write_bytes(b"%PDF-1.4 test")
    (tmp_path / "p.html").write_text("<script>alert(1)</script>")
    with TestClient(app) as client:
        _login(client)
        r = client.get("/api/fs/raw", params={"path": str(tmp_path / "a.pdf")})
        assert r.status_code == 200 and r.content == b"%PDF-1.4 test"
        assert r.headers["content-disposition"].startswith("inline")
        assert "sandbox" in r.headers["content-security-policy"]
        d = client.get("/api/fs/raw", params={"path": str(tmp_path / "a.pdf"), "download": 1})
        assert d.headers["content-disposition"].startswith("attachment")
        # HTML never renders inline on our origin
        h = client.get("/api/fs/raw", params={"path": str(tmp_path / "p.html")})
        assert h.headers["content-disposition"].startswith("attachment")


def test_secrets_are_never_served(tmp_path):
    ssh = tmp_path / ".ssh"
    ssh.mkdir()
    (ssh / "id_ed25519").write_text("PRIVATE")
    (ssh / "id_ed25519.pub").write_text("ssh-ed25519 AAA")
    (tmp_path / "creds").symlink_to(ssh / "id_ed25519")
    with TestClient(app) as client:
        _login(client)
        for p in (ssh / "id_ed25519", tmp_path / "creds"):  # symlink resolves first
            assert client.get("/api/fs/text", params={"path": str(p)}).status_code == 403
            assert client.get("/api/fs/raw", params={"path": str(p)}).status_code == 403
        assert client.get("/api/fs/text", params={"path": str(ssh / "id_ed25519.pub")}).status_code == 200
        assert client.get("/api/fs/stat", params={"path": str(ssh / "id_ed25519")}).json()["secret"] is True


def test_is_secret_patterns():
    assert is_secret("/home/u/.hr-harnessor/vault.key")
    assert is_secret("/home/u/.hr-harnessor/mounts/conn_x/id_key")
    assert is_secret("/home/u/.hr-harnessor/android-signing/passwords.txt")
    assert is_secret("/home/u/.hr-harnessor/accounts/claude/acct_1/.claude/.credentials.json")
    assert is_secret("/home/u/.codex/auth.json")
    assert is_secret("/home/u/.git-credentials")
    assert is_secret("/srv/app/deploy/cloudflared/04f3.json")
    assert is_secret("/home/hr-harnessor/backend/.env")
    assert not is_secret("/home/u/.ssh/known_hosts")
    assert not is_secret("/home/u/proj/.env")
    assert not is_secret("/home/u/proj/auth.json")


def test_resolve_uses_the_chats_working_folders(tmp_path):
    repo = tmp_path / "repo"
    (repo / "docs").mkdir(parents=True)
    (repo / "docs" / "mate.md").write_text("# mate")
    with TestClient(app) as client:
        _login(client)
        s = client.post("/api/sessions", json={
            "provider": "claude", "model": "", "connection_id": None, "workspace_path": "/", "title": "t",
        }).json()
        svc = app.state.session_service
        from app.providers.base import ProviderEvent
        svc._add_event(s["id"], ProviderEvent(type="tool.use", data={"id": "t1", "name": "Write",
                                                                    "input": {"file_path": str(repo / "docs" / "mate.md")}}))
        r = client.get("/api/fs/resolve", params={"path": "docs/mate.md", "session_id": s["id"], "roots": ["/"]}).json()
        assert r["matches"] == [{"path": str(repo / "docs" / "mate.md"), "is_dir": False}]
        r = client.get("/api/fs/resolve", params={"path": "nothing/here.md", "session_id": s["id"], "roots": ["/"]}).json()
        assert r["matches"] == []
        client.delete(f"/api/sessions/{s['id']}")
