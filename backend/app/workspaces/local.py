"""Local workspace connector — folders on the runtime host."""

from __future__ import annotations

import os
from typing import Any

from app.workspaces.base import DirEntry, FolderExists, WorkspaceConnector, WorkspaceError, folder_name_error


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

    async def mkdir(self, parent: str, name: str) -> DirEntry:
        name = (name or "").strip()
        why = folder_name_error(name, windows=os.name == "nt")
        if why:
            raise WorkspaceError(why)
        base = os.path.abspath(os.path.expanduser(parent or "~"))
        if not os.path.isdir(base):
            raise WorkspaceError(f"not a directory: {base}")
        target = os.path.join(base, name)
        if os.path.lexists(target):
            raise FolderExists(f"“{name}” already exists in {base}")
        try:
            os.mkdir(target)
        except FileExistsError as exc:
            raise FolderExists(f"“{name}” already exists in {base}") from exc
        except PermissionError as exc:
            raise WorkspaceError(f"permission denied: {base}") from exc
        except OSError as exc:
            raise WorkspaceError(f"could not create the folder: {exc.strerror or exc}") from exc
        return DirEntry(name=name, path=target, is_dir=True)

    async def status(self) -> dict[str, Any]:
        return {"kind": self.kind, "reachable": True, "host": "localhost"}
