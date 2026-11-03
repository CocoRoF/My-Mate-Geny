"""A chat's additional folders — each one is a *(host, path)* pair.

``sessions.extra_dirs`` holds a JSON list of ``{"path": str, "connection_id": str | None}``:
``connection_id`` NULL = a folder on this server (the agent CLI's own filesystem), otherwise
the SSH connection whose host has it. Before multi-host folders the column was a list of plain
paths that lived on the *workspace's* host; :func:`normalize` reads both shapes (a plain string
becomes ``{"path": s, "connection_id": <the session's connection>}``), so old rows keep working
and :func:`app.db.Database._migrate` rewrites them once.

The API shows both ``folders`` (everything, with hosts) and ``extra_dirs`` — the legacy view:
just the paths on the workspace's own host, for clients that predate hosts.
"""

from __future__ import annotations

import json
import posixpath
from typing import Any, Iterable

MAX_FOLDERS = 20


def _clean_path(p: str) -> str:
    p = (p or "").strip()
    if len(p) > 1:
        p = p.rstrip("/") or "/"
    return p


def folder(path: str, connection_id: str | None) -> dict[str, Any]:
    return {"path": _clean_path(path), "connection_id": connection_id or None}


def normalize(raw: Any, session_connection: str | None) -> list[dict[str, Any]]:
    """Any stored shape -> a de-duplicated list of folder dicts (old plain paths = the workspace's host)."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except ValueError:
            raw = []
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, str):
            f = folder(item, session_connection)
        elif isinstance(item, dict) and isinstance(item.get("path"), str):
            f = folder(item["path"], item.get("connection_id") or None)
        else:
            continue
        if not f["path"]:
            continue
        k = key(f)
        if k not in seen:
            seen.add(k)
            out.append(f)
    return out


def key(f: dict[str, Any]) -> tuple[str, str]:
    return (f.get("connection_id") or "", _clean_path(f["path"]))


def legacy_paths(folders: Iterable[dict[str, Any]], session_connection: str | None) -> list[str]:
    """The old ``extra_dirs`` view: paths of the folders on the workspace's own host."""
    return [f["path"] for f in folders if (f.get("connection_id") or None) == (session_connection or None)]


def merge_legacy(current: list[dict[str, Any]], paths: list[str], session_connection: str | None) -> list[dict[str, Any]]:
    """An old client sent ``extra_dirs`` (paths on the workspace's host): replace those, keep the other hosts'."""
    others = [f for f in current if (f.get("connection_id") or None) != (session_connection or None)]
    return [*[folder(p, session_connection) for p in paths], *others]


def is_abs(path: str) -> bool:
    return path.startswith("/") or path == "~" or path.startswith("~/")


def inside(p: str, root: str) -> bool:
    p, root = p.rstrip("/") or "/", root.rstrip("/") or "/"
    return p == root or root == "/" or p.startswith(root + "/")


def roots_by_host(session: dict[str, Any]) -> dict[str | None, list[str]]:
    """{connection_id or None: [paths]} — the workspace first on its host, then the folders."""
    out: dict[str | None, list[str]] = {session.get("connection_id") or None: [session["workspace_path"]]}
    for f in session.get("folders") or []:
        out.setdefault(f.get("connection_id") or None, [])
        if f["path"] not in out[f.get("connection_id") or None]:
            out[f.get("connection_id") or None].append(f["path"])
    return out


def norm_remote(path: str) -> str:
    return posixpath.normpath(path) if path.startswith("/") else path
