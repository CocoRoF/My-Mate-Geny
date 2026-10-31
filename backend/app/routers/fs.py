"""File explorer — browse and open files on a session's host (VS Code style).

Unlike ``/api/sessions/{sid}/file`` (media the chat renders on its own, so it
stays confined to the session's folders), these endpoints back an explicit
user action — expanding a folder, opening a file, clicking a path the agent
printed — so any path on the host can be browsed, the same reach the folder
picker already has. The harness's own secrets (vault/session keys, SSH and
CLI credentials, tunnel creds, its env file and DB) are never served.

Local paths are read on this server (symlinks resolved before the secret check);
remote paths go over SFTP through the connection's connector.
"""

from __future__ import annotations

import asyncio
import codecs
import mimetypes
import os
import posixpath
import stat as stat_mod

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response

from app.config import settings
from app.routers._deps import workspace_service
from app.routers.attachments import _INLINE_PREFIXES, _SAFE_HEADERS
from app.services import path_resolver
from app.services.workspace_service import WorkspaceService
from app.workspaces.remote_ssh import RemoteSshConnector

router = APIRouter(prefix="/api/fs")

_TEXT_LIMIT = 2 * 1024 * 1024    # text viewer: first 2 MB
_TEXT_MAX = 16 * 1024 * 1024     # explicit "load more" ceiling
_RAW_LIMIT = 100 * 1024 * 1024   # documents/media over SFTP
_LIST_LIMIT = 5000

mimetypes.add_type("text/markdown", ".md")
mimetypes.add_type("text/csv", ".csv")
mimetypes.add_type("text/tab-separated-values", ".tsv")


# This checkout's own env files (backend/.env, ./.env), wherever it is cloned —
# the cwd-relative ones below only cover the usual `cd backend` launch.
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_OWN_ENV_FILES = (os.path.join(_BACKEND_DIR, ".env"), os.path.join(os.path.dirname(_BACKEND_DIR), ".env"))


def is_secret(path: str) -> bool:
    """Credentials the harness itself relies on — never shown in the UI."""
    parts = path.split("/")
    name, dirs = parts[-1], parts[:-1]
    if ".ssh" in dirs:
        return not (name.endswith(".pub") or name in ("known_hosts", "known_hosts.old", "config", "authorized_keys"))
    if ".hr-harnessor" in dirs and (name in ("vault.key", "session.key", "id_key") or "android-signing" in dirs):
        return True
    if name == ".git-credentials" or (name == ".credentials.json" and ".claude" in dirs):
        return True
    if name == "auth.json" and ".codex" in dirs:
        return True
    if (".cloudflared" in dirs or "cloudflared" in dirs) and name.endswith(".json"):
        return True
    if name in (".env", ".env.local") and "hr-harnessor" in dirs:  # this app's own login password
        return True
    own = {os.path.realpath(p) for p in (".env", "../.env", *_OWN_ENV_FILES)} | {
        str(settings.db_file), str(settings.vault_key_file), str(settings.session_key_file)}
    return path in own or path.split(".db-")[0] in own  # SQLite -wal/-shm too


def _guard(path: str) -> None:
    if is_secret(path):
        raise HTTPException(status_code=403, detail="this file holds credentials and is not shown")


def _mime(path: str) -> str:
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def decode_text(data: bytes, truncated: bool) -> tuple[str, str, bool]:
    """(text, encoding, binary). UTF-8 first, then CP949 (Korean Excel CSVs),
    UTF-16 by BOM; NUL bytes without a BOM mean binary."""
    if data.startswith(codecs.BOM_UTF8):
        return data[3:].decode("utf-8", errors="replace"), "utf-8-sig", False
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        if truncated and len(data) % 2:
            data = data[:-1]
        return data.decode("utf-16", errors="replace"), "utf-16", False
    if b"\x00" in data[:8192]:
        return "", "binary", True
    try:  # incremental: a multi-byte char cut by the size limit is not an error
        return codecs.getincrementaldecoder("utf-8")().decode(data, final=not truncated), "utf-8", False
    except UnicodeDecodeError:
        pass
    try:
        return data.decode("cp949", errors="strict" if not truncated else "replace"), "cp949", False
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace"), "utf-8", False


# ---- local ---------------------------------------------------------------


def _local_path(path: str) -> str:
    if not path:
        raise HTTPException(status_code=400, detail="path required")
    p = os.path.abspath(os.path.expanduser(path))
    return p


def _local_stat(p: str) -> dict:
    try:
        st = os.stat(p)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="not found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="permission denied") from exc
    return {"path": p, "is_dir": stat_mod.S_ISDIR(st.st_mode), "size": st.st_size, "mtime": int(st.st_mtime)}


def _local_list(p: str) -> list[dict]:
    out = []
    try:
        with os.scandir(p) as it:
            for e in it:
                try:
                    link = e.is_symlink()
                    is_dir = e.is_dir()  # follows links
                    st = e.stat() if not link or os.path.exists(e.path) else e.stat(follow_symlinks=False)
                    out.append({"name": e.name, "path": e.path, "is_dir": is_dir, "is_link": link,
                                "size": st.st_size, "mtime": int(st.st_mtime)})
                except OSError:
                    out.append({"name": e.name, "path": e.path, "is_dir": False, "is_link": True, "size": 0, "mtime": None})
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="permission denied") from exc
    return out


# ---- remote --------------------------------------------------------------


def _remote(svc: WorkspaceService, connection_id: str) -> RemoteSshConnector:
    try:
        c = svc.connector_for(connection_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="connection not found") from exc
    if not isinstance(c, RemoteSshConnector):
        raise HTTPException(status_code=400, detail="not a remote connection")
    return c


async def _remote_op(c: RemoteSshConnector, path: str, op: str) -> dict:
    try:
        return await c.explore(path, op)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="not found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="permission denied") from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "ermission denied" in msg:
            raise HTTPException(status_code=403, detail="permission denied") from exc
        raise HTTPException(status_code=502, detail=f"remote: {msg[:200]}") from exc


def _sort(entries: list[dict]) -> tuple[list[dict], bool]:
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return entries[:_LIST_LIMIT], len(entries) > _LIST_LIMIT


# ---- endpoints -----------------------------------------------------------


@router.get("/list")
async def list_dir(
    path: str = Query(...),
    connection_id: str | None = Query(default=None),
    svc: WorkspaceService = Depends(workspace_service),
) -> dict:
    """Folder contents (dotfiles included; folders first)."""
    if connection_id:
        info = await _remote_op(_remote(svc, connection_id), path, "list")
        if not info["is_dir"]:
            raise HTTPException(status_code=400, detail="not a folder")
        entries, truncated = _sort(info["entries"])
        return {"path": info["path"], "entries": entries, "truncated": truncated}
    p = _local_path(path)
    info = _local_stat(p)
    if not info["is_dir"]:
        raise HTTPException(status_code=400, detail="not a folder")
    entries, truncated = _sort(await asyncio.to_thread(_local_list, p))
    return {"path": p, "entries": entries, "truncated": truncated}


@router.get("/stat")
async def stat_path(
    path: str = Query(...),
    connection_id: str | None = Query(default=None),
    svc: WorkspaceService = Depends(workspace_service),
) -> dict:
    """What a path is (file / folder) — used when the agent's text links to it."""
    if connection_id:
        info = await _remote_op(_remote(svc, connection_id), path, "stat")
    else:
        info = _local_stat(_local_path(path))
    info["mime"] = None if info["is_dir"] else _mime(info["path"])
    info["secret"] = is_secret(info["path"])
    return info


@router.get("/resolve")
async def resolve_path(
    request: Request,
    path: str = Query(...),
    session_id: str | None = Query(default=None),
    connection_id: str | None = Query(default=None),
    roots: list[str] = Query(default=[]),
    svc: WorkspaceService = Depends(workspace_service),
) -> dict:
    """Where a relative path the agent printed really is: the roots the client
    tried, then the folders this chat has been working in (its recent tool
    calls and answers), then a bounded search (see ``path_resolver``)."""
    mentioned: list[str] = []
    if session_id:
        rows = request.app.state.db.query(
            "SELECT type, data FROM events WHERE session_id = ? AND type IN ('tool.use', 'tool.result', 'turn.complete')"
            " ORDER BY id DESC LIMIT 600",
            (session_id,),
        )
        mentioned = path_resolver.paths_in_events((r["type"], r["data"]) for r in rows)
    if connection_id:
        c = _remote(svc, connection_id)
        ref = path_resolver.clean_ref(path)
        cands = [posixpath.join(b, ref) for b in roots]
        cands += path_resolver.direct_hits(ref, mentioned)
        cands += [posixpath.join(b, ref) for b in path_resolver.candidate_bases(mentioned)[:24]]
        found: list[dict] = []
        for cand in dict.fromkeys(posixpath.normpath(x) for x in cands):
            try:
                info = await c.explore(cand, "stat")
            except Exception:  # noqa: BLE001 - not there (or unreadable): next candidate
                continue
            found.append({"path": info["path"], "is_dir": info["is_dir"]})
            if len(found) >= 5:
                break
        return {"matches": found}
    hits = await asyncio.to_thread(path_resolver.resolve, path, [os.path.expanduser(r) for r in roots], mentioned)
    return {"matches": [{"path": h, "is_dir": os.path.isdir(h)} for h in hits if not is_secret(h)]}


@router.get("/text")
async def read_text(
    path: str = Query(...),
    connection_id: str | None = Query(default=None),
    limit: int = Query(default=_TEXT_LIMIT, ge=1, le=_TEXT_MAX),
    svc: WorkspaceService = Depends(workspace_service),
) -> dict:
    """The head of a file as text, with encoding detection (UTF-8 / CP949 / UTF-16)."""
    if connection_id:
        c = _remote(svc, connection_id)
        info = await _remote_op(c, path, "stat")
        if info["is_dir"]:
            raise HTTPException(status_code=400, detail="is a folder")
        _guard(info["path"])
        try:
            data = await c.read_file(info["path"], limit)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"remote: {str(exc)[:200]}") from exc
    else:
        p = os.path.realpath(_local_path(path))
        info = _local_stat(p)
        if info["is_dir"]:
            raise HTTPException(status_code=400, detail="is a folder")
        _guard(p)
        try:
            with open(p, "rb") as fh:
                data = fh.read(limit)
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail="permission denied") from exc
    truncated = info["size"] > len(data)
    text, encoding, binary = decode_text(data, truncated)
    return {"path": info["path"], "size": info["size"], "mtime": info["mtime"], "mime": _mime(info["path"]),
            "content": text, "encoding": encoding, "binary": binary, "truncated": truncated}


@router.get("/raw")
async def read_raw(
    path: str = Query(...),
    connection_id: str | None = Query(default=None),
    download: bool = False,
    svc: WorkspaceService = Depends(workspace_service),
):
    """File bytes for the document/media viewers (and downloads).

    Same safety headers as attachments: only plain media/PDF/text render
    inline, everything else (HTML, SVG, ...) is an attachment in a sandbox."""
    if connection_id:
        c = _remote(svc, connection_id)
        info = await _remote_op(c, path, "stat")
        if info["is_dir"]:
            raise HTTPException(status_code=400, detail="is a folder")
        _guard(info["path"])
        if info["size"] > _RAW_LIMIT:
            raise HTTPException(status_code=413, detail=f"over {_RAW_LIMIT // (1024 * 1024)} MB — too large to open remotely")
        real = info["path"]
        try:
            data = await c.read_file(real, _RAW_LIMIT)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"remote: {str(exc)[:200]}") from exc
    else:
        real = os.path.realpath(_local_path(path))
        if _local_stat(real)["is_dir"]:
            raise HTTPException(status_code=400, detail="is a folder")
        _guard(real)
        if not os.access(real, os.R_OK):
            raise HTTPException(status_code=403, detail="permission denied")
        data = None
    mime = _mime(real)
    inline = not download and mime.startswith(_INLINE_PREFIXES)
    name = posixpath.basename(real)
    headers = {**_SAFE_HEADERS, "Cache-Control": "private, no-cache"}
    if data is None:
        return FileResponse(real, media_type=mime, filename=name,
                            content_disposition_type="inline" if inline else "attachment", headers=headers)
    from urllib.parse import quote

    headers["Content-Disposition"] = f"{'inline' if inline else 'attachment'}; filename*=utf-8''{quote(name)}"
    return Response(data, media_type=mime, headers=headers)
