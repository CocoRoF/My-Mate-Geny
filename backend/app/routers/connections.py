from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from app.routers._deps import connection_service, workspace_service
from app.schemas.models import ConnectionCreate
from app.services.connection_service import ConnectionService
from app.services.workspace_service import WorkspaceService

router = APIRouter(prefix="/api/connections")


@router.get("")
async def list_connections(svc: ConnectionService = Depends(connection_service)) -> list[dict]:
    return svc.list_all()


@router.get("/hosts")
async def hosts(ws: WorkspaceService = Depends(workspace_service)) -> list[dict]:
    """Where folders can come from: this server, then each SSH connection — marked ``this_host``
    when it turns out to be this very machine (its folders are offered as this server's; see
    app/workspaces/this_host.py). Probes run in parallel and are cached for a few minutes."""
    from app.workspaces import this_host

    conns = ws.connections()

    async def probe(c: dict) -> bool:
        try:
            return await asyncio.wait_for(this_host.is_this_host(ws.connector_for(c["id"])), timeout=15)
        except Exception:  # noqa: BLE001 - unreachable: certainly not usable as this server
            return False

    same = await asyncio.gather(*(probe(c) for c in conns))
    out = [{"id": None, "name": None, "local": True, "this_host": True}]
    for c, s in zip(conns, same):
        out.append({"id": c["id"], "name": c["name"], "host": c["host"], "port": c["port"],
                    "username": c["username"], "default_path": c["default_path"], "local": False,
                    "this_host": bool(s)})
    return out


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
    from app.workspaces import this_host

    svc.delete(cid)
    this_host.forget(cid)
    return {"id": cid, "deleted": True}
