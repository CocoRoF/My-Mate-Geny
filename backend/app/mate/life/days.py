"""The days of the year she knows (``builtin/days.json``): per country, the observances of a date (Pepero Day, Christmas) and the
public holidays that are one by their names (Seollal, Chuseok: Nager.Date has their dates, which move every year). Read once,
checked as it is read: a mistake in it fails loudly, in the tests first."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

PATH = Path(__file__).resolve().parents[1] / "builtin" / "days.json"
TONES = ("festive", "solemn", "plain")


def check(doc: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for country, days in doc.items():
        if country == "about":
            continue
        if not re.fullmatch(r"[A-Z]{2}", country) or not isinstance(days, list):
            raise ValueError(f"days: {country!r} is not a country code with a list")
        for d in days:
            name = d.get("id") or "?"
            if not d.get("id") or not (d.get("names") or {}).get("ko") or not (d.get("names") or {}).get("en") or not d.get("about"):
                raise ValueError(f"days: {country} {name} needs an id, its names and what she is told")
            if d.get("tone") not in TONES:
                raise ValueError(f"days: {country} {name}: tone is one of {TONES}")
            fixed, held = d.get("date"), d.get("holiday")
            if bool(fixed) == bool(held):
                raise ValueError(f"days: {country} {name} is a date or a holiday, one of them")
            if fixed and not is_mmdd(fixed):
                raise ValueError(f"days: {country} {name}: {fixed!r} is not MM-DD")
            if held and (not isinstance(held, list) or not all(isinstance(h, str) and h for h in held)):
                raise ValueError(f"days: {country} {name}: holiday is a list of its names")
        out[country] = list(days)
    return out


def is_mmdd(v: Any) -> bool:
    """A day of the year as MM-DD (02-29 too): a date in the calendar, a birthday."""
    if not isinstance(v, str) or not re.fullmatch(r"\d{2}-\d{2}", v):
        return False
    try:
        datetime.strptime(f"2000-{v}", "%Y-%m-%d")  # (a leap year)
    except ValueError:
        return False
    return True


CALENDAR = check(json.loads(PATH.read_text(encoding="utf-8")))


def on(local: datetime, country: str, holidays: dict[str, list[dict[str, str]]] | None = None) -> list[dict[str, Any]]:
    """What this day is where the user lives: the observances a public holiday of the day is (by its names) first, then the
    ones of the date. ``holidays``: {date: [{en, local}, …]} (life/world.py)."""
    days = CALENDAR.get(country or "") or []
    if not days:
        return []
    names = {n for h in (holidays or {}).get(local.strftime("%Y-%m-%d")) or [] for n in (h.get("en"), h.get("local")) if n}
    held = [d for d in days if d.get("holiday") and names & set(d["holiday"])]
    mmdd = local.strftime("%m-%d")
    return [*held, *(d for d in days if d.get("date") == mmdd and d not in held)]


def off(local: datetime, country: str) -> bool:
    """A day off for her there, whatever the public holidays say (Labor Day in Korea)."""
    return any(d.get("off") for d in on(local, country))
