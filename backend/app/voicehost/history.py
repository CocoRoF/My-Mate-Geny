"""Voice Studio's history (docs/local-voice.md "Voice Studio"): every line made there — in the studio, by a batch, a
comparison or a seed search — with everything that made it (model, profile, the clip's feeling, mode, language,
instruction, parameters, seed) and what it took, its WAV under <voice home>/history.

A mate's own words are not kept here (they live in her speech cache). Limits (Voice Studio → 설정): at most
``history_max_entries`` lines and ``history_max_gb`` of audio; the oldest go first, never a starred one or a batch's
(a batch's lines go with the batch).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.services._ids import new_id, now_iso

GiB = 1 << 30
_COLS = ("id", "created_at", "source", "model_id", "voice_id", "voice_name", "feeling", "ref_label", "mode", "language",
         "text", "instruct", "params", "seed", "file", "sample_rate", "seconds", "ready_seconds", "generate_seconds",
         "rtf", "size", "starred", "note", "batch_id", "batch_index")


class HistoryStore:
    def __init__(self, db, root: Path) -> None:
        self.db = db
        self.root = root
        db.execute("CREATE TABLE IF NOT EXISTS voice_history(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, "
                   "source TEXT NOT NULL DEFAULT 'studio', model_id TEXT NOT NULL, voice_id TEXT NOT NULL DEFAULT '', "
                   "voice_name TEXT NOT NULL DEFAULT '', feeling TEXT NOT NULL DEFAULT '', ref_label TEXT NOT NULL "
                   "DEFAULT '', mode TEXT NOT NULL DEFAULT 'clone', language TEXT NOT NULL DEFAULT 'auto', text TEXT "
                   "NOT NULL, instruct TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}', seed INTEGER, "
                   "file TEXT NOT NULL, sample_rate INTEGER NOT NULL DEFAULT 0, seconds REAL NOT NULL DEFAULT 0, "
                   "ready_seconds REAL, generate_seconds REAL, rtf REAL, size INTEGER NOT NULL DEFAULT 0, starred "
                   "INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', batch_id TEXT NOT NULL DEFAULT '', "
                   "batch_index INTEGER)")
        db.execute("CREATE INDEX IF NOT EXISTS voice_history_by_time ON voice_history(created_at)")
        db.execute("CREATE INDEX IF NOT EXISTS voice_history_by_batch ON voice_history(batch_id, batch_index)")

    @staticmethod
    def _row(r) -> dict[str, Any]:
        d = dict(r)
        try:
            d["params"] = json.loads(d.get("params") or "{}")
        except ValueError:
            d["params"] = {}
        d["starred"] = bool(d.get("starred"))
        return d

    def path(self, entry: dict[str, Any]) -> Path:
        return self.root / entry["file"]

    # -- writing ----------------------------------------------------------------------------------------------------
    def add(self, wav: bytes, meta: dict[str, Any]) -> dict[str, Any]:
        hid = new_id("gen")
        day = now_iso()[:10]
        rel = f"{day}/{hid}.wav"
        f = self.root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(wav)
        row = {c: None for c in _COLS}
        row.update({k: v for k, v in meta.items() if k in _COLS})
        row.update(id=hid, created_at=now_iso(), file=rel, size=len(wav),
                   params=json.dumps(meta.get("params") or {}, ensure_ascii=False),
                   starred=0, note="", batch_id=meta.get("batch_id") or "")
        for k, default in (("source", "studio"), ("voice_id", ""), ("voice_name", ""), ("feeling", ""),
                           ("ref_label", ""), ("mode", "clone"), ("language", "auto"), ("instruct", ""),
                           ("sample_rate", 0), ("seconds", 0)):
            if row[k] is None:
                row[k] = default
        self.db.execute(f"INSERT INTO voice_history({', '.join(_COLS)}) VALUES({', '.join('?' for _ in _COLS)})",
                        tuple(row[c] for c in _COLS))
        return self.get(hid) or {}

    def update(self, hid: str, *, starred: bool | None = None, note: str | None = None) -> dict[str, Any] | None:
        if starred is not None:
            self.db.execute("UPDATE voice_history SET starred=? WHERE id=?", (1 if starred else 0, hid))
        if note is not None:
            self.db.execute("UPDATE voice_history SET note=? WHERE id=?", (str(note)[:500], hid))
        return self.get(hid)

    def delete(self, ids: list[str]) -> int:
        n = 0
        for hid in ids:
            e = self.get(hid)
            if e is None:
                continue
            self.path(e).unlink(missing_ok=True)
            self.db.execute("DELETE FROM voice_history WHERE id=?", (hid,))
            n += 1
        return n

    def delete_batch(self, batch_id: str) -> int:
        ids = [r["id"] for r in self.db.query("SELECT id FROM voice_history WHERE batch_id=?", (batch_id,))]
        return self.delete(ids)

    def prune(self, max_entries: int, max_bytes: int) -> int:
        """the oldest unstarred lines (not a batch's) until both limits hold"""
        rows = self.db.query("SELECT id, size FROM voice_history WHERE starred=0 AND batch_id='' ORDER BY created_at")
        total_n = self.db.query_one("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS b FROM voice_history")
        n, b = int(total_n["n"]), int(total_n["b"])
        drop = []
        for r in rows:
            if n <= max_entries and b <= max_bytes:
                break
            drop.append(r["id"])
            n -= 1
            b -= int(r["size"] or 0)
        return self.delete(drop)

    # -- reading ----------------------------------------------------------------------------------------------------
    def get(self, hid: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM voice_history WHERE id=?", (hid,))
        return self._row(r) if r else None

    def list(self, *, q: str = "", voice_id: str = "", model_id: str = "", source: str = "", starred: bool = False,
             batch_id: str | None = None, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        where, args = [], []
        if q:
            where.append("(text LIKE ? OR note LIKE ? OR instruct LIKE ?)")
            args += [f"%{q}%"] * 3
        for col, val in (("voice_id", voice_id), ("model_id", model_id), ("source", source)):
            if val:
                where.append(f"{col}=?")
                args.append(val)
        if starred:
            where.append("starred=1")
        if batch_id is not None:
            where.append("batch_id=?")
            args.append(batch_id)
        w = f"WHERE {' AND '.join(where)}" if where else ""
        total = self.db.query_one(f"SELECT COUNT(*) AS n FROM voice_history {w}", tuple(args))
        order = "batch_index" if batch_id else "created_at DESC"
        rows = self.db.query(f"SELECT * FROM voice_history {w} ORDER BY {order} LIMIT ? OFFSET ?",
                             (*args, max(1, min(int(limit), 500)), max(0, int(offset))))
        return {"items": [self._row(r) for r in rows], "total": int(total["n"])}

    def usage(self) -> dict[str, Any]:
        r = self.db.query_one("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS b, COALESCE(SUM(starred),0) AS s, "
                              "COALESCE(SUM(CASE WHEN batch_id!='' THEN size ELSE 0 END),0) AS bb FROM voice_history")
        return {"count": int(r["n"]), "bytes": int(r["b"]), "starred": int(r["s"]), "batch_bytes": int(r["bb"])}

    def facets(self) -> dict[str, Any]:
        """what the history can be filtered by: the models, profiles and sources it holds"""
        def col(c: str) -> list[dict[str, Any]]:
            return [{"value": r["v"], "count": int(r["n"])}
                    for r in self.db.query(f"SELECT {c} AS v, COUNT(*) AS n FROM voice_history GROUP BY {c} ORDER BY n DESC")
                    if r["v"]]
        voices = [{"value": r["voice_id"], "name": r["voice_name"], "count": int(r["n"])}
                  for r in self.db.query("SELECT voice_id, MAX(voice_name) AS voice_name, COUNT(*) AS n FROM "
                                         "voice_history WHERE voice_id!='' GROUP BY voice_id ORDER BY n DESC")]
        return {"models": col("model_id"), "sources": col("source"), "voices": voices}
