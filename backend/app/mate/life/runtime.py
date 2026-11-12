"""Keeps her day going on the real clock and gives everyone else one way in (docs/mate-life.md)."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Callable

from app.mate import affinity as A
from app.mate.life import sim
from app.mate.life.world import World

TICK_S = 60


def _prefs(raw: Any) -> dict[str, Any]:
    try:
        prefs = json.loads(raw or "{}")
    except ValueError:
        return {}
    return prefs if isinstance(prefs, dict) else {}


class LifeRuntime:
    def __init__(self, store: Any, log: Any = None, on_events: Callable[[str, list[dict[str, Any]]], None] | None = None,
                 wear: Callable[..., Any] | None = None) -> None:
        self.store = store
        self._log = log
        self.on_events = on_events  # (story events: how she takes them, and whether she writes first)
        self.wear = wear  # (what she has on goes the usual way, so every window follows)
        self.on_tick: Callable[[], None] | None = None  # (what else goes with the clock: her diary)
        self.world = World(store, log)  # (the weather where the user is, their public holidays)

    def _row(self, mate_id: str) -> Any:
        row = self.store._db.query_one("SELECT builtin, prefs, persona FROM mates WHERE id = ?", (mate_id,))
        if row is None:
            raise KeyError(f"mate not found: {mate_id}")
        return row

    def _bond(self, mate_id: str) -> tuple[float, str, list[dict[str, Any]]]:
        """How close they are, the stage they are at and the milestones they passed."""
        rel = self.store.relation_doc(mate_id) or A.new()
        if not rel.get("enabled"):
            return 0.33, "new", []
        return float(rel.get("affinity") or 0) / 100, str(rel.get("stage") or "new"), list(rel.get("milestones") or [])

    def _birthdays(self, row: Any) -> dict[str, str]:
        """Hers (her persona) and theirs (the app-wide settings): what she knows of the days that are theirs."""
        try:
            her = str((json.loads(row["persona"] or "{}") or {}).get("birthday") or "")
        except (ValueError, AttributeError):
            her = ""
        return {"her": her, "user": self.store.user_birthday()}

    def _played(self, mate_id: str, profile: dict[str, Any], now: datetime, tz: Any, birthdays: dict[str, str] | None = None
                ) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
        """Her day up to now. -> (doc, what showed before, what happened)."""
        doc = self.store.life_doc(mate_id, profile)
        if doc is None:
            doc = sim.new(profile, now, tz, mate_id)
            doc["birthdays"] = dict(birthdays or doc["birthdays"])
            return doc, {"signature": [], "slot": ""}, [{"type": "began"}]
        before = {"signature": sim.signature(doc), "slot": sim.slot((A._t(doc["at"]) or now).astimezone(tz))}
        closeness, stage, milestones = self._bond(mate_id)
        return doc, before, sim.advance(doc, profile, now, tz, closeness=closeness, stage=stage, milestones=milestones, birthdays=birthdays)

    #: why she changes, as she is told it, when the activity doesn't say (``wear_why``: {on, off}): for bed and back
    WEAR_WHY = {"on": "it's time for bed", "off": "the day has started"}

    def _dress(self, mate_id: str, doc: dict[str, Any], profile: dict[str, Any], happened: list[dict[str, Any]], prefs: dict[str, Any]) -> None:
        """She changes for what she does and back after: what an activity asks for (``wear``: pajamas for bed, her stream outfit
        to go live), from one such outfit straight into the next, unless they are with her or she doesn't change clothes
        herself. ``dressed_from``: what she had on before her day dressed her, what it put her in and for what. If someone
        changed her clothes meanwhile, those stay, and are what she comes back to."""
        started = [e for e in happened if e.get("type") == "started"]
        if not started or not self.wear or prefs.get("self_outfit") == "off" or doc.get("with_user"):
            return
        key = started[-1].get("activity")
        act = profile["activities"].get(key) or {}
        target = act.get("wear")
        came_from = doc.get("dressed_from")
        if not target and not came_from:
            return
        try:
            worn = self.store.get(mate_id)["outfits"]["worn"]
            if came_from and worn != came_from.get("into"):
                came_from = doc["dressed_from"] = None  # (someone changed her meanwhile: that is hers now)
            if target:
                if worn != target:
                    why = {**self.WEAR_WHY, **(act.get("wear_why") or {})}["on"]
                    self.wear(mate_id, target, reason=why)
                    doc["dressed_from"] = {"outfit": came_from["outfit"] if came_from else worn, "into": target, "for": key}
                return
            if not came_from:
                return
            doc["dressed_from"] = None
            was = (profile["activities"].get(came_from.get("for") or "") or {}).get("wear_why") or {}
            self.wear(mate_id, came_from.get("outfit"), reason={**self.WEAR_WHY, **was}["off"])
        except Exception as exc:  # noqa: BLE001 - nothing in her wardrobe is worth stopping her day for
            if self._log:
                self._log("warning", f"life: {mate_id}: {exc}")

    def advance(self, mate_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """Her day up to now, kept; every window hears when something shows. -> (doc, profile); None if she has no day."""
        row = self._row(mate_id)
        profile = self.store.life_profile(row["builtin"], _prefs(row["prefs"]))
        if profile is None:
            return None
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc, before, happened = self._played(mate_id, profile, now, tz, self._birthdays(row))
        self._dress(mate_id, doc, profile, happened, _prefs(row["prefs"]))
        self.store.save_life(mate_id, doc)
        # (story events, her birthday and theirs, what she gave them: how she takes them, whether she writes first)
        events = [e for e in happened if e.get("type") in ("event", "occasion", "gave")]
        if events and self.on_events:
            try:
                self.on_events(mate_id, events)
            except Exception as exc:  # noqa: BLE001 - what happened to her stands, whoever hears about it
                if self._log:
                    self._log("warning", f"life: {mate_id}: {exc}")
        if sim.signature(doc) != before["signature"] or sim.slot(now.astimezone(tz)) != before["slot"]:
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
            woke = sim.heard(doc, profile, said["id"], datetime.now(timezone.utc), warm=bool(cues["warm"]), rude=bool(cues["rude"]),
                             tz=self.store.tz())
            self.store.save_life(mate_id, doc)
            if sim.signature(doc) != before or woke:
                self.store._changed("life", mate_id)
        return doc, profile, woke

    def decide(self, mate_id: str, key: Any, *, with_user: bool = False, minutes: Any = None, why: str = "") -> dict[str, Any]:
        """She decided to go and do this (do_activity). -> what happened (sim.decide), and every window sees it."""
        played = self.advance(mate_id)
        if played is None:
            return {"code": "off"}
        doc, profile = played
        out = sim.decide(doc, profile, key, datetime.now(timezone.utc), self.store.tz(), with_user=with_user, minutes=minutes, why=why)
        if out["code"] in ("ok", "already"):
            self.store.save_life(mate_id, doc)
            self.store._changed("life", mate_id)
        return out

    def give(self, mate_id: str, item: Any) -> dict[str, Any]:
        """They send her something. -> {code, item, doc, profile}: how she takes it is for the service to bring to her."""
        played = self.advance(mate_id)
        if played is None:
            return {"code": "off"}
        doc, profile = played
        out = sim.give(doc, profile, item, datetime.now(timezone.utc), self.store.tz())
        if out["code"] == "ok":
            self.store.save_life(mate_id, doc)
            self.store._changed("life", mate_id)
        return {**out, "asleep": sim.asleep(doc, profile, datetime.now(timezone.utc))}

    def set_plan(self, mate_id: str, slot: Any, activity: Any) -> dict[str, Any]:
        played = self.advance(mate_id)
        if played is None:
            return {"enabled": False}
        doc, profile = played
        if not sim.set_plan(doc, profile, slot, activity):
            raise ValueError("no such slot or activity")
        self.store.save_life(mate_id, doc)
        return sim.view(doc, profile, datetime.now(timezone.utc), self.store.tz())

    def note(self, mate_id: str, text: str) -> None:
        """For her to hear with their next message."""
        played = self.advance(mate_id)
        if played is not None:
            sim.note(played[0], text, datetime.now(timezone.utc))
            self.store.save_life(mate_id, played[0])

    def take_notes(self, mate_id: str, doc: dict[str, Any]) -> list[str]:
        notes = sim.take_notes(doc, datetime.now(timezone.utc))
        if notes:
            self.store.save_life(mate_id, doc)
        return notes

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
            await self.world.refresh()
            self.tick()
            if self.on_tick:
                self.on_tick()
            await asyncio.sleep(TICK_S)
