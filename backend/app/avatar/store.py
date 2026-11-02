"""Avatar Create projects: one row per project (``avatar_projects``), the whole state as one JSON document, and the
project's folder ``<AVATAR_ROOT>/<id>/`` with every picture, clip and the export (docs/avatar-create.md §6).

The document is written after every change (status, plan, confirmation, each job's id and result), so a restart
picks a project up where it was — a job already submitted is waited for, never submitted again.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from app.config import settings
from app.db import Database
from app.services._ids import new_id, now_iso

_TABLE = """
CREATE TABLE IF NOT EXISTS avatar_projects (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'interview',
    mate_id     TEXT,
    session_id  TEXT,
    doc         TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
)
"""
_ID_RE = re.compile(r"^av_[0-9a-f]{12}$")


class AvatarError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "invalid") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def project_dir(pid: str) -> Path:
    if not _ID_RE.match(pid or ""):
        raise AvatarError("not an avatar project id", 404, "not_found")
    return settings.avatar_root_path / pid


def safe_rel(path: str) -> str:
    parts = [p for p in (path or "").replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or any(p == ".." or p.startswith(".") for p in parts):
        raise AvatarError("bad file path", 400)
    return "/".join(parts)


class AvatarStore:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._db.execute(_TABLE)
        self._cache: dict[str, dict[str, Any]] = {}

    def create(self, doc: dict[str, Any]) -> dict[str, Any]:
        pid = new_id("av_")[:15]
        now = now_iso()
        doc = {**doc, "id": pid, "created_at": now, "updated_at": now, "version": 1}
        project_dir(pid).mkdir(parents=True, exist_ok=True)
        self._db.execute(
            "INSERT INTO avatar_projects (id, title, status, mate_id, session_id, doc, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (pid, doc.get("title") or "", doc.get("status") or "interview", doc.get("mate_id"),
             doc.get("session_id"), json.dumps(doc, ensure_ascii=False), now, now))
        self._cache[pid] = doc
        return doc

    def get(self, pid: str) -> dict[str, Any]:
        hit = self._cache.get(pid)
        if hit is not None:
            return hit
        row = self._db.query_one("SELECT doc FROM avatar_projects WHERE id = ?", (pid,))
        if row is None:
            raise AvatarError("no such avatar project", 404, "not_found")
        doc = json.loads(row["doc"] or "{}")
        self._cache[pid] = doc
        return doc

    def save(self, doc: dict[str, Any]) -> dict[str, Any]:
        doc["updated_at"] = now_iso()
        doc["version"] = int(doc.get("version") or 0) + 1
        self._db.execute(
            "UPDATE avatar_projects SET title = ?, status = ?, mate_id = ?, session_id = ?, doc = ?, updated_at = ? "
            "WHERE id = ?",
            (doc.get("title") or "", doc.get("status") or "interview", doc.get("mate_id"), doc.get("session_id"),
             json.dumps(doc, ensure_ascii=False), doc["updated_at"], doc["id"]))
        self._cache[doc["id"]] = doc
        return doc

    def ids(self) -> list[str]:
        return [r["id"] for r in self._db.query("SELECT id FROM avatar_projects ORDER BY updated_at DESC")]

    def by_session(self, sid: str) -> str | None:
        row = self._db.query_one("SELECT id FROM avatar_projects WHERE session_id = ?", (sid,))
        return row["id"] if row else None

    def delete(self, pid: str) -> None:
        self._db.execute("DELETE FROM avatar_projects WHERE id = ?", (pid,))
        self._cache.pop(pid, None)
        shutil.rmtree(project_dir(pid), ignore_errors=True)
