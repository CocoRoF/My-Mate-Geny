"""Her wardrobe as she sees it: what she can change into, and how she feels about each right now.

Whether she changes is hers to decide (docs/mate.md "Outfits"); these only say what is there. Pure helpers.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from app.mate.store import DEFAULT_OUTFIT

NOTE_CHARS = 100
LEAN_WORDS = {"glad": "you'd be glad to", "maybe": "you could go either way", "rather_not": "you'd rather not right now"}


def _plain(text: Any) -> str:
    """For comparing names: no case, spacing or punctuation."""
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", str(text or "")).casefold())


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


def _wearable(card: dict[str, Any]) -> bool:
    return card["id"] == DEFAULT_OUTFIT or (not card.get("locked") and card.get("kind") != "none")


def signature(cards: list[dict[str, Any]], lean: dict[str, str], worn: str) -> list[list[Any]]:
    """What she has to be told again about when it changes."""
    return [[c["id"], c["name"], c.get("kind"), bool(c.get("locked")), lean.get(c["id"]), c["id"] == worn] for c in cards]


def listing(cards: list[dict[str, Any]], lean: dict[str, str], worn: str) -> str:
    """Her wardrobe in a line of her <context>, with how she leans on each; "" when there is nothing to change into."""
    def how(card: dict[str, Any]) -> str:
        return "you have it on" if card["id"] == worn else LEAN_WORDS.get(lean.get(card["id"], ""), "")

    ready, closed = [], []
    for c in cards:
        if c["id"] == DEFAULT_OUTFIT:
            continue
        if c.get("locked"):
            closed.append(f"“{c['name']}”")
        elif _wearable(c):
            note = " ".join(str(c.get("note") or "").split())[:NOTE_CHARS]
            feels = ", ".join(c.get("feel") or {})
            parts = [*([note] if note else []), *([f"wearing it makes you {feels}"] if feels else []), how(c)]
            ready.append(f"{c['id']} “{c['name']}” ({'; '.join(p for p in parts if p)})")
    if not ready and not closed:
        return ""
    default = next((c for c in cards if c["id"] == DEFAULT_OUTFIT), {"id": DEFAULT_OUTFIT})
    line = f"Your wardrobe, for change_outfit, and how you lean on each right now: default (your usual clothes; {how(default)})"
    if ready:
        line += "; " + "; ".join(ready)
    if closed:
        line += ". Not open to you yet: " + ", ".join(closed)
    return line + "."
