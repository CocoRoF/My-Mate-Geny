"""The journal of the Geny-State-System: everything that happened to a mate's state, in one place and in order — what a
message was read as, how she felt, what stayed with her, how the relationship moved, promises, what she remembers of the
two of them, and what she was told each turn. The State Inspector reads it; nothing decides anything from it.

Rows are small JSON entries in ``mate_gss_events`` (app/db.py); a mate keeps at most ``KEEP`` of them and none older than ``DAYS``."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

KEEP, DAYS = 3000, 90
LAYERS = ("heard", "feeling", "grudge", "bond", "promise", "episode", "told", "said", "temperament")

def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat(timespec="seconds")


class Journal:
    def __init__(self, db: Any) -> None:
        self._db = db  # (its table: app/db.py, mate_gss_events)
        self._added = 0

    def record(self, mate_id: str, layer: str, kind: str, data: dict[str, Any] | None = None, at: datetime | None = None) -> None:
        if not mate_id:
            return
        self._db.execute("INSERT INTO mate_gss_events (mate_id, at, layer, kind, data) VALUES (?, ?, ?, ?, ?)",
                         (mate_id, _iso(at or datetime.now(timezone.utc)), layer, kind,
                          json.dumps(data or {}, ensure_ascii=False, default=str)[:4000]))
        self._added += 1
        if self._added % 200 == 0:
            self.prune(mate_id)

    def recent(self, mate_id: str, *, limit: int = 200, layers: list[str] | None = None, before: int | None = None) -> list[dict[str, Any]]:
        """Newest first."""
        q, args = "SELECT id, at, layer, kind, data FROM mate_gss_events WHERE mate_id = ?", [mate_id]
        if layers:
            q += f" AND layer IN ({','.join('?' * len(layers))})"
            args += list(layers)
        if before:
            q += " AND id < ?"
            args.append(int(before))
        q += " ORDER BY id DESC LIMIT ?"
        args.append(max(1, min(1000, int(limit))))
        out = []
        for r in self._db.query(q, tuple(args)):
            try:
                data = json.loads(r["data"])
            except ValueError:
                data = {}
            out.append({"id": r["id"], "at": r["at"], "layer": r["layer"], "kind": r["kind"], "data": data})
        return out

    def prune(self, mate_id: str) -> None:
        cutoff = _iso(datetime.now(timezone.utc) - timedelta(days=DAYS))
        self._db.execute("DELETE FROM mate_gss_events WHERE mate_id = ? AND at < ?", (mate_id, cutoff))
        self._db.execute("DELETE FROM mate_gss_events WHERE mate_id = ? AND id NOT IN (SELECT id FROM mate_gss_events "
                         "WHERE mate_id = ? ORDER BY id DESC LIMIT ?)", (mate_id, mate_id, KEEP))

    def wipe(self, mate_id: str) -> None:
        self._db.execute("DELETE FROM mate_gss_events WHERE mate_id = ?", (mate_id,))
