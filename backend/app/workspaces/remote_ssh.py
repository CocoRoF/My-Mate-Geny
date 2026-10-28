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
import shutil
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

    def _mount_point(self, path: str) -> str:
        digest = hashlib.sha1(path.encode()).hexdigest()[:10]
        return str(settings.mount_root_path / self._spec.connection_id / digest)

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
        """Mount the remote folder via sshfs and return the local mount point."""
        if shutil.which("sshfs") is None:
            raise WorkspaceError(
                "sshfs not available on the runtime host — install it "
                "(apt-get install sshfs) to use remote workspaces"
            )
        if not self._spec.private_key_pem:
            raise WorkspaceError("no SSH private key configured for this connection")

        remote_path = path or self._spec.default_path
        mount_point = self._mount_point(remote_path)
        if self._mounts.get(remote_path) and os.path.ismount(mount_point):
            return mount_point

        os.makedirs(mount_point, exist_ok=True)
        # Write key to a temp 0600 file for sshfs (which needs IdentityFile).
        key_path = os.path.join(mount_point + ".key")
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(self._spec.private_key_pem)

        target = f"{self._spec.username}@{self._spec.host}:{remote_path}"
        argv = [
            "sshfs",
            target,
            mount_point,
            "-p",
            str(self._spec.port),
            "-o",
            f"IdentityFile={key_path},StrictHostKeyChecking=no,reconnect",
        ]
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise WorkspaceError(f"sshfs mount failed: {stderr.decode(errors='replace')[:500]}")
        self._mounts[remote_path] = mount_point
        return mount_point

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
            "sshfs_available": shutil.which("sshfs") is not None,
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

    async def mcp_config(self, path: str) -> dict[str, Any] | None:
        """Attach the remote-bash MCP bridge so Bash runs on the remote host."""
        bridge = os.path.join(os.path.dirname(__file__), "mcp_remote_bridge.py")
        return {
            "mcpServers": {
                "remote": {
                    "type": "stdio",
                    "command": "python3",
                    "args": [bridge],
                    "env": {
                        "HRH_SSH_HOST": self._spec.host,
                        "HRH_SSH_PORT": str(self._spec.port),
                        "HRH_SSH_USER": self._spec.username,
                        "HRH_SSH_CWD": path or self._spec.default_path,
                        # Key passed by path (0600) rather than inline env.
                    },
                }
            }
        }

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
