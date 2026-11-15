"""What Image Studio keeps in the app's database: the licenses the user accepted, small settings (which model each use
takes, a recipe's defaults, the idle time), and every job it ran — what was asked, on which model, for whom, how long it
took and what it made (the files are under <image home>/history/<job id>/)."""

from __future__ import annotations

import json
from typing import Any

from app.services._ids import new_id, now_iso


class ImageStore:
    def __init__(self, db) -> None:
        self.db = db
        db.execute("CREATE TABLE IF NOT EXISTS image_licenses(model_id TEXT PRIMARY KEY, license TEXT NOT NULL, "
                   "url TEXT NOT NULL DEFAULT '', accepted_at TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS image_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, "
                   "updated_at TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS image_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, "
                   "recipe TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', "
                   "state TEXT NOT NULL, inputs TEXT NOT NULL DEFAULT '{}', params TEXT NOT NULL DEFAULT '{}', "
                   "outputs TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', seconds REAL NOT NULL DEFAULT 0, "
                   "starred INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT '', "
                   "ended_at TEXT NOT NULL DEFAULT '')")
        db.execute("CREATE INDEX IF NOT EXISTS image_jobs_by_time ON image_jobs(created_at)")

    # -- settings ---------------------------------------------------------------------------------------------------
    def setting(self, key: str, default: Any = None) -> Any:
        r = self.db.query_one("SELECT value FROM image_settings WHERE key=?", (key,))
        if r is None:
            return default
        try:
            return json.loads(r["value"])
        except ValueError:
            return default

    def put_setting(self, key: str, value: Any) -> None:
        if value is None:
            self.db.execute("DELETE FROM image_settings WHERE key=?", (key,))
            return
        self.db.execute("INSERT INTO image_settings(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE "
                        "SET value=excluded.value, updated_at=excluded.updated_at",
                        (key, json.dumps(value, ensure_ascii=False), now_iso()))

    # -- licenses ---------------------------------------------------------------------------------------------------
    def accept_license(self, model_id: str, license_name: str, url: str) -> dict[str, Any]:
        at = now_iso()
        self.db.execute("INSERT INTO image_licenses(model_id, license, url, accepted_at) VALUES(?,?,?,?) "
                        "ON CONFLICT(model_id) DO UPDATE SET license=excluded.license, url=excluded.url, "
                        "accepted_at=excluded.accepted_at", (model_id, license_name, url, at))
        return {"license": license_name, "url": url, "accepted_at": at}

    def license_record(self, model_id: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT license, url, accepted_at FROM image_licenses WHERE model_id=?", (model_id,))
        return dict(r) if r else None

    # -- jobs -------------------------------------------------------------------------------------------------------
    @staticmethod
    def _row(r) -> dict[str, Any]:
        d = dict(r)
        for k, empty in (("inputs", {}), ("params", {}), ("outputs", [])):
            try:
                d[k] = json.loads(d.get(k) or "null") or empty
            except ValueError:
                d[k] = empty
        d["starred"] = bool(d.get("starred"))
        return d

    def add_job(self, *, kind: str, recipe: str, model_id: str, source: str, inputs: dict[str, Any],
                params: dict[str, Any]) -> dict[str, Any]:
        jid = new_id("img")
        self.db.execute("INSERT INTO image_jobs(id, kind, recipe, model_id, source, state, inputs, params, created_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?)", (jid, kind, recipe, model_id, source, "queued",
                                                      json.dumps(inputs, ensure_ascii=False),
                                                      json.dumps(params, ensure_ascii=False), now_iso()))
        return self.job(jid)  # type: ignore[return-value]

    def update_job(self, jid: str, **fields: Any) -> dict[str, Any] | None:
        cols = {"state", "outputs", "error", "seconds", "started_at", "ended_at", "starred", "model_id", "params"}
        sets, vals = [], []
        for k, v in fields.items():
            if k not in cols:
                continue
            if k in ("outputs", "params"):
                v = json.dumps(v, ensure_ascii=False)
            elif k == "starred":
                v = 1 if v else 0
            sets.append(f"{k}=?")
            vals.append(v)
        if sets:
            self.db.execute(f"UPDATE image_jobs SET {', '.join(sets)} WHERE id=?", (*vals, jid))
        return self.job(jid)

    def job(self, jid: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM image_jobs WHERE id=?", (jid,))
        return self._row(r) if r else None

    def jobs(self, *, kind: str = "", source: str = "", starred: bool | None = None, limit: int = 60,
             offset: int = 0) -> tuple[list[dict[str, Any]], int]:
        where, vals = [], []
        if kind:
            where.append("kind=?")
            vals.append(kind)
        if source:
            where.append("source LIKE ?")
            vals.append(source.rstrip("*") + "%")
        if starred is not None:
            where.append("starred=?")
            vals.append(1 if starred else 0)
        w = (" WHERE " + " AND ".join(where)) if where else ""
        total = self.db.query_one(f"SELECT COUNT(*) AS n FROM image_jobs{w}", tuple(vals))["n"]
        rows = self.db.query(f"SELECT * FROM image_jobs{w} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                             (*vals, limit, offset))
        return [self._row(r) for r in rows], int(total)

    def unfinished(self) -> list[dict[str, Any]]:
        return [self._row(r) for r in self.db.query("SELECT * FROM image_jobs WHERE state IN ('queued', 'running')")]

    def delete_jobs(self, ids: list[str]) -> list[str]:
        gone = []
        for jid in ids:
            if self.db.query_one("SELECT id FROM image_jobs WHERE id=? AND state NOT IN ('queued', 'running')", (jid,)):
                self.db.execute("DELETE FROM image_jobs WHERE id=?", (jid,))
                gone.append(jid)
        return gone

    def oldest_unstarred(self, keep: int) -> list[str]:
        rows = self.db.query("SELECT id FROM image_jobs WHERE starred=0 AND state NOT IN ('queued', 'running') "
                             "ORDER BY created_at DESC LIMIT -1 OFFSET ?", (keep,))
        return [r["id"] for r in rows]
