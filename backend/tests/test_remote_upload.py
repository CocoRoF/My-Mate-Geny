"""Attachments copied to a "remote" host that is this very machine must not be
destroyed: the remote target is then the local file itself."""

from __future__ import annotations

import asyncio
import os
import shutil

from app.workspaces.remote_ssh import RemoteSshConnector


class _LocalSftp:
    """An SFTP client whose remote filesystem is the local one (ssh to localhost)."""

    def __init__(self, home: str) -> None:
        self.home = home

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def realpath(self, p: str) -> str:
        return self.home

    async def makedirs(self, p: str, exist_ok: bool = False) -> None:
        os.makedirs(p, exist_ok=exist_ok)

    async def put(self, src: str, dst: str) -> None:
        # like asyncssh: open the destination for writing (truncating it) first
        with open(dst, "wb") as out, open(src, "rb") as inp:
            shutil.copyfileobj(inp, out)

    async def posix_rename(self, a: str, b: str) -> None:
        os.replace(a, b)


class _Conn:
    def __init__(self, sftp):
        self._sftp = sftp

    def start_sftp_client(self):
        return self._sftp

    def close(self):
        pass

    async def wait_closed(self):
        pass


def test_upload_to_the_same_machine_keeps_the_file(tmp_path, monkeypatch):
    home = tmp_path / "home"
    folder = home / ".hr-harnessor" / "uploads" / "sess_x" / "att_1"
    folder.mkdir(parents=True)
    original = folder / "shot.png"
    original.write_bytes(b"\x89PNG" + b"x" * 5000)

    conn = RemoteSshConnector.__new__(RemoteSshConnector)

    async def fake_connect():
        return _Conn(_LocalSftp(str(home)))

    monkeypatch.setattr(conn, "_asyncssh_connect", fake_connect)
    out = asyncio.run(conn.upload_files("sess_x", [("att_1", str(original), "shot.png")]))
    assert out == {"att_1": str(original)}
    assert original.stat().st_size == 5004  # not truncated
    assert not (folder / "shot.png.part").exists()
