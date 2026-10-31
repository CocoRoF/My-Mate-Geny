"""Where samples live: a ring buffer for live views and SQLite for history.

* :class:`Ring` — the last ~30 min at full resolution (one entry per tick),
  stored as ``(ts, keys, values)`` tuples that share one ``keys`` tuple, so
  900 samples of ~35 metrics cost about a megabyte.
* :class:`Agg` — running min / sum / max / n per metric.
* :class:`MetricsStore` — ``sys_metrics`` rows at two resolutions:
  1-minute aggregates kept 7 days, 15-minute aggregates kept 90 days (both
  configurable). A row's ``data`` is zlib-compressed JSON
  ``{"metric": [min, avg, max]}`` (a bare number when min == max), ~0.5 KB.
  (A plain rowid table: ~1 KB rows would spill into overflow pages in a
  WITHOUT ROWID b-tree.) Queries re-bucket rows to ~300-700 points.
"""

from __future__ import annotations

import json
import math
import time
import zlib
from collections import deque
from typing import Any, Iterable

from app.db import Database

RES_1M = 60
RES_15M = 900

SCHEMA = """
CREATE TABLE IF NOT EXISTS sys_metrics (
    id   INTEGER PRIMARY KEY,
    res  INTEGER NOT NULL,      -- bucket length in seconds (60 | 900)
    ts   INTEGER NOT NULL,      -- bucket start, epoch seconds (UTC)
    n    INTEGER NOT NULL,      -- samples aggregated
    data BLOB    NOT NULL       -- zlib(JSON {"metric": [min, avg, max] | value})
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sys_metrics ON sys_metrics(res, ts);
CREATE TABLE IF NOT EXISTS sys_monitor_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# range -> (source, span seconds, bucket seconds). "ring" = live samples.
RANGES: dict[str, tuple[str | int, int, int]] = {
    "15m": ("ring", 900, 0),
    "30m": ("ring", 1800, 0),
    "1h": (RES_1M, 3600, 60),
    "6h": (RES_1M, 6 * 3600, 60),
    "24h": (RES_1M, 24 * 3600, 300),
    "7d": (RES_15M, 7 * 86400, 1800),
    "30d": (RES_15M, 30 * 86400, 7200),
    "90d": (RES_15M, 90 * 86400, 21600),
}


def _r(v: float) -> float | int:
    """4 significant digits — plenty for a chart, keeps rows small."""
    if v == 0 or not math.isfinite(v):
        return 0
    x = float(f"{v:.4g}")
    return int(x) if x.is_integer() else x


class Ring:
    def __init__(self, maxlen: int) -> None:
        self._d: deque[tuple[float, tuple[str, ...], tuple[float, ...]]] = deque(maxlen=maxlen)
        self._keys: tuple[str, ...] = ()

    def __len__(self) -> int:
        return len(self._d)

    def append(self, ts: float, metrics: dict[str, float]) -> None:
        keys = tuple(metrics)
        if keys != self._keys:
            self._keys = keys
        self._d.append((ts, self._keys, tuple(metrics.values())))

    def last(self, n: int) -> list[tuple[float, dict[str, float]]]:
        items = list(self._d)[-n:] if n else []
        return [(ts, dict(zip(k, v))) for ts, k, v in items]

    def window(self, since: float) -> list[tuple[float, dict[str, float]]]:
        return [(ts, dict(zip(k, v))) for ts, k, v in self._d if ts >= since]

    def values(self, key: str, since: float) -> list[float]:
        out = []
        for ts, k, v in self._d:
            if ts >= since:
                try:
                    out.append(v[k.index(key)])
                except ValueError:
                    pass
        return out

    def columnar(self, since: float, keys: Iterable[str] | None = None) -> dict[str, Any]:
        rows = self.window(since)
        names = list(keys) if keys is not None else _union(m for _, m in rows)
        return {
            "t": [round(ts, 1) for ts, _ in rows],
            "series": {k: {"avg": [_maybe(m.get(k)) for _, m in rows]} for k in names},
        }


def pack(data: dict[str, Any]) -> bytes:
    return zlib.compress(json.dumps(data, separators=(",", ":")).encode(), 6)


def unpack(raw: bytes | str) -> dict[str, Any]:
    if isinstance(raw, (bytes, bytearray, memoryview)):
        raw = zlib.decompress(bytes(raw)).decode()
    return json.loads(raw)


def _maybe(v: float | None) -> float | int | None:
    return None if v is None else _r(v)


def _union(dicts: Iterable[dict[str, Any]]) -> list[str]:
    seen: dict[str, None] = {}
    for d in dicts:
        for k in d:
            seen.setdefault(k, None)
    return list(seen)


class Agg:
    """min / sum / max / count per metric."""

    def __init__(self) -> None:
        self.n = 0
        self.v: dict[str, list[float]] = {}   # key -> [min, sum, max, n]

    def add(self, metrics: dict[str, float]) -> None:
        self.n += 1
        for k, x in metrics.items():
            if x is None:
                continue
            a = self.v.get(k)
            if a is None:
                self.v[k] = [x, x, x, 1]
            else:
                if x < a[0]:
                    a[0] = x
                if x > a[2]:
                    a[2] = x
                a[1] += x
                a[3] += 1

    def merge(self, data: dict[str, Any], n: int) -> None:
        """Fold in a stored row (``{k: [min, avg, max] | value}`` over n samples)."""
        self.n += n
        for k, raw in data.items():
            mn, avg, mx = (raw if isinstance(raw, list) else (raw, raw, raw))
            a = self.v.get(k)
            if a is None:
                self.v[k] = [mn, avg * n, mx, n]
            else:
                a[0], a[2] = min(a[0], mn), max(a[2], mx)
                a[1] += avg * n
                a[3] += n

    def absorb(self, other: "Agg") -> None:
        """Fold in another running aggregate."""
        self.n += other.n
        for k, (mn, sm, mx, n) in other.v.items():
            a = self.v.get(k)
            if a is None:
                self.v[k] = [mn, sm, mx, n]
            else:
                a[0], a[2] = min(a[0], mn), max(a[2], mx)
                a[1] += sm
                a[3] += n

    def result(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for k, (mn, s, mx, n) in self.v.items():
            lo, avg, hi = _r(mn), _r(s / n), _r(mx)
            out[k] = avg if lo == hi else [lo, avg, hi]
        return out

    def __bool__(self) -> bool:
        return self.n > 0


class MetricsStore:
    def __init__(self, db: Database, *, keep_1m_days: float = 7, keep_15m_days: float = 90) -> None:
        self.db = db
        self.keep = {RES_1M: keep_1m_days * 86400, RES_15M: keep_15m_days * 86400}
        with db._lock:  # noqa: SLF001 - one-off DDL on the shared connection
            assert db._conn is not None  # noqa: SLF001
            db._conn.executescript(SCHEMA)  # noqa: SLF001
            db._conn.commit()  # noqa: SLF001

    # -- write

    def write(self, res: int, ts: int, agg: Agg) -> None:
        """Insert a bucket; merge if one exists (e.g. a restart mid-bucket)."""
        if not agg:
            return
        row = self.db.query_one("SELECT n, data FROM sys_metrics WHERE res = ? AND ts = ?", (res, ts))
        if row is not None:
            merged = Agg()
            merged.merge(unpack(row["data"]), row["n"])
            merged.absorb(agg)
            agg = merged
        self.db.execute(
            "INSERT OR REPLACE INTO sys_metrics (res, ts, n, data) VALUES (?, ?, ?, ?)",
            (res, ts, agg.n, pack(agg.result())),
        )

    def prune(self, now: float | None = None) -> int:
        now = now or time.time()
        deleted = 0
        for res, keep in self.keep.items():
            before = self.count(res)
            self.db.execute("DELETE FROM sys_metrics WHERE res = ? AND ts < ?", (res, int(now - keep)))
            deleted += before - self.count(res)
        return deleted

    def count(self, res: int | None = None) -> int:
        if res is None:
            row = self.db.query_one("SELECT COUNT(*) AS c FROM sys_metrics")
        else:
            row = self.db.query_one("SELECT COUNT(*) AS c FROM sys_metrics WHERE res = ?", (res,))
        return row["c"] if row else 0

    def rows(self, res: int, since: float, until: float | None = None) -> list[tuple[int, int, dict[str, Any]]]:
        sql = "SELECT ts, n, data FROM sys_metrics WHERE res = ? AND ts >= ?"
        params: list[Any] = [res, int(since)]
        if until is not None:
            sql += " AND ts < ?"
            params.append(int(until))
        rows = self.db.query(sql + " ORDER BY ts", params)
        return [(r["ts"], r["n"], unpack(r["data"])) for r in rows]

    # -- key/value state (restart detection)

    def get_state(self, key: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT value FROM sys_monitor_state WHERE key = ?", (key,))
        if row is None:
            return None
        try:
            return json.loads(row["value"])
        except ValueError:
            return None

    def set_state(self, key: str, value: dict[str, Any]) -> None:
        self.db.execute("INSERT OR REPLACE INTO sys_monitor_state (key, value) VALUES (?, ?)",
                        (key, json.dumps(value)))


def bucketize(
    rows: list[tuple[int, int, dict[str, Any]]], step: int, extra: list[tuple[int, Agg]] = ()
) -> dict[str, Any]:
    """Re-bucket stored rows (plus in-memory partial buckets) to ``step``
    seconds; columnar output with min/avg/max per metric."""
    buckets: dict[int, Agg] = {}
    for ts, n, data in rows:
        b = ts - ts % step if step else ts
        buckets.setdefault(b, Agg()).merge(data, n)
    for ts, agg in extra:
        if not agg:
            continue
        b = ts - ts % step if step else ts
        buckets.setdefault(b, Agg()).absorb(agg)
    order = sorted(buckets)
    keys = _union(buckets[b].v for b in order)
    series: dict[str, dict[str, list[Any]]] = {k: {"min": [], "avg": [], "max": []} for k in keys}
    for b in order:
        v = buckets[b].v
        for k in keys:
            a = v.get(k)
            s = series[k]
            if a is None:
                s["min"].append(None)
                s["avg"].append(None)
                s["max"].append(None)
            else:
                s["min"].append(_r(a[0]))
                s["avg"].append(_r(a[1] / a[3]))
                s["max"].append(_r(a[2]))
    return {"t": order, "series": series}
