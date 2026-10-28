"""FastAPI entry point — wires storage, vault, and services, mounts routers.

Mirrors the geny-executor-web lifespan pattern: build services once on
startup, stash them on ``app.state``, tear down on shutdown.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import settings
from app.db import Database
from app.routers import (
    config as config_router,
    connections,
    execute,
    health,
    history,
    providers,
    sessions,
    workspaces,
)
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from app.ws import stream


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = Database()
    db.bootstrap()
    vault = SecretVault(db)

    provider_service = ProviderService(db, vault)
    connection_service = ConnectionService(db, vault)
    workspace_service = WorkspaceService(connection_service)
    session_service = SessionService(db, provider_service, workspace_service)

    app.state.db = db
    app.state.vault = vault
    app.state.provider_service = provider_service
    app.state.connection_service = connection_service
    app.state.workspace_service = workspace_service
    app.state.session_service = session_service

    yield

    db.close()


app = FastAPI(title="hr-harnessor", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (
    health.router,
    config_router.router,
    providers.router,
    connections.router,
    workspaces.router,
    sessions.router,
    execute.router,
    history.router,
):
    app.include_router(r)

app.include_router(stream.router)


def main() -> None:  # pragma: no cover - manual entry
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":  # pragma: no cover
    main()
