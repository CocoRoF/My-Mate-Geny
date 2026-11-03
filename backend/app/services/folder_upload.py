"""Upload a COPY of a folder from the user's own computer into the session.

The server runs elsewhere than the browser / desktop app, so a folder on the
user's computer cannot be linked: its files are uploaded instead, into
``<workspace>/.geny-uploads/<name>/`` on the session's workspace host (this
server, or the SSH host of a remote workspace), and that folder is connected
to the session like any additional folder. It is a copy — edits by the agent
stay on the server.

Flow (several requests, so the client can show progress and stay under any
proxy's body limit): ``begin`` (declared size, checked against the limits)
-> ``add`` batches of files (each path checked, sizes counted as they stream)
-> ``finish`` (moved into place, connected). ``abort`` drops a partial copy.

Same-host check (``probe``): the desktop app writes a random nonce to a file
in its temp dir; if this server can read that very file, both share one
filesystem and a picked folder can be linked directly instead of copied.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import posixpath
import re
import secrets
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from fastapi import UploadFile

from app.config import settings

UPLOADS_DIR = ".geny-uploads"
INCOMING = ".incoming"

# Never copied (also skipped by the clients before upload): VCS internals,
# dependency / build caches and OS litter — big, regenerable or private.
SKIP_NAMES = frozenset({
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".tox",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", ".nuxt", ".turbo",
    ".parcel-cache", ".gradle", ".cache", ".DS_Store", "Thumbs.db", "desktop.ini",
})

_DRIVE = re.compile(r"^[A-Za-z]:")
_PROBE_NAME = re.compile(r"^geny-probe-[A-Za-z0-9_-]{8,64}$")
_UNSAFE_NAME = re.compile(r"[^\w.\- ()+@]+", re.UNICODE)
_CHUNK = 1 << 20
_TTL_S = 6 * 3600
_MAX_ACTIVE_PER_SESSION = 3


class FolderUploadError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def limits() -> dict[str, Any]:
    return {
        "max_bytes": settings.folder_upload_max_mb * 1024 * 1024,
        "max_files": settings.folder_upload_max_files,
        "max_file_bytes": settings.folder_upload_max_file_mb * 1024 * 1024,
        "skip": sorted(SKIP_NAMES),
        "dir": UPLOADS_DIR,
    }


def clean_rel(raw: str) -> str | None:
    """A client-sent relative path, normalized (``a/b/c.txt``).

    Raises on anything that could leave the upload folder (absolute paths,
    drive letters, ``..``, NUL); returns ``None`` for paths under a skipped
    name (``node_modules/...``, ``.git/...``)."""
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise FolderUploadError("invalid file path")
    p = raw.replace("\\", "/")
    if p.startswith("/") or _DRIVE.match(p):
        raise FolderUploadError(f"absolute path not allowed: {raw[:120]}")
    parts = [s for s in p.split("/") if s not in ("", ".")]
    if not parts or len(parts) > 64:
        raise FolderUploadError("invalid file path")
    if any(s == ".." for s in parts):
        raise FolderUploadError(f"path leaves the folder: {raw[:120]}")
    if any(len(s.encode()) > 255 for s in parts):
        raise FolderUploadError("file name too long")
    if any(s in SKIP_NAMES for s in parts):
        return None
    return "/".join(parts)


def safe_name(name: str) -> str:
    """The copy's folder name, from the picked folder's name."""
    base = (name or "").replace("\\", "/").rstrip("/").split("/")[-1]
    base = _UNSAFE_NAME.sub("-", base).strip(" .-")[:80]
    return base or "folder"


def _unique(parent: Path, name: str) -> Path:
    cand = parent / name
    n = 2
    while cand.exists():
        cand = parent / f"{name}-{n}"
        n += 1
    return cand


def _ensure_uploads_dir(root: Path) -> Path:
    """``<workspace>/.geny-uploads`` with a ``.gitignore`` of ``*``: the copies
    never show up as untracked files in the workspace's own repo."""
    d = root / UPLOADS_DIR
    d.mkdir(parents=True, exist_ok=True)
    gi = d / ".gitignore"
    if not gi.exists():
        gi.write_text("# uploaded copies of folders from your computer (My Mate Geny)\n*\n")
    return d


@dataclass
class _Upload:
    id: str
    sid: str
    name: str
    staging: Path
    remote: bool
    workspace: str
    declared_files: int
    declared_bytes: int
    files: int = 0
    bytes: int = 0
    skipped: int = 0
    created: float = field(default_factory=time.time)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class FolderUploadService:
    def __init__(self, sessions: Any, workspaces: Any, staging_root: Path | None = None) -> None:
        self._sessions = sessions
        self._workspaces = workspaces
        self._staging_root = staging_root or (settings.uploads_root_path / "folders")
        self._uploads: dict[str, _Upload] = {}

    # ---- lifecycle ----

    def _gc(self) -> None:
        now = time.time()
        for uid, up in list(self._uploads.items()):
            if now - up.created > _TTL_S:
                self._drop(uid)

    def _drop(self, uid: str) -> None:
        up = self._uploads.pop(uid, None)
        if up is not None:
            shutil.rmtree(up.staging, ignore_errors=True)

    def _get(self, sid: str, uid: str) -> _Upload:
        up = self._uploads.get(uid)
        if up is None or up.sid != sid:
            raise FolderUploadError("upload not found (expired or finished)", 404)
        return up

    def begin(self, sid: str, name: str, files: int, total_bytes: int) -> dict[str, Any]:
        session = self._sessions.get(sid)  # KeyError -> 404
        self._gc()
        lim = limits()
        if files <= 0:
            raise FolderUploadError("the folder has no files to upload")
        if files > lim["max_files"]:
            raise FolderUploadError(f"too many files: {files} (at most {lim['max_files']})", 413)
        if total_bytes > lim["max_bytes"]:
            raise FolderUploadError(
                f"folder too large: {total_bytes / 1048576:.0f} MB (at most {settings.folder_upload_max_mb} MB)", 413)
        if len(session.get("folders") or session.get("extra_dirs") or []) >= 20:
            raise FolderUploadError("at most 20 additional folders — disconnect one first")
        if sum(1 for u in self._uploads.values() if u.sid == sid) >= _MAX_ACTIVE_PER_SESSION:
            raise FolderUploadError("another upload for this chat is still running", 409)
        uid = "fup_" + secrets.token_hex(8)
        remote = bool(session["connection_id"])
        workspace = session["workspace_path"]
        if remote:
            staging = self._staging_root / uid
        else:
            ws = Path(os.path.abspath(os.path.expanduser(workspace)))
            if not ws.is_dir():
                raise FolderUploadError(f"workspace not found: {ws}")
            staging = _ensure_uploads_dir(ws) / INCOMING / uid
        staging.mkdir(parents=True, exist_ok=False)
        up = _Upload(uid, sid, safe_name(name), staging, remote, workspace, files, total_bytes)
        self._uploads[uid] = up
        return {"id": uid, "name": up.name, "remote": remote, "limits": lim}

    async def add(self, sid: str, uid: str, items: Iterable[tuple[str, UploadFile]]) -> dict[str, Any]:
        up = self._get(sid, uid)
        lim = limits()
        async with up.lock:
            try:
                for raw, f in items:
                    rel = clean_rel(raw)
                    if rel is None:
                        up.skipped += 1
                        continue
                    if up.files + 1 > lim["max_files"] or up.files + 1 > up.declared_files + 16:
                        raise FolderUploadError("more files than declared / allowed", 413)
                    await self._write(up, rel, f, lim)
                    up.files += 1
            except FolderUploadError:
                self._drop(uid)  # a broken copy is worse than none
                raise
            except OSError as exc:
                self._drop(uid)
                raise FolderUploadError(f"could not write the copy: {exc.strerror or exc}") from exc
        return {"files": up.files, "bytes": up.bytes, "skipped": up.skipped}

    async def _write(self, up: _Upload, rel: str, f: UploadFile, lim: dict[str, Any]) -> None:
        root = up.staging.resolve()
        target = (root / rel).resolve()
        if root not in target.parents:
            raise FolderUploadError(f"path leaves the folder: {rel[:120]}")
        target.parent.mkdir(parents=True, exist_ok=True)
        # (every directory on the way was made here; no symlink can be in it,
        # but never follow one at the leaf either)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o644)
        size = 0
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = await f.read(_CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > lim["max_file_bytes"]:
                    raise FolderUploadError(
                        f"{rel[:120]} is larger than {settings.folder_upload_max_file_mb} MB", 413)
                if up.bytes + size > lim["max_bytes"]:
                    raise FolderUploadError(f"folder larger than {settings.folder_upload_max_mb} MB", 413)
                out.write(chunk)
        up.bytes += size

    async def finish(self, sid: str, uid: str) -> dict[str, Any]:
        up = self._get(sid, uid)
        async with up.lock:
            if up.files == 0:
                self._drop(uid)
                raise FolderUploadError("no files were uploaded (everything was skipped?)")
            try:
                if up.remote:
                    session = self._sessions.get(sid)
                    connector = self._workspaces.connector_for(session["connection_id"])
                    push = getattr(connector, "upload_tree", None)
                    if push is None:
                        raise FolderUploadError("this workspace cannot receive folder copies")
                    path = await push(str(up.staging), up.workspace, posixpath.join(UPLOADS_DIR, up.name))
                else:
                    parent = up.staging.parent.parent  # <workspace>/.geny-uploads
                    dest = _unique(parent, up.name)
                    os.rename(up.staging, dest)
                    path = str(dest)
            except FolderUploadError:
                self._drop(uid)
                raise
            except Exception as exc:  # noqa: BLE001 - ssh / filesystem errors to the UI
                self._drop(uid)
                raise FolderUploadError(f"could not place the copy: {str(exc)[:200]}", 502) from exc
            self._uploads.pop(uid, None)
            if up.remote:
                shutil.rmtree(up.staging, ignore_errors=True)
        session = self._sessions.get(sid)
        # the copy is a folder on the workspace's host
        here = {"path": path, "connection_id": session.get("connection_id") or None}
        folders = [dict(f) for f in session.get("folders") or []]
        if here not in folders:
            folders.append(here)
        session = self._sessions.update(sid, folders=folders)
        return {"path": path, "files": up.files, "bytes": up.bytes, "skipped": up.skipped, "session": session}

    def abort(self, sid: str, uid: str) -> None:
        self._get(sid, uid)
        self._drop(uid)

    # ---- same machine? ----

    @staticmethod
    def probe(probe_path: str, nonce: str, path: str) -> dict[str, Any]:
        """Does this server see the desktop app's filesystem? (see module doc)"""
        out = {"same_host": False, "is_dir": False, "path": path}
        if not probe_path or not nonce or not _PROBE_NAME.match(os.path.basename(probe_path)):
            return out
        try:
            with open(probe_path, "rb") as fh:
                got = fh.read(256).decode("utf-8", "replace").strip()
        except OSError:
            return out
        if not hmac.compare_digest(got, nonce.strip()):
            return out
        out["same_host"] = True
        p = os.path.abspath(os.path.expanduser(path or ""))
        out["path"] = p
        out["is_dir"] = bool(path) and os.path.isdir(p)
        return out
