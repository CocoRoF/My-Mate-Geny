"""Her wardrobe from her side: when she changes because the user asked.

She doesn't change on a whim, and the model's word isn't enough: the tool checks that the user's latest message really says
it, that the outfit can be worn, and whether she is up for it. In a good mood she does it when asked; otherwise it takes
asking again. Going back to her default clothes is the user's call at any time.

Pure helpers; MateService owns the writes (docs/mate.md "Outfits").
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timedelta
from typing import Any

from app.mate import affinity as A
from app.mate.store import DEFAULT_OUTFIT

#: how many times the user has to ask, by how she feels
MOOD_ASKS = {"cheerful": 1, "content": 1, "calm": 1, "focused": 2, "sleepy": 2, "concerned": 3}
#: one more if they have only just met, or she has only just changed
NEW_ASKS = 1
AGAIN_ASKS = 1
AGAIN_WITHIN = timedelta(minutes=10)
MAX_ASKS = 4
#: asking again after this long starts over
ASK_WINDOW = timedelta(minutes=30)
NOTE_CHARS = 100


def asks_needed(mood: str | None, stage: str | None, changed_at: datetime | None, now: datetime) -> int:
    """``mood`` / ``stage``: None while the relationship is off or paused (nothing holds her back then)."""
    n = MOOD_ASKS.get(mood or "", 1)
    if stage == "new":
        n += NEW_ASKS
    if changed_at is not None and now - changed_at < AGAIN_WITHIN:
        n += AGAIN_ASKS
    return min(n, MAX_ASKS)


def _plain(text: Any) -> str:
    """For comparing words: no case, spacing or punctuation."""
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", str(text or "")).casefold())


def said_it(asked: Any, message: Any) -> bool:
    """Whether ``asked`` really is in what the user wrote."""
    words = _plain(asked)
    return bool(words) and words in _plain(message)


def count_ask(state: dict[str, Any], outfit: str, message: str, now: datetime) -> dict[str, Any]:
    """The state with this ask counted: one per message of theirs, for one outfit, while they keep at it."""
    asks = state.get("asks") if isinstance(state.get("asks"), dict) else {}
    at = A._t(asks.get("at"))
    going = asks.get("outfit") == outfit and at is not None and now - at <= ASK_WINDOW
    seen = [str(m) for m in asks.get("messages") or []] if going else []
    if message not in seen:
        seen = [*seen, message][-MAX_ASKS:]
    return {**state, "asks": {"outfit": outfit, "messages": seen, "at": A._iso(now)}}


def changed(state: dict[str, Any], now: datetime) -> dict[str, Any]:
    return {**{k: v for k, v in state.items() if k != "asks"}, "changed_at": A._iso(now)}


def find(cards: list[dict[str, Any]], text: Any) -> dict[str, Any] | None:
    """One of her outfits by id or by name."""
    want = str(text or "").strip()
    plain = _plain(want)
    for c in cards:
        if c["id"] == want:
            return c
    if plain:
        for c in cards:
            if c["id"] != DEFAULT_OUTFIT and _plain(c["name"]) == plain:
                return c
    return None


def signature(cards: list[dict[str, Any]]) -> list[list[Any]]:
    """What she has to be told again about when it changes."""
    return [[c["id"], c["name"], c.get("kind"), bool(c.get("locked"))] for c in cards]


def listing(cards: list[dict[str, Any]]) -> str:
    """Her wardrobe in a line of her <context>; "" when there is nothing to change into."""
    ready, closed = [], []
    for c in cards:
        if c["id"] == DEFAULT_OUTFIT:
            continue
        if c.get("locked"):
            closed.append(f"“{c['name']}”")
        elif c.get("kind") != "none":
            note = " ".join(str(c.get("note") or "").split())[:NOTE_CHARS]
            ready.append(f"{c['id']} “{c['name']}”" + (f" ({note})" if note else ""))
    if not ready and not closed:
        return ""
    line = "Your wardrobe, for change_outfit: default (your usual clothes)"
    if ready:
        line += "; " + "; ".join(ready)
    if closed:
        line += ". Not open to you yet: " + ", ".join(closed)
    return line + "."
