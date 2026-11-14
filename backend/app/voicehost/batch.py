"""Voice Studio's batches: many lines in one go (docs/local-voice.md "Voice Studio → 일괄 생성").

Input: plain text (a line each; ``[joy] …`` sets that line's feeling), CSV (a header with ``text`` and any of
``profile``, ``feeling`` / ``emotion``, ``seed``, ``language``, ``instruct``, ``model``; without one the first column
is the text) or JSON (strings or objects with the same keys) — at most 500 lines. Shared settings come from the form;
a line's own columns win.

A batch runs one line at a time at the lowest GPU priority (a mate's words and the studio's own lines go first), each
line a history entry of the batch. It can be cancelled (what is made stays), its failed lines retried, and one that a
restart stopped is resumed. Download: a ZIP of the lines in a chosen format with a manifest.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import re
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.services._ids import new_id, now_iso

if TYPE_CHECKING:
    from .service import VoiceHost

log = logging.getLogger("app.voicehost")

MAX_LINES = 500
LINE_KEYS = ("text", "profile", "feeling", "seed", "language", "instruct", "model")
_TAG = re.compile(r"^\s*\[([a-zA-Z_]+)\]\s*")


class BatchInputError(ValueError):
    pass


def _norm_line(d: dict[str, Any]) -> dict[str, Any] | None:
    d = {str(k).strip().lower(): v for k, v in d.items() if k is not None}
    if "emotion" in d and "feeling" not in d:
        d["feeling"] = d.pop("emotion")
    if "voice" in d and "profile" not in d:
        d["profile"] = d.pop("voice")
    text = " ".join(str(d.get("text") or "").split())
    if not text:
        return None
    out: dict[str, Any] = {"text": text}
    for k in ("profile", "feeling", "language", "instruct", "model"):
        v = str(d.get(k) or "").strip()
        if v:
            out[k] = v
    seed = str(d.get("seed") or "").strip()
    if seed:
        try:
            out["seed"] = int(float(seed))
        except ValueError:
            raise BatchInputError(f"seed '{seed}' isn't a number") from None
    return out


def parse(content: str, fmt: str) -> list[dict[str, Any]]:
    """the lines of a batch: [{text, profile?, feeling?, seed?, language?, instruct?, model?}]"""
    content = (content or "").lstrip("﻿")
    fmt = (fmt or "txt").lower()
    lines: list[dict[str, Any]] = []
    if fmt == "json":
        try:
            data = json.loads(content)
        except ValueError as e:
            raise BatchInputError(f"not JSON: {e}") from None
        if not isinstance(data, list):
            raise BatchInputError("JSON must be a list of lines")
        for item in data:
            line = _norm_line({"text": item} if isinstance(item, str) else item if isinstance(item, dict) else {})
            if line:
                lines.append(line)
    elif fmt == "csv":
        rows = list(csv.reader(io.StringIO(content)))
        rows = [r for r in rows if any(c.strip() for c in r)]
        if not rows:
            return []
        head = [c.strip().lower() for c in rows[0]]
        if "text" in head:
            for r in rows[1:]:
                line = _norm_line(dict(zip(head, r)))
                if line:
                    lines.append(line)
        else:
            for r in rows:
                line = _norm_line({"text": r[0] if r else ""})
                if line:
                    lines.append(line)
    else:
        for raw in content.splitlines():
            m = _TAG.match(raw)
            line = _norm_line({"text": raw[m.end():] if m else raw, "feeling": m.group(1) if m else ""})
            if line:
                lines.append(line)
    if len(lines) > MAX_LINES:
        raise BatchInputError(f"{len(lines)} lines: at most {MAX_LINES} in one batch")
    return lines


def _slug(text: str, n: int = 40) -> str:
    s = re.sub(r"[^\w가-힣ぁ-んァ-ン一-龥]+", "_", text, flags=re.UNICODE).strip("_")
    return s[:n] or "line"


class BatchStore:
    def __init__(self, db) -> None:
        self.db = db
        db.execute("CREATE TABLE IF NOT EXISTS voice_batches(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, started_at "
                   "TEXT, finished_at TEXT, label TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'queued', "
                   "total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT "
                   "0, settings TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '')")
        db.execute("CREATE TABLE IF NOT EXISTS voice_batch_items(batch_id TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT "
                   "NOT NULL, overrides TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'queued', history_id "
                   "TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', seconds REAL, rtf REAL, seed INTEGER, "
                   "PRIMARY KEY(batch_id, idx))")

    @staticmethod
    def _batch(r) -> dict[str, Any]:
        d = dict(r)
        try:
            d["settings"] = json.loads(d.get("settings") or "{}")
        except ValueError:
            d["settings"] = {}
        return d

    def create(self, label: str, settings: dict[str, Any], lines: list[dict[str, Any]]) -> dict[str, Any]:
        bid = new_id("batch")
        with self.db.transaction():
            self.db.execute("INSERT INTO voice_batches(id, created_at, label, state, total, settings) VALUES(?,?,?,?,?,?)",
                            (bid, now_iso(), label[:120], "queued", len(lines), json.dumps(settings, ensure_ascii=False)))
            for i, line in enumerate(lines):
                over = {k: v for k, v in line.items() if k != "text"}
                self.db.execute("INSERT INTO voice_batch_items(batch_id, idx, text, overrides) VALUES(?,?,?,?)",
                                (bid, i, line["text"], json.dumps(over, ensure_ascii=False)))
        return self.get(bid) or {}

    def get(self, bid: str, items: bool = False) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM voice_batches WHERE id=?", (bid,))
        if r is None:
            return None
        d = self._batch(r)
        if items:
            d["items"] = self.items(bid)
        return d

    def items(self, bid: str) -> list[dict[str, Any]]:
        out = []
        for r in self.db.query("SELECT * FROM voice_batch_items WHERE batch_id=? ORDER BY idx", (bid,)):
            d = dict(r)
            try:
                d["overrides"] = json.loads(d.get("overrides") or "{}")
            except ValueError:
                d["overrides"] = {}
            out.append(d)
        return out

    def list(self, limit: int = 30) -> list[dict[str, Any]]:
        return [self._batch(r) for r in self.db.query("SELECT * FROM voice_batches ORDER BY created_at DESC LIMIT ?",
                                                      (limit,))]

    def set(self, bid: str, **fields: Any) -> None:
        if fields:
            sets = ", ".join(f"{k}=?" for k in fields)
            self.db.execute(f"UPDATE voice_batches SET {sets} WHERE id=?", (*fields.values(), bid))

    def set_item(self, bid: str, idx: int, **fields: Any) -> None:
        sets = ", ".join(f"{k}=?" for k in fields)
        self.db.execute(f"UPDATE voice_batch_items SET {sets} WHERE batch_id=? AND idx=?", (*fields.values(), bid, idx))

    def recount(self, bid: str) -> dict[str, int]:
        r = self.db.query_one("SELECT SUM(state='done') AS d, SUM(state='failed') AS f FROM voice_batch_items "
                              "WHERE batch_id=?", (bid,))
        done, failed = int(r["d"] or 0), int(r["f"] or 0)
        self.set(bid, done=done, failed=failed)
        return {"done": done, "failed": failed}

    def delete(self, bid: str) -> None:
        with self.db.transaction():
            self.db.execute("DELETE FROM voice_batch_items WHERE batch_id=?", (bid,))
            self.db.execute("DELETE FROM voice_batches WHERE id=?", (bid,))

    def interrupted(self) -> list[str]:
        """batches a restart stopped: marked so (they can be resumed)"""
        ids = [r["id"] for r in self.db.query("SELECT id FROM voice_batches WHERE state IN ('queued','running')")]
        for bid in ids:
            self.set(bid, state="interrupted")
            self.db.execute("UPDATE voice_batch_items SET state='queued' WHERE batch_id=? AND state='running'", (bid,))
        return ids


class BatchRunner:
    """One batch at a time, its lines one by one (each through the GPU queue at background priority)."""

    def __init__(self, host: "VoiceHost", store: BatchStore) -> None:
        self.host = host
        self.store = store
        self._lock = asyncio.Lock()
        self._tasks: dict[str, asyncio.Task] = {}
        self._cancel: set[str] = set()

    def start(self, bid: str) -> None:
        if bid in self._tasks and not self._tasks[bid].done():
            return
        self._cancel.discard(bid)
        self._tasks[bid] = asyncio.create_task(self._run(bid))

    def running(self) -> list[str]:
        return [b for b, t in self._tasks.items() if not t.done()]

    def cancel(self, bid: str) -> bool:
        t = self._tasks.get(bid)
        if t is None or t.done():
            b = self.store.get(bid)
            if b and b["state"] in ("queued", "interrupted"):
                self.store.set(bid, state="cancelled", finished_at=now_iso())
                return True
            return False
        self._cancel.add(bid)
        return True

    async def close(self) -> None:
        for bid in self.running():
            self._cancel.add(bid)
        tasks = [t for t in self._tasks.values() if not t.done()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=10)

    async def _run(self, bid: str) -> None:
        from .service import BACKGROUND, VoiceError

        async with self._lock:  # (one batch at a time: two would only take turns on the GPU anyway)
            b = self.store.get(bid)
            if b is None or b["state"] == "cancelled":
                return
            self.store.set(bid, state="running", started_at=b.get("started_at") or now_iso(), error="")
            self.host.on_change(f"batch:{bid}")
            base = b["settings"]
            try:
                for item in self.store.items(bid):
                    if item["state"] in ("done", "skipped"):
                        continue
                    if bid in self._cancel:
                        break
                    over = item["overrides"]
                    self.store.set_item(bid, item["idx"], state="running", error="")
                    try:
                        entry = await self.host.generate(
                            model_id=over.get("model") or base.get("model_id") or "",
                            text=item["text"],
                            voice_id=self.host.voice_id_for(over.get("profile")) if over.get("profile")
                            else base.get("voice_id") or "",
                            feeling=over.get("feeling") or base.get("feeling") or "neutral",
                            mode=base.get("mode") or "auto",
                            language=over.get("language") or base.get("language") or "auto",
                            instruct=over.get("instruct") if "instruct" in over else base.get("instruct") or "",
                            params=base.get("params") or {},
                            seed=over.get("seed") if "seed" in over else base.get("seed"),
                            source="batch", batch_id=bid, batch_index=item["idx"], priority=BACKGROUND)
                        self.store.set_item(bid, item["idx"], state="done", history_id=entry["id"],
                                            seconds=entry.get("seconds"), rtf=entry.get("rtf"), seed=entry.get("seed"))
                    except VoiceError as e:
                        self.store.set_item(bid, item["idx"], state="failed", error=str(e)[:400])
                    except asyncio.CancelledError:
                        self.store.set_item(bid, item["idx"], state="queued")
                        raise
                    except Exception as e:  # noqa: BLE001 - one line must not stop the batch
                        log.exception("batch %s line %s", bid, item["idx"])
                        self.store.set_item(bid, item["idx"], state="failed", error=f"{type(e).__name__}: {e}"[:400])
                    self.store.recount(bid)
                    self.host.on_change(f"batch:{bid}")
                c = self.store.recount(bid)
                state = "cancelled" if bid in self._cancel else ("done" if c["failed"] == 0 else "done_with_errors")
                self.store.set(bid, state=state, finished_at=now_iso())
            except asyncio.CancelledError:
                self.store.set(bid, state="interrupted")
                raise
            except Exception as e:  # noqa: BLE001
                log.exception("batch %s", bid)
                self.store.set(bid, state="failed", error=f"{type(e).__name__}: {e}"[:400], finished_at=now_iso())
            finally:
                self._cancel.discard(bid)
                self.host.on_change(f"batch:{bid}")

    def zip_to(self, bid: str, dest: Path, fmt: str = "wav") -> Path:
        """the batch's lines in one ZIP: 0001_<text>.<fmt> … and manifest.json"""
        from . import audio

        b = self.store.get(bid, items=True)
        if b is None:
            raise KeyError("no such batch")
        manifest = {"id": bid, "label": b["label"], "created_at": b["created_at"], "settings": b["settings"], "lines": []}
        with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_STORED if fmt != "wav" else zipfile.ZIP_DEFLATED) as z:
            for it in b["items"]:
                rec = {"index": it["idx"] + 1, "text": it["text"], "state": it["state"], "error": it["error"],
                       "seconds": it["seconds"], "rtf": it["rtf"], "seed": it["seed"], **it["overrides"]}
                e = self.host.history.get(it["history_id"]) if it["history_id"] else None
                if e is not None and self.host.history.path(e).is_file():
                    name = f"{it['idx'] + 1:04d}_{_slug(it['text'])}.{fmt}"
                    z.writestr(name, audio.encode(self.host.history.path(e), fmt))
                    rec.update(file=name, model_id=e["model_id"], voice=e["voice_name"], feeling=e["feeling"],
                               clip=e["ref_label"])
                manifest["lines"].append(rec)
            z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1))
        return dest
