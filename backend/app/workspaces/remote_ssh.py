"""Remote SSH workspace connector (scaffold).

Strategy — the runtime stays on 2223, but the agent operates a folder on a
remote host (2222 / 2224):

1. **Files** — the remote folder is mounted onto 2223 with ``sshfs`` at
   ``<MOUNT_ROOT>/<connection_id>/<path-hash>``. The provider CLI's cwd is set
   to that mount, so its built-in Read/Write/Edit/Glob/Grep operate on remote
   files transparently.
2. **Commands** — a remote-bash MCP bridge (see
   :mod:`app.workspaces.mcp_remote_bridge`) is attached to the provider so Bash
   tool calls execute on the remote host over ``asyncssh``, not on 2223.

This is a scaffold: connection validation + mount/unmount are implemented
defensively (friendly errors when ``sshfs`` or keys are missing). End-to-end
verification against 2222/2224 is a follow-up milestone.

Adapted from GAPT's ``SshConnectionSpec`` / ``RemoteSshTarget`` (asyncssh,
in-memory keys).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from dataclasses import dataclass
from typing import Any

from app.config import settings
from app.workspaces.base import DirEntry, WorkspaceConnector, WorkspaceError


@dataclass
class SshSpec:
    connection_id: str
    host: str
    port: int
    username: str
    private_key_pem: str | None  # held in memory only (read from vault)
    default_path: str = "."


class RemoteSshConnector(WorkspaceConnector):
    kind = "remote_ssh"

    def __init__(self, spec: SshSpec) -> None:
        self._spec = spec
        self._mounts: dict[str, str] = {}

    # ---- helpers ----

    def _conn_dir(self) -> str:
        d = str(settings.mount_root_path / self._spec.connection_id)
        os.makedirs(d, exist_ok=True)
        return d

    def _mount_point(self, path: str) -> str:
        digest = hashlib.sha1(path.encode()).hexdigest()[:10]
        return os.path.join(self._conn_dir(), digest)

    def _ensure_key_file(self) -> str:
        """Write the decrypted private key to one 0600 file, reused by sshfs and
        the bash bridge. Returns its path."""
        if not self._spec.private_key_pem:
            raise WorkspaceError("no SSH private key configured for this connection")
        key_path = os.path.join(self._conn_dir(), "id_key")
        pem = self._spec.private_key_pem
        if not pem.endswith("\n"):
            pem += "\n"
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(pem)
        return key_path

    async def _asyncssh_connect(self):
        try:
            import asyncssh  # noqa: F401
        except ImportError as exc:  # pragma: no cover
            raise WorkspaceError("asyncssh not installed") from exc
        import asyncssh

        if not self._spec.private_key_pem:
            raise WorkspaceError("no SSH private key configured for this connection")
        client_key = asyncssh.import_private_key(self._spec.private_key_pem)
        return await asyncssh.connect(
            host=self._spec.host,
            port=self._spec.port,
            username=self._spec.username,
            client_keys=[client_key],
            known_hosts=None,  # TODO: pin known_hosts in a follow-up
        )

    # ---- contract ----

    async def resolve_cwd(self, path: str) -> str:
        """Return a small LOCAL scratch dir for the agent to start in.

        The agent never cd's into the remote filesystem (sshfs-in-container is
        brittle). Instead all remote I/O goes through the remote_* MCP tools
        (see :meth:`mcp_config`). A CLAUDE.md in the scratch dir tells the agent
        the remote target and to use those tools.
        """
        if not self._spec.private_key_pem:
            raise WorkspaceError("no SSH private key configured for this connection")
        self._ensure_key_file()  # 0600, shared with the bridge

        remote_path = path or self._spec.default_path
        scratch = os.path.join(self._conn_dir(), "scratch_" + hashlib.sha1(remote_path.encode()).hexdigest()[:8])
        os.makedirs(scratch, exist_ok=True)
        guide = (
            f"# Remote session\n\n"
            f"This is a LOCAL scratch directory. The real workspace is on a remote host:\n\n"
            f"- Host: `{self._spec.username}@{self._spec.host}:{self._spec.port}`\n"
            f"- Remote path: `{remote_path}`\n\n"
            f"Operate the remote host ONLY through the `remote_*` MCP tools "
            f"(`remote_bash`, `remote_read`, `remote_write`, `remote_list`). "
            f"Do NOT use your built-in file/Bash tools for the task — they act on "
            f"this local scratch dir, not the remote host.\n"
        )
        try:
            with open(os.path.join(scratch, "CLAUDE.md"), "w") as fh:
                fh.write(guide)
        except OSError:
            pass
        return scratch

    async def list_dir(self, path: str) -> list[DirEntry]:
        """List a remote directory over SFTP (no mount needed for browsing)."""
        remote_path = path or self._spec.default_path
        conn = await self._asyncssh_connect()
        try:
            async with conn.start_sftp_client() as sftp:
                names = await sftp.listdir(remote_path)
                entries: list[DirEntry] = []
                for name in sorted(names):
                    if name in (".", "..") or name.startswith("."):
                        continue
                    full = os.path.join(remote_path, name)
                    try:
                        is_dir = (await sftp.stat(full)).permissions is not None and await sftp.isdir(
                            full
                        )
                    except Exception:
                        is_dir = False
                    entries.append(DirEntry(name=name, path=full, is_dir=is_dir))
                return entries
        finally:
            conn.close()
            await conn.wait_closed()

    async def status(self) -> dict[str, Any]:
        info: dict[str, Any] = {
            "kind": self.kind,
            "host": f"{self._spec.username}@{self._spec.host}:{self._spec.port}",
            "has_key": bool(self._spec.private_key_pem),
        }
        try:
            conn = await self._asyncssh_connect()
            conn.close()
            await conn.wait_closed()
            info["reachable"] = True
        except Exception as exc:  # noqa: BLE001 - surface the reason to the UI
            info["reachable"] = False
            info["error"] = str(exc)[:300]
        return info

    def ssh_prefix(self) -> list[str]:
        """argv prefix to run a command on the remote host over SSH."""
        key = self._ensure_key_file()
        return [
            "ssh", "-p", str(self._spec.port), "-i", key,
            "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
            f"{self._spec.username}@{self._spec.host}",
        ]

    async def mcp_config(self, path: str) -> dict[str, Any] | None:
        """Attach the remote-bash MCP bridge so Bash runs on the remote host."""
        import sys

        bridge = os.path.join(os.path.dirname(__file__), "mcp_remote_bridge.py")
        key_path = self._ensure_key_file()
        return {
            "mcpServers": {
                "remote": {
                    "type": "stdio",
                    # Absolute interpreter so the spawn never depends on the
                    # child PATH; PATH is still passed so the bridge finds `ssh`.
                    "command": sys.executable,
                    "args": [bridge],
                    "env": {
                        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                        "HOME": os.environ.get("HOME", "/root"),
                        "HRH_SSH_HOST": self._spec.host,
                        "HRH_SSH_PORT": str(self._spec.port),
                        "HRH_SSH_USER": self._spec.username,
                        "HRH_SSH_CWD": path or self._spec.default_path,
                        "HRH_SSH_KEY_FILE": key_path,  # 0600, same key as sshfs
                    },
                }
            }
        }

    async def upload_files(self, session_id: str, files: list[tuple[str, str, str]]) -> dict[str, str]:
        """Copy attachments to ``~/.hr-harnessor/uploads/<session>/<id>/<name>``
        on the remote host over SFTP so remote tools can use them."""
        if not files:
            return {}
        conn = await self._asyncssh_connect()
        out: dict[str, str] = {}
        try:
            async with conn.start_sftp_client() as sftp:
                home = await sftp.realpath(".")
                for aid, local_path, name in files:
                    folder = f"{home}/.hr-harnessor/uploads/{session_id}/{aid}"
                    await sftp.makedirs(folder, exist_ok=True)
                    target = f"{folder}/{name}"
                    await sftp.put(local_path, target)
                    out[aid] = target
        finally:
            conn.close()
            await conn.wait_closed()
        return out

    async def teardown(self) -> None:
        for remote_path, mount_point in list(self._mounts.items()):
            try:
                proc = await asyncio.create_subprocess_exec(
                    "fusermount", "-u", mount_point,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await proc.communicate()
            except FileNotFoundError:
                pass
            self._mounts.pop(remote_path, None)
