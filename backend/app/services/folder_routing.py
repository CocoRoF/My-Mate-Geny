"""Where a chat's folders are and which tools reach them — computed for every turn's launch.

* **This server** (``connection_id`` NULL, or an SSH connection that turns out to be this very
  machine with the folder visible here — :mod:`app.workspaces.this_host`): real paths for the
  CLI (``--add-dir`` for Claude; listed for Codex), its own tools work on them.
* **SSH hosts** (the workspace's and any other): one ``remote`` MCP server whose tools take a
  ``host`` argument; each host is allow-listed with only its folders (+ the workspace and the
  chat's uploads dir there) — see :mod:`app.workspaces.mcp_remote_bridge`.
* A short **note** for the agent: what is attached where and which tools reach it.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

from app.workspaces import this_host
from app.workspaces.remote_ssh import RemoteSshConnector

_EQ_TTL = 600.0
_eq_cache: dict[tuple[str, str], tuple[str | None, float]] = {}


@dataclass
class Routing:
    local_dirs: list[str] = field(default_factory=list)       # real paths on this server for the CLI
    hosts: list[dict[str, Any]] = field(default_factory=list)  # remote bridge hosts
    mcp_config: dict[str, Any] | None = None
    note: str = ""
    missing: list[str] = field(default_factory=list)          # skipped: gone / host removed
    host_names: dict[str, str] = field(default_factory=dict)  # connection id -> tool host name


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9._-]+", "-", (name or "").lower()).strip("-.")
    return s[:40]


def host_names(connections: list[dict[str, Any]], needed: list[str]) -> dict[str, str]:
    """connection id -> a short, unique name for the ``host`` argument (from the connection's name)."""
    by_id = {c["id"]: c for c in connections}
    out: dict[str, str] = {}
    used: set[str] = set()
    for cid in needed:
        c = by_id.get(cid)
        n = slug(c["name"]) if c else ""
        if not n or n in ("local", "this-server"):
            n = cid
        base, i = n, 2
        while n in used:
            n = f"{base}-{i}"
            i += 1
        used.add(n)
        out[cid] = n
    return out


async def _equivalents(connector: RemoteSshConnector, cid: str, paths: list[str]) -> dict[str, str]:
    now = time.monotonic()
    todo = [p for p in paths if not ((hit := _eq_cache.get((cid, p))) and now < hit[1])]
    if todo:
        try:
            found = await this_host.local_equivalents(connector, todo)
        except Exception:  # noqa: BLE001 - probe failed: use them over SSH
            found = {}
        for p in todo:
            _eq_cache[(cid, p)] = (found.get(p), now + _EQ_TTL)
    return {p: v for p in paths if (v := (_eq_cache.get((cid, p)) or (None, 0))[0])}


class FolderError(ValueError):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _remote_error(exc: Exception, where: str, path: str) -> FolderError:
    msg = str(exc)
    login = type(exc).__name__ in ("PermissionDenied", "DisconnectError", "ConnectionLost") or "publickey" in msg
    if isinstance(exc, FileNotFoundError) or "No such file" in msg:
        return FolderError(f"folder not found on {where}: {path}", 404)
    if not login and (isinstance(exc, PermissionError) or "ermission denied" in msg):
        return FolderError(f"permission denied on {where}: {path}", 403)
    if login:
        return FolderError(f"can't log in to {where} (SSH key refused): {msg[:160]}", 502)
    return FolderError(f"can't reach {where}: {msg[:200] or type(exc).__name__}", 502)


async def prepare(session: dict[str, Any], wanted: list[dict[str, Any]], workspaces: Any) -> list[dict[str, Any]]:
    """Check folders being attached (the ones not attached yet) on their hosts before saving:
    a remote one must exist and be a folder (``~`` resolved to the real path); one on an SSH
    connection that is this very machine, visible here as the same folder, becomes a folder of
    this server (no duplicate, the CLI's own tools work on it). Raises :class:`FolderError`."""
    from app.services import folders as folder_model

    have = {folder_model.key(f) for f in session.get("folders") or []}
    labels = {c["id"]: c["name"] for c in workspaces.connections()}
    out: list[dict[str, Any]] = []
    for f in wanted:
        f = folder_model.folder(f.get("path") or "", f.get("connection_id"))
        cid = f["connection_id"]
        if not f["path"] or not cid or folder_model.key(f) in have:
            out.append(f)
            continue
        where = labels.get(cid)
        if where is None:
            raise FolderError(f"unknown connection: {cid}")
        if not folder_model.is_abs(f["path"]):
            raise FolderError(f"use an absolute path on {where}: {f['path']}")
        try:
            connector = workspaces.connector_for(cid)
            info = await connector.explore(f["path"], "stat")
        except FolderError:
            raise
        except Exception as exc:  # noqa: BLE001 - unreachable / missing / no permission
            raise _remote_error(exc, where, f["path"]) from exc
        if not info.get("is_dir"):
            raise FolderError(f"not a folder on {where}: {f['path']}")
        path = info.get("path") or f["path"]
        eq = await _equivalents(connector, cid, [path])
        out.append(folder_model.folder(eq[path], None) if path in eq else folder_model.folder(path, cid))
    return out


async def plan(session: dict[str, Any], workspaces: Any, *, uploads_remote: str | None = None) -> Routing:
    """The launch routing for ``session`` (needs ``folders``)."""
    r = Routing()
    main = session.get("connection_id") or None
    folders = list(session.get("folders") or [])
    by_host: dict[str | None, list[str]] = {}
    for f in folders:
        by_host.setdefault(f.get("connection_id") or None, []).append(f["path"])

    connections = workspaces.connections()
    remote_ids = [c for c in dict.fromkeys([main, *by_host]) if c]
    names = host_names(connections, remote_ids)
    r.host_names = names
    known = {c["id"] for c in connections}
    labels = {c["id"]: c["name"] for c in connections}

    # folders on an SSH connection that is this machine: the same folder here → use it locally
    local_paths = list(by_host.get(None, []))
    connectors: dict[str, RemoteSshConnector] = {}
    for cid in remote_ids:
        if cid not in known:
            continue
        try:
            connectors[cid] = workspaces.connector_for(cid)
        except KeyError:
            continue
    for cid, paths in list(by_host.items()):
        if not cid or cid not in connectors:
            continue
        eq = await _equivalents(connectors[cid], cid, paths)
        if eq:
            local_paths += [eq[p] for p in paths if p in eq]
            by_host[cid] = [p for p in paths if p not in eq]

    for p in dict.fromkeys(local_paths):
        if os.path.isdir(p):
            r.local_dirs.append(p)
        else:
            r.missing.append(p)

    lines: list[str] = []
    ws = session["workspace_path"]
    if main and main in connectors:
        roots = [ws, *[p for p in by_host.get(main, []) if p != ws]]
        if uploads_remote:
            roots.append(uploads_remote)
        r.hosts.append(connectors[main].bridge_host(
            name=names[main], aliases=[main, labels.get(main, "")], cwd=ws, roots=roots, default=True))
        lines.append(f'- Workspace: `{ws}` on server "{names[main]}" — the remote_* tools (default host)')
    elif main:
        r.missing.append(f"{ws} (connection removed)")
    else:
        lines.append(f"- Workspace: `{ws}` on this server — your working directory, your own tools")
    for p in r.local_dirs:
        lines.append(f"- `{p}` on this server — your own tools (Read, Edit, Bash…)")
    for cid, paths in by_host.items():
        if not cid or not paths:
            continue
        if cid == main:
            if main in connectors:
                lines += [f'- `{p}` on server "{names[main]}" — the remote_* tools' for p in paths if p != ws]
            else:
                r.missing += [f"{p} (connection removed)" for p in paths]
            continue
        if cid not in connectors:
            r.missing += [f"{p} (connection removed)" for p in paths]
            continue
        r.hosts.append(connectors[cid].bridge_host(
            name=names[cid], aliases=[cid, labels.get(cid, "")], cwd=paths[0], roots=paths, default=False))
        for p in paths:
            lines.append(f'- `{p}` on server "{names[cid]}" — the remote_* tools with host="{names[cid]}"')

    if r.hosts:
        r.mcp_config = RemoteSshConnector.bridge_config(r.hosts)
    if folders:
        tail = []
        if r.hosts:
            tail.append("The remote_* tools reach only the folders listed for their server. Long remote_bash calls return a job_id: await that same job using remote_poll (wait_ms=30000), continuing output at next_offset. Do not repeat or abandon unfinished commands; remote_stop cancels them. Use run_in_background only for explicitly requested background work.")
        if main:
            tail.append("Your own file tools act on this server only, never on a remote one.")
        r.note = "# Folders in this chat\n" + "\n".join(lines) + ("\n" + " ".join(tail) if tail else "")
    return r
