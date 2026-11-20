"""A mate as a file (app/mate/transfer.py; docs/mate.md "Export and import"): her package to download, and a new mate from one."""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.config import settings
from app.mate import transfer
from app.mate.store import MateError

router = APIRouter(prefix="/api/mates")


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, KeyError):
        return HTTPException(404, str(exc).strip("'"))
    return HTTPException(getattr(exc, "status", 400), str(exc))


@router.get("/{mate_id}/export")
async def export_mate(mate_id: str, request: Request) -> FileResponse:
    """Her package (.mate.zip): the character, how she talks, her temperament, avatar, wardrobe, picture and voice."""
    fd, tmp = tempfile.mkstemp(suffix=".mate.zip", prefix="mate-export-")
    os.close(fd)
    try:
        _path, name = await asyncio.to_thread(request.app.state.mate_service.export_mate, mate_id, Path(tmp))
    except (KeyError, MateError) as exc:
        os.unlink(tmp)
        raise _http(exc) from exc
    except Exception:
        os.unlink(tmp)
        raise
    return FileResponse(tmp, media_type="application/zip", background=BackgroundTask(os.unlink, tmp),
                        headers={"Content-Disposition": f"attachment; filename=\"mate.mate.zip\"; filename*=UTF-8''{quote(name)}",
                                 "Cache-Control": "no-store"})


@router.post("/import")
async def import_mate(request: Request, file: UploadFile = File(...)) -> dict:
    """A new mate from a package. → {mate, notes} (notes: what couldn't come along as it was — ``voice:tts:elevenlabs`` …)."""
    limit = settings.mate_import_max_mb * 1024 * 1024
    fd, tmp = tempfile.mkstemp(suffix=".zip", prefix="mate-import-")
    try:
        size = 0
        with os.fdopen(fd, "wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"the mate file is larger than {settings.mate_import_max_mb} MB")
                fh.write(chunk)
        svc = request.app.state.mate_service
        voice = getattr(request.app.state, "voice_service", None)
        usable = transfer.usable_here(svc.store, getattr(voice, "local", None))
        try:
            return await asyncio.to_thread(svc.import_mate, tmp, usable)
        except (KeyError, MateError) as exc:
            raise _http(exc) from exc
    finally:
        os.unlink(tmp)
