"""Keeps her day going on the real clock and gives everyone else one way in (docs/mate-life.md)."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

from app.mate import affinity as A
from app.mate.life import sim

TICK_S = 60


def _prefs(raw: Any) -> dict[str, Any]:
    try:
        prefs = json.loads(raw or "{}")
    except ValueError:
        return {}
    return prefs if isinstance(prefs, dict) else {}


class LifeRuntime:
    def __init__(self, store: Any, log: Any = None) -> None:
        self.store = store
        self._log = log

    def _row(self, mate_id: str) -> Any:
        row = self.store._db.query_one("SELECT builtin, prefs FROM mates WHERE id = ?", (mate_id,))
        if row is None:
            raise KeyError(f"mate not found: {mate_id}")
        return row

    def _closeness(self, mate_id: str) -> float:
        rel = self.store.relation_doc(mate_id) or A.new()
        return float(rel.get("affinity") or 0) / 100 if rel.get("enabled") else 0.33

    def _played(self, mate_id: str, profile: dict[str, Any], now: datetime, tz: Any) -> tuple[dict[str, Any], list[Any], list[dict[str, Any]]]:
        """Her day up to now. -> (doc, what she was told last, what happened)."""
        doc = self.store.life_doc(mate_id, profile)
        if doc is None:
            doc = sim.new(profile, now, tz, mate_id)
            return doc, [], [{"type": "began"}]
        before = sim.signature(doc)
        return doc, before, sim.advance(doc, profile, now, tz, closeness=self._closeness(mate_id))

    def advance(self, mate_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """Her day up to now, kept; every window hears when something shows. -> (doc, profile); None if she has no day."""
        row = self._row(mate_id)
        profile = self.store.life_profile(row["builtin"], _prefs(row["prefs"]))
        if profile is None:
            return None
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc, before, _ = self._played(mate_id, profile, now, tz)
        self.store.save_life(mate_id, doc)
        if sim.signature(doc) != before:
            self.store._changed("life", mate_id)
        return doc, profile

    def hear(self, mate_id: str, said: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any], bool] | None:
        """Her day up to now, with this message of theirs in it. -> (doc, profile, whether it just woke her); None if she has no day."""
        played = self.advance(mate_id)
        if played is None:
            return None
        doc, profile = played
        woke = False
        if said and said.get("id"):
            before = sim.signature(doc)
            cues = A.cues((said.get("content") or "").strip())
            woke = sim.heard(doc, profile, said["id"], datetime.now(timezone.utc), warm=bool(cues["warm"]), rude=bool(cues["rude"]))
            self.store.save_life(mate_id, doc)
            if sim.signature(doc) != before or woke:
                self.store._changed("life", mate_id)
        return doc, profile, woke

    def view(self, mate_id: str) -> dict[str, Any]:
        played = self.advance(mate_id)
        if played is None:
            return {"enabled": False}
        return sim.view(played[0], played[1], datetime.now(timezone.utc), self.store.tz())

    def tick(self) -> None:
        """Every mate who has a day."""
        for row in self.store._db.query("SELECT id FROM mates WHERE draft = 0"):
            try:
                self.advance(row["id"])
            except Exception as exc:  # noqa: BLE001 - one bad document never stops the clock of the others
                if self._log:
                    self._log("warning", f"life: {row['id']}: {exc}")

    async def run(self) -> None:
        while True:
            self.tick()
            await asyncio.sleep(TICK_S)
