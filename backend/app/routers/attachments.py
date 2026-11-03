"""Chat attachments — upload from the composer, serve into the chat."""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from app.auth import AuthManager
from app.config import settings
from app.routers._deps import session_service
from app.services.attachment_service import AttachmentError, AttachmentService
from app.services.session_service import SessionService

router = APIRouter()

# Rendered inline in the browser; everything else is served as a download.
# (HTML/SVG/XML never inline: they could run script on our origin.)
_INLINE_PREFIXES = ("image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
                    "application/pdf", "text/plain", "audio/", "video/")

_SAFE_HEADERS = {
    # Even if something slips through, a sandboxed, script-less document.
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data: blob:; media-src 'self'; "
                               "style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=604800, immutable",
}


def _svc(request: Request) -> AttachmentService:
    return request.app.state.attachment_service


@router.get("/api/attachments/limits")
async def limits() -> dict:
    return {"max_mb": settings.upload_max_mb, "max_files": settings.upload_max_files}


@router.post("/api/sessions/{sid}/attachments")
async def upload(
    sid: str,
    request: Request,
    files: list[UploadFile] = File(...),
    sessions: SessionService = Depends(session_service),
) -> list[dict]:
    try:
        sessions.get(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if len(files) > settings.upload_max_files:
        raise HTTPException(status_code=400, detail=f"at most {settings.upload_max_files} files per upload")

    broker = getattr(getattr(request.app.state,"screen_service",None),"broker",None)
    rid = request.headers.get("x-capture-request")
    proof = request.headers.get("x-capture-proof") or ""
    if rid and (not broker or not broker.register_upload(sid,rid,proof)):
        raise HTTPException(409,"Capture was cancelled or expired")
    svc = _svc(request)
    out: list[dict] = []
    for f in files:
        try:
            saved = await svc.save(sid, f)
            if rid and not broker.register_upload(sid,rid,proof,saved["id"]):
                svc.delete_pending(saved["id"])
                raise HTTPException(409,"Capture was cancelled or expired")
            out.append(saved)
        except AttachmentError as exc:
            request.app.state.logs.record(
                "warning", "upload", str(exc), code="upload.rejected",
                detail={"name": f.filename, "content_type": f.content_type},
                session_id=sid, path=request.url.path, ip=AuthManager.client_ip(request),
            )
            raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    return out


@router.get("/api/attachments/{aid}/content")
async def content(aid: str, request: Request, download: bool = False, variant: str = "original"):
    row = _svc(request).get(aid)
    if row is None:
        raise HTTPException(status_code=404, detail="attachment not found")
    path, mime = row["path"], row["mime"]
    if variant == "preview" and row["model_path"] and os.path.exists(row["model_path"]):
        path, mime = row["model_path"], row["model_mime"] or mime
    # An empty file is lost data, not a valid image: never serve it (it would be
    # cached as "immutable" and show as a broken image for a week).
    if os.path.exists(path) and os.path.getsize(path) == 0 and (row["size"] or 0) > 0:
        raise HTTPException(status_code=410, detail="attachment data is gone",
                            headers={"Cache-Control": "no-store"})
    if not os.path.exists(path):
        request.app.state.logs.record(
            "warning", "upload", f"attachment file missing on disk: {row['name']}",
            code="upload.file_missing", detail={"path": path}, session_id=row["session_id"],
            path=request.url.path,
        )
        raise HTTPException(status_code=410, detail="attachment file is gone")
    inline = not download and mime.startswith(_INLINE_PREFIXES)
    return FileResponse(
        path,
        media_type=mime,
        filename=row["name"],
        content_disposition_type="inline" if inline else "attachment",
        headers=_SAFE_HEADERS,
    )


@router.delete("/api/attachments/{aid}")
async def remove(aid: str, request: Request) -> dict:
    """Remove a not-yet-sent attachment from the composer."""
    if not _svc(request).delete_pending(aid):
        raise HTTPException(status_code=409, detail="attachment not found or already sent")
    return {"id": aid, "deleted": True}
