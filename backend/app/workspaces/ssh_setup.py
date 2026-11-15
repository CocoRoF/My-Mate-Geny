"""An SSH connection from a password (docs/remote.md "Adding a server"): the password is used once — to sign in, put a
key made here into the other machine's ``~/.ssh/authorized_keys`` and see that the key signs in — and never kept.
What the connection keeps is that key (in the vault, like a pasted one) and the server's host key (pinned: later
connections must meet the same machine)."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

from app.workspaces.base import WorkspaceError

CONNECT_TIMEOUT = 20
# put the key in once (umask: the folder and the file only the user's), read from stdin — no key on a command line
INSTALL = ('umask 077; mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && chmod 700 "$HOME/.ssh" && '
           'chmod 600 "$HOME/.ssh/authorized_keys" && IFS= read -r K && '
           '{ grep -qxF "$K" "$HOME/.ssh/authorized_keys" || printf "%s\\n" "$K" >> "$HOME/.ssh/authorized_keys"; }')


class SetupError(WorkspaceError):
    """``code``: auth (the password or the user name), unreachable, refused (the key doesn't sign in: the server allows
    passwords only), failed"""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class Installed:
    private_key_pem: str
    home: str
    host_key_line: str  # a known_hosts line for the server (pinned for the connection)


def _known_host(host: str, port: int, key) -> str:
    name = host if port == 22 else f"[{host}]:{port}"
    return f"{name} {key.export_public_key().decode().strip()}\n"


async def install_key(host: str, port: int, username: str, password: str, *, comment: str) -> Installed:
    """Sign in with the password, install a new key, check that it signs in. → the key, the home folder, the host key."""
    import asyncssh

    key = asyncssh.generate_private_key("ssh-ed25519", comment=comment)
    public = key.export_public_key().decode().strip()
    try:
        conn = await asyncio.wait_for(asyncssh.connect(
            host, port=port, username=username, password=password, known_hosts=None, client_keys=None,
            preferred_auth="password,keyboard-interactive", agent_path=None), CONNECT_TIMEOUT)
    except asyncssh.PermissionDenied:
        raise SetupError("The user name or password is wrong.", "auth") from None
    except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
        raise SetupError(f"Can't reach {host}:{port} ({e.__class__.__name__}: {e}).", "unreachable") from None
    try:
        server_key = conn.get_server_host_key()
        home = (await conn.run('printf %s "$HOME"', check=True, timeout=15)).stdout or ""
        done = await conn.run(INSTALL, input=public + "\n", timeout=15)
        if done.exit_status != 0:
            raise SetupError(f"Couldn't add the key on {host}: {(done.stderr or '').strip()[:300]}", "failed")
    finally:
        conn.close()
    # the key itself must sign in now (a server that allows only passwords would fail here)
    try:
        check = await asyncio.wait_for(asyncssh.connect(
            host, port=port, username=username, client_keys=[key], known_hosts=None, password=None,
            preferred_auth="publickey", agent_path=None), CONNECT_TIMEOUT)
        check.close()
    except asyncssh.PermissionDenied:
        raise SetupError(f"{host} doesn't accept SSH keys (only passwords): allow PubkeyAuthentication there.", "refused") from None
    except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
        raise SetupError(f"The key was added but signing in with it failed ({e}).", "failed") from None
    return Installed(key.export_private_key().decode(), str(home).strip(),
                     _known_host(host, port, server_key) if server_key is not None else "")


def pin(conn_dir: str, line: str) -> None:
    """the server's host key, as met while setting up (the connector checks every later connection against it)"""
    if not line:
        return
    os.makedirs(conn_dir, exist_ok=True)
    path = os.path.join(conn_dir, "known_hosts")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(line)
