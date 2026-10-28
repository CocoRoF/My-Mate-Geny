from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.routers._deps import connection_service, workspace_service
from app.schemas.models import ConnectionCreate
from app.services.connection_service import ConnectionService
from app.services.workspace_service import WorkspaceService

router = APIRouter(prefix="/api/connections")


@router.get("")
async def list_connections(svc: ConnectionService = Depends(connection_service)) -> list[dict]:
    return svc.list_all()


@router.post("")
async def create_connection(
    body: ConnectionCreate, svc: ConnectionService = Depends(connection_service)
) -> dict:
    return svc.create(
        name=body.name,
        host=body.host,
        port=body.port,
        username=body.username,
        private_key_pem=body.private_key_pem,
        default_path=body.default_path,
    )


@router.get("/{cid}/status")
async def connection_status(
    cid: str, ws: WorkspaceService = Depends(workspace_service)
) -> dict:
    try:
        return await ws.status(cid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{cid}")
async def delete_connection(cid: str, svc: ConnectionService = Depends(connection_service)) -> dict:
    svc.delete(cid)
    return {"id": cid, "deleted": True}
