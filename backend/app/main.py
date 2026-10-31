"""FastAPI entry point — wires storage, vault, and services, mounts routers.

Mirrors the geny-executor-web lifespan pattern: build services once on
startup, stash them on ``app.state``, tear down on shutdown.
"""

from __future__ import annotations

import asyncio
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from app import __version__
from app.auth import AuthManager, AuthMiddleware
from app.config import settings
from app.providers.oauth import OAuthManager
from app.providers.accounts import AccountPool, AccountStore
from app.db import Database
from app.routers import (
    accounts,
    admin,
    attachments,
    auth as auth_router,
    downloads,
    files,
    fs,
    config as config_router,
    connections,
    execute,
    git,
    health,
    history,
    providers,
    sessions,
    usage,
    workspaces,
)
from app.services.attachment_service import AttachmentService
from app.services.downloads import DownloadService
from app.services.connection_service import ConnectionService
from app.services.log_service import LogService, install_log_bridge
from app.services.git_service import GitService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from app.ws import sessions as sessions_ws
from app.ws import stream


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = Database()
    db.bootstrap()
    vault = SecretVault(db)

    logs = LogService(db)
    app.state.logs = logs
    install_log_bridge(logs)  # WARNING+ from python logging -> admin log
    attachment_service = AttachmentService(db)
    app.state.attachment_service = attachment_service
    app.state.downloads = DownloadService()

    app.state.auth = AuthManager(db)
    app.state.oauth = OAuthManager()
    account_store = AccountStore(db, vault)
    account_pool = AccountPool(account_store)
    app.state.account_store = account_store
    app.state.account_pool = account_pool
    provider_service = ProviderService(db, vault)
    connection_service = ConnectionService(db, vault)
    app.state.git_service = GitService(db, vault)
    workspace_service = WorkspaceService(connection_service)
    session_service = SessionService(
        db, provider_service, workspace_service, pool=account_pool,
        attachments=attachment_service, logs=logs,
    )

    app.state.db = db
    app.state.vault = vault
    app.state.provider_service = provider_service
    app.state.connection_service = connection_service
    app.state.workspace_service = workspace_service
    app.state.session_service = session_service

    async def housekeeping() -> None:
        while True:
            try:
                await asyncio.to_thread(attachment_service.purge_abandoned)
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(3600)

    housekeeper = asyncio.create_task(housekeeping())

    yield

    housekeeper.cancel()
    await session_service.shutdown()  # end engines (and their background tasks) cleanly
    db.close()


app = FastAPI(title="hr-harnessor", version=__version__, lifespan=lifespan)


class ErrorLogMiddleware(BaseHTTPMiddleware):
    """Record unhandled exceptions and 5xx responses in the admin error log
    (with traceback), and answer with a JSON 500 carrying the log id."""

    async def dispatch(self, request: Request, call_next):
        logs: LogService = request.app.state.logs
        ip = AuthManager.client_ip(request)
        try:
            response = await call_next(request)
        except Exception as exc:  # noqa: BLE001
            log_id = logs.record(
                "error", "http", f"{request.method} {request.url.path} -> {type(exc).__name__}: {exc}",
                code="http.unhandled",
                detail={"method": request.method, "query": request.url.query,
                        "traceback": traceback.format_exc()},
                path=request.url.path, ip=ip,
            )
            return JSONResponse({"detail": "internal server error", "log_id": log_id}, status_code=500)
        if response.status_code >= 500:
            logs.record(
                "error", "http", f"{request.method} {request.url.path} -> HTTP {response.status_code}",
                code=f"http.{response.status_code}", detail={"method": request.method, "query": request.url.query},
                path=request.url.path, ip=ip,
            )
        return response


# Innermost first: error logging wraps the app, the auth gate wraps that, and
# CORS (added last) is outermost.
app.add_middleware(ErrorLogMiddleware)
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
    accounts.router,
    connections.router,
    workspaces.router,
    sessions.router,
    execute.router,
    history.router,
    history.tasks_router,
    usage.router,
    git.router,
    attachments.router,
    files.router,
    fs.router,
    downloads.router,
    admin.router,
):
    app.include_router(r)

app.include_router(stream.router)
app.include_router(sessions_ws.router)

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
