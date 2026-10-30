"""Workspace connector contract.

A *workspace* answers "where does the agent run and operate files?". Two
implementations:

* :class:`~app.workspaces.local.LocalConnector` — a path on the 2223 runtime.
* :class:`~app.workspaces.remote_ssh.RemoteSshConnector` — a path on a remote
  SSH host (2222 / 2224), surfaced to the agent via an sshfs mount on 2223
  plus a remote-bash MCP bridge.

The runtime always stays on 2223; the connector's job is to produce a local
``cwd`` the provider CLI can use, and optionally an ``mcp_config`` that routes
command execution to the right host.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any


class WorkspaceError(RuntimeError):
    pass


@dataclass
class DirEntry:
    name: str
    path: str
    is_dir: bool


class WorkspaceConnector(abc.ABC):
    kind: str  # "local" | "remote_ssh"

    @abc.abstractmethod
    async def resolve_cwd(self, path: str) -> str:
        """Return a path on the 2223 filesystem the provider CLI can cd into.

        For local this is the path itself; for remote it is the sshfs mount
        point (mounting on demand)."""

    @abc.abstractmethod
    async def list_dir(self, path: str) -> list[DirEntry]:
        """List directory entries for the folder picker."""

    @abc.abstractmethod
    async def status(self) -> dict[str, Any]:
        """Health / reachability info for the UI."""

    async def mcp_config(self, path: str) -> dict[str, Any] | None:
        """Optional MCP config to attach so tool calls hit the right host.

        Local returns ``None`` (the CLI's built-in tools run on 2223 directly)."""
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
