"""Admin error log — every malfunction, in one queryable place.

Sources that write here:

* ``provider``  — a turn ended in an ``error`` event (CLI exit, timeout, auth…)
* ``tool``      — a tool call the agent made came back ``is_error``
* ``workspace`` — the session's workspace could not be resolved
* ``account``   — a pooled provider account failed / was rate-limited
* ``upload``    — an attachment was rejected or could not be shipped to a host
* ``http``      — an unhandled exception or 5xx in an API request
* ``ws``        — a chat turn crashed inside the WebSocket loop
* ``auth``      — failed logins, IP bans, manual unbans
* ``client``    — uncaught errors reported by the browser
* ``system``    — WARNING+ records from Python logging (uvicorn, asyncssh, …)
* ``monitor``   — system monitor alerts: memory / swap / disk / CPU / GPU
  thresholds crossed and recovered, OOM kills, backend restarts (sysmon)

Writes never raise: logging must not be able to break the request it is
describing. Rows beyond ``settings.log_max_rows`` are pruned oldest-first.
"""

from __future__ import annotations

import json
import logging
import threading
import traceback
from datetime import datetime, timedelta, timezone
from typing import Any

from app.config import settings
from app.db import Database
from app.services._ids import now_iso

LEVELS = ("error", "warning", "info")
SOURCES = (
    "provider", "tool", "workspace", "account", "upload",
    "http", "ws", "auth", "client", "system", "monitor",
)

_MAX_MESSAGE = 4000
_MAX_STR = 20000  # per string field inside `detail`
_PRUNE_EVERY = 200


def _clip(value: Any) -> Any:
    """Bound the size of anything we persist in ``detail``."""
    if isinstance(value, str):
        return value if len(value) <= _MAX_STR else value[:_MAX_STR] + f"… [{len(value) - _MAX_STR} more chars]"
    if isinstance(value, dict):
        return {str(k): _clip(v) for k, v in list(value.items())[:100]}
    if isinstance(value, (list, tuple)):
        return [_clip(v) for v in list(value)[:100]]
    if value is None or isinstance(value, (int, float, bool)):
        return value
    return _clip(str(value))


def _iso_ago(**delta: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(**delta)).isoformat()


class LogService:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._writes = 0
        self._lock = threading.Lock()

    # ---- write ----

    def record(
        self,
        level: str,
        source: str,
        message: str,
        *,
        code: str = "",
        detail: dict[str, Any] | None = None,
        session_id: str | None = None,
        path: str | None = None,
        ip: str | None = None,
    ) -> int | None:
        try:
            msg = (message or "").strip() or code or "(no message)"
            if len(msg) > _MAX_MESSAGE:
                msg = msg[:_MAX_MESSAGE] + "…"
            row_id = self._db.insert(
                """
                INSERT INTO error_logs (ts, level, source, code, message, detail, session_id, path, ip)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    now_iso(),
                    level if level in LEVELS else "error",
                    source,
                    code or "",
                    msg,
                    json.dumps(_clip(detail or {}), ensure_ascii=False, default=str),
                    session_id,
                    path,
                    ip,
                ),
            )
            with self._lock:
                self._writes += 1
                prune = self._writes % _PRUNE_EVERY == 0
            if prune:
                self._prune()
            return row_id
        except Exception:  # noqa: BLE001 - the logger itself must never fail a request
            return None

    def _prune(self) -> None:
        row = self._db.query_one("SELECT MAX(id) AS m FROM error_logs")
        if row and row["m"]:
            self._db.execute("DELETE FROM error_logs WHERE id <= ?", (row["m"] - settings.log_max_rows,))

    # ---- read ----

    @staticmethod
    def _row(r: Any) -> dict[str, Any]:
        d = dict(r)
        try:
            d["detail"] = json.loads(d.get("detail") or "{}")
        except ValueError:
            d["detail"] = {"raw": d.get("detail")}
        return d

    def list(
        self,
        *,
        level: str | None = None,
        source: str | None = None,
        q: str | None = None,
        session_id: str | None = None,
        before_id: int | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        where: list[str] = []
        params: list[Any] = []
        if level:
            where.append("level = ?")
            params.append(level)
        if source:
            where.append("source = ?")
            params.append(source)
        if session_id:
            where.append("session_id = ?")
            params.append(session_id)
        if before_id:
            where.append("id < ?")
            params.append(before_id)
        if q:
            where.append("(message LIKE ? OR code LIKE ? OR detail LIKE ?)")
            like = f"%{q}%"
            params += [like, like, like]
        limit = max(1, min(limit, 500))
        sql = "SELECT * FROM error_logs"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC LIMIT ?"
        rows = self._db.query(sql, (*params, limit + 1))
        items = [self._row(r) for r in rows[:limit]]
        return {"items": items, "has_more": len(rows) > limit}

    def get(self, log_id: int) -> dict[str, Any] | None:
        r = self._db.query_one("SELECT * FROM error_logs WHERE id = ?", (log_id,))
        return self._row(r) if r else None

    def stats(self) -> dict[str, Any]:
        def counts(since: str) -> dict[str, int]:
            out = {lv: 0 for lv in LEVELS}
            for r in self._db.query(
                "SELECT level, COUNT(*) AS c FROM error_logs WHERE ts >= ? GROUP BY level", (since,)
            ):
                out[r["level"]] = r["c"]
            return out

        day = _iso_ago(hours=24)
        by_source = {
            r["source"]: r["c"]
            for r in self._db.query(
                "SELECT source, COUNT(*) AS c FROM error_logs WHERE ts >= ? AND level != 'info' "
                "GROUP BY source ORDER BY c DESC",
                (day,),
            )
        }
        # 24 hourly buckets (oldest first) of error / warning counts.
        now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        buckets = [
            {"hour": (now - timedelta(hours=23 - i)).isoformat(), "error": 0, "warning": 0}
            for i in range(24)
        ]
        index = {b["hour"][:13]: b for b in buckets}
        for r in self._db.query(
            "SELECT substr(ts, 1, 13) AS h, level, COUNT(*) AS c FROM error_logs "
            "WHERE ts >= ? AND level IN ('error', 'warning') GROUP BY h, level",
            (buckets[0]["hour"],),
        ):
            b = index.get(r["h"])
            if b is not None:
                b[r["level"]] = r["c"]
        total = self._db.query_one("SELECT COUNT(*) AS c FROM error_logs")
        return {
            "last_24h": counts(day),
            "last_7d": counts(_iso_ago(days=7)),
            "by_source_24h": by_source,
            "hourly": buckets,
            "total": total["c"] if total else 0,
        }

    def clear(self) -> int:
        row = self._db.query_one("SELECT COUNT(*) AS c FROM error_logs")
        self._db.execute("DELETE FROM error_logs")
        return row["c"] if row else 0


# ---- bridge: Python logging -> error_logs ----------------------------------

_guard = threading.local()


class DBLogHandler(logging.Handler):
    """Persist WARNING+ log records (uvicorn tracebacks, asyncssh, …)."""

    def __init__(self, logs: LogService) -> None:
        super().__init__(level=logging.WARNING)
        self._logs = logs

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(_guard, "active", False):  # never recurse through our own writes
            return
        _guard.active = True
        try:
            detail: dict[str, Any] = {"logger": record.name, "where": f"{record.pathname}:{record.lineno}"}
            if record.exc_info:
                detail["traceback"] = "".join(traceback.format_exception(*record.exc_info))
            self._logs.record(
                "error" if record.levelno >= logging.ERROR else "warning",
                "system",
                record.getMessage(),
                code=record.name,
                detail=detail,
            )
        except Exception:  # noqa: BLE001
            pass
        finally:
            _guard.active = False


def install_log_bridge(logs: LogService) -> DBLogHandler:
    handler = DBLogHandler(logs)
    # uvicorn's loggers don't propagate to root, so attach to both.
    for name in ("", "uvicorn"):
        lg = logging.getLogger(name)
        if not any(isinstance(h, DBLogHandler) for h in lg.handlers):
            lg.addHandler(handler)
    return handler
