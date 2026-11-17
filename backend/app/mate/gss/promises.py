"""Promises, both ways (docs/geny-state-system.md, roadmap 6): what the user said they would do ("I'll call you tonight", "내일
또 올게", "이따 파일 보내줄게") and what she said she would, read from the messages (app/mate/gss/appraisal.py). Kept in her
state document (``doc["promises"]``), pure functions over it.

- A promise to be in touch again ("contact") is kept by any word from them at least ``CONTACT_AFTER`` after it was made and
  before it was due (with ``GRACE``); the first word after that comes late: it was broken.
- Any other promise of theirs is kept when a later message does what it said (the reading's ``fulfills``); past due she is
  told it is overdue, and a day after that it lapses — she minds it as she would, nothing is counted for her.
- Her own promises are told back to her when they are due, so she keeps her word; they lapse a day after.

Kept and broken promises of theirs move trust (affinity.BOND_EVENTS); a broken one also stays with her a little
(state.broken_promise)."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any

KEEP = 30
CONTACT_AFTER, GRACE, LAPSE = timedelta(minutes=30), timedelta(hours=2), timedelta(hours=24)
DEFAULT_DUE = {"contact": 24.0, "task": 48.0, "other": 72.0}  # hours, when no time was said


def _t(v: Any) -> datetime | None:
    if not isinstance(v, str) or not v:
        return None
    t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat(timespec="seconds")


def listed(doc: dict[str, Any]) -> list[dict[str, Any]]:
    return [p for p in doc.get("promises") or [] if isinstance(p, dict) and p.get("id")]


def open_ones(doc: dict[str, Any], who: str | None = None) -> list[dict[str, Any]]:
    return [p for p in listed(doc) if p.get("status") in ("open", "overdue") and (who is None or p.get("who") == who)]


def _words(t: str) -> set[str]:
    import re

    return set(re.findall(r"[\w가-힣]{2,}", (t or "").lower()))


def same(a: str, b: str) -> bool:
    """The same thing said in other words (most of the words shared)."""
    x, y = _words(a), _words(b)
    return bool(x and y) and len(x & y) / min(len(x), len(y)) >= 0.6


def add(doc: dict[str, Any], who: str, what: str, kind: str, made: datetime, due_hours: float | None,
        message: str = "") -> dict[str, Any] | None:
    """A new promise (``who``: user | her). The same thing promised again while it is open — in other words too — is the same
    promise."""
    what = " ".join(str(what or "").split())[:160]
    if not what:
        return None
    for p in open_ones(doc, who):
        if p["what"] == what or same(p["what"], what):
            return None
    due = made + timedelta(hours=due_hours if due_hours is not None else DEFAULT_DUE.get(kind, 48.0))
    p = {"id": "p" + hashlib.sha1(f"{who}|{what}|{_iso(made)}".encode()).hexdigest()[:8], "who": who, "what": what,
         "kind": kind if kind in DEFAULT_DUE else "other", "made_at": _iso(made), "due_at": _iso(due), "status": "open",
         "message": message, "told": None}
    doc["promises"] = [*listed(doc), p][-KEEP:]
    return p


def _settle(p: dict[str, Any], status: str, at: datetime) -> dict[str, Any]:
    p["status"], p["settled_at"] = status, _iso(at)
    return p


def fulfil(doc: dict[str, Any], ids: list[str], at: datetime) -> list[dict[str, Any]]:
    """A message did what open promises said. → the ones it kept."""
    out = []
    for p in open_ones(doc):
        if p["id"] in ids:
            out.append(_settle(p, "kept", at))
    return out


def heard_from_them(doc: dict[str, Any], at: datetime, last: datetime | None = None) -> list[dict[str, Any]]:
    """They wrote or called after a while (``last``: their message before this one): their promises to be in touch again are
    kept, or — the first word after one was due — broken. Chatting on in the same conversation keeps nothing. → the ones settled
    now."""
    out = []
    if last is not None and at - last < CONTACT_AFTER:
        return out
    for p in open_ones(doc, "user"):
        if p["kind"] != "contact":
            continue
        made, due = _t(p["made_at"]), _t(p["due_at"])
        if made is None or due is None or at - made < CONTACT_AFTER:
            continue
        out.append(_settle(p, "kept" if at <= due + GRACE else "broken", at))
    return out


def tick(doc: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    """Time passed: open ones past due are overdue, overdue ones lapse a day later. → what changed."""
    out = []
    for p in open_ones(doc):
        due = _t(p["due_at"])
        if due is None:
            continue
        if p["status"] == "open" and now > due + GRACE:
            p["status"] = "overdue"
            out.append(p)
        elif p["status"] == "overdue" and now > due + GRACE + LAPSE:
            out.append(_settle(p, "lapsed", now))
    return out


def lines(doc: dict[str, Any], now: datetime) -> list[str]:
    """What she is told about promises, once each when it matters: theirs overdue or just broken or kept, hers due."""
    out = []
    for p in listed(doc):
        key = p["status"] if p["who"] == "user" else "due_her"  # (hers: told once, when it is due)
        if p.get("told") == key:
            continue
        when = _t(p.get("settled_at") or p.get("due_at")) or now
        recent = now - when <= timedelta(days=2)
        if p["who"] == "user" and p["status"] == "overdue":
            out.append(f"They promised: “{p['what']}” — it was due {_ago(now - (_t(p['due_at']) or now))}, and you haven't seen it done.")
        elif p["who"] == "user" and p["status"] == "broken" and recent:
            out.append(f"They promised: “{p['what']}” — and didn't, until now.")
        elif p["who"] == "user" and p["status"] == "kept" and recent:
            out.append(f"They kept their word: “{p['what']}”.")
        elif p["who"] == "her" and p["status"] in ("open", "overdue") and (_t(p["due_at"]) or now) <= now + timedelta(hours=1):
            out.append(f"You promised them: “{p['what']}” — it's due now; keep your word, or tell them why not.")
        else:
            continue
        p["told"] = key
    return out


def _ago(d: timedelta) -> str:
    h = d.total_seconds() / 3600
    if h < 1:
        return f"{max(1, round(h * 60))} minutes ago"
    return f"{round(h)} hours ago" if h < 36 else f"{round(h / 24)} days ago"
