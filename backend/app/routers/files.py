"""Preview files the agent works with (images it made, files it edited).

Only paths inside the session's own roots are served: the workspace, its
additional folders (on whichever host each is) and its uploads dir. Local paths
are resolved (symlinks included) before the check; remote paths are read over SFTP.
A path alone may exist on several hosts: the client can say which
(``connection_id``, ``local`` = this server), otherwise the workspace's host is
tried first, then this server, then the other hosts with folders.
"""

from __future__ import annotations

import mimetypes
import os
import posixpath

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response

from app.routers._deps import session_service, workspace_service
from app.routers.attachments import _INLINE_PREFIXES, _SAFE_HEADERS
from app.services import folders as folder_model
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService

router = APIRouter()

_TEXT_LIMIT = 512 * 1024
_REMOTE_LIMIT = 25 * 1024 * 1024


def _inside(path: str, roots: list[str]) -> bool:
    return any(path == r or path.startswith(r.rstrip("/") + "/") for r in roots if r)


def _candidates(session: dict, path: str, uploads_dir: str | None,
                host: str | None = None) -> list[tuple[str, str | None]]:
    """[(absolute path, connection id or None = this server)] that ``path`` may mean, best first.
    Only paths inside a root of that host qualify; a relative path means the workspace. 403/400."""
    if not path:
        raise HTTPException(status_code=400, detail="path required")
    by_host = folder_model.roots_by_host(session)
    main = session.get("connection_id") or None
    order = list(dict.fromkeys([main, None, *by_host]))
    if host:  # the client said where
        want = None if host == "local" else host
        order = [h for h in order if h == want]
    relative = not path.startswith("/")
    out: list[tuple[str, str | None]] = []
    for h in order:
        roots = by_host.get(h, [])
        if relative and h != main:
            continue
        if h is None:
            real = os.path.realpath(path if not relative else os.path.join(session["workspace_path"], path))
            allowed = [os.path.realpath(r) for r in roots] + ([os.path.realpath(uploads_dir)] if uploads_dir else [])
            if _inside(real, allowed):
                out.append((real, None))
        else:
            p = posixpath.normpath(path if not relative else posixpath.join(session["workspace_path"], path))
            if _inside(p, [posixpath.normpath(r) for r in roots]):
                out.append((p, h))
    if not out:
        raise HTTPException(status_code=403, detail="outside this session's folders")
    return out


def _resolve(session: dict, path: str, uploads_dir: str | None) -> tuple[str, bool]:
    """(absolute path, is_remote) of the best candidate (kept for callers of the single-host API)."""
    p, h = _candidates(session, path, uploads_dir)[0]
    return p, h is not None


async def _read_remote(workspaces: WorkspaceService, cid: str, path: str, limit: int) -> bytes:
    try:
        connector = workspaces.connector_for(cid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="connection not found") from exc
    try:
        return await connector.read_file(path, limit)
    except FileNotFoundError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"could not read remote file: {exc}") from exc


@router.get("/api/sessions/{sid}/file")
async def session_file(
    sid: str,
    path: str,
    request: Request,
    text: bool = False,
    connection_id: str | None = None,
    sessions: SessionService = Depends(session_service),
    workspaces: WorkspaceService = Depends(workspace_service),
):
    try:
        session = sessions.get(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="session not found") from exc
    att = request.app.state.attachment_service
    cands = _candidates(session, path, str(att.session_dir(sid)), connection_id)

    for real, host in cands:
        mime = mimetypes.guess_type(real)[0] or "application/octet-stream"
        if host is not None:
            try:
                data = await _read_remote(workspaces, host, real, _TEXT_LIMIT if text else _REMOTE_LIMIT)
            except FileNotFoundError:
                continue
            if text:
                return {"path": real, "mime": mime, "content": data.decode(errors="replace"),
                        "truncated": len(data) >= _TEXT_LIMIT, "connection_id": host}
            inline = mime.startswith(_INLINE_PREFIXES)
            return Response(
                data, media_type=mime,
                headers={**_SAFE_HEADERS, "Content-Disposition": f'{"inline" if inline else "attachment"}; filename="{posixpath.basename(real)}"'},
            )
        if not os.path.isfile(real):
            continue
        if text:
            with open(real, "rb") as fh:
                data = fh.read(_TEXT_LIMIT + 1)
            return {"path": real, "mime": mime, "content": data[:_TEXT_LIMIT].decode(errors="replace"),
                    "truncated": len(data) > _TEXT_LIMIT, "size": os.path.getsize(real), "connection_id": None}
        inline = mime.startswith(_INLINE_PREFIXES)
        return FileResponse(
            real, media_type=mime, filename=os.path.basename(real),
            content_disposition_type="inline" if inline else "attachment",
            headers={**_SAFE_HEADERS, "Cache-Control": "private, no-cache"},
        )
    raise HTTPException(status_code=404, detail="file not found")
