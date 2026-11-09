from __future__ import annotations

import asyncio

import shlex
import subprocess

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.routers._deps import workspace_service
from app.services.git_service import git_info as compute_git_info
from app.services.workspace_service import WorkspaceService
from app.workspaces.base import FolderExists, WorkspaceError
from app.workspaces.remote_ssh import RemoteSshConnector

router = APIRouter(prefix="/api/workspaces")


@router.get("/list")
async def list_dir(
    connection_id: str | None = Query(default=None),
    path: str = Query(default="~"),
    svc: WorkspaceService = Depends(workspace_service),
) -> dict:
    try:
        return await svc.list_dir(connection_id, path)
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


class NewFolder(BaseModel):
    connection_id: str | None = None
    parent: str = Field(min_length=1, max_length=4096)
    name: str = Field(min_length=1, max_length=255)


@router.post("/mkdir")
async def mkdir(body: NewFolder, svc: WorkspaceService = Depends(workspace_service)) -> dict:
    """New folder (the folder pickers): ``name`` in ``parent``, on this server or the connection's host."""
    try:
        return await svc.mkdir(body.connection_id, body.parent, body.name)
    except FolderExists as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/git-info")
async def git_info(
    connection_id: str | None = Query(default=None),
    path: str = Query(...),
    svc: WorkspaceService = Depends(workspace_service),
) -> dict:
    """Git context for a workspace path (.git detection, repo, branch, changes)."""
    try:
        if connection_id:
            connector = svc.connector_for(connection_id)
            if not isinstance(connector, RemoteSshConnector):
                return {"is_repo": False}
            prefix = connector.ssh_prefix()

            def run(args: list[str]) -> tuple[int, str]:
                cmd = "git -C " + shlex.quote(path) + " " + " ".join(shlex.quote(a) for a in args)
                p = subprocess.run([*prefix, cmd], capture_output=True, text=True, timeout=12)
                return p.returncode, p.stdout
        else:
            def run(args: list[str]) -> tuple[int, str]:
                p = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True, timeout=12)
                return p.returncode, p.stdout

        return await asyncio.to_thread(compute_git_info, run)
    except Exception as exc:  # noqa: BLE001
        return {"is_repo": False, "error": str(exc)[:200]}
