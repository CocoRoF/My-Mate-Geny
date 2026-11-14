"""What local voice keeps in the app's database: the licenses the user accepted (model, license, when), and the user's
own voices (a name, a language, and reference clips by feeling — the clips are files under <voice home>/references).
"""

from __future__ import annotations

import json
from typing import Any

from app.services._ids import new_id, now_iso


class VoiceStore:
    def __init__(self, db) -> None:
        self.db = db
        db.execute("CREATE TABLE IF NOT EXISTS voice_licenses(model_id TEXT PRIMARY KEY, license TEXT NOT NULL, "
                   "url TEXT NOT NULL DEFAULT '', accepted_at TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS voice_voices(id TEXT PRIMARY KEY, name TEXT NOT NULL, "
                   "language TEXT NOT NULL DEFAULT 'auto', instruct TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, "
                   "updated_at TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS voice_refs(id TEXT PRIMARY KEY, voice_id TEXT NOT NULL, "
                   "label TEXT NOT NULL DEFAULT 'neutral', file TEXT NOT NULL, transcript TEXT NOT NULL DEFAULT '', "
                   "language TEXT NOT NULL DEFAULT 'auto', duration REAL NOT NULL DEFAULT 0, stats TEXT NOT NULL "
                   "DEFAULT '{}', created_at TEXT NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS voice_refs_by_voice ON voice_refs(voice_id, created_at)")
        # Voice Studio's profile fields (2026-11-14): added to a table that may already hold voices
        have = {r[1] for r in db.query("PRAGMA table_info(voice_voices)")}
        for col, decl in (("description", "TEXT NOT NULL DEFAULT ''"), ("default_model", "TEXT NOT NULL DEFAULT ''"),
                          ("default_params", "TEXT NOT NULL DEFAULT '{}'"), ("tags", "TEXT NOT NULL DEFAULT '[]'"),
                          ("starred", "INTEGER NOT NULL DEFAULT 0")):
            if col not in have:
                db.execute(f"ALTER TABLE voice_voices ADD COLUMN {col} {decl}")
        # small settings (Voice Studio: GPU budget, idle times, history limits, each model's default parameters)
        db.execute("CREATE TABLE IF NOT EXISTS voice_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, "
                   "updated_at TEXT NOT NULL)")

    # -- settings ---------------------------------------------------------------------------------------------------
    def setting(self, key: str, default: Any = None) -> Any:
        r = self.db.query_one("SELECT value FROM voice_settings WHERE key=?", (key,))
        if r is None:
            return default
        try:
            return json.loads(r["value"])
        except ValueError:
            return default

    def put_setting(self, key: str, value: Any) -> None:
        if value is None:
            self.db.execute("DELETE FROM voice_settings WHERE key=?", (key,))
            return
        self.db.execute("INSERT INTO voice_settings(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE "
                        "SET value=excluded.value, updated_at=excluded.updated_at",
                        (key, json.dumps(value, ensure_ascii=False), now_iso()))

    # -- licenses ---------------------------------------------------------------------------------------------------
    def accept_license(self, model_id: str, license_name: str, url: str) -> dict[str, Any]:
        at = now_iso()
        self.db.execute("INSERT INTO voice_licenses(model_id, license, url, accepted_at) VALUES(?,?,?,?) "
                        "ON CONFLICT(model_id) DO UPDATE SET license=excluded.license, url=excluded.url, "
                        "accepted_at=excluded.accepted_at", (model_id, license_name, url, at))
        return {"license": license_name, "url": url, "accepted_at": at}

    def license_record(self, model_id: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT license, url, accepted_at FROM voice_licenses WHERE model_id=?", (model_id,))
        return dict(r) if r else None

    # -- voices -----------------------------------------------------------------------------------------------------
    @staticmethod
    def _voice_row(r) -> dict[str, Any]:
        d = dict(r)
        for k, empty in (("default_params", {}), ("tags", [])):
            try:
                d[k] = json.loads(d.get(k) or json.dumps(empty))
            except ValueError:
                d[k] = empty
        d["starred"] = bool(d.get("starred"))
        return d

    def voices(self) -> list[dict[str, Any]]:
        out = []
        for v in self.db.query("SELECT * FROM voice_voices ORDER BY created_at"):
            d = self._voice_row(v)
            d["references"] = self.references(d["id"])
            out.append(d)
        return out

    def voice(self, vid: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM voice_voices WHERE id=?", (vid,))
        if r is None:
            return None
        d = self._voice_row(r)
        d["references"] = self.references(vid)
        return d

    def create_voice(self, name: str, language: str = "auto", instruct: str = "") -> dict[str, Any]:
        vid, at = new_id("voice"), now_iso()
        self.db.execute("INSERT INTO voice_voices(id, name, language, instruct, created_at, updated_at) "
                        "VALUES(?,?,?,?,?,?)", (vid, name, language, instruct, at, at))
        return self.voice(vid) or {}

    def update_voice(self, vid: str, **fields: Any) -> dict[str, Any] | None:
        allowed = {k: v for k, v in fields.items()
                   if k in ("name", "language", "instruct", "description", "default_model", "default_params", "tags",
                            "starred") and v is not None}
        for k in ("default_params", "tags"):
            if k in allowed:
                allowed[k] = json.dumps(allowed[k], ensure_ascii=False)
        if "starred" in allowed:
            allowed["starred"] = 1 if allowed["starred"] else 0
        if allowed:
            sets = ", ".join(f"{k}=?" for k in allowed)
            self.db.execute(f"UPDATE voice_voices SET {sets}, updated_at=? WHERE id=?",
                            (*allowed.values(), now_iso(), vid))
        return self.voice(vid)

    def delete_voice(self, vid: str) -> list[str]:
        files = [r["file"] for r in self.db.query("SELECT file FROM voice_refs WHERE voice_id=?", (vid,))]
        with self.db.transaction():
            self.db.execute("DELETE FROM voice_refs WHERE voice_id=?", (vid,))
            self.db.execute("DELETE FROM voice_voices WHERE id=?", (vid,))
        return files

    # -- references -------------------------------------------------------------------------------------------------
    def references(self, vid: str) -> list[dict[str, Any]]:
        out = []
        for r in self.db.query("SELECT * FROM voice_refs WHERE voice_id=? ORDER BY created_at", (vid,)):
            d = dict(r)
            try:
                d["stats"] = json.loads(d.get("stats") or "{}")
            except ValueError:
                d["stats"] = {}
            out.append(d)
        return out

    def reference(self, rid: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM voice_refs WHERE id=?", (rid,))
        if r is None:
            return None
        d = dict(r)
        try:
            d["stats"] = json.loads(d.get("stats") or "{}")
        except ValueError:
            d["stats"] = {}
        return d

    def add_reference(self, vid: str, *, label: str, file: str, transcript: str, language: str, duration: float,
                      stats: dict[str, Any], rid: str | None = None) -> dict[str, Any]:
        rid = rid or new_id("ref")
        self.db.execute("INSERT INTO voice_refs(id, voice_id, label, file, transcript, language, duration, stats, "
                        "created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                        (rid, vid, label, file, transcript, language, duration, json.dumps(stats), now_iso()))
        self.db.execute("UPDATE voice_voices SET updated_at=? WHERE id=?", (now_iso(), vid))
        return self.reference(rid) or {}

    def update_reference(self, rid: str, **fields: Any) -> dict[str, Any] | None:
        allowed = {k: v for k, v in fields.items()
                   if k in ("label", "transcript", "language", "duration", "stats") and v is not None}
        if "stats" in allowed:
            allowed["stats"] = json.dumps(allowed["stats"])
        if allowed:
            sets = ", ".join(f"{k}=?" for k in allowed)
            self.db.execute(f"UPDATE voice_refs SET {sets} WHERE id=?", (*allowed.values(), rid))
        return self.reference(rid)

    def delete_reference(self, rid: str) -> str | None:
        r = self.reference(rid)
        if r is None:
            return None
        self.db.execute("DELETE FROM voice_refs WHERE id=?", (rid,))
        return r["file"]
