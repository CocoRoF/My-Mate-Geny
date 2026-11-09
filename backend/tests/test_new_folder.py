"""New folder in the folder pickers (New chat's workspace, Add folder): on this server and on an SSH host."""

from __future__ import annotations

import asyncio
import os

import asyncssh
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.workspaces.base import FolderExists, WorkspaceError, folder_name_error
from app.workspaces.local import LocalConnector
from app.workspaces.remote_ssh import RemoteSshConnector


def test_a_folder_is_made_where_the_picker_stands(tmp_path):
    entry = asyncio.run(LocalConnector().mkdir(str(tmp_path), "  new project "))
    assert entry.name == "new project" and entry.is_dir and os.path.isdir(tmp_path / "new project")
    with pytest.raises(FolderExists):
        asyncio.run(LocalConnector().mkdir(str(tmp_path), "new project"))
    (tmp_path / "a-file").write_text("x")
    with pytest.raises(FolderExists):  # (a file by that name takes it too)
        asyncio.run(LocalConnector().mkdir(str(tmp_path), "a-file"))
    with pytest.raises(WorkspaceError, match="not a directory"):
        asyncio.run(LocalConnector().mkdir(str(tmp_path / "missing"), "x"))


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="root can write anywhere")
def test_a_folder_it_may_not_write_to_says_so(tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        with pytest.raises(WorkspaceError, match="permission denied"):
            asyncio.run(LocalConnector().mkdir(str(locked), "x"))
    finally:
        locked.chmod(0o700)


@pytest.mark.parametrize("name", ["", ".", "..", "a/b", "a\0b", "tab\there", "x" * 256])
def test_names_that_cant_be_a_folder(name):
    assert folder_name_error(name)


@pytest.mark.parametrize("name", ["a\\b", "what?", "con", "LPT1.txt", "dot.", "space "])
def test_windows_has_more_rules(name):
    assert folder_name_error(name, windows=True)


def test_names_that_are_fine():
    for name in ("project", "새 프로젝트", "v1.2", "a b", "-dash", "x" * 255):
        assert folder_name_error(name) is None


class _Sftp:
    """asyncssh's SFTP client, over the local filesystem."""

    def __init__(self, home: str) -> None:
        self.home = home

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def realpath(self, p: str) -> str:
        p = os.path.join(self.home, p[2:]) if p.startswith("./") else (self.home if p == "." else p)
        if not os.path.exists(p):
            raise asyncssh.SFTPNoSuchFile("no such file")
        return os.path.realpath(p)

    async def isdir(self, p: str) -> bool:
        return os.path.isdir(p)

    async def exists(self, p: str) -> bool:
        return os.path.lexists(p)

    async def mkdir(self, p: str) -> None:
        if not os.access(os.path.dirname(p), os.W_OK):
            raise asyncssh.SFTPPermissionDenied("permission denied")
        os.mkdir(p)


class _Conn:
    def __init__(self, sftp):
        self.sftp = sftp

    def start_sftp_client(self):
        return self.sftp

    def close(self):
        pass

    async def wait_closed(self):
        pass


def _remote(monkeypatch, home):
    conn = RemoteSshConnector.__new__(RemoteSshConnector)
    conn._spec = type("Spec", (), {"default_path": "~"})()

    async def connect():
        return _Conn(_Sftp(str(home)))

    monkeypatch.setattr(conn, "_asyncssh_connect", connect)
    return conn


def test_on_an_ssh_host_too(tmp_path, monkeypatch):
    (tmp_path / "work").mkdir()
    conn = _remote(monkeypatch, tmp_path)
    entry = asyncio.run(conn.mkdir("~/work", "remote project"))
    assert entry.path == str(tmp_path / "work" / "remote project") and os.path.isdir(entry.path)
    with pytest.raises(FolderExists):
        asyncio.run(conn.mkdir(str(tmp_path / "work"), "remote project"))
    with pytest.raises(WorkspaceError, match="not a directory"):
        asyncio.run(conn.mkdir("~/nope", "x"))
    with pytest.raises(WorkspaceError):
        asyncio.run(conn.mkdir("~/work", "../escape"))


def test_through_the_api(tmp_path):
    with TestClient(app) as client:
        assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        r = client.post("/api/workspaces/mkdir", json={"parent": str(tmp_path), "name": "made"})
        assert r.status_code == 200 and r.json() == {"connection_id": None, "name": "made", "path": str(tmp_path / "made")}
        assert client.post("/api/workspaces/mkdir", json={"parent": str(tmp_path), "name": "made"}).status_code == 409
        assert client.post("/api/workspaces/mkdir", json={"parent": str(tmp_path), "name": "a/b"}).status_code == 400
        listed = client.get("/api/workspaces/list", params={"path": str(tmp_path)}).json()
        assert [e["name"] for e in listed["entries"]] == ["made"]
