"""Workspace layer — where an agent runs (local or remote SSH)."""

from app.workspaces.base import DirEntry, WorkspaceConnector, WorkspaceError
from app.workspaces.local import LocalConnector
from app.workspaces.remote_ssh import RemoteSshConnector

__all__ = [
    "DirEntry",
    "WorkspaceConnector",
    "WorkspaceError",
    "LocalConnector",
    "RemoteSshConnector",
]
