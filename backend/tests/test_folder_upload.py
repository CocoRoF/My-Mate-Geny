"""Local folder -> uploaded copy (app/services/folder_upload.py): paths can't
leave the copy, limits hold, skipped folders stay out, the copy gets connected."""

from __future__ import annotations

import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services.folder_upload import FolderUploadError, FolderUploadService, clean_rel, safe_name


def _login(client: TestClient) -> None:
    r = client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"})
    assert r.status_code == 200


def _session(client: TestClient, ws) -> str:
    r = client.post("/api/sessions", json={"provider": "claude", "model": "sonnet", "connection_id": None,
                                           "workspace_path": str(ws), "title": "t"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _send(client, sid, uid, items):
    files = [("files", (os.path.basename(p) or "f", data, "application/octet-stream")) for p, data in items]
    data = {"paths": [p for p, _ in items]}
    return client.post(f"/api/sessions/{sid}/folder-uploads/{uid}/files", files=files, data=data)


def test_clean_rel():
    assert clean_rel("src/a.py") == "src/a.py"
    assert clean_rel("src\\win\\b.txt") == "src/win/b.txt"
    assert clean_rel("./x//y.txt") == "x/y.txt"
    assert clean_rel("node_modules/react/index.js") is None
    assert clean_rel("pkg/.git/HEAD") is None
    assert clean_rel("a/__pycache__/m.pyc") is None
    for bad in ("../evil", "a/../../b", "a\\..\\..\\b", "/etc/passwd", "C:\\Windows\\x", "c:/x", "", "a\x00b", "..", "./.."):
        with pytest.raises(FolderUploadError):
            clean_rel(bad)
    assert safe_name("../../etc") == "etc"
    assert safe_name("C:\\Users\\me\\My Project") == "My Project"
    assert safe_name("...") == "folder"
    assert safe_name(".hidden") == "hidden"  # never a dot-name next to .incoming / .gitignore


def test_upload_copy_end_to_end(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    with TestClient(app) as client:
        _login(client)
        sid = _session(client, ws)
        lim = client.get("/api/folder-uploads/limits").json()
        assert lim["max_files"] == settings.folder_upload_max_files and "node_modules" in lim["skip"]

        r = client.post(f"/api/sessions/{sid}/folder-uploads", json={"name": "my-proj", "files": 4, "bytes": 30})
        assert r.status_code == 200, r.text
        uid = r.json()["id"]
        r = _send(client, sid, uid, [("README.md", b"# hi\n"), ("src/main.py", b"print(1)\n")])
        assert r.status_code == 200, r.text
        r = _send(client, sid, uid, [("node_modules/x/index.js", b"junk"), ("src/deep/er/c.txt", b"c")])
        assert r.json() == {"files": 3, "bytes": 15, "skipped": 1}
        # nothing visible as a folder before it's finished
        assert sorted(os.listdir(ws / ".geny-uploads")) == [".gitignore", ".incoming"]

        r = client.post(f"/api/sessions/{sid}/folder-uploads/{uid}/finish")
        assert r.status_code == 200, r.text
        out = r.json()
        dest = ws / ".geny-uploads" / "my-proj"
        assert out["path"] == str(dest) and out["files"] == 3 and out["skipped"] == 1
        assert (dest / "src" / "deep" / "er" / "c.txt").read_bytes() == b"c"
        assert not (dest / "node_modules").exists()
        assert str(dest) in out["session"]["extra_dirs"]
        assert client.get(f"/api/sessions/{sid}").json()["extra_dirs"] == [str(dest)]
        assert (ws / ".geny-uploads" / ".gitignore").read_text().strip().endswith("*")
        assert os.listdir(ws / ".geny-uploads" / ".incoming") == []
        # finished uploads are gone
        assert client.post(f"/api/sessions/{sid}/folder-uploads/{uid}/finish").status_code == 404

        # the same name again: a second copy beside it, never merged into the first
        uid2 = client.post(f"/api/sessions/{sid}/folder-uploads", json={"name": "my-proj", "files": 1, "bytes": 1}).json()["id"]
        _send(client, sid, uid2, [("a.txt", b"2")])
        assert client.post(f"/api/sessions/{sid}/folder-uploads/{uid2}/finish").json()["path"] == str(dest) + "-2"


@pytest.mark.parametrize("evil", ["../escape.txt", "a/../../escape.txt", "..\\escape.txt", "/tmp/escape.txt", "C:\\escape.txt"])
def test_traversal_is_refused_and_drops_the_upload(tmp_path, evil):
    ws = tmp_path / "ws"
    ws.mkdir()
    with TestClient(app) as client:
        _login(client)
        sid = _session(client, ws)
        uid = client.post(f"/api/sessions/{sid}/folder-uploads", json={"name": "p", "files": 2, "bytes": 2}).json()["id"]
        r = _send(client, sid, uid, [("ok.txt", b"1"), (evil, b"x")])
        assert r.status_code == 400
        assert not (tmp_path / "escape.txt").exists() and not (ws / ".geny-uploads" / "escape.txt").exists()
        assert not os.path.exists("/tmp/escape.txt") or evil != "/tmp/escape.txt"
        # the partial copy is gone with it
        assert os.listdir(ws / ".geny-uploads" / ".incoming") == []
        assert client.post(f"/api/sessions/{sid}/folder-uploads/{uid}/finish").status_code == 404


def test_limits(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setattr(settings, "folder_upload_max_mb", 2)
    monkeypatch.setattr(settings, "folder_upload_max_files", 5)
    monkeypatch.setattr(settings, "folder_upload_max_file_mb", 1)
    with TestClient(app) as client:
        _login(client)
        sid = _session(client, ws)
        begin = lambda files, size: client.post(f"/api/sessions/{sid}/folder-uploads",
                                                json={"name": "p", "files": files, "bytes": size})
        assert begin(6, 10).status_code == 413  # declared: too many files
        assert begin(1, 3 * 1048576).status_code == 413  # declared: too large
        assert begin(0, 0).status_code == 400

        # one file over the per-file limit
        uid = begin(1, 10).json()["id"]
        assert _send(client, sid, uid, [("big.bin", b"x" * (1048576 + 10))]).status_code == 413
        assert client.post(f"/api/sessions/{sid}/folder-uploads/{uid}/finish").status_code == 404

        # declared small, sent more than the folder limit
        uid = begin(3, 10).json()["id"]
        assert _send(client, sid, uid, [("a.bin", b"x" * 900_000), ("b.bin", b"x" * 900_000)]).status_code == 200
        assert _send(client, sid, uid, [("c.bin", b"x" * 900_000)]).status_code == 413

        # more files than allowed
        uid = begin(5, 10).json()["id"]
        r = _send(client, sid, uid, [(f"f{i}.txt", b"1") for i in range(6)])
        assert r.status_code == 413
        assert os.listdir(ws / ".geny-uploads" / ".incoming") == []


def test_abort_and_foreign_session(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    with TestClient(app) as client:
        _login(client)
        sid = _session(client, ws)
        other = _session(client, ws)
        uid = client.post(f"/api/sessions/{sid}/folder-uploads", json={"name": "p", "files": 1, "bytes": 1}).json()["id"]
        # another chat can't touch it
        assert _send(client, other, uid, [("a.txt", b"1")]).status_code == 404
        assert client.delete(f"/api/sessions/{other}/folder-uploads/{uid}").status_code == 404
        _send(client, sid, uid, [("a.txt", b"1")])
        assert client.delete(f"/api/sessions/{sid}/folder-uploads/{uid}").status_code == 200
        assert os.listdir(ws / ".geny-uploads" / ".incoming") == []
        assert client.get(f"/api/sessions/{sid}").json()["extra_dirs"] == []


def test_needs_login(tmp_path):
    with TestClient(app) as client:
        assert client.post("/api/sessions/x/folder-uploads", json={"name": "p", "files": 1, "bytes": 1}).status_code == 401
        assert client.post("/api/folder-uploads/probe", json={"probe_path": "/tmp/x", "nonce": "n"}).status_code == 401


def test_probe(tmp_path):
    folder = tmp_path / "picked"
    folder.mkdir()
    probe = tmp_path / "geny-probe-0123456789abcdef"
    probe.write_text("nonce-123")
    with TestClient(app) as client:
        _login(client)
        p = lambda **kw: client.post("/api/folder-uploads/probe", json=kw).json()
        assert p(probe_path=str(probe), nonce="nonce-123", path=str(folder)) == {
            "same_host": True, "is_dir": True, "path": str(folder)}
        assert p(probe_path=str(probe), nonce="nonce-123", path=str(tmp_path / "nope"))["is_dir"] is False
        assert p(probe_path=str(probe), nonce="wrong", path=str(folder))["same_host"] is False
        assert p(probe_path=str(tmp_path / "geny-probe-missing0000"), nonce="nonce-123", path=str(folder))["same_host"] is False
        # only probe files: never a way to test arbitrary files' contents
        other = tmp_path / "secret.txt"
        other.write_text("nonce-123")
        assert p(probe_path=str(other), nonce="nonce-123", path=str(folder))["same_host"] is False


class _FakeSessions:
    def __init__(self, s):
        self.s = s

    def get(self, sid):
        return dict(self.s)

    def update(self, sid, folders=None):
        self.s["folders"] = folders
        return dict(self.s)


class _FakeRemote:
    def __init__(self, root):
        self.root = root
        self.calls = []

    async def upload_tree(self, local_dir, base, rel_target):
        files = sorted(os.path.relpath(os.path.join(r, f), local_dir) for r, _, fs in os.walk(local_dir) for f in fs)
        self.calls.append((base, rel_target, files))
        return f"{base}/{rel_target}"


class _FakeWorkspaces:
    def __init__(self, c):
        self.c = c

    def connector_for(self, cid):
        return self.c


class _Up:
    def __init__(self, data):
        self.data = data

    async def read(self, n=-1):
        d, self.data = self.data[:n], self.data[n:]
        return d


def test_remote_workspace_gets_the_copy_over_ssh(tmp_path):
    remote = _FakeRemote(tmp_path)
    sessions = _FakeSessions({"id": "s1", "connection_id": "conn_1", "workspace_path": "/srv/app", "folders": []})
    svc = FolderUploadService(sessions, _FakeWorkspaces(remote), staging_root=tmp_path / "staging")

    async def run():
        b = svc.begin("s1", "proj", 2, 4)
        await svc.add("s1", b["id"], [("a.txt", _Up(b"aa")), ("d/b.txt", _Up(b"bb"))])
        return b, await svc.finish("s1", b["id"])

    b, out = asyncio.run(run())
    assert remote.calls == [("/srv/app", ".geny-uploads/proj", ["a.txt", "d/b.txt"])]
    assert out["path"] == "/srv/app/.geny-uploads/proj"
    assert sessions.s["folders"] == [{"path": "/srv/app/.geny-uploads/proj", "connection_id": "conn_1"}]
    assert not (tmp_path / "staging" / b["id"]).exists()  # staging cleaned up


class _DirSftp:
    """SFTP onto a local directory (the "remote host")."""

    def __init__(self, home):
        self.home = str(home)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def realpath(self, p):
        return os.path.normpath(os.path.join(self.home, p))

    async def makedirs(self, p, exist_ok=False):
        os.makedirs(p, exist_ok=exist_ok)

    async def exists(self, p):
        return os.path.exists(p)

    def open(self, p, mode):
        class _F:
            async def __aenter__(self):
                self.fh = open(p, mode)
                return self

            async def __aexit__(self, *exc):
                self.fh.close()

            async def write(self, data):
                self.fh.write(data)

        return _F()

    async def put(self, src, dst):
        with open(src, "rb") as i, open(dst, "wb") as o:
            o.write(i.read())


def test_ssh_upload_tree(tmp_path, monkeypatch):
    from app.workspaces.remote_ssh import RemoteSshConnector

    home = tmp_path / "remote-home"
    (home / "app").mkdir(parents=True)
    src = tmp_path / "staging"
    (src / "d" / "e").mkdir(parents=True)
    (src / "a.txt").write_text("a")
    (src / "d" / "e" / "b.txt").write_text("b")

    class _Conn:
        def start_sftp_client(self):
            return _DirSftp(home)

        def close(self):
            pass

        async def wait_closed(self):
            pass

    conn = RemoteSshConnector.__new__(RemoteSshConnector)

    async def fake_connect():
        return _Conn()

    monkeypatch.setattr(conn, "_asyncssh_connect", fake_connect)
    first = asyncio.run(conn.upload_tree(str(src), "app", ".geny-uploads/proj"))
    second = asyncio.run(conn.upload_tree(str(src), "app", ".geny-uploads/proj"))
    assert first == str(home / "app" / ".geny-uploads" / "proj")
    assert second == first + "-2"
    assert (home / "app" / ".geny-uploads" / "proj" / "d" / "e" / "b.txt").read_text() == "b"
    assert (home / "app" / ".geny-uploads" / ".gitignore").read_text().strip().endswith("*")
