"""Her calls they asked for (docs/mate-calls.md "Alarms"): "9시에 알람해 줘" — at nine she phones them; "끝나면 알려 줘" in
a chat — when its work is done she phones them with what it did. Both are a call she makes because she was asked, not
because she felt like it: no daytime rule, no cooldown, no hurt feelings when it rings out.

- ``AlarmBook``: the alarms, kept in the database (``mate_alarms``) — a server restart loses none. Each has a mate, a time
  (UTC), what it is about, a kind (``alarm``: a time they gave · ``done``: a chat finished), and where it stands
  (pending → ringing → done | missed | cancelled).
- ``AlarmClock``: sleeps until the next one is due (woken at once when one is set or cancelled) and has her call
  (``CallService.alarm``). Unanswered, it rings again — ATTEMPTS times, RETRY_S apart; never answered, she leaves them a
  message instead. Due while the server was down: rung when it comes back, if no more than LATE_MAX late; else the
  message.
- A phone whose app is closed can't be reached at a moment's notice (it checks in every 15 minutes): the alarms coming up
  go to it (its link's hello, the page's ``alarms.changed``), and it wakes itself a little before each (AlarmManager) to
  be on the line when she calls.
"""

from __future__ import annotations

import asyncio
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from app.services._ids import now_iso

ATTEMPTS = 3                       # times an alarm rings before she leaves a message instead
RETRY_S = 120                      # between two tries
UNREACHABLE_S = 30                 # nowhere to ring (a phone waking up for it): looked at again this soon…
UNREACHABLE_MAX = timedelta(minutes=10)  # …until this long after it was due: then the message
LATE_MAX = timedelta(minutes=30)   # due while the server was down: still rung this late
AHEAD_MAX = timedelta(days=30)     # how far ahead an alarm may be set
MAX_PENDING = 50                   # alarms waiting at once (all mates)
WAKE_AHEAD_S = 25                  # a phone wakes itself this long before an alarm (to be on the line in time)
NEXT_MAX_S = 30.0                  # the clock looks again at least this often (a missed wake never stalls it)
ABOUT_CHARS = 600


def _t(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat(timespec="seconds")


def parse_when(value: str, now: datetime, tz: Any) -> datetime:
    """When an alarm is for, from what she was told: ``HH:MM`` (the next time it is that, in the user's zone),
    ``YYYY-MM-DD HH:MM`` / ISO (their zone unless it says its own), or ``+N`` / ``+Nm`` / ``+Nh`` (from now). → UTC.
    ValueError with a line she can read when it can't be used (the past, too far ahead, nonsense)."""
    s = str(value or "").strip()
    if not s:
        raise ValueError("say when: HH:MM, YYYY-MM-DD HH:MM, or +minutes")
    local_now = now.astimezone(tz)
    at: datetime
    if s.startswith("+"):
        body = s[1:].strip().lower()
        unit = 60
        if body.endswith("h"):
            body, unit = body[:-1], 3600
        elif body.endswith("m"):
            body = body[:-1]
        try:
            amount = float(body)
        except ValueError:
            raise ValueError(f"can't read {s!r}: use +30 (minutes), +2h, HH:MM or YYYY-MM-DD HH:MM") from None
        at = now + timedelta(seconds=amount * unit)
    elif len(s) <= 5 and ":" in s:
        try:
            hh, mm = (int(x) for x in s.split(":", 1))
            day = local_now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        except ValueError:
            raise ValueError(f"can't read {s!r} as a time of day (HH:MM, 24-hour)") from None
        if day <= local_now:
            day += timedelta(days=1)  # (09:00 at ten in the morning: tomorrow's)
        at = day.astimezone(timezone.utc)
    else:
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00").replace(" ", "T", 1) if "T" not in s else s.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError(f"can't read {s!r}: use HH:MM, YYYY-MM-DD HH:MM, or +minutes") from None
        at = (d if d.tzinfo else d.replace(tzinfo=tz)).astimezone(timezone.utc)
    if at <= now - timedelta(seconds=5):
        raise ValueError(f"{_iso(at)} has already passed (it is {local_now.strftime('%Y-%m-%d %H:%M')} for them now)")
    if at - now > AHEAD_MAX:
        raise ValueError("an alarm can be set at most 30 days ahead")
    return at


class AlarmBook:
    """The alarms, in the database."""

    def __init__(self, db: Any, clock: Callable[[], float]) -> None:
        self.db = db
        self.clock = clock
        # (``due``: when it was set for; ``at``: when it is tried next — the same until it rings out or can't ring)
        db.execute("CREATE TABLE IF NOT EXISTS mate_alarms(id TEXT PRIMARY KEY, mate_id TEXT NOT NULL, due TEXT NOT NULL, "
                   "at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'alarm', about TEXT NOT NULL DEFAULT '', session_id TEXT NOT "
                   "NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, call_id TEXT "
                   "NOT NULL DEFAULT '', created_at TEXT NOT NULL, done_at TEXT)")
        db.execute("CREATE INDEX IF NOT EXISTS mate_alarms_due ON mate_alarms(status, at)")
        # (ringing when the server stopped: that call ended with it — the alarm is due again)
        db.execute("UPDATE mate_alarms SET status='pending' WHERE status='ringing'")

    def now(self) -> datetime:
        return datetime.fromtimestamp(self.clock(), timezone.utc)

    @staticmethod
    def _row(r: Any) -> dict[str, Any]:
        return {k: r[k] for k in ("id", "mate_id", "due", "at", "kind", "about", "session_id", "status", "attempts", "call_id",
                                  "created_at", "done_at")}

    def add(self, mate_id: str, at: datetime, about: str = "", *, kind: str = "alarm", session_id: str = "") -> dict[str, Any]:
        n = self.db.query_one("SELECT COUNT(*) AS n FROM mate_alarms WHERE status IN ('pending','ringing')")["n"]
        if n >= MAX_PENDING:
            raise ValueError(f"{MAX_PENDING} alarms are already waiting: cancel one first")
        aid = "alarm_" + secrets.token_hex(6)
        self.db.execute("INSERT INTO mate_alarms(id, mate_id, due, at, kind, about, session_id, status, attempts, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)",
                        (aid, mate_id, _iso(at), _iso(at), kind, " ".join(str(about or "").split())[:ABOUT_CHARS], session_id,
                         now_iso()))
        return self.get(aid)

    def get(self, aid: str) -> dict[str, Any]:
        r = self.db.query_one("SELECT * FROM mate_alarms WHERE id = ?", (aid,))
        if r is None:
            raise KeyError(aid)
        return self._row(r)

    def upcoming(self, mate_id: str | None = None, *, within: timedelta | None = None) -> list[dict[str, Any]]:
        """Waiting alarms, soonest first (one mate's, or all)."""
        q = "SELECT * FROM mate_alarms WHERE status IN ('pending','ringing')"
        args: list[Any] = []
        if mate_id:
            q += " AND mate_id = ?"
            args.append(mate_id)
        if within is not None:
            q += " AND at <= ?"
            args.append(_iso(self.now() + within))
        return [self._row(r) for r in self.db.query(q + " ORDER BY at", tuple(args))]

    def due(self) -> list[dict[str, Any]]:
        return [self._row(r) for r in self.db.query(
            "SELECT * FROM mate_alarms WHERE status = 'pending' AND at <= ? ORDER BY at", (_iso(self.now()),))]

    def next_at(self) -> datetime | None:
        r = self.db.query_one("SELECT at FROM mate_alarms WHERE status = 'pending' ORDER BY at LIMIT 1")
        return _t(r["at"]) if r else None

    def cancel(self, aid: str, mate_id: str | None = None) -> dict[str, Any]:
        a = self.get(aid)
        if mate_id and a["mate_id"] != mate_id:
            raise KeyError(aid)
        if a["status"] not in ("pending", "ringing"):
            raise ValueError(f"that alarm is already {a['status']}")
        self.db.execute("UPDATE mate_alarms SET status='cancelled', done_at=? WHERE id=?", (now_iso(), aid))
        return self.get(aid)

    def mark(self, aid: str, status: str, **fields: Any) -> None:
        sets = ["status = ?"]
        args: list[Any] = [status]
        for k, v in fields.items():
            if k in ("attempts", "call_id", "at"):
                sets.append(f"{k} = ?")
                args.append(v)
        if status in ("done", "missed", "cancelled"):
            sets.append("done_at = ?")
            args.append(now_iso())
        self.db.execute(f"UPDATE mate_alarms SET {', '.join(sets)} WHERE id = ?", (*args, aid))

    def by_call(self, call_id: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM mate_alarms WHERE call_id = ? AND status = 'ringing'", (call_id,))
        return self._row(r) if r else None


class AlarmClock:
    """Rings her calls when they are due (CallService.alarm), again when unanswered, and says when a phone should wake."""

    def __init__(self, book: AlarmBook, calls: Any, *, on_change: Callable[[], None] | None = None) -> None:
        self.book = book
        self.calls = calls
        self.on_change = on_change
        self._wake = asyncio.Event()
        self.task: asyncio.Task | None = None

    def poke(self) -> None:
        """an alarm was set, cancelled or moved: look again now (and tell the windows and phones)"""
        self._wake.set()
        if self.on_change is not None:
            try:
                self.on_change()
            except Exception:  # noqa: BLE001 - telling the windows never stops the clock
                pass

    def poke_quiet(self) -> None:
        """look again now (a phone just came on the line: an alarm due may ring on it)"""
        self._wake.set()

    def wakes(self, *, within: timedelta = timedelta(hours=26)) -> list[str]:
        """When a phone should be awake to be rung (UTC, a little before each alarm), the next day's."""
        out = []
        for a in self.book.upcoming(within=within):
            at = _t(a["at"])
            if at is not None and a["kind"] == "alarm":
                out.append(_iso(at - timedelta(seconds=WAKE_AHEAD_S)))
        return out

    async def tick(self) -> None:
        """Ring what is due (one at a time: a call already on waits its turn)."""
        now = self.book.now()
        for a in self.book.due():
            due = _t(a["due"]) or now
            if now - due > LATE_MAX and a["attempts"] == 0:
                # (due while the server was down, long ago: she tells them instead of ringing late)
                self.book.mark(a["id"], "missed")
                await self.calls.alarm_missed(a, late=True)
                self.poke()
                continue
            outcome = await self.calls.alarm(a)
            if outcome == "ringing":
                continue  # (its call's end says how it went: CallService → after_call)
            if outcome == "busy":
                break  # (a call is on: the next tick)
            if outcome == "unreachable":
                # (nowhere to ring right now — a phone may be waking up for it: looked at again shortly, then a message)
                if now - due > UNREACHABLE_MAX:
                    self.book.mark(a["id"], "missed")
                    await self.calls.alarm_missed(a, late=False)
                else:
                    self.book.mark(a["id"], "pending", at=_iso(now + timedelta(seconds=UNREACHABLE_S)))
                self.poke()

    async def after_call(self, call_id: str, status: str) -> None:
        """Her alarm call ended: answered (or turned down: they heard it) → done; rang out → again later, or a message."""
        a = self.book.by_call(call_id)
        if a is None:
            return
        if status in ("talked", "declined"):
            self.book.mark(a["id"], "done")
        elif a["attempts"] >= ATTEMPTS:
            self.book.mark(a["id"], "missed")
            await self.calls.alarm_missed(a, late=False)
        else:
            self.book.mark(a["id"], "pending", at=_iso(self.book.now() + timedelta(seconds=RETRY_S)))
        self.poke()

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception as exc:  # noqa: BLE001 - one bad alarm never stops the clock
                self.calls.mates._log("warning", f"alarm clock: {exc}", code="mate.alarm")
            nxt = self.book.next_at()
            wait = NEXT_MAX_S if nxt is None else max(0.5, min(NEXT_MAX_S, (nxt - self.book.now()).total_seconds()))
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=wait)
            except asyncio.TimeoutError:
                pass

    def start(self) -> None:
        self.task = asyncio.create_task(self.run())

    @staticmethod
    def public(a: dict[str, Any], tz: Any) -> dict[str, Any]:
        due = _t(a["due"])
        return {**{k: a[k] for k in ("id", "mate_id", "kind", "about", "status", "attempts", "session_id", "due", "at")},
                "local": due.astimezone(tz).strftime("%Y-%m-%d %H:%M") if due else ""}

