"""FastAPI entry point — wires storage, vault, and services, mounts routers.

Mirrors the geny-executor-web lifespan pattern: build services once on
startup, stash them on ``app.state``, tear down on shutdown.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.auth import AuthManager, AuthMiddleware
from app.config import settings
from app.providers.oauth import OAuthManager
from app.db import Database
from app.routers import (
    auth as auth_router,
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

    app.state.auth = AuthManager(db)
    app.state.oauth = OAuthManager()
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

# Auth gate runs first (added last = outermost). CORS added after so it wraps.
app.add_middleware(AuthMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (
    auth_router.router,
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

# Serve the built frontend (single origin => the auth gate covers the UI too).
_static = settings.static_path
if _static is not None:
    @app.get("/")
    async def _index() -> FileResponse:
        return FileResponse(_static / "index.html")

    app.mount("/", StaticFiles(directory=str(_static), html=True), name="static")


def main() -> None:  # pragma: no cover - manual entry
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":  # pragma: no cover
    main()
