"""Workspace connector contract.

A *workspace* answers "where does the agent run and operate files?". Two
implementations:

* :class:`~app.workspaces.local.LocalConnector` — a path on the runtime host.
* :class:`~app.workspaces.remote_ssh.RemoteSshConnector` — a path on a remote
  SSH host, surfaced to the agent via an sshfs mount on the runtime host
  plus a remote-bash MCP bridge.

The runtime always stays on the server host; the connector's job is to produce a local
``cwd`` the provider CLI can use, and optionally an ``mcp_config`` that routes
command execution to the right host.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any


class WorkspaceError(RuntimeError):
    pass


class FolderExists(WorkspaceError):
    """A new folder's name is already taken there."""


_WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def folder_name_error(name: str, *, windows: bool = False) -> str | None:
    """Why ``name`` can't be a new folder's name (one level, no path), or None."""
    if not name:
        return "Give the folder a name."
    if name in (".", ".."):
        return f"“{name}” can't be a folder name."
    if "/" in name or "\0" in name or (windows and "\\" in name):
        return "A folder name can't contain a slash."
    if any(ord(c) < 32 for c in name):
        return "A folder name can't contain control characters."
    if len(name.encode("utf-8")) > 255:
        return "That name is too long."
    if windows:
        if any(c in '<>:"|?*' for c in name):
            return 'A folder name can\'t contain < > : " | ? *'
        if name.endswith((".", " ")):
            return "A folder name can't end with a dot or a space."
        if name.split(".")[0].upper() in _WINDOWS_RESERVED:
            return f"“{name}” is a reserved name."
    return None


@dataclass
class DirEntry:
    name: str
    path: str
    is_dir: bool


class WorkspaceConnector(abc.ABC):
    kind: str  # "local" | "remote_ssh"

    @abc.abstractmethod
    async def resolve_cwd(self, path: str, extra_dirs: list[str] | None = None) -> str:
        """Return a path on the runtime filesystem the provider CLI can cd into.

        For local this is the path itself; for remote it is the sshfs mount
        point (mounting on demand)."""

    @abc.abstractmethod
    async def list_dir(self, path: str) -> list[DirEntry]:
        """List directory entries for the folder picker."""

    async def mkdir(self, parent: str, name: str) -> DirEntry:
        """Create the folder ``name`` in ``parent`` (the folder pickers' New folder). Raises :class:`FolderExists`
        when the name is taken, :class:`WorkspaceError` otherwise."""
        raise WorkspaceError("this connection can't create folders")

    @abc.abstractmethod
    async def status(self) -> dict[str, Any]:
        """Health / reachability info for the UI."""

    async def mcp_config(self, path: str) -> dict[str, Any] | None:
        """Optional MCP config to attach so tool calls hit the right host.

        Local returns ``None`` (the CLI's built-in tools run on the runtime host directly)."""
        return None

    async def upload_files(self, session_id: str, files: list[tuple[str, str, str]]) -> dict[str, str]:
        """Make chat attachments reachable where the agent works.

        ``files`` is ``[(attachment_id, local_path, name), ...]``; returns
        ``{attachment_id: path_on_target}`` for files that had to be copied.
        Local workspaces already see the runtime filesystem, so: no-op."""
        return {}

    async def teardown(self) -> None:
        """Release resources (e.g. unmount). Default no-op."""
        return None
