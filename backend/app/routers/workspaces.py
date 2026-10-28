from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.routers._deps import workspace_service
from app.services.workspace_service import WorkspaceService
from app.workspaces.base import WorkspaceError

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
