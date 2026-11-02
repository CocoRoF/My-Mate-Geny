"""Settings → Providers → CLI versions (app/services/cli_tools).

    GET  /api/cli-tools                    every CLI: installed / latest / upgrade plan / job
    POST /api/cli-tools/check              {tool?}: re-run --version and the registry lookup now
    POST /api/cli-tools/{tool}/upgrade     {version?, when: now|idle}: start (one at a time)
    POST /api/cli-tools/{tool}/cancel      a waiting ("when idle") upgrade
    PUT  /api/cli-tools/{tool}             {auto_upgrade?, channel?, use_managed?}

Progress is pushed over /ws/sessions: ``cli.log`` (new log lines) and
``cli.changed`` (refetch the status). Errors: ``{"detail": "<message>", "code": "<code>"}``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.services.cli_tools.service import CliToolsService, UpgradeError
from app.services.cli_tools.tools import TOOLS

router = APIRouter(prefix="/api/cli-tools")


class CheckBody(BaseModel):
    tool: str | None = None


class UpgradeBody(BaseModel):
    version: str | None = None   # an exact version (pin / roll back) or a channel; default: the tool's channel
    when: str = "now"            # now | idle (once no chat is running)


class SettingsBody(BaseModel):
    auto_upgrade: bool | None = None
    channel: str | None = None
    use_managed: bool | None = None


def _svc(request: Request) -> CliToolsService:
    return request.app.state.cli_tools


def _tool(tool: str) -> str:
    if tool not in TOOLS:
        raise HTTPException(status_code=404, detail=f"unknown CLI: {tool}")
    return tool


def _error(exc: UpgradeError) -> JSONResponse:
    return JSONResponse({"detail": str(exc), "code": exc.code}, status_code=exc.status)


@router.get("")
async def status(request: Request) -> dict:
    return await _svc(request).status()


@router.post("/check")
async def check(body: CheckBody, request: Request) -> dict:
    svc = _svc(request)
    await svc.check(_tool(body.tool) if body.tool else None)
    return await svc.status()


@router.post("/{tool}/upgrade")
async def upgrade(tool: str, body: UpgradeBody, request: Request):
    try:
        return await _svc(request).upgrade(_tool(tool), version=body.version or None, when=body.when)
    except UpgradeError as exc:
        return _error(exc)


@router.post("/{tool}/cancel")
async def cancel(tool: str, request: Request):
    try:
        return await _svc(request).cancel(_tool(tool))
    except UpgradeError as exc:
        return _error(exc)


@router.put("/{tool}")
async def update(tool: str, body: SettingsBody, request: Request):
    svc = _svc(request)
    try:
        svc.update_settings(_tool(tool), auto_upgrade=body.auto_upgrade, channel=body.channel,
                            use_managed=body.use_managed)
    except UpgradeError as exc:
        return _error(exc)
    return await svc.tool_status(tool)
