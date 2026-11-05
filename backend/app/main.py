"""FastAPI entry point — wires storage, vault, and services, mounts routers.

Mirrors the geny-executor-web lifespan pattern: build services once on
startup, stash them on ``app.state``, tear down on shutdown.
"""

from __future__ import annotations

import asyncio
import logging
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app import __version__
from app.auth import AuthManager, AuthMiddleware, OpenCORSMiddleware
from app.config import settings
from app.static_files import ConsoleStaticFiles, index_response
from app.providers.oauth import OAuthManager
from app.providers.accounts import SESSION_CHECK_S, AccountPool, AccountStore
from app.db import Database
from app.routers import (
    mcp as mcp_router,
    screen as screen_router,
    local_runtime,
    setup,
    accounts,
    admin,
    attachments,
    auth as auth_router,
    avatar as avatar_router,
    cli_tools as cli_tools_router,
    downloads,
    files,
    folder_uploads,
    fs,
    config as config_router,
    connections,
    execute,
    git,
    health,
    higgsfield as higgsfield_router,
    history,
    mate_internal,
    mates,
    preferences as preferences_router,
    providers,
    session_git,
    sessions,
    usage,
    workspaces,
)
from app.avatar.service import AvatarService
from app.higgsfield.agent import HiggsfieldAgent
from app.higgsfield.service import HiggsfieldService
from app.mate.service import MateService
from app.mate.store import MateStore
from app.mate.voice import VoiceService
from app.services.attachment_service import AttachmentService
from app.services.cli_tools.service import CliToolsService
from app.services.downloads import DownloadService
from app.services.folder_upload import FolderUploadService
from app.services.connection_service import ConnectionService
from app.services.log_service import LogService, install_log_bridge
from app.services.git_service import GitService
from app.services.provider_service import ProviderService
from app.services.session_git import SessionGit
from app.services.session_service import SessionService
from app.services.sysmon import SystemMonitor
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from app.ws import sessions as sessions_ws
from app.ws import system as system_ws
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
    app.state.auth.warn_if_default()  # also lands in the admin log (bridge above)
    app.state.oauth = OAuthManager()
    account_store = AccountStore(db, vault)
    # plan numbers + their backoff survive restarts; no requests when PLAN_USAGE_FETCH=false
    account_pool = AccountPool(account_store, persist_plans=True, fetch_plans=settings.plan_usage_fetch)
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
    from app.mcp_runtime.service import McpService
    app.state.mcp = McpService(db, vault, session_service, logs)
    session_service.mcp = app.state.mcp
    await app.state.mcp.start()
    app.state.folder_uploads = FolderUploadService(session_service, workspace_service)
    app.state.session_git = SessionGit(session_service, workspace_service, app.state.git_service)
    mate_store = MateStore(db, vault)
    app.state.mate_service = MateService(session_service, mate_store, logs=logs)
    from app.mate.consolidation import Consolidator
    app.state.memory_worker = Consolidator(app.state.mate_service)
    app.state.memory_worker.start()
    app.state.mate_service.recover_memory_work()
    from app.services.screen import ScreenService
    app.state.screen_service = ScreenService(session_service, app.state.mate_service.capture, mates=mate_store)
    session_service.screen = app.state.screen_service
    app.state.screen_service.triggers.mate_runtime = app.state.mate_service
    app.state.screen_service.triggers.start()
    app.state.voice_service = VoiceService(mate_store)
    # Higgsfield: accounts + what the chats' agents get (docs/higgsfield.md)
    higgsfield = HiggsfieldService(db, vault)
    app.state.higgsfield = higgsfield
    app.state.higgsfield_agent = HiggsfieldAgent(
        higgsfield, is_live=session_service.is_live, session_exists=session_service.exists)
    session_service.higgsfield = app.state.higgsfield_agent
    higgsfield_keeper = asyncio.create_task(app.state.higgsfield_agent.run_keeper())
    # Avatar Create (docs/avatar-create.md): the agent in the Mate window that makes video avatars
    app.state.avatar_service = AvatarService(session_service, app.state.mate_service, higgsfield, logs=logs)
    await app.state.avatar_service.start()  # (projects that were running go on)
    # Settings -> Providers -> CLI versions: installed vs latest, upgrades (services/cli_tools)
    cli_tools = CliToolsService(session_service, logs)
    app.state.cli_tools = cli_tools
    await cli_tools.start()

    async def housekeeping() -> None:
        while True:
            try:
                await asyncio.to_thread(attachment_service.purge_abandoned)
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(3600)

    housekeeper = asyncio.create_task(housekeeping())

    async def session_watch() -> None:
        # Login sessions (docs/providers.md): read every account's credentials
        # file (no network) and log the ones that start needing the user.
        while True:
            try:
                await asyncio.to_thread(account_pool.check_sessions)
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(SESSION_CHECK_S)

    session_watcher = asyncio.create_task(session_watch())

    # Host / container metrics, history and alerts (Admin -> System).
    system_monitor = None
    if settings.monitor_enabled:
        try:
            system_monitor = SystemMonitor(db, logs, session_service)
            await system_monitor.start()
        except Exception:  # noqa: BLE001 - monitoring must never block the app
            logging.getLogger(__name__).exception("system monitor failed to start")
            system_monitor = None
    app.state.system_monitor = system_monitor

    from app.services.speech_input import SpeechInput
    app.state.speech_input = SpeechInput(db, session_service)
    session_service.speech_input = app.state.speech_input
    await app.state.speech_input.start()
    await session_service.remote_jobs.start()

    yield
    await setup.service.stop()
    await app.state.memory_worker.stop()

    await app.state.screen_service.triggers.stop()
    housekeeper.cancel()
    session_watcher.cancel()
    higgsfield_keeper.cancel()
    await app.state.avatar_service.stop()
    await cli_tools.stop()
    if system_monitor is not None:
        await system_monitor.stop()  # flushes the partial minute, marks a clean shutdown
    await app.state.speech_input.stop()
    await session_service.shutdown()  # end engines (and their background tasks) cleanly
    await app.state.mcp.stop()
    db.close()


app = FastAPI(title="My Mate Geny", version=__version__, lifespan=lifespan)


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


# Innermost first: error logging wraps the app, the auth gate wraps that, then
# the credentialed CORS policy, and outermost the open (``*``, no credentials)
# CORS for /health + /api/auth/login that native connect pages need.
app.add_middleware(ErrorLogMiddleware)
app.add_middleware(AuthMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(OpenCORSMiddleware)

for r in (
    mcp_router.router,
    mcp_router.internal,
    screen_router.router,
    screen_router.internal,
    auth_router.router,
    health.router,
    config_router.router,
    providers.router,
    accounts.router,
    higgsfield_router.router,
    connections.router,
    workspaces.router,
    session_git.router,
    sessions.router,
    execute.router,
    history.router,
    history.tasks_router,
    usage.router,
    git.router,
    attachments.router,
    files.router,
    folder_uploads.router,
    fs.router,
    downloads.router,
    admin.router,
    mates.router,
    mate_internal.router,
    avatar_router.router,
    avatar_router.internal,
    preferences_router.router,
    cli_tools_router.router,
    local_runtime.router,
    setup.router,
):
    app.include_router(r)

app.include_router(stream.router)
app.include_router(sessions_ws.router)
app.include_router(system_ws.router)

# Serve the built frontend (single origin => the auth gate covers the UI too).
_static = settings.static_path
if _static is not None:
    # index.html never cached without revalidation, hashed assets immutable (app/static_files.py: a page cached from
    # the previous build would load code a deploy removed — a blank window)
    @app.get("/")
    async def _index():
        return index_response(_static)

    app.mount("/", ConsoleStaticFiles(directory=str(_static), html=True), name="static")


def main() -> None:  # pragma: no cover - manual entry
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":  # pragma: no cover
    main()
