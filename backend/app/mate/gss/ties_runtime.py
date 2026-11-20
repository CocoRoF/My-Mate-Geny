"""What they are to each other, at work (app/mate/gss/ties.py; docs/geny-state-system.md §12): one document for every mate's
view of the user and of the other mates (``mate_settings`` key ``ties``), kept going with her day's clock (the life ticker,
once a minute):

- Her night. When one of her days has ended (04:00, after her diary if she keeps one), she thinks over each one something
  passed between them that day, when it is due (``ties.due``): one bounded call in her own engine, at most one at a time.
  Changed or kept, it goes in the journal (layer ``tie``); a new view of the user is also one of her memories.
- At the moment. Her tool ``what_we_are``: something decisive just happened and she says what they are now.
- Someone she already knew when this began (or a relationship rebuilt) has no view yet. She puts it into words soon, from
  everything between them so far (``pending``).

What she is told (``lines``, ``call_lines``, ``mate_words``) goes through her <context>, the other-mates section and her messages
to another mate. What the user sees is ``view`` (the ♥ status window).
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from app.mate import affinity as A
from app.mate import oneshot
from app.mate import state as S
from app.mate.gss import ties as T
from app.mate.social import bonds as B

KEY = "ties"
TALKED_WITHIN = timedelta(days=7)    # (as her diary: nobody's quota goes on a mate nobody visits)
DIARY_WAIT = timedelta(hours=3)      # her night waits this long for her diary to be written
SOON_GAP = timedelta(minutes=2)      # first views of those she already knew: one every two minutes
TODAY_LINES, TODAY_CHARS = 24, 220


class TiesRuntime:
    def __init__(self, mates: Any) -> None:
        self.mates = mates
        self.store = mates.store
        self._queue: list[tuple[str, str, str, str]] = []  # (holder, other, reason, her day)
        self._doing: set[tuple[str, str]] = set()  # (the one she is thinking over right now)
        self._running = False
        self._started = False

    # ---- the document ----

    def doc(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.store._setting(KEY) or "null")
        except ValueError:
            raw = None
        return T.normalized(raw)

    def _save(self, doc: dict[str, Any]) -> None:
        self.store._put_setting(KEY, json.dumps(doc, ensure_ascii=False))

    def tie(self, holder: str, other: str) -> dict[str, Any] | None:
        return T.get(self.doc(), holder, other)

    # ---- who is who ----

    def _people(self) -> dict[str, dict[str, Any]]:
        return self.mates.social.mates()

    def _rel(self, holder: str, other: str) -> dict[str, Any] | None:
        """How she feels about them (the relationship's numbers): with the user her relationship, with a mate the social one."""
        if other == T.USER:
            rel = self.store.relation_doc(holder)
            return rel if rel and rel.get("enabled") else None
        return B.rel_of(self.mates.social.doc(), holder, other)

    def _labels(self, holder: str, other: str, people: dict[str, dict[str, Any]], doc: dict[str, Any]) -> tuple[str, ...]:
        cur = (T.get(doc, holder, other) or {}).get("label")
        if other == T.USER:
            return T.allowed(with_user=True, romance=True, current=cur)
        romance = other in people and holder in people and self.mates.social.romance_fits(people[holder], people[other])
        return T.allowed(with_user=False, romance=romance, user_label=(T.get(doc, holder, T.USER) or {}).get("label"), current=cur)

    def _them(self, holder: str, other: str, people: dict[str, dict[str, Any]]) -> str:
        if other != T.USER:
            return (people.get(other) or {}).get("name") or "the other mate"
        try:
            user = str(((self.store.get(holder).get("prefs") or {}).get("user_name") or "")).strip()
        except KeyError:
            user = ""
        return f"the user ({user})" if user else "the user"

    # ---- the clock ----

    def tick(self, now: datetime | None = None) -> None:
        """A minute of her day: the views of those she already knew put into words soon, her night when a day has ended."""
        now, tz = now or datetime.now(timezone.utc), self.store.tz()
        doc = self.doc()
        before = json.dumps(doc, sort_keys=True)
        people = self._people()
        for gone in {*doc["ties"], *(o for row in doc["ties"].values() for o in row if o != T.USER)} - set(people):
            T.forget(doc, gone)
        if not self._started:
            self._started = True
            self._seed(doc, people, now)
        for holder, row in doc["ties"].items():
            for other, t in row.items():
                if t.get("pending") and (A._t(t["pending"]) or now) <= now:
                    self._enqueue(holder, other, "asked", T.her_day(now, tz))
        self._nights(doc, people, now, tz)
        if json.dumps(doc, sort_keys=True) != before:
            self._save(doc)
        self._kick()

    def _seed(self, doc: dict[str, Any], people: dict[str, dict[str, Any]], now: datetime) -> None:
        """Those she already knew (from before this, or rebuilt): she puts into words soon what they are to her."""
        n = 0
        social = self.mates.social.doc()
        for holder in people:
            rel = self.store.relation_doc(holder)
            pairs = [(T.USER, rel)] + [(o, r) for o, r in (social["rel"].get(holder) or {}).items() if o in people]
            for other, r in pairs:
                if T.get(doc, holder, other) is None and r and r.get("enabled", True) and int(r.get("turns") or 0) > 0:
                    t = T.ensure(doc, holder, other, now)
                    t["pending"] = A._iso(now + SOON_GAP * n)
                    n += 1

    def _nights(self, doc: dict[str, Any], people: dict[str, dict[str, Any]], now: datetime, tz: Any) -> None:
        """Her day ended: whom she thinks over tonight (each one something passed between them that day, when due)."""
        last = T.her_day(now, tz) - timedelta(days=1)
        social = None
        for holder in people:
            if doc["checked"].get(holder) == last.isoformat():
                continue
            if doc["checked"].get(holder) is None:  # (from now on: the days before this began are put into words by ``_seed``)
                doc["checked"][holder] = last.isoformat()
                continue
            if self._diary_pending(holder, last, now, tz):
                continue
            doc["checked"][holder] = last.isoformat()
            rel = self.store.relation_doc(holder)
            heard = A._d((rel or {}).get("last_active_day"))
            parties: list[tuple[str, dict[str, Any] | None]] = []
            if rel and rel.get("enabled") and not rel.get("paused") and heard and now.astimezone(tz).date() - heard <= TALKED_WITHIN:
                parties.append((T.USER, rel))
            social = social if social is not None else self.mates.social.doc()
            parties += [(o, r) for o, r in (social["rel"].get(holder) or {}).items() if o in people]
            for other, r in parties:
                reason = T.due(T.get(doc, holder, other), T.days(r, tz), last, now, tz)
                if reason:
                    self._enqueue(holder, other, reason, last)

    def _diary_pending(self, holder: str, day: Any, now: datetime, tz: Any) -> bool:
        """Her diary for that day is still to be written (she thinks it over after it), for a while."""
        from app.mate.life import diary

        try:
            mate = self.store.get(holder)
            life = self.store.life_now(holder, mate.get("builtin"), mate.get("prefs") or {})
        except KeyError:
            return False
        if not life:
            return False
        ended = datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=tz) + T.DAY_STARTS
        if now - ended > DIARY_WAIT:
            return False
        d = diary.due(life[0], now)
        return d is not None and d.get("day") == day.isoformat()

    def _enqueue(self, holder: str, other: str, reason: str, day: Any) -> None:
        if (holder, other) not in self._doing and not any(q[0] == holder and q[1] == other for q in self._queue):
            self._queue.append((holder, other, reason, str(day)))

    def _kick(self) -> None:
        if self._running or not self._queue:
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
                holder, other, reason, day = self._queue.pop(0)
                self._doing.add((holder, other))
                try:
                    await self.think(holder, other, reason, day)
                except Exception as exc:  # noqa: BLE001 - one night that didn't go never stops the others
                    self.mates._log("warning", f"ties: {holder} → {other}: {exc}")
                finally:
                    self._doing.discard((holder, other))
        finally:
            self._running = False

    # ---- thinking it over ----

    def _today(self, holder: str, other: str, day: str, people: dict[str, dict[str, Any]]) -> list[str]:
        """What passed between them that day, oldest first: their conversation (the user), or their messages (another mate)."""
        tz = self.store.tz()
        try:
            start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=tz) + T.DAY_STARTS
        except ValueError:
            return []
        end = start + timedelta(days=1)
        clip = lambda s: (lambda x: x if len(x) <= TODAY_CHARS else x[: TODAY_CHARS - 1] + "…")(" ".join(str(s or "").split()))  # noqa: E731
        out: list[str] = []
        if other == T.USER:
            try:
                sid = self.store.get(holder).get("session_id")
            except KeyError:
                return []
            if not sid:
                return []
            rows = self.store._db.query("SELECT role, content, meta, created_at FROM messages WHERE session_id = ? AND role IN "
                                        "('user', 'assistant') AND created_at >= ? AND created_at < ? ORDER BY created_at, rowid",
                                        (sid, start.astimezone(timezone.utc).isoformat(), end.astimezone(timezone.utc).isoformat()))
            for r in rows:
                try:
                    meta = json.loads(r["meta"] or "null") or {}
                except ValueError:
                    meta = {}
                if isinstance(meta, dict) and meta.get("internal") and r["role"] == "user":
                    continue
                text = clip(r["content"])
                if text:
                    out.append(f"{'They' if r['role'] == 'user' else 'You'}: {text}")
            return out[-TODAY_LINES:]
        name = (people.get(other) or {}).get("name") or "them"
        for th in self.mates.social.doc()["threads"]:
            if set(th["who"]) != {holder, other}:
                continue
            for m in th["messages"]:
                at = A._t(m.get("at"))
                if at and start <= at < end:
                    out.append(f"{'You' if m['by'] == holder else name}: {clip(m['text'])}")
        try:
            out += [f"(with {name}) {x}" for x in self.mates.social.day_lines(holder, start, end) if not x.startswith("messaged with")]
        except Exception:  # noqa: BLE001 - only colour
            pass
        return out[-TODAY_LINES:]

    def _how(self, holder: str, other: str, rel: dict[str, Any] | None, now: datetime, tz: Any) -> str:
        if not rel:
            return "you haven't really talked yet"
        w = A.bond_words(rel)
        out = f"{A.STAGE_WORDS.get(rel['stage'], rel['stage'])}; trust {w['trust']}; romance {w['romance']}; respect {w['respect']}"
        if other == T.USER and rel.get("started_at"):
            out += f"; day {A.days_together(rel, now.astimezone(tz).date(), tz)} since you met"
        return out

    def _diary(self, holder: str, day: str) -> str:
        try:
            mate = self.store.get(holder)
            life = self.store.life_now(holder, mate.get("builtin"), mate.get("prefs") or {})
        except KeyError:
            return ""
        for d in ((life or ({}, None))[0].get("days") or []):
            if d.get("day") == day:
                return str(d.get("diary") or "")[:800]
        return ""

    def _holding(self, holder: str) -> str:
        try:
            doc, who = self.store.state_doc(holder), self.store.state_who(holder)
        except KeyError:
            return ""
        return S.held_line(S.held(doc, who, datetime.now(timezone.utc)))

    async def think(self, holder: str, other: str, reason: str, day: str) -> dict[str, Any] | None:
        """One night's thinking it over (or a first view put into words): her own engine says what they are to her. → the tie."""
        now, tz = datetime.now(timezone.utc), self.store.tz()
        try:
            mate = self.store.get(holder)
        except KeyError:
            return None
        people = self._people()
        if other != T.USER and other not in people:
            return None
        doc = self.doc()
        t = T.get(doc, holder, other)
        labels = self._labels(holder, other, people, doc)
        rel = self._rel(holder, other)
        by_day = T.days(rel, tz)
        today = T.her_day(now, tz)
        since = T.her_day(A._t(t["since"]) or now, tz) if t and t["label"] != "stranger" and reason != "asked" else None
        system, content = T.request(
            mate, t, reason, them=self._them(holder, other, people), with_user=other == T.USER, labels=labels,
            how=self._how(holder, other, rel, now, tz), happened=T.story(by_day, today, since), today=self._today(holder, other, day, people),
            now=now, tz=tz, diary=self._diary(holder, day), holding=self._holding(holder) if other == T.USER else "",
            user_label="" if other == T.USER else ((T.get(doc, holder, T.USER) or {}).get("label") or "stranger"))
        stamp = (t or {}).get("since")
        try:
            raw = await oneshot.ask(self.mates, mate, system, content, ".ties", timeout_s=90)
        except Exception as exc:  # noqa: BLE001 - she didn't get to it tonight: another night
            raw = ""
            self.mates._log("warning", f"ties: {mate['name']} couldn't think it over: {exc}")
        found = T.parse(raw, labels)
        doc = self.doc()  # (it may have moved meanwhile: her own word at the moment stands)
        t = T.get(doc, holder, other)
        if t is not None and t.get("since") != stamp:
            return t
        if found is None:
            if t is not None and t.get("pending"):
                t["pending"] = None if reason == "asked" and raw else A._iso(now + timedelta(hours=6))  # (no answer: later)
                self._save(doc)
            return t
        return self._apply(doc, holder, other, found, "first" if t is None or t["label"] == "stranger" else "night", reason, now,
                           people, mate)

    def _apply(self, doc: dict[str, Any], holder: str, other: str, found: dict[str, str], by: str, reason: str, now: datetime,
               people: dict[str, dict[str, Any]], mate: dict[str, Any]) -> dict[str, Any]:
        t = T.ensure(doc, holder, other, now)
        was = t["label"]
        changed = T.set_label(t, found["label"], found.get("why") or "", now, by)
        if changed:
            if found.get("thought"):
                t["thought"], t["thought_at"] = found["thought"], A._iso(now)
        else:
            T.kept(t, found.get("thought") or "", now, found.get("why") or "")
        self._save(doc)
        other_name = "" if other == T.USER else (people.get(other) or {}).get("name") or ""
        data = {"with": other, "with_name": other_name, "from": was, "to": t["label"], "why": t.get("why") or "",
                "thought": found.get("thought") or "", "reason": reason, "by": by}
        self.mates.gss.journal.record(holder, "tie", "changed" if changed else "kept", data, now)
        if changed:
            self.mates._log("info", f"ties: {mate['name']} now sees {other_name or 'the user'} as {t['label']} (was {was}; {by})",
                            code="mate.tie_changed", detail=data)
            if other == T.USER and t["label"] != "stranger":
                self.mates.gss._remember(mate, "tie", {"label": t["label"], "from": was, "why": t.get("why") or ""}, now)
        self._pushed(holder, other)
        return t

    def _pushed(self, holder: str, other: str) -> None:
        self.store._changed("ties", holder)
        if other != T.USER:
            self.store._changed("social", holder)
            self.store._changed("social", other)

    # ---- at the moment: her own word ----

    def say(self, holder: str, label: str, why: str, with_name: str = "") -> str:
        """Her tool: something decisive just happened and she says what the two of them are now. → what she is told back."""
        people = self._people()
        mate = self.store.get(holder)
        other = T.USER
        if (with_name or "").strip():
            found = self.mates.social.find(holder, with_name)
            if found is None:
                raise ValueError(f"there is nobody called {with_name!r} among the user's mates")
            other = found["id"]
            if B.knows(self.mates.social.doc(), holder, other) is None:
                raise ValueError(f"you don't know {found['name']} yet")
        label = str(label or "").strip().lower()
        doc = self.doc()
        labels = self._labels(holder, other, people, doc)
        if label not in T.LABELS:
            raise ValueError("label: one of " + ", ".join(T.LABELS))
        if label not in labels:
            if other == T.USER:
                raise ValueError(f"{label} isn't possible now")
            raise ValueError(f"not with {people[other]['name']}: between you and another mate nothing goes further than 썸, and "
                             "nothing is closer than what is between you and the user")
        now = datetime.now(timezone.utc)
        t = T.get(doc, holder, other)
        if t is not None and t["label"] == label:
            if (why or "").strip():
                t["why"] = " ".join(why.split())[:400]
                self._save(doc)
            return f"Already: to you, you two are {T.NAMES[label][1]}."
        self._apply(doc, holder, other, {"label": label, "why": why or "", "thought": ""}, "moment", "moment", now, people, mate)
        who = "the user" if other == T.USER else people[other]["name"]
        return f"Noted: to you, you and {who} are now {T.NAMES[label][1]}. It stays so until something changes it."

    # ---- a fresh start, or gone ----

    def restart(self, holder: str, other: str = T.USER) -> None:
        doc = self.doc()
        T.restart(doc, holder, other)
        self._save(doc)
        self._pushed(holder, other)

    def forget(self, mate_id: str) -> None:
        doc = self.doc()
        T.forget(doc, mate_id)
        self._save(doc)
        self.store._changed("ties", mate_id)

    # ---- what she is told ----

    def lines(self, mate_id: str, st: dict[str, Any], turn: int, now: datetime, tz: Any) -> list[str]:
        """For her <context>, each only when it changed (or every 30 turns): what the two of them are, as she sees it, and a doubt
        of hers about it while it is with her."""
        t = self.tie(mate_id, T.USER)
        out: list[str] = []
        line = T.line(t, now, tz)
        sig = [t["label"], t["since"], bool(t["history"] and now - (A._t(t["history"][-1].get("at")) or now) <= T.FRESH_FOR)] if t else None
        if line and (st.get("tie") != sig or turn - int(st.get("tie_turn") or 0) >= 30):
            st["tie"], st["tie_turn"] = sig, turn
            out.append(line)
        thought = T.thought_line(t, now)
        if thought and st.get("tie_thought") != (t or {}).get("thought_at"):
            st["tie_thought"] = t["thought_at"]
            out.append(thought)
        return out

    def call_lines(self, mate_id: str, now: datetime, tz: Any) -> list[str]:
        t = self.tie(mate_id, T.USER)
        return [x for x in (T.line(t, now, tz), T.thought_line(t, now)) if x]

    def label(self, mate_id: str, other: str = T.USER) -> str | None:
        t = self.tie(mate_id, other)
        return t["label"] if t else None

    def mate_words(self, holder: str, other: str) -> str:
        return T.words(self.tie(holder, other))

    # ---- what the user sees ----

    def view(self, mate_id: str, other: str = T.USER) -> dict[str, Any]:
        now, tz = datetime.now(timezone.utc), self.store.tz()
        t = self.tie(mate_id, other)
        rel = self._rel(mate_id, other)
        return {"tie": T.summary(t, T.days(rel, tz) if rel else {}, now, tz), "labels": list(T.LABELS),
                "romantic": list(T.ROMANTIC), "review_at": T.REVIEW_AT}

    def summary(self, holder: str, other: str) -> dict[str, Any] | None:
        now, tz = datetime.now(timezone.utc), self.store.tz()
        t = self.tie(holder, other)
        if t is None:
            return None
        rel = self._rel(holder, other)
        return T.summary(t, T.days(rel, tz) if rel else {}, now, tz)
