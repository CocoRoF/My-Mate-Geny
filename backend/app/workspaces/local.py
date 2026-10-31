"""Local workspace connector — folders on the runtime host."""

from __future__ import annotations

import os
from typing import Any

from app.workspaces.base import DirEntry, WorkspaceConnector, WorkspaceError


class LocalConnector(WorkspaceConnector):
    kind = "local"

    async def resolve_cwd(self, path: str, extra_dirs: list[str] | None = None) -> str:
        abspath = os.path.abspath(os.path.expanduser(path))
        if not os.path.isdir(abspath):
            raise WorkspaceError(f"not a directory: {abspath}")
        return abspath

    async def list_dir(self, path: str) -> list[DirEntry]:
        abspath = os.path.abspath(os.path.expanduser(path or "~"))
        if not os.path.isdir(abspath):
            raise WorkspaceError(f"not a directory: {abspath}")
        entries: list[DirEntry] = []
        try:
            for name in sorted(os.listdir(abspath)):
                if name.startswith("."):
                    continue
                full = os.path.join(abspath, name)
                entries.append(DirEntry(name=name, path=full, is_dir=os.path.isdir(full)))
        except PermissionError as exc:
            raise WorkspaceError(f"permission denied: {abspath}") from exc
        return entries

    async def status(self) -> dict[str, Any]:
        return {"kind": self.kind, "reachable": True, "host": "localhost"}
