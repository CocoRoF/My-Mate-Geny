"""Resolve workspace connectors (local or remote) and browse folders."""

from __future__ import annotations

from typing import Any

from app.services.connection_service import ConnectionService
from app.workspaces.base import WorkspaceConnector
from app.workspaces.local import LocalConnector


class WorkspaceService:
    def __init__(self, connections: ConnectionService) -> None:
        self._connections = connections
        self._local = LocalConnector()

    def connections(self) -> list[dict[str, Any]]:
        """The SSH connections the user registered (public fields only)."""
        return self._connections.list_all()

    def connector_for(self, connection_id: str | None) -> WorkspaceConnector:
        if not connection_id:
            return self._local
        return self._connections.build_connector(connection_id)

    async def mkdir(self, connection_id: str | None, parent: str, name: str) -> dict[str, Any]:
        """A new folder in ``parent`` (on this server, or the connection's host)."""
        entry = await self.connector_for(connection_id).mkdir(parent, name)
        return {"connection_id": connection_id, "name": entry.name, "path": entry.path}

    async def list_dir(self, connection_id: str | None, path: str) -> dict[str, Any]:
        connector = self.connector_for(connection_id)
        entries = await connector.list_dir(path)
        return {
            "connection_id": connection_id,
            "path": getattr(connector, "resolved_path", None) or path,
            "entries": [
                {"name": e.name, "path": e.path, "is_dir": e.is_dir} for e in entries
            ],
        }

    async def status(self, connection_id: str | None) -> dict[str, Any]:
        return await self.connector_for(connection_id).status()
