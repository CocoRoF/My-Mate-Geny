"""An SSH connection from a password (app/workspaces/ssh_setup.py, docs/remote.md "Adding a server"), against a real SSH
server in the test (asyncssh): password sign-in, a key put into ~/.ssh/authorized_keys by a real shell, the key signing
in, the server's host key pinned — and a wrong password, a server that takes passwords only, the HTTP routes."""

from __future__ import annotations

import asyncio
import os
import secrets
from pathlib import Path

import asyncssh
import pytest

from app.workspaces import ssh_setup

# (made at run time: the test server's own, never a literal in the code)
USER = "geny"
PASSWORD = secrets.token_urlsafe(12)
WRONG = secrets.token_urlsafe(12)


class _Server(asyncssh.SSHServer):
    home: Path
    keys_ok = True

    def begin_auth(self, username: str) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return True

    def validate_password(self, username: str, password: str) -> bool:
        return username == USER and password == PASSWORD

    def public_key_auth_supported(self) -> bool:
        return self.keys_ok

    def validate_public_key(self, username: str, key) -> bool:
        auth = self.home / ".ssh" / "authorized_keys"
        want = key.export_public_key().decode().split()[:2]  # (type and key: a line's comment is its own)
        return auth.exists() and any(line.split()[:2] == want for line in auth.read_text().splitlines())


async def _serve(home: Path, *, keys_ok: bool = True):
    """an SSH server whose commands run in a real shell with HOME = `home`"""

    async def run(process: asyncssh.SSHServerProcess) -> None:
        data = await process.stdin.read() if process.command and "read -r" in process.command else ""
        p = await asyncio.create_subprocess_shell(process.command or "true", env={"HOME": str(home), "PATH": os.environ["PATH"]},
                                                  stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                  stderr=asyncio.subprocess.PIPE)
        out, err = await p.communicate(data.encode() if data else None)
        process.stdout.write(out.decode())
        process.stderr.write(err.decode())
        process.exit(p.returncode or 0)

    def factory():
        s = _Server()
        s.home = home
        s.keys_ok = keys_ok
        return s

    server = await asyncssh.create_server(factory, "127.0.0.1", 0, server_host_keys=[asyncssh.generate_private_key("ssh-ed25519")],
                                          process_factory=run)
    return server, server.sockets[0].getsockname()[1]


async def test_a_password_installs_a_key_that_signs_in_and_is_never_kept(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    server, port = await _serve(home)
    try:
        with pytest.raises(ssh_setup.SetupError) as bad:
            await ssh_setup.install_key("127.0.0.1", port, USER, WRONG, comment="t")
        assert bad.value.code == "auth"
        got = await ssh_setup.install_key("127.0.0.1", port, USER, PASSWORD, comment="my-mate-geny test")
        assert got.home == str(home) and "PRIVATE KEY" in got.private_key_pem
        auth = (home / ".ssh" / "authorized_keys").read_text().splitlines()
        assert len(auth) == 1 and auth[0].startswith("ssh-ed25519 ") and auth[0].endswith("my-mate-geny test")
        assert oct((home / ".ssh").stat().st_mode & 0o777) == "0o700"
        assert oct((home / ".ssh" / "authorized_keys").stat().st_mode & 0o777) == "0o600"
        assert got.host_key_line.startswith(f"[127.0.0.1]:{port} ssh-ed25519 ")
        # the key signs in by itself
        key = asyncssh.import_private_key(got.private_key_pem)
        async with asyncssh.connect("127.0.0.1", port=port, username=USER, client_keys=[key], known_hosts=None,
                                    password=None, preferred_auth="publickey", agent_path=None) as c:
            assert (await c.run("printf ok")).stdout == "ok"
        # again (a connection finished twice): another key line, never the same one twice
        await ssh_setup.install_key("127.0.0.1", port, USER, PASSWORD, comment="again")
        lines = (home / ".ssh" / "authorized_keys").read_text().splitlines()
        assert len(lines) == 2 and len(set(lines)) == 2
    finally:
        server.close()


async def test_a_server_that_takes_passwords_only_is_said_so(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    server, port = await _serve(home, keys_ok=False)
    try:
        with pytest.raises(ssh_setup.SetupError) as e:
            await ssh_setup.install_key("127.0.0.1", port, USER, PASSWORD, comment="t")
        assert e.value.code == "refused"
        with pytest.raises(ssh_setup.SetupError) as e:
            await ssh_setup.install_key("127.0.0.1", 1, USER, PASSWORD, comment="t")
        assert e.value.code == "unreachable"
    finally:
        server.close()


async def test_the_routes_add_a_server_with_its_password_and_finish_one_without_a_key(tmp_path):
    import httpx

    from app.config import settings
    from app.main import app

    home = tmp_path / "home"
    home.mkdir()
    server, port = await _serve(home)
    try:
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
                assert (await c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"})).status_code == 200
                r = await c.post("/api/connections", json={"host": "127.0.0.1", "port": port, "username": USER, "password": WRONG})
                assert r.status_code == 400 and r.json()["code"] == "auth"  # (never 401: that would sign the app out)
                r = await c.post("/api/connections", json={"host": "127.0.0.1", "port": port, "username": USER, "password": PASSWORD})
                assert r.status_code == 200, r.text
                conn = r.json()
                assert conn["has_key"] and conn["name"] == "127.0.0.1" and conn["default_path"] == str(home)
                pinned = settings.mount_root_path / conn["id"] / "known_hosts"
                assert pinned.read_text().startswith(f"[127.0.0.1]:{port} ssh-ed25519 ")
                st = (await c.get(f"/api/connections/{conn['id']}/status")).json()
                assert st.get("reachable") is True, st
                # one added without a key (the old form, a key never pasted): the password finishes it
                bare = (await c.post("/api/connections", json={"name": "bare", "host": "127.0.0.1", "port": port,
                                                               "username": USER, "default_path": "."})).json()
                assert not bare["has_key"] and bare["default_path"] == "."
                r = await c.post(f"/api/connections/{bare['id']}/password", json={"password": PASSWORD})
                assert r.status_code == 200, r.text
                assert r.json()["has_key"] and r.json()["default_path"] == str(home)
                r = await c.patch(f"/api/connections/{bare['id']}", json={"name": "srv", "default_path": "/tmp"})
                assert r.json()["name"] == "srv" and r.json()["default_path"] == "/tmp"
                for x in (conn, bare):
                    await c.delete(f"/api/connections/{x['id']}")
    finally:
        server.close()
