"""SSH connections (docs/remote.md): add one with a password (used once to install a key made here — never kept) or
with a private key of their own, finish one that has no key with a password, rename it or change its start folder."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from app.routers._deps import connection_service, workspace_service
from app.schemas.models import ConnectionCreate, ConnectionPassword, ConnectionPatch
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


def _setup_failed(e: Exception) -> JSONResponse:
    # (400 even for a wrong password: a 401 means the app's own session ended — the page would go to its login)
    return JSONResponse({"detail": str(e), "code": getattr(e, "code", "failed")}, status_code=400)


@router.post("")
async def create_connection(
    body: ConnectionCreate, svc: ConnectionService = Depends(connection_service)
) -> Any:
    from app.config import settings
    from app.workspaces import ssh_setup

    host, user = body.host.strip(), body.username.strip()
    if not host or not user:
        return JSONResponse({"detail": "A host and a user name are needed", "code": "bad_input"}, status_code=400)
    name = body.name.strip() or host
    installed = None
    if body.password:
        try:
            installed = await ssh_setup.install_key(host, body.port, user, body.password, comment=f"my-mate-geny {name}")
        except ssh_setup.SetupError as e:
            return _setup_failed(e)
    path = body.default_path.strip() or (installed.home if installed else "") or "."
    conn = svc.create(name=name, host=host, port=body.port, username=user,
                      private_key_pem=installed.private_key_pem if installed else body.private_key_pem, default_path=path)
    if installed:
        ssh_setup.pin(str(settings.mount_root_path / conn["id"]), installed.host_key_line)
    return conn


@router.post("/{cid}/password")
async def finish_with_password(
    cid: str, body: ConnectionPassword, svc: ConnectionService = Depends(connection_service)
) -> Any:
    """A connection with no key (or one that no longer signs in): the password installs a new one."""
    from app.config import settings
    from app.workspaces import ssh_setup, this_host

    try:
        c = svc.get(cid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        installed = await ssh_setup.install_key(c["host"], c["port"], c["username"], body.password,
                                                comment=f"my-mate-geny {c['name']}")
    except ssh_setup.SetupError as e:
        return _setup_failed(e)
    out = svc.set_key(cid, installed.private_key_pem, home=installed.home)
    ssh_setup.pin(str(settings.mount_root_path / cid), installed.host_key_line)
    this_host.forget(cid)
    return out


@router.patch("/{cid}")
async def update_connection(cid: str, body: ConnectionPatch, svc: ConnectionService = Depends(connection_service)) -> dict:
    try:
        return svc.update(cid, name=body.name, default_path=body.default_path)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


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
