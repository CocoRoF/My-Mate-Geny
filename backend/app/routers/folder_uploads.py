"""Folders from the user's own computer: same-machine probe, upload a copy
(see app/services/folder_upload.py)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, UploadFile
from pydantic import BaseModel

from app.services.folder_upload import FolderUploadError, FolderUploadService, limits

router = APIRouter()


def _svc(request: Request) -> FolderUploadService:
    return request.app.state.folder_uploads


def _err(exc: FolderUploadError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


class BeginBody(BaseModel):
    name: str
    files: int
    bytes: int


class ProbeBody(BaseModel):
    probe_path: str
    nonce: str
    path: str = ""


@router.get("/api/folder-uploads/limits")
async def upload_limits() -> dict:
    return limits()


@router.post("/api/folder-uploads/probe")
async def probe(body: ProbeBody, request: Request) -> dict:
    return _svc(request).probe(body.probe_path, body.nonce, body.path)


@router.post("/api/sessions/{sid}/folder-uploads")
async def begin(sid: str, body: BeginBody, request: Request) -> dict:
    try:
        return _svc(request).begin(sid, body.name, body.files, body.bytes)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except FolderUploadError as exc:
        raise _err(exc) from exc


@router.post("/api/sessions/{sid}/folder-uploads/{uid}/files")
async def add_files(sid: str, uid: str, request: Request) -> dict:
    """multipart: ``files`` (the contents) + ``paths`` (each file's path in the
    folder, same order) — a file's own name could not carry the folders."""
    form = await request.form(max_files=2000, max_fields=2000)
    try:
        files = [f for f in form.getlist("files") if isinstance(f, UploadFile) or hasattr(f, "read")]
        paths = [str(p) for p in form.getlist("paths")]
        if len(files) != len(paths):
            raise FolderUploadError("each file needs its path")
        return await _svc(request).add(sid, uid, list(zip(paths, files)))
    except FolderUploadError as exc:
        raise _err(exc) from exc
    finally:
        await form.close()


@router.post("/api/sessions/{sid}/folder-uploads/{uid}/finish")
async def finish(sid: str, uid: str, request: Request) -> dict:
    try:
        return await _svc(request).finish(sid, uid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:  # e.g. too many additional folders
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FolderUploadError as exc:
        raise _err(exc) from exc


@router.delete("/api/sessions/{sid}/folder-uploads/{uid}")
async def abort(sid: str, uid: str, request: Request) -> dict:
    try:
        _svc(request).abort(sid, uid)
    except FolderUploadError as exc:
        raise _err(exc) from exc
    return {"ok": True}
