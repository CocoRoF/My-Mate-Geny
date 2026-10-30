"""Preview files the agent works with (images it made, files it edited).

Only paths inside the session's own roots are served: the workspace, its
additional folders and its uploads dir. Local paths are resolved (symlinks
included) before the check; remote paths are read over SFTP.
"""

from __future__ import annotations

import mimetypes
import os
import posixpath

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response

from app.routers._deps import session_service, workspace_service
from app.routers.attachments import _INLINE_PREFIXES, _SAFE_HEADERS
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService

router = APIRouter()

_TEXT_LIMIT = 512 * 1024
_REMOTE_LIMIT = 25 * 1024 * 1024


def _inside(path: str, roots: list[str]) -> bool:
    return any(path == r or path.startswith(r.rstrip("/") + "/") for r in roots if r)


def _resolve(session: dict, path: str, uploads_dir: str | None) -> tuple[str, bool]:
    """(absolute path, is_remote). Raises 403/400 for anything outside the roots."""
    remote = bool(session["connection_id"])
    roots = [session["workspace_path"], *(session.get("extra_dirs") or [])]
    if not path:
        raise HTTPException(status_code=400, detail="path required")
    if remote:
        p = path if path.startswith("/") else posixpath.join(session["workspace_path"], path)
        p = posixpath.normpath(p)
        if not _inside(p, [posixpath.normpath(r) for r in roots]):
            raise HTTPException(status_code=403, detail="outside this session's folders")
        return p, True
    p = path if os.path.isabs(path) else os.path.join(session["workspace_path"], path)
    real = os.path.realpath(p)
    allowed = [os.path.realpath(r) for r in roots] + ([os.path.realpath(uploads_dir)] if uploads_dir else [])
    if not _inside(real, allowed):
        raise HTTPException(status_code=403, detail="outside this session's folders")
    return real, False


@router.get("/api/sessions/{sid}/file")
async def session_file(
    sid: str,
    path: str,
    request: Request,
    text: bool = False,
    sessions: SessionService = Depends(session_service),
    workspaces: WorkspaceService = Depends(workspace_service),
):
    try:
        session = sessions.get(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="session not found") from exc
    att = request.app.state.attachment_service
    real, remote = _resolve(session, path, str(att.session_dir(sid)))
    mime = mimetypes.guess_type(real)[0] or "application/octet-stream"

    if remote:
        connector = workspaces.connector_for(session["connection_id"])
        try:
            data = await connector.read_file(real, _TEXT_LIMIT if text else _REMOTE_LIMIT)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="file not found") from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"could not read remote file: {exc}") from exc
        if text:
            return {"path": real, "mime": mime, "content": data.decode(errors="replace"),
                    "truncated": len(data) >= _TEXT_LIMIT}
        inline = mime.startswith(_INLINE_PREFIXES)
        return Response(
            data, media_type=mime,
            headers={**_SAFE_HEADERS, "Content-Disposition": f'{"inline" if inline else "attachment"}; filename="{posixpath.basename(real)}"'},
        )

    if not os.path.isfile(real):
        raise HTTPException(status_code=404, detail="file not found")
    if text:
        with open(real, "rb") as fh:
            data = fh.read(_TEXT_LIMIT + 1)
        return {"path": real, "mime": mime, "content": data[:_TEXT_LIMIT].decode(errors="replace"),
                "truncated": len(data) > _TEXT_LIMIT, "size": os.path.getsize(real)}
    inline = mime.startswith(_INLINE_PREFIXES)
    return FileResponse(
        real, media_type=mime, filename=os.path.basename(real),
        content_disposition_type="inline" if inline else "attachment",
        headers={**_SAFE_HEADERS, "Cache-Control": "private, no-cache"},
    )
