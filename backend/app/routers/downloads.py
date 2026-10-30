"""Download page API: latest native app builds + authenticated asset serving."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/downloads")


@router.get("")
async def latest(request: Request, refresh: bool = False) -> dict:
    return await asyncio.to_thread(request.app.state.downloads.latest, refresh)


@router.get("/asset/{asset_id}/{name}")
async def asset(asset_id: int, name: str, request: Request):
    svc = request.app.state.downloads
    try:
        path, real_name = await asyncio.to_thread(svc.asset_path, asset_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such build (a newer one may have replaced it)") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"could not fetch the build: {exc}") from exc
    media = {
        ".apk": "application/vnd.android.package-archive",
        ".dmg": "application/x-apple-diskimage",
        ".exe": "application/vnd.microsoft.portable-executable",
        ".deb": "application/vnd.debian.binary-package",
    }.get(path.suffix, "application/octet-stream")
    return FileResponse(path, media_type=media, filename=real_name, content_disposition_type="attachment",
                        headers={"Cache-Control": "private, max-age=3600"})
