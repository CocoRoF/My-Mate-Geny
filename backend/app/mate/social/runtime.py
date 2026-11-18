"""Keeps the user's mates' lives together going on the real clock (docs/mate-social.md), and is the one way in: who knows whom,
the plans they make and keep, what they did together, what each of them is told and what the user sees.

One document for all of them (``mate_settings`` key ``social``: social/ties.py), advanced once a minute with her day (the life
ticker). Plans move each one's own day (``sim.meet``); afterwards both remember it, each with a part of her own. A mate without a
day of her own still has friends: she is free in the daytime.
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from itertools import combinations
from typing import Any, Awaitable, Callable

from app.mate import affinity as A
from app.mate.life import sim
from app.mate.social import outings as O
from app.mate.social import ties as T
from app.mate.store import infer_gender
from app.services._ids import new_id

KEY = "social"
#: what she is told of what happened, and for how long it is news (older ones are only remembered)
NEWS_FOR, NEWS_AT_ONCE = timedelta(days=7), 3
#: a mate is told about a friend she names, or they name: this many recent things they did together
NAMED_RECENT = 3
#: a plan whose time has come while she is with the user in person: it waits this long, this many times, then is called off
POSTPONE, POSTPONES = timedelta(minutes=20), 3
STILL_TALKING = timedelta(minutes=20)
#: going out to meet, they set off this long before the time (from home, a call or a game online starts on the dot)
SET_OFF = timedelta(minutes=20)
#: after an outing, being with a friend does her good (on top of what they did)
COMPANY = {"affection": -0.12, "fun": -0.05}
#: a model writes what they remember of an outing in their own words (outings.compose is the fallback): only for mates someone
#: still talks to, and it may take this long before they are told
TALKED_WITHIN, NARRATE_WAIT = timedelta(days=7), timedelta(minutes=5)
DAILY_HOURS = (10, 21)  # (the hour of the day a pair's daily chances come up: seeded)
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def _norm(text: str) -> str:
    return re.sub(r"[\s\W_]+", "", str(text or "")).lower()


class SocialRuntime:
    def __init__(self, store: Any, life: Any, log: Any = None) -> None:
        self.store = store
        self.life = life
        self._log = log
        #: an event is final (a meeting, an introduction, a message, an outing): how each of them takes it, whether she writes first
        self.on_event: Callable[[dict[str, Any], dict[str, dict[str, Any]]], None] | None = None
        #: writes an outing in their own words: (event, {id: mate}) -> {text: str, own: {id: str}, lang} or None
        self.narrate: Callable[[dict[str, Any], dict[str, dict[str, Any]]], Awaitable[dict[str, Any] | None]] | None = None
        self._narrating: set[str] = set()

    # ---- the document ----

    def doc(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(timezone.utc)
        try:
            raw = json.loads(self.store._setting(KEY) or "null")
        except ValueError:
            raw = None
        return T.normalized(raw, now)

    def _save(self, doc: dict[str, Any]) -> None:
        self.store._put_setting(KEY, json.dumps(doc, ensure_ascii=False))

    def mates(self) -> dict[str, dict[str, Any]]:
        """Everyone who could have friends: {id: {id, name, builtin, gender, language, names, icon}} (no drafts)."""
        out = {}
        for r in self.store._db.query("SELECT id, name, builtin, persona, builtin_snapshot, icon FROM mates WHERE draft = 0 ORDER BY created_at"):
            try:
                persona = json.loads(r["persona"] or "{}") or {}
            except ValueError:
                persona = {}
            try:
                names = (json.loads(r["builtin_snapshot"] or "{}") or {}).get("names") or {}
            except ValueError:
                names = {}
            out[r["id"]] = {"id": r["id"], "name": r["name"] or "", "builtin": r["builtin"], "icon": r["icon"] or "",
                            "gender": persona.get("gender") or infer_gender(persona), "language": persona.get("language") or "ko",
                            "names": [n for n in [r["name"], *names.values()] if n]}
        return out

    def romance_fits(self, a: dict[str, Any], b: dict[str, Any]) -> bool:
        """A spark only where it is on (메이트 공통 설정) and between a man and a woman their personas say they are."""
        return self.store.social_romance() and {a.get("gender"), b.get("gender")} == {"female", "male"}

    # ---- the clock ----

    def tick(self, now: datetime | None = None) -> None:
        """A minute of their lives together; every window that shows it hears. (``now``: for tests.)"""
        if not self.store.social_on():
            return
        now, tz = now or datetime.now(timezone.utc), self.store.tz()
        doc = self.doc(now)
        before = json.dumps({**doc, "at": ""}, sort_keys=True)  # (nothing new this minute: nothing written)
        mates = self.mates()
        changed: set[str] = set()
        final: list[dict[str, Any]] = []
        T.drift(doc, now, tz)
        self._seed(doc, mates, now, changed)
        self._meet(doc, mates, now, tz, changed, final)
        self._messages(doc, mates, now, tz, changed, final)
        self._plan(doc, mates, now, tz, changed)
        self._run(doc, mates, now, tz, changed, final)
        self._ready_late(doc, now, final)
        if json.dumps({**doc, "at": ""}, sort_keys=True) != before:
            doc["at"] = A._iso(now)
            self._save(doc)
        for m in changed:
            self.store._changed("social", m)
        for e in final:
            self._final(e, mates)

    def _seed(self, doc: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, changed: set[str]) -> None:
        """Everyone is seen once; the built-in mates know each other from the start; a mate who is gone leaves nothing behind."""
        for gone in {m for t in doc["ties"].values() for m in (t["a"], t["b"])} - set(mates):
            T.forget(doc, gone)
        for mid in mates:
            doc["seen"].setdefault(mid, A._iso(now))
        by_key = {m["builtin"]: mid for mid, m in mates.items() if m.get("builtin")}
        for pair in O.builtin_pairs():
            x, y = pair["mates"]
            if x in by_key and y in by_key and T.tie_of(doc, by_key[x], by_key[y]) is None:
                a, b = by_key[x], by_key[y]
                T.make(doc, a, b, how="builtin", at=now, story=pair["story"], fond={a: pair["fond"][x], b: pair["fond"][y]},
                       close=float(pair["close"]))
                changed |= {a, b}

    def _daily(self, doc: dict[str, Any], what: str, k: str, local: datetime) -> bool:
        """A pair's chance of this, once a day at an hour of its own: whether it is that time (and it is then marked done)."""
        day = local.strftime("%Y-%m-%d")
        mark = f"{what}|{k}"
        if doc["checked"].get(mark) == day:
            return False
        hour = T.rng(doc, what, k, day).randint(*DAILY_HOURS)
        if local.hour < hour:
            return False
        doc["checked"][mark] = day
        return True

    def _event(self, doc: dict[str, Any], what: str, who: list[str], now: datetime, **extra: Any) -> dict[str, Any]:
        e = {"id": new_id("se_"), "type": what, "at": A._iso(now), "who": list(who), "told": {}, "ready": True, **extra}
        doc["events"] = [*doc["events"], e][-T.EVENTS_MAX:]
        return e

    def _meet(self, doc: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, tz: Any, changed: set[str],
              final: list[dict[str, Any]]) -> None:
        """Two who don't know each other yet may meet, over time (once both have been around a few days)."""
        local = now.astimezone(tz)
        for a, b in combinations(sorted(mates), 2):
            k = T.key(a, b)
            if T.tie_of(doc, a, b) is not None or not self._daily(doc, "meet", k, local):
                continue
            settled = min((now - (A._t(doc["seen"].get(m)) or now)).days for m in (a, b))
            rng = T.rng(doc, "meet", k, local.strftime("%Y-%m-%d"))
            if settled < O.SETTLE_DAYS or rng.random() >= O.MEET_DAY:
                continue
            first, second = rng.sample([a, b], 2)
            story = O.met_text(rng, mates[first], mates[second])
            T.make(doc, a, b, how="met", at=now, story=story)
            final.append(self._event(doc, "met", [first, second], now, text=story))
            changed |= {a, b}

    def _messages(self, doc: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, tz: Any, changed: set[str],
                  final: list[dict[str, Any]]) -> None:
        """Friends message each other now and then."""
        local = now.astimezone(tz)
        for k, tie in doc["ties"].items():
            if not self._daily(doc, "message", k, local):
                continue
            rng = T.rng(doc, "message", k, local.strftime("%Y-%m-%d"))
            if rng.random() >= O.message_chance(tie):
                continue
            first, second = rng.sample([tie["a"], tie["b"]], 2)
            T.bump(tie, now, "message", fond={tie["a"]: O.MESSAGE_FOND, tie["b"]: O.MESSAGE_FOND}, close=O.MESSAGE_CLOSE_UP)
            tie["last"] = A._iso(now)
            final.append(self._event(doc, "message", [first, second], now, text=O.message_text(rng, mates[first], mates[second])))
            changed |= {first, second}

    def _days(self, who: list[str]) -> dict[str, tuple[dict[str, Any], dict[str, Any]] | None]:
        """Each one's day up to now (None: she has none)."""
        out = {}
        for m in who:
            try:
                out[m] = self.life.advance(m)
            except Exception as exc:  # noqa: BLE001 - a day that can't be read is a day off for this
                if self._log:
                    self._log("warning", f"social: {m}: {exc}")
                out[m] = None
        return out

    def _plan(self, doc: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, tz: Any, changed: set[str]) -> None:
        """Friends make plans now and then, for time both of them have free."""
        local = now.astimezone(tz)
        if not O.PLAN_HOURS[0] <= local.hour < O.PLAN_HOURS[1]:
            return
        hour = local.strftime("%Y-%m-%d-%H")
        for k, tie in doc["ties"].items():
            mark = f"plan|{k}"
            if doc["checked"].get(mark) == hour:
                continue
            doc["checked"][mark] = hour
            a, b = tie["a"], tie["b"]
            if any(set(p["who"]) == {a, b} for p in doc["plans"]):
                continue
            last = A._t(tie.get("outing_at"))
            if last is not None and now - last < timedelta(days=O.GAP_DAYS) and not T.boosted(tie, now):
                continue
            rng = T.rng(doc, "plan", k, hour)
            if rng.random() >= O.plan_chance(tie, now):
                continue
            days = self._days([a, b])
            lives = [d for d in days.values() if d]
            sky = sim.weather(lives[0][0], local) if lives else "clear"
            kind = O.pick_kind(rng, [d[1] if d else None for d in days.values()], sky)
            if kind is None:
                continue
            busy = [(A._t(p["at"]), A._t(p["until"])) for p in doc["plans"] if {a, b} & set(p["who"])]

            def free(start: datetime, end: datetime, days: dict[str, Any] = days, busy: list[Any] = busy) -> bool:
                if any(s and e and s < end and e > start for s, e in busy):
                    return False
                for d in days.values():
                    if d is None:
                        if not (O.FREE_HOURS[0] <= start.hour and (end.hour < O.FREE_HOURS[1] or (end.hour == O.FREE_HOURS[1] and end.minute == 0))
                                and end.date() == start.date()):
                            return False
                    elif not sim.free_between(d[0], d[1], start, end, tz):
                        return False
                return True

            when = O.pick_time(rng, kind, local, free)
            if when is None:
                continue
            start, end = when
            plan = {"id": new_id("sp_"), "who": [a, b], "kind": kind["id"], "at": A._iso(start), "until": A._iso(end),
                    "status": "planned", "made": A._iso(now), "postponed": 0, "by": rng.choice([a, b])}
            doc["plans"] = [*doc["plans"], plan][-T.PLANS_MAX:]
            changed |= {a, b}
            if self._log:
                self._log("info", f"social: {mates[a]['name']} and {mates[b]['name']} made plans: {kind['id']} at {start.isoformat()}",
                          code="mate.social_plan", detail={"plan": plan["id"], "kind": kind["id"], "who": [a, b], "at": plan["at"]})

    def _run(self, doc: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, tz: Any, changed: set[str],
             final: list[dict[str, Any]]) -> None:
        for plan in list(doc["plans"]):
            start, end = A._t(plan["at"]), A._t(plan["until"])
            if start is None or end is None or any(m not in mates for m in plan["who"]) or plan["kind"] not in O.kinds():
                doc["plans"].remove(plan)
                continue
            remote = bool(O.kinds()[plan["kind"]].get("remote"))
            if plan["status"] == "planned" and now >= start - (timedelta(0) if remote else SET_OFF):
                if now >= end:  # (their whole time went by while nothing ran: it happened all the same)
                    self._finish(doc, plan, mates, now, tz, changed, final)
                    continue
                self._start(doc, plan, mates, now, tz, changed, final)
            if plan["status"] == "on" and now >= end:
                self._finish(doc, plan, mates, now, tz, changed, final)

    def _start(self, doc: dict[str, Any], plan: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, tz: Any,
               changed: set[str], final: list[dict[str, Any]]) -> None:
        """Their time has come: each one goes, unless she is asleep, or with the user in person (then it waits a little)."""
        days = self._days(plan["who"])
        for m, d in days.items():
            if d is None:
                continue
            ldoc, profile = d
            if sim.asleep(ldoc, profile, now):
                return self._call_off(doc, plan, m, "asleep", now, changed, final)
            heard = A._t(ldoc.get("heard_at"))
            if ldoc.get("with_user") and heard is not None and now - heard < STILL_TALKING:
                if int(plan.get("postponed") or 0) >= POSTPONES:
                    return self._call_off(doc, plan, m, "with_user", now, changed, final)
                plan["postponed"] = int(plan.get("postponed") or 0) + 1
                plan["at"] = A._iso(now + POSTPONE)
                return
        kind = O.kinds()[plan["kind"]]
        local = now.astimezone(tz)
        lives = [d for d in days.values() if d]
        if kind.get("outdoor") and lives and sim.weather(lives[0][0], local) in ("rain", "snow") and "cafe" in O.kinds():
            kind = O.kinds()["cafe"]  # (it rained: somewhere indoors instead)
            plan["kind"], plan["moved_in"] = kind["id"], True
        host = self._host(kind, days, plan.get("by"))
        end = A._t(plan["until"]) or now
        for m, d in days.items():
            if d is None:
                continue
            ldoc, profile = d
            other = next(x for x in plan["who"] if x != m)
            key = O.activity_for(kind, profile) or ("rest" if kind.get("remote") else sim.OUTING)
            friend = {"id": other, "name": mates[other]["name"], "outing": plan["id"], "kind": kind["id"], "names": dict(kind["names"]),
                      "body": kind.get("body") or ""}
            if key == sim.OUTING and host:
                friend |= {"place_names": host["place_names"], "art": host["art"], "outdoor": host["outdoor"]}
            sim.meet(ldoc, profile, key, end, now, tz, friend=friend)
            self.store.save_life(m, ldoc)
            self.store._changed("life", m)
        plan["status"] = "on"
        changed |= set(plan["who"])

    @staticmethod
    def _host(kind: dict[str, Any], days: dict[str, Any], by: str | None) -> dict[str, Any] | None:
        """Whose place they go to, for the one whose own day has nothing like it: the picture and names of it."""
        order = sorted(days, key=lambda m: m != by)
        for m in order:
            d = days[m]
            if d is None:
                continue
            profile = d[1]
            key = O.activity_for(kind, profile)
            if key is None:
                continue
            place = profile["activities"][key]["place"]
            return {"place_names": dict((profile["places"].get(place) or {}).get("names") or {}),
                    "art": {s: sim.art(profile, place, s) for s in ("morning", "day", "evening", "night")},
                    "outdoor": bool((profile["places"].get(place) or {}).get("outdoor"))}
        return None

    def _call_off(self, doc: dict[str, Any], plan: dict[str, Any], who: str, why: str, now: datetime, changed: set[str],
                  final: list[dict[str, Any]]) -> None:
        """She couldn't make it (asleep, or with the user): the other one is a little let down; both remember it."""
        doc["plans"].remove(plan)
        tie = T.tie_of(doc, *plan["who"])
        other = next(x for x in plan["who"] if x != who)
        if tie:
            T.bump(tie, now, f"called_off:{why}", fond={other: -1.0})
        final.append(self._event(doc, "called_off", plan["who"], now, kind=plan["kind"], by=who, why=why,
                                 names=dict(O.kinds()[plan["kind"]]["names"])))
        changed |= set(plan["who"])

    def _finish(self, doc: dict[str, Any], plan: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, tz: Any,
                changed: set[str], final: list[dict[str, Any]]) -> None:
        """It is over: how it went, what it did to them, what each of them remembers."""
        doc["plans"].remove(plan)
        a, b = plan["who"]
        tie = T.tie_of(doc, a, b)
        if tie is None:
            return
        kind = O.kinds()[plan["kind"]]
        rng = T.rng(doc, "went", plan["id"])
        days = self._days(plan["who"])
        stress = tuple(float(d[0]["needs"].get("stress") or 0) if d else 0.0 for d in days.values())
        what = O.mood(rng, tie, (stress[0], stress[1]))
        moved = O.settle(tie, rng, what, now, romance=self.romance_fits(mates[a], mates[b]))
        end = A._t(plan["until"]) or now
        tie["last"] = tie["outing_at"] = A._iso(min(end, now))
        tie["together"] = int(tie.get("together") or 0) + 1
        words = O.compose(rng, kind, what, mates[a], mates[b])
        e = self._event(doc, "outing", [a, b], A._t(plan["at"]) or now, kind=kind["id"], names=dict(kind["names"]), until=plan["until"],
                        mood=what, spark=sorted(moved["spark"]), moved_in=bool(plan.get("moved_in")), **words)
        if what in ("great", "awkward"):
            tie["highlights"] = [*tie["highlights"], e["id"]][-T.HIGHLIGHTS_MAX:]
        for m, d in days.items():
            if d is not None:
                sim.ease(d[0], {**COMPANY, "stress": -0.04 if what in ("great", "good") else 0.05})
                self.store.save_life(m, d[0])
        changed |= {a, b}
        try:
            loop = asyncio.get_running_loop() if self.narrate is not None and self._talked(days) else None
        except RuntimeError:
            loop = None
        if loop is not None:
            e["ready"] = False
            e["wait_until"] = A._iso(now + NARRATE_WAIT)
            self._narrating.add(e["id"])
            loop.create_task(self._narrate(e["id"], dict(e), {m: mates[m] for m in (a, b)}))
        else:
            final.append(e)
        if self._log:
            self._log("info", f"social: {mates[a]['name']} and {mates[b]['name']}: {kind['id']} ({what})", code="mate.social_outing",
                      detail={"event": e["id"], "kind": kind["id"], "mood": what, "who": [a, b]})

    @staticmethod
    def _talked(days: dict[str, Any]) -> bool:
        now = datetime.now(timezone.utc)
        return any(d and (A._t(d[0].get("heard_at")) or datetime.min.replace(tzinfo=timezone.utc)) > now - TALKED_WITHIN for d in days.values())

    async def _narrate(self, eid: str, event: dict[str, Any], mates: dict[str, dict[str, Any]]) -> None:
        """Their own words for it (a bounded model call); the outline stays if that fails."""
        words = None
        try:
            words = await self.narrate(event, mates) if self.narrate else None
        except Exception as exc:  # noqa: BLE001 - the outing happened all the same
            if self._log:
                self._log("warning", f"social: writing {eid}: {exc}")
        finally:
            self._narrating.discard(eid)
        doc = self.doc()
        e = next((x for x in doc["events"] if x["id"] == eid), None)
        if e is None or e.get("ready"):
            return
        if words and words.get("text"):
            lang = words.get("lang") or "ko"
            e["told_as"] = {"lang": lang, "text": words["text"], "own": {m: str(v) for m, v in (words.get("own") or {}).items() if m in e["who"]}}
        e["ready"] = True
        self._save(doc)
        for m in e["who"]:
            self.store._changed("social", m)
        self._final(e, self.mates())

    def _ready_late(self, doc: dict[str, Any], now: datetime, final: list[dict[str, Any]]) -> None:
        """An outing whose writing never came back (a restart in between): told as it is."""
        for e in doc["events"]:
            if not e.get("ready") and e["id"] not in self._narrating and now >= (A._t(e.get("wait_until")) or now):
                e["ready"] = True
                final.append(e)

    def _final(self, e: dict[str, Any], mates: dict[str, dict[str, Any]]) -> None:
        if self.on_event is None:
            return
        try:
            self.on_event(e, mates)
        except Exception as exc:  # noqa: BLE001 - what happened stands, whoever hears about it
            if self._log:
                self._log("warning", f"social: {e.get('id')}: {exc}")

    # ---- what she does ----

    def find(self, mate_id: str, name: str) -> dict[str, Any] | None:
        """Another mate of theirs by the name the user used (or one of hers)."""
        want = _norm(name)
        if not want:
            return None
        others = [m for mid, m in self.mates().items() if mid != mate_id]
        for exact in (True, False):
            for m in others:
                keys = [_norm(n) for n in m["names"] if _norm(n)]
                if any(k == want if exact else (want in k or k in want) and min(len(k), len(want)) >= 2 for k in keys):
                    return m
        return None

    def introduce(self, mate_id: str, name: Any, note: Any = "") -> dict[str, Any]:
        """The user introduced another of their mates to her (introduce_friend). -> {code: ok | known | unknown | off, name, stage}."""
        if not self.store.social_on():
            return {"code": "off"}
        target = self.find(mate_id, str(name or ""))
        if target is None:
            return {"code": "unknown"}
        now = datetime.now(timezone.utc)
        doc = self.doc(now)
        tie = T.tie_of(doc, mate_id, target["id"])
        if tie is not None:
            return {"code": "known", "name": target["name"], "stage": T.stage(tie)}
        note = " ".join(str(note or "").split())[:200]
        tie = T.make(doc, mate_id, target["id"], how="introduced", at=now,
                     story={"ko": "내 소개로 알게 된 사이예요.", "en": "They met through you."})
        T.boost(tie, now)
        e = self._event(doc, "introduced", [mate_id, target["id"]], now, note=note)
        e["told"][mate_id] = True  # (she was there)
        self._save(doc)
        self.store._changed("social", mate_id)
        self.store._changed("social", target["id"])
        self._final(e, self.mates())
        return {"code": "ok", "name": target["name"], "stage": T.stage(tie)}

    def forget(self, mate_id: str) -> None:
        """Her memory was wiped (or she is gone): her ties, plans and shared moments go; a built-in one knows her friends again at once."""
        doc = self.doc()
        T.forget(doc, mate_id)
        self._save(doc)

    # ---- what she is told ----

    def prompt(self, mate_id: str) -> str:
        """The people in her life who are also the user's mates, for her system prompt: who they are to her and how they met."""
        if not self.store.social_on():
            return ""
        doc, mates = self.doc(), self.mates()
        if mate_id not in mates:
            return ""
        me = mates[mate_id]
        lines, sparks = [], []
        for tie in sorted(T.ties_of(doc, mate_id), key=lambda t: -t["close"]):
            o = T.other(tie, mate_id)
            if o not in mates:
                continue
            name = mates[o]["name"]
            how = "The user introduced you." if tie["how"] == "introduced" else (tie.get("story") or {}).get("en") or ""
            lines.append(f"- {name}: {T.STAGE_WORDS[T.stage(tie)]}; you {T.fond_word(tie['fond'][mate_id])}."
                         + (f" How you know each other: {how}" if how else ""))
            if self.romance_fits(me, mates[o]):
                s = T.spark(tie, mate_id)
                if s == "crush":
                    sparks.append(f"- You have a quiet crush on {name} lately. It is innocent and it is yours: you may go a little shy when "
                                  f"{name} comes up, and you don't tell anyone unless you really would.")
                elif s == "mutual":
                    sparks.append(f"- You and {name} have something going on lately (썸): a few sparks, nothing settled, both a bit shy about it.")
        if not lines:
            return ""
        return ("## People in your life\nSome people you know are also close to the user. They are real in your story, with lives of "
                "their own. How things are with each:\n" + "\n".join(lines) + "\n"
                "- You know what you did together and what they told you. What they do with the user, or anything else in their day, you "
                "only know if the user or they tell you. Your <context> says what you two did lately: keep to it and never make up an "
                "outing that isn't there; small everyday things between friends are fine.\n"
                "- Bring them up when it fits, as you would a friend: tell the user what you two did, ask after them, suggest the user "
                "meets them. No jealousy over the user's time with them, and never compare it with your own.\n"
                + ("\n".join(sparks) + "\n- It stays innocent: nothing sexual, and it never makes you cold to the user.\n" if sparks else "")
                + "- When the user introduces someone else they know to you, or says you two should meet, call introduce_friend with the name.")

    def lines(self, mate_id: str, query: str = "", *, day_of_her_own: bool = False) -> tuple[list[str], Callable[[], None]]:
        """What she is told with this message: news (what happened with whom, not told yet), her plans, and what she remembers with a
        friend named in the message. -> (lines, acknowledge: what was told is marked told). ``day_of_her_own``: her day says
        already who she is out with."""
        if not self.store.social_on():
            return [], lambda: None
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc, mates = self.doc(now), self.mates()
        if mate_id not in mates:
            return [], lambda: None
        local = now.astimezone(tz)
        out: list[str] = []
        told: list[str] = []
        fresh = [e for e in doc["events"] if mate_id in e["who"] and e.get("ready") and not e["told"].get(mate_id)]
        for e in fresh:
            if now - (A._t(e.get("until") or e["at"]) or now) > NEWS_FOR:
                told.append(e["id"])  # (too old to be news: only remembered)
        news = [e for e in fresh if e["id"] not in told][-NEWS_AT_ONCE:]
        for e in news:
            line = self._said(e, mate_id, mates, now)
            if line:
                out.append(line)
            told.append(e["id"])
        for plan in sorted(doc["plans"], key=lambda p: p["at"]):
            if mate_id not in plan["who"]:
                continue
            o = next(x for x in plan["who"] if x != mate_id)
            if plan["status"] == "on":
                if not day_of_her_own:
                    out.append(f"Right now you are out with {mates[o]['name']} "
                               f"({O.kinds().get(plan['kind'], {}).get('names', {}).get('en', 'out').lower()}), as you two planned.")
                continue
            when = (A._t(plan["at"]) or now).astimezone(tz)
            day = ("today" if when.date() == local.date() else "tomorrow" if when.date() == (local + timedelta(days=1)).date()
                   else WEEKDAYS[when.weekday()])
            out.append(f"Plans: {day} at {when.strftime('%H:%M')} you and {mates[o]['name']} are meeting "
                       f"({O.kinds().get(plan['kind'], {}).get('names', {}).get('en', 'out').lower()}).")
        if query and not query.startswith("<"):
            said = _norm(query)
            for tie in T.ties_of(doc, mate_id):
                o = T.other(tie, mate_id)
                if o not in mates or not any(len(_norm(n)) >= 2 and _norm(n) in said for n in mates[o]["names"]):
                    continue
                past = [e for e in T.recent(doc, mate_id, o, limit=NAMED_RECENT + len(news)) if e["id"] not in {x["id"] for x in news}
                        and e["type"] in ("outing", "message", "called_off")][:NAMED_RECENT]
                if past:
                    out.append(f"What you remember with {mates[o]['name']} lately: "
                               + " ".join(self._said(e, mate_id, mates, now, news=False) for e in reversed(past)))

        def acknowledge() -> None:
            if not told:
                return
            d = self.doc()
            for e in d["events"]:
                if e["id"] in told:
                    e["told"][mate_id] = True
            self._save(d)
        return out, acknowledge

    @staticmethod
    def _ago(at: datetime, now: datetime) -> str:
        hours = (now - at).total_seconds() / 3600
        return ("Just now" if hours < 1 else "Earlier today" if hours < 12 else "Yesterday or so" if hours < 36
                else f"About {max(2, round(hours / 24))} days ago")

    def _said(self, e: dict[str, Any], me: str, mates: dict[str, dict[str, Any]], now: datetime, *, news: bool = True) -> str:
        """One thing that happened, as she is told it: what both know, what only she knows, how it went."""
        o = next((x for x in e["who"] if x != me), "")
        name = mates.get(o, {}).get("name") or "a friend"
        ago = self._ago(A._t(e.get("until") or e["at"]) or now, now)
        kind = e.get("type")
        if kind == "met":
            return f"{ago}: you got to know {name}. {(e.get('text') or {}).get('en', '')}".strip()
        if kind == "introduced":
            if e["who"][0] == me:
                return f"{ago}: the user introduced you to {name}." + (f" They said: “{e['note']}”" if e.get("note") else "")
            return (f"{ago}: the user told {name} about you, and now you two know of each other; you might meet soon."
                    + (f" (What they said to {name}: “{e['note']}”)" if e.get("note") else ""))
        if kind == "message":
            return f"{ago}: {(e.get('text') or {}).get('en', '')}".strip()
        if kind == "called_off":
            what = (e.get("names") or {}).get("en", "plans").lower()
            if e.get("by") == me:
                return f"{ago}: you missed your plans with {name} ({what}) — " + ("you overslept." if e.get("why") == "asleep" else "you were with the user.")
            return f"{ago}: {name} couldn't make your plans ({what}); it was called off."
        as_told = e.get("told_as") or {}
        if as_told.get("text"):
            told, own = as_told["text"], (as_told.get("own") or {}).get(me, "")
        else:
            told, own = (e.get("text") or {}).get("en", ""), ((e.get("own") or {}).get(me) or {}).get("en", "")
        how = {"great": "It went really well.", "good": "It was nice.", "okay": "It was alright.", "awkward": "It got a bit awkward between you."}.get(e.get("mood") or "", "")
        return (f"{ago}{' (news)' if news else ''}: you and {name} — {told}" + (f" Only you know: {own}" if own else "") + f" {how}").strip()

    # ---- what the user sees ----

    def view(self, mate_id: str) -> dict[str, Any]:
        """Her side of it, for the ♥ status window: who she knows and how, the plans she has, what she did with whom."""
        on, romance = self.store.social_on(), self.store.social_romance()
        if not on:
            return {"enabled": False, "romance": romance, "ties": [], "events": [], "plans": []}
        now = datetime.now(timezone.utc)
        doc, mates = self.doc(now), self.mates()
        ties = []
        for tie in sorted(T.ties_of(doc, mate_id), key=lambda t: (-t["close"], t["since"])):
            o = T.other(tie, mate_id)
            if o not in mates:
                continue
            fits = mate_id in mates and self.romance_fits(mates[mate_id], mates[o])
            ties.append({"id": o, "name": mates[o]["name"], "icon": mates[o]["icon"], "stage": T.stage(tie), "how": tie["how"],
                         "since": tie["since"], "story": dict(tie.get("story") or {}), "fond": round(tie["fond"][mate_id], 1),
                         "fond_back": round(tie["fond"][o], 1), "close": round(tie["close"], 1), "together": tie["together"],
                         "last": tie.get("last"), "spark": T.spark(tie, mate_id) if fits else "none"})
        plans = [{"id": p["id"], "with": next(x for x in p["who"] if x != mate_id), "kind": p["kind"],
                  "names": dict(O.kinds().get(p["kind"], {}).get("names") or {}), "at": p["at"], "until": p["until"], "status": p["status"]}
                 for p in sorted(doc["plans"], key=lambda p: p["at"]) if mate_id in p["who"]]
        events = []
        for e in reversed(doc["events"]):
            if mate_id not in e["who"] or not e.get("ready"):
                continue
            o = next((x for x in e["who"] if x != mate_id), "")
            as_told = e.get("told_as") or {}
            events.append({"id": e["id"], "type": e["type"], "at": e["at"], "until": e.get("until"), "with": o,
                           "with_name": mates.get(o, {}).get("name") or "", "kind": e.get("kind"), "names": dict(e.get("names") or {}),
                           "mood": e.get("mood"), "text": ({as_told.get("lang") or "ko": as_told["text"]} if as_told.get("text") else dict(e.get("text") or {})),
                           "own": ({as_told.get("lang") or "ko": as_told.get("own", {}).get(mate_id, "")} if as_told.get("text")
                                   else dict((e.get("own") or {}).get(mate_id) or {})),
                           "mood_line": dict(e.get("mood_line") or {}), "note": e.get("note") or "",
                           "by": e.get("by"), "why": e.get("why"), "first": bool(e["who"] and e["who"][0] == mate_id),
                           "spark": bool(romance and mate_id in (e.get("spark") or []))})
            if len(events) >= 40:
                break
        return {"enabled": True, "romance": romance, "ties": ties, "plans": plans, "events": events}

    def day_lines(self, mate_id: str, day_start: datetime, day_end: datetime) -> list[str]:
        """What she did with friends that day, for her diary."""
        doc, mates = self.doc(), self.mates()
        out = []
        for e in doc["events"]:
            at = A._t(e.get("at"))
            if mate_id in e["who"] and e["type"] == "outing" and at and day_start <= at < day_end:
                o = next((x for x in e["who"] if x != mate_id), "")
                as_told = e.get("told_as") or {}
                text = as_told.get("text") or (e.get("text") or {}).get("ko") or ""
                own = (as_told.get("own") or {}).get(mate_id) or ((e.get("own") or {}).get(mate_id) or {}).get("ko") or ""
                out.append(f"{mates.get(o, {}).get('name', '')}: {text} {own}".strip())
        return out
