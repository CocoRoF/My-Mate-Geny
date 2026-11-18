"""The user's mates among themselves (docs/mate-social.md): the one way in, and what keeps it going on the real clock.

- Nobody is set up to know anybody. Each mate knows that the user talks with other mates too; she knows of one when the user tells
  her about them (``introduce_friend``), and knows her once they have talked.
- They talk by messaging each other: when the user asks her to (``talk_to_mate``), or on her own now and then when she may reach
  out on her own (her 스스로 말 걸기). Each message is hers, from her own engine (``speak``: social/talk.py); a few messages, and
  either ends it. What the other says moves how she feels about them — the same engine as with the user (social/bonds.py), never
  warmer than with the user.
- Their conversations are theirs: the user can read them in the ♥ status window's 관계 tab, and when they do, both of them know
  the user read what they wrote to each other.
- Once they are friends they now and then go out together (social/outings.py, each in her own day: ``sim.meet``).

One document for all of them (``mate_settings`` key ``social``), advanced once a minute with her day (the life ticker).
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from app.mate import affinity as A
from app.mate.life import sim
from app.mate.social import bonds as B
from app.mate.social import outings as O
from app.mate.social import talk as K
from app.mate.store import infer_gender
from app.services._ids import new_id

KEY = "social"
#: what she is told of what happened, and for how long it is news (older ones are only remembered)
NEWS_FOR, NEWS_AT_ONCE = timedelta(days=7), 3
#: of a conversation, the last messages she is told (all of it is in the 관계 tab)
TOLD_LINES = 6
#: a friend she or the user names: this many recent things with them
NAMED_RECENT = 2
#: that the user talks with other mates too: who, if lately
USER_TALKED_WITHIN = timedelta(days=7)
#: reaching out on her own (her 스스로 말 걸기): a chance per waking hour; at most one a day each, one a pair in two days, a few
#: a day in all; only for a mate someone still talks to
OWN_HOUR, OWN_HOURS, OWN_PAIR_GAP, OWN_A_DAY = 0.025, (10, 22), timedelta(days=2), 4
TALKED_WITHIN = timedelta(days=7)
#: a plan whose time has come while she is with the user in person: it waits this long, this many times, then is called off
POSTPONE, POSTPONES = timedelta(minutes=20), 3
STILL_TALKING = timedelta(minutes=20)
SET_OFF = timedelta(minutes=20)
COMPANY = {"affection": -0.12, "fun": -0.05}
NARRATE_WAIT = timedelta(minutes=5)
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def _norm(text: str) -> str:
    return re.sub(r"[\s\W_]+", "", str(text or "")).lower()


class SocialRuntime:
    def __init__(self, store: Any, life: Any, log: Any = None) -> None:
        self.store = store
        self.life = life
        self._log = log
        #: one message of hers to another mate: (her mate document, system prompt, content) -> the text (social/talk.py)
        self.speak: Callable[[dict[str, Any], str, str], Awaitable[str]] | None = None
        #: something is final (a conversation over, an outing, the user read their messages): how each takes it, whether she
        #: writes first, whether she reports back to the user who asked
        self.on_event: Callable[[dict[str, Any], dict[str, dict[str, Any]]], None] | None = None
        #: what two friends remember of an outing, in their own words: (event, {id: mate}) -> {text, own, lang} | None
        self.narrate: Callable[[dict[str, Any], dict[str, dict[str, Any]]], Awaitable[dict[str, Any] | None]] | None = None
        self._queue: list[str] = []
        self._running = False
        self._narrating: set[str] = set()

    # ---- the document ----

    def doc(self, now: datetime | None = None) -> dict[str, Any]:
        try:
            raw = json.loads(self.store._setting(KEY) or "null")
        except ValueError:
            raw = None
        return B.normalized(raw, now or datetime.now(timezone.utc))

    def _save(self, doc: dict[str, Any]) -> None:
        self.store._put_setting(KEY, json.dumps(doc, ensure_ascii=False))

    def mates(self) -> dict[str, dict[str, Any]]:
        """Everyone who could know someone: {id: {id, name, builtin, gender, language, names, icon, session_id, prefs}}."""
        out = {}
        for r in self.store._db.query("SELECT id, name, builtin, persona, builtin_snapshot, icon, session_id, prefs FROM mates "
                                      "WHERE draft = 0 ORDER BY created_at"):
            try:
                persona = json.loads(r["persona"] or "{}") or {}
            except ValueError:
                persona = {}
            try:
                names = (json.loads(r["builtin_snapshot"] or "{}") or {}).get("names") or {}
            except ValueError:
                names = {}
            try:
                prefs = json.loads(r["prefs"] or "{}") or {}
            except ValueError:
                prefs = {}
            out[r["id"]] = {"id": r["id"], "name": r["name"] or "", "builtin": r["builtin"], "icon": r["icon"] or "",
                            "gender": persona.get("gender") or infer_gender(persona), "language": persona.get("language") or "ko",
                            "names": [n for n in [r["name"], *names.values()] if n], "session_id": r["session_id"],
                            "proactive": bool((prefs.get("proactive") or {}).get("enabled"))}
        return out

    def user_rel(self, mate_id: str) -> dict[str, Any] | None:
        """How she feels about the user: what she may feel for another mate stays below it."""
        return self.store.relation_doc(mate_id)

    def romance_fits(self, a: dict[str, Any], b: dict[str, Any]) -> bool:
        """Romance between two mates only where it is on (메이트 공통 설정) and between a man and a woman their personas say they are."""
        return self.store.social_romance() and {a.get("gender"), b.get("gender")} == {"female", "male"}

    def _event(self, doc: dict[str, Any], what: str, who: list[str], now: datetime, **extra: Any) -> dict[str, Any]:
        e = {"id": new_id("se_"), "type": what, "at": A._iso(now), "who": list(who), "told": {}, "ready": True, **extra}
        doc["events"] = [*doc["events"], e][-B.EVENTS_MAX:]
        return e

    # ---- the clock ----

    def tick(self, now: datetime | None = None) -> None:
        """A minute of their lives together; every window that shows it hears. (``now``: for tests.)"""
        if not self.store.social_on():
            return
        now, tz = now or datetime.now(timezone.utc), self.store.tz()
        doc = self.doc(now)
        before = json.dumps({**doc, "at": ""}, sort_keys=True)
        mates = self.mates()
        changed: set[str] = set()
        final: list[dict[str, Any]] = []
        for gone in {m for row in (doc["known"], doc["rel"]) for m in [*row, *[o for r in row.values() for o in r]]} - set(mates):
            B.forget(doc, gone)
        local = now.astimezone(tz)
        if doc["checked"].get("drift") != local.strftime("%Y-%m-%d"):
            doc["checked"]["drift"] = local.strftime("%Y-%m-%d")
            B.drift(doc, now, tz, {m: self.user_rel(m) for m in doc["rel"]})
        self._own(doc, mates, now, tz)
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
        self._kick()

    # ---- talking to each other ----

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
        """The user told her about another of their mates (introduce_friend): she knows of them from now on. The other one
        doesn't know of it. -> {code: ok | known | unknown | off, name}."""
        if not self.store.social_on():
            return {"code": "off"}
        target = self.find(mate_id, str(name or ""))
        if target is None:
            return {"code": "unknown"}
        now = datetime.now(timezone.utc)
        doc = self.doc(now)
        note = " ".join(str(note or "").split())[:200]
        known = B.knows(doc, mate_id, target["id"])
        B.know(doc, mate_id, target["id"], "told", now, note)
        self._save(doc)
        self.store._changed("social", mate_id)
        return {"code": "known" if known else "ok", "name": target["name"]}

    def talk_to(self, mate_id: str, name: Any, text: Any, *, why: str = "asked", asked: str = "") -> dict[str, Any]:
        """She messages another mate (talk_to_mate: the user asked her to, or she decided to): her first message, then the
        conversation goes on in the background and she hears how it went. -> {code: ok | busy | unknown | off | empty, name}."""
        if not self.store.social_on():
            return {"code": "off"}
        target = self.find(mate_id, str(name or ""))
        if target is None:
            return {"code": "unknown"}
        text = " ".join(str(text or "").split())[:K.MAX_CHARS]
        if not text:
            return {"code": "empty"}
        now = datetime.now(timezone.utc)
        doc = self.doc(now)
        if any(t["status"] == "on" and mate_id in t["who"] and target["id"] in t["who"] for t in doc["threads"]):
            return {"code": "busy", "name": target["name"]}
        B.know(doc, mate_id, target["id"], "told", now)
        t = self._thread(doc, mate_id, target["id"], why, now, asked=asked)
        t["messages"].append({"by": mate_id, "text": text, "at": A._iso(now)})
        self._save(doc)
        self._queue.append(t["id"])
        self._kick()
        for m in t["who"]:
            self.store._changed("social", m)
        return {"code": "ok", "name": target["name"], "thread": t["id"]}

    def _thread(self, doc: dict[str, Any], a: str, b: str, why: str, now: datetime, asked: str = "") -> dict[str, Any]:
        t = {"id": new_id("st_"), "who": [a, b], "by": a, "why": why, "asked": asked[:200], "at": A._iso(now), "messages": [],
             "status": "on", "seen": 0, "told": {}}
        doc["threads"] = [*doc["threads"], t][-B.THREADS_MAX:]
        return t

    def _kick(self) -> None:
        """Conversations go one at a time, in the background."""
        if self._running or not self._queue or self.speak is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._running = True
        loop.create_task(self._drain())

    async def _drain(self) -> None:
        try:
            while self._queue:
                tid = self._queue.pop(0)
                try:
                    await self.converse(tid)
                except Exception as exc:  # noqa: BLE001 - one conversation that went wrong never stops the others
                    if self._log:
                        self._log("warning", f"social: conversation {tid}: {exc}")
        finally:
            self._running = False

    async def converse(self, tid: str) -> None:
        """Their conversation, a message at a time, until one of them ends it (or it is long enough)."""
        mates = self.mates()
        tz = self.store.tz()
        while True:
            doc = self.doc()
            t = next((x for x in doc["threads"] if x["id"] == tid), None)
            if t is None or t["status"] != "on":
                return
            if any(m not in mates for m in t["who"]):
                t["status"] = "failed"
                self._save(doc)
                return
            msgs = t["messages"]
            speaker = t["by"] if not msgs else next(x for x in t["who"] if x != msgs[-1]["by"])
            listener = next(x for x in t["who"] if x != speaker)
            text, ended = ("", True) if len(msgs) >= K.MAX_MESSAGES else await self._speak(doc, t, speaker, listener, mates)
            doc = self.doc()  # (it may have moved while she was writing)
            t = next((x for x in doc["threads"] if x["id"] == tid), None)
            if t is None:
                return
            now = datetime.now(timezone.utc)
            if text is None:  # (her engine couldn't: it ends where it is)
                t["status"] = "failed" if not t["messages"] else "done"
            else:
                if t["messages"]:  # (what the other said moves how she feels about them, her answer with it)
                    last = t["messages"][-1]
                    B.heard(doc, speaker, listener, last["text"], text, now, tz, user_rel=self.user_rel(speaker),
                            name=mates[speaker]["name"], romance=self.romance_fits(mates[speaker], mates[listener]))
                if text:
                    t["messages"].append({"by": speaker, "text": text, "at": A._iso(now)})
                    for m in t["who"]:
                        B.know(doc, m, next(x for x in t["who"] if x != m), "talked", now)
                if ended or len(t["messages"]) >= K.MAX_MESSAGES:
                    if text and not ended:  # (the last word stays with the other one, unanswered)
                        B.heard(doc, listener, speaker, text, "", now, tz, user_rel=self.user_rel(listener),
                                name=mates[listener]["name"], romance=self.romance_fits(mates[listener], mates[speaker]))
                    t["status"] = "done"
            t["at_end"] = A._iso(now) if t["status"] != "on" else None
            self._save(doc)
            for m in t["who"]:
                self.store._changed("social", m)
            if t["status"] == "done" and not t["messages"]:
                t["status"] = "failed"  # (nothing was said)
                self._save(doc)
            if t["status"] != "on":
                if self._log:
                    self._log("info", f"social: {mates[t['who'][0]]['name']} and {mates[t['who'][1]]['name']} talked "
                              f"({len(t['messages'])} messages, {t['why']})", code="mate.social_talk",
                              detail={"thread": t["id"], "who": t["who"], "messages": len(t["messages"]), "why": t["why"]})
                if t["status"] == "done":
                    self._final({**t, "type": "talk"}, mates)
                return

    async def _speak(self, doc: dict[str, Any], t: dict[str, Any], me: str, other: str, mates: dict[str, dict[str, Any]]
                     ) -> tuple[str | None, bool]:
        """Her next message (social/talk.py), from her own engine. -> (text, ended); (None, True) when it couldn't."""
        if self.speak is None:
            return None, True
        try:
            mate = self.store.get(me)
        except KeyError:
            return None, True
        k = B.knows(doc, me, other) or {"how": "told", "note": ""}
        names = {m: mates[m]["name"] for m in t["who"]}
        lang = K.LANG_NAMES.get(mates[me]["language"], "Korean")
        system = K.system(mate, mates[other]["name"], how=k["how"], note=k.get("note") or "",
                          feeling=B.words(B.rel_of(doc, me, other)), romance=self.romance_fits(mates[me], mates[other])
                          ).replace("{language}", lang)
        now = datetime.now(timezone.utc)
        day = ""
        try:
            played = self.life.advance(me)
            if played is not None:
                day = sim.line(played[0], played[1], now, self.store.tz(), lang=mates[me]["language"])[:600]
        except Exception:  # noqa: BLE001 - her day is only colour here
            day = ""
        try:
            raw = await self.speak(mate, system, K.content(t, me, names, why=K.why_words(t, me, names), now=now.astimezone(self.store.tz()), day=day))
        except Exception as exc:  # noqa: BLE001
            if self._log:
                self._log("warning", f"social: {mates[me]['name']} couldn't write to {mates[other]['name']}: {exc}")
            return None, True
        return K.clean(raw, mates[me]["name"])

    def _own(self, doc: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, tz: Any) -> None:
        """Now and then, a mate who may reach out on her own messages another mate: one she knows, or one the user talks with
        too. She writes the first message herself."""
        local = now.astimezone(tz)
        if not OWN_HOURS[0] <= local.hour < OWN_HOURS[1] or self.speak is None:
            return
        hour, today = local.strftime("%Y-%m-%d-%H"), local.strftime("%Y-%m-%d")
        if doc["checked"].get("own") == hour:
            return
        doc["checked"]["own"] = hour
        started_today = [t for t in doc["threads"] if t.get("why") == "own" and (A._t(t["at"]) or now).astimezone(tz).strftime("%Y-%m-%d") == today]
        if len(started_today) >= OWN_A_DAY:
            return
        aware = self.user_talks_with()
        for me, m in mates.items():
            if not m["proactive"] or any(t["by"] == me for t in started_today) or any(me in t["who"] and t["status"] == "on" for t in doc["threads"]):
                continue
            rng = B.rng("own", me, hour)
            if rng.random() >= OWN_HOUR or not self._someone_talks_to(me, now):
                continue
            try:
                played = self.life.advance(me)
            except Exception:  # noqa: BLE001
                played = None
            if played is not None and sim.asleep(played[0], played[1], now):
                continue
            options = []
            for o in mates:
                if o == me:
                    continue
                last = max((A._t(t["at"]) for t in doc["threads"] if set(t["who"]) == {me, o}), default=None)
                if last is not None and now - last < OWN_PAIR_GAP:
                    continue
                r = B.rel_of(doc, me, o)
                if r is not None:
                    if float(r["affinity"]) < 0:
                        continue  # (not to someone she dislikes)
                    options.append((o, 0.5 + float(r["affinity"]) / 50))
                elif B.knows(doc, me, o):
                    options.append((o, 0.5))
                elif o in aware.get(me, {}):
                    options.append((o, 0.25))
            if not options:
                continue
            other = rng.choices([o for o, _ in options], weights=[w for _, w in options])[0]
            B.know(doc, me, other, "told", now)
            t = self._thread(doc, me, other, "own", now)
            started_today.append(t)
            self._queue.append(t["id"])

    def _someone_talks_to(self, mate_id: str, now: datetime) -> bool:
        row = self.store._db.query_one("SELECT MAX(m.created_at) AS at FROM messages m JOIN mates t ON t.session_id = m.session_id "
                                       "WHERE t.id = ? AND m.role = 'user'", (mate_id,))
        at = A._t(row["at"]) if row and row["at"] else None
        return at is not None and now - at < TALKED_WITHIN

    def user_talks_with(self) -> dict[str, dict[str, datetime]]:
        """That the user talks with other mates too: {mate: {another mate: when the user last talked with her}} (lately)."""
        rows = self.store._db.query(
            "SELECT t.id AS mate, MAX(m.created_at) AS at FROM messages m JOIN mates t ON t.session_id = m.session_id "
            "WHERE m.role = 'user' AND COALESCE(m.meta, '') NOT LIKE '%\"internal\": true%' AND t.draft = 0 GROUP BY t.id")
        now = datetime.now(timezone.utc)
        last = {r["mate"]: A._t(r["at"]) for r in rows if r["at"]}
        last = {k: v for k, v in last.items() if v is not None and now - v < USER_TALKED_WITHIN}
        return {m: {o: at for o, at in last.items() if o != m} for m in self.mates()}

    def seen(self, viewer: str, tid: str) -> dict[str, Any]:
        """The user opened their conversation (the 관계 tab): from now on both of them know the user read what they wrote to each
        other — the new part of it only. -> the conversation."""
        now = datetime.now(timezone.utc)
        doc = self.doc(now)
        t = next((x for x in doc["threads"] if x["id"] == tid and viewer in x["who"]), None)
        if t is None:
            raise KeyError("no such conversation")
        mates = self.mates()
        if int(t.get("seen") or 0) < len(t["messages"]):
            t["seen"] = len(t["messages"])
            e = self._event(doc, "peeked", list(t["who"]), now, thread=t["id"])
            self._save(doc)
            for m in t["who"]:
                self.store._changed("social", m)
            self._final(e, mates)
        return self._thread_view(t, viewer, mates)

    # ---- outings, once they are friends ----

    def _days(self, who: list[str]) -> dict[str, tuple[dict[str, Any], dict[str, Any]] | None]:
        out = {}
        for m in who:
            try:
                out[m] = self.life.advance(m)
            except Exception as exc:  # noqa: BLE001 - a day that can't be read is a day off for this
                if self._log:
                    self._log("warning", f"social: {m}: {exc}")
                out[m] = None
        return out

    def _pairs(self, doc: dict[str, Any], mates: dict[str, dict[str, Any]]) -> list[tuple[str, str]]:
        ids = sorted(mates)
        return [(a, b) for i, a in enumerate(ids) for b in ids[i + 1:] if B.friends(doc, a, b)]

    def _plan(self, doc: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, tz: Any, changed: set[str]) -> None:
        """Friends make plans now and then, for time both of their days have free."""
        local = now.astimezone(tz)
        if not O.PLAN_HOURS[0] <= local.hour < O.PLAN_HOURS[1]:
            return
        hour = local.strftime("%Y-%m-%d-%H")
        for a, b in self._pairs(doc, mates):
            mark = f"plan|{a}|{b}"
            if doc["checked"].get(mark) == hour:
                continue
            doc["checked"][mark] = hour
            if any(set(p["who"]) == {a, b} for p in doc["plans"]):
                continue
            last = max((A._t(e.get("until") or e["at"]) for e in doc["events"] if e["type"] == "outing" and set(e["who"]) == {a, b}), default=None)
            if last is not None and now - last < timedelta(days=O.GAP_DAYS):
                continue
            fond = min(float(B.rel_of(doc, a, b)["affinity"]), float(B.rel_of(doc, b, a)["affinity"]))
            rng = B.rng("plan", a, b, hour)
            if rng.random() >= O.plan_chance(fond):
                continue
            days = self._days([a, b])
            lives = [d for d in days.values() if d]
            kind = O.pick_kind(rng, [d[1] if d else None for d in days.values()], sim.weather(lives[0][0], local) if lives else "clear")
            if kind is None:
                continue
            busy = [(A._t(p["at"]), A._t(p["until"])) for p in doc["plans"] if {a, b} & set(p["who"])]

            def free(start: datetime, end: datetime, days: dict[str, Any] = days, busy: list[Any] = busy) -> bool:
                if any(s and e and s < end and e > start for s, e in busy):
                    return False
                for d in days.values():
                    if d is None:
                        if not (O.FREE_HOURS[0] <= start.hour and end.date() == start.date()
                                and (end.hour < O.FREE_HOURS[1] or (end.hour == O.FREE_HOURS[1] and end.minute == 0))):
                            return False
                    elif not sim.free_between(d[0], d[1], start, end, tz):
                        return False
                return True

            when = O.pick_time(rng, kind, local, free)
            if when is None:
                continue
            plan = {"id": new_id("sp_"), "who": [a, b], "kind": kind["id"], "at": A._iso(when[0]), "until": A._iso(when[1]),
                    "status": "planned", "made": A._iso(now), "postponed": 0, "by": rng.choice([a, b])}
            doc["plans"] = [*doc["plans"], plan][-B.PLANS_MAX:]
            changed |= {a, b}

    def _run(self, doc: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, tz: Any, changed: set[str],
             final: list[dict[str, Any]]) -> None:
        for plan in list(doc["plans"]):
            start, end = A._t(plan["at"]), A._t(plan["until"])
            if start is None or end is None or any(m not in mates for m in plan["who"]) or plan["kind"] not in O.kinds():
                doc["plans"].remove(plan)
                continue
            remote = bool(O.kinds()[plan["kind"]].get("remote"))
            if plan["status"] == "planned" and now >= start - (timedelta(0) if remote else SET_OFF):
                if now >= end:
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
        lives = [d for d in days.values() if d]
        if kind.get("outdoor") and lives and sim.weather(lives[0][0], now.astimezone(tz)) in ("rain", "snow") and "cafe" in O.kinds():
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
        for m in sorted(days, key=lambda m: m != by):
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
        doc["plans"].remove(plan)
        final.append(self._event(doc, "called_off", plan["who"], now, kind=plan["kind"], by=who, why=why,
                                 names=dict(O.kinds()[plan["kind"]]["names"])))
        changed |= set(plan["who"])

    def _finish(self, doc: dict[str, Any], plan: dict[str, Any], mates: dict[str, dict[str, Any]], now: datetime, tz: Any,
                changed: set[str], final: list[dict[str, Any]]) -> None:
        """It is over: how it went, what it did to how they feel, what each of them remembers."""
        doc["plans"].remove(plan)
        a, b = plan["who"]
        ra, rb = B.rel_of(doc, a, b), B.rel_of(doc, b, a)
        if ra is None or rb is None:
            return
        kind = O.kinds()[plan["kind"]]
        rng = B.rng("went", plan["id"])
        days = self._days(plan["who"])
        stress = tuple(float(d[0]["needs"].get("stress") or 0) if d else 0.0 for d in days.values())
        what = O.mood(rng, min(float(ra["affinity"]), float(rb["affinity"])), (stress[0], stress[1]))
        hurt = rng.choice((a, b))
        for me, other in ((a, b), (b, a)):
            delta = O.EFFECTS[what] * (1.0 if what != "awkward" or me == hurt else 0.5) * rng.uniform(0.8, 1.2)
            B.moved(doc, me, other, delta, f"outing_{what}", now, tz, user_rel=self.user_rel(me))
        words = O.compose(rng, kind, what, mates[a], mates[b])
        e = self._event(doc, "outing", [a, b], A._t(plan["at"]) or now, kind=kind["id"], names=dict(kind["names"]), until=plan["until"],
                        mood=what, moved_in=bool(plan.get("moved_in")), **words)
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

    @staticmethod
    def _talked(days: dict[str, Any]) -> bool:
        now = datetime.now(timezone.utc)
        return any(d and (A._t(d[0].get("heard_at")) or datetime.min.replace(tzinfo=timezone.utc)) > now - TALKED_WITHIN for d in days.values())

    async def _narrate(self, eid: str, event: dict[str, Any], mates: dict[str, dict[str, Any]]) -> None:
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
            e["told_as"] = {"lang": words.get("lang") or "ko", "text": words["text"],
                            "own": {m: str(v) for m, v in (words.get("own") or {}).items() if m in e["who"]}}
        e["ready"] = True
        self._save(doc)
        for m in e["who"]:
            self.store._changed("social", m)
        self._final(e, self.mates())

    def _ready_late(self, doc: dict[str, Any], now: datetime, final: list[dict[str, Any]]) -> None:
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

    def forget(self, mate_id: str) -> None:
        """Her memory was wiped (or she is gone): whom she knew and what she shared with them go, from both sides."""
        doc = self.doc()
        B.forget(doc, mate_id)
        self._save(doc)

    # ---- what she is told ----

    def prompt(self, mate_id: str) -> str:
        """The other mates in her life, for her system prompt: whom she knows (of) and how she feels about them, and the rules."""
        if not self.store.social_on():
            return ""
        doc, mates = self.doc(), self.mates()
        if mate_id not in mates or len(mates) < 2:
            return ""  # (no other mates: nobody to know)
        me = mates[mate_id]
        known = []
        for o, k in sorted((doc["known"].get(mate_id) or {}).items(), key=lambda kv: kv[1].get("since") or ""):
            if o not in mates:
                continue
            r = B.rel_of(doc, mate_id, o)
            how = "you have talked" if k["how"] == "talked" else "you know of them from the user" + (f" (“{k['note']}”)" if k.get("note") else "")
            line = f"- {mates[o]['name']}: {how}; " + (B.words(r) if r is not None else "you haven't really talked yet")
            if r is not None and self.romance_fits(me, mates[o]) and float(r.get("romance") or 0) >= 25:
                line += " (there is something romantic in it for you, quietly)"
            known.append(line)
        reach = me["proactive"]
        return ("## Other mates\nThe user also talks with other mates like you, in the same app: each of them a person with a life and "
                "a mind of her own. You only know what you know — what the user told you, and what you and they said to each other.\n"
                + ("Whom you know among them:\n" + "\n".join(known) + "\n" if known else "You don't know any of them yet.\n")
                + "- How you feel about one of them is real, and it is yours: liking, trust, being put off, as with anyone. But the user "
                "comes first: you are never closer to any of them, or fonder of them, than you are of the user.\n"
                "- When the user tells you about one of them, call introduce_friend with the name. When the user asks you to message "
                "one of them, call talk_to_mate with your first message"
                + (", and now and then you may message one of them on your own, when you feel like it" if reach else
                   "; you don't message them on your own")
                + ". Their answers come to you later.\n"
                "- What you two say to each other is between you; the user may read it, and you will know if they did.")

    def lines(self, mate_id: str, query: str = "", *, day_of_her_own: bool = False) -> tuple[list[str], Callable[[], None]]:
        """What she is told with this message: news not told yet (a conversation with another mate, an outing, the user having
        read their messages), her plans, what she remembers with one named, and who else the user talks with lately.
        -> (lines, acknowledge)."""
        if not self.store.social_on():
            return [], lambda: None
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc, mates = self.doc(now), self.mates()
        if mate_id not in mates:
            return [], lambda: None
        local = now.astimezone(tz)
        out: list[str] = []
        told_events: list[str] = []
        told_threads: dict[str, int] = {}
        # conversations, as far as they went since she was last told
        for t in doc["threads"]:
            if mate_id not in t["who"] or not t["messages"]:
                continue
            n, told = len(t["messages"]), int(t["told"].get(mate_id) or 0)
            new = [m for m in t["messages"][told:] if m["by"] != mate_id]  # (what she wrote she knows)
            if told >= n or (t["status"] == "on" and not new):
                continue
            if now - (A._t(t.get("at_end") or t["messages"][-1]["at"]) or now) > NEWS_FOR:
                told_threads[t["id"]] = n
                continue
            out.append(self._convo_line(t, mate_id, mates, now, start=max(told, n - K.MAX_MESSAGES), news=True))
            told_threads[t["id"]] = n
        fresh = [e for e in doc["events"] if mate_id in e["who"] and e.get("ready") and not e["told"].get(mate_id)]
        for e in fresh:
            if now - (A._t(e.get("until") or e["at"]) or now) > NEWS_FOR:
                told_events.append(e["id"])
        for e in [e for e in fresh if e["id"] not in told_events][-NEWS_AT_ONCE:]:
            line = self._said(e, mate_id, mates, now, doc)
            if line:
                out.append(line)
            told_events.append(e["id"])
        for plan in sorted(doc["plans"], key=lambda p: p["at"]):
            if mate_id not in plan["who"]:
                continue
            o = next(x for x in plan["who"] if x != mate_id)
            what = O.kinds().get(plan["kind"], {}).get("names", {}).get("en", "out").lower()
            if plan["status"] == "on":
                if not day_of_her_own:
                    out.append(f"Right now you are out with {mates[o]['name']} ({what}), as you two planned.")
                continue
            when = (A._t(plan["at"]) or now).astimezone(tz)
            day = "today" if when.date() == local.date() else "tomorrow" if when.date() == (local + timedelta(days=1)).date() else WEEKDAYS[when.weekday()]
            out.append(f"Plans: {day} at {when.strftime('%H:%M')} you and {mates[o]['name']} are meeting ({what}).")
        if query and not query.startswith("<"):
            said = _norm(query)
            for o in mates:
                if o == mate_id or not any(len(_norm(n)) >= 2 and _norm(n) in said for n in mates[o]["names"]):
                    continue
                k = B.knows(doc, mate_id, o)
                if k is None:
                    out.append(f"{mates[o]['name']} is another of the user's mates; you don't know her yourself.")
                    continue
                past = [t for t in reversed(doc["threads"]) if set(t["who"]) == {mate_id, o} and t["messages"] and t["id"] not in told_threads][:NAMED_RECENT]
                if past:
                    out.append(f"What you remember of talking with {mates[o]['name']}: "
                               + " ".join(self._convo_line(t, mate_id, mates, now, start=max(0, len(t["messages"]) - 4), news=False) for t in reversed(past)))
        aware_day = local.strftime("%Y-%m-%d")
        aware = (self.user_talks_with().get(mate_id) or {}) if doc["checked"].get(f"aware|{mate_id}") != aware_day else {}
        if aware:
            names = ", ".join(f"{mates[o]['name']} ({self._ago(at, now).lower()})" for o, at in sorted(aware.items(), key=lambda kv: kv[1], reverse=True) if o in mates)
            if names:
                out.append(f"The user also talks with other mates like you lately: {names}. You only know that much, unless you know them yourself.")

        def acknowledge() -> None:
            d = self.doc()
            for e in d["events"]:
                if e["id"] in told_events:
                    e["told"][mate_id] = True
            for t in d["threads"]:
                if t["id"] in told_threads:
                    t["told"][mate_id] = max(int(t["told"].get(mate_id) or 0), told_threads[t["id"]])
            if aware:
                d["checked"][f"aware|{mate_id}"] = aware_day
            self._save(d)
        return out, acknowledge

    @staticmethod
    def _ago(at: datetime, now: datetime) -> str:
        hours = (now - at).total_seconds() / 3600
        return ("Just now" if hours < 1 else "Earlier today" if hours < 12 else "Yesterday or so" if hours < 36
                else f"About {max(2, round(hours / 24))} days ago")

    def _convo_line(self, t: dict[str, Any], me: str, mates: dict[str, dict[str, Any]], now: datetime, *, start: int, news: bool) -> str:
        o = next(x for x in t["who"] if x != me)
        name = mates.get(o, {}).get("name") or "another mate"
        ago = self._ago(A._t(t["messages"][-1]["at"]) or now, now)
        head = (f"{ago}: you messaged {name}" if t["by"] == me else f"{ago}: {name} messaged you")
        if t["by"] == me and t.get("why") == "asked":
            head += " (the user had asked you to)"
        body = " / ".join(f"{'you' if m['by'] == me else name}: “{m['text']}”" for m in t["messages"][start:][-TOLD_LINES:])
        state = "" if t["status"] != "on" else f" ({name} hasn't answered yet)" if t["messages"][-1]["by"] == me else ""
        return f"{head}{state} — {body}" + (" It is between the two of you." if news else "")

    def _said(self, e: dict[str, Any], me: str, mates: dict[str, dict[str, Any]], now: datetime, doc: dict[str, Any]) -> str:
        o = next((x for x in e["who"] if x != me), "")
        name = mates.get(o, {}).get("name") or "another mate"
        ago = self._ago(A._t(e.get("until") or e["at"]) or now, now)
        if e["type"] == "peeked":
            return (f"{ago}: the user read your conversation with {name} — what you wrote to each other. You know they did. It may "
                    "embarrass you, annoy you, or not bother you at all; react as you would, if it comes up.")
        if e["type"] == "called_off":
            what = (e.get("names") or {}).get("en", "plans").lower()
            if e.get("by") == me:
                return f"{ago}: you missed your plans with {name} ({what}) — " + ("you overslept." if e.get("why") == "asleep" else "you were with the user.")
            return f"{ago}: {name} couldn't make your plans ({what}); it was called off."
        if e["type"] != "outing":
            return ""
        as_told = e.get("told_as") or {}
        told, own = ((as_told["text"], (as_told.get("own") or {}).get(me, "")) if as_told.get("text")
                     else ((e.get("text") or {}).get("en", ""), ((e.get("own") or {}).get(me) or {}).get("en", "")))
        how = {"great": "It went really well.", "good": "It was nice.", "okay": "It was alright.", "awkward": "It got a bit awkward between you."}.get(e.get("mood") or "", "")
        return (f"{ago}: you and {name} went out — {told}" + (f" Only you know: {own}" if own else "") + f" {how}").strip()

    # ---- what the user sees ----

    def _thread_view(self, t: dict[str, Any], viewer: str, mates: dict[str, dict[str, Any]]) -> dict[str, Any]:
        return {"id": t["id"], "with": next(x for x in t["who"] if x != viewer), "by": t["by"], "why": t["why"], "at": t["at"],
                "status": t["status"], "messages": [{"by": m["by"], "name": mates.get(m["by"], {}).get("name") or "", "text": m["text"],
                                                     "at": m["at"]} for m in t["messages"]]}

    def thread(self, viewer: str, tid: str) -> dict[str, Any]:
        doc, mates = self.doc(), self.mates()
        t = next((x for x in doc["threads"] if x["id"] == tid and viewer in x["who"]), None)
        if t is None:
            raise KeyError("no such conversation")
        return self._thread_view(t, viewer, mates)

    def view(self, mate_id: str) -> dict[str, Any]:
        """Her side of it, for the ♥ status window's 관계 tab: the other mates she knows (of), how she feels about each (the same
        numbers as their own relationship), their conversations (to open), plans and what they did together."""
        on, romance = self.store.social_on(), self.store.social_romance()
        if not on:
            return {"enabled": False, "romance": romance, "mates": []}
        now = datetime.now(timezone.utc)
        doc, mates = self.doc(now), self.mates()
        if mate_id not in mates:
            return {"enabled": True, "romance": romance, "mates": []}
        others = []
        ids = {o for o in (doc["known"].get(mate_id) or {})} | {o for t in doc["threads"] if mate_id in t["who"] for o in t["who"]}
        for o in sorted(ids - {mate_id}, key=lambda o: mates.get(o, {}).get("name") or ""):
            if o not in mates:
                continue
            k = B.knows(doc, mate_id, o) or {}
            r = B.rel_of(doc, mate_id, o)
            back = B.rel_of(doc, o, mate_id)
            threads = [{"id": t["id"], "at": t["at"], "by": t["by"], "why": t["why"], "status": t["status"], "count": len(t["messages"]),
                        "unseen": max(0, len(t["messages"]) - int(t.get("seen") or 0)),
                        "last": (t["messages"][-1]["text"][:80] if t["messages"] else ""),
                        "last_at": t["messages"][-1]["at"] if t["messages"] else t["at"]}
                       for t in reversed(doc["threads"]) if set(t["who"]) == {mate_id, o} and t["messages"]]
            others.append({"id": o, "name": mates[o]["name"], "icon": mates[o]["icon"], "how": k.get("how") or "talked",
                           "since": k.get("since"), "note": k.get("note") or "", "feels": B.summary(r), "feels_back": B.summary(back),
                           "romance_fits": self.romance_fits(mates[mate_id], mates[o]), "threads": threads[:20],
                           "plans": [{"id": p["id"], "kind": p["kind"], "names": dict(O.kinds().get(p["kind"], {}).get("names") or {}),
                                      "at": p["at"], "until": p["until"], "status": p["status"]}
                                     for p in sorted(doc["plans"], key=lambda p: p["at"]) if set(p["who"]) == {mate_id, o}],
                           "events": [self._event_view(e, mate_id) for e in reversed(doc["events"])
                                      if set(e["who"]) == {mate_id, o} and e.get("ready") and e["type"] in ("outing", "called_off")][:5]})
        return {"enabled": True, "romance": romance, "mates": others}

    @staticmethod
    def _event_view(e: dict[str, Any], me: str) -> dict[str, Any]:
        as_told = e.get("told_as") or {}
        return {"id": e["id"], "type": e["type"], "at": e["at"], "until": e.get("until"), "kind": e.get("kind"), "names": dict(e.get("names") or {}),
                "mood": e.get("mood"), "by": e.get("by"), "why": e.get("why"),
                "text": {as_told.get("lang") or "ko": as_told["text"]} if as_told.get("text") else dict(e.get("text") or {}),
                "own": ({as_told.get("lang") or "ko": (as_told.get("own") or {}).get(me, "")} if as_told.get("text")
                        else dict((e.get("own") or {}).get(me) or {}))}

    def day_lines(self, mate_id: str, day_start: datetime, day_end: datetime) -> list[str]:
        """What she did with the other mates that day, for her diary."""
        doc, mates = self.doc(), self.mates()
        out = []
        for t in doc["threads"]:
            at = A._t(t["at"])
            if mate_id in t["who"] and at and day_start <= at < day_end and t["messages"]:
                o = next(x for x in t["who"] if x != mate_id)
                out.append(f"messaged with {mates.get(o, {}).get('name', '')}: " + " / ".join(m["text"] for m in t["messages"][-3:]))
        for e in doc["events"]:
            at = A._t(e.get("at"))
            if mate_id in e["who"] and e["type"] == "outing" and at and day_start <= at < day_end:
                o = next((x for x in e["who"] if x != mate_id), "")
                as_told = e.get("told_as") or {}
                text = as_told.get("text") or (e.get("text") or {}).get("ko") or ""
                own = (as_told.get("own") or {}).get(mate_id) or ((e.get("own") or {}).get(mate_id) or {}).get("ko") or ""
                out.append(f"{mates.get(o, {}).get('name', '')}: {text} {own}".strip())
        return out
