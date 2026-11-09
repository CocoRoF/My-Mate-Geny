"""What the harness shares with the rest of the app: the database (bound once, by the session service)."""

from __future__ import annotations

from typing import Any

_db: Any = None


def bind(db: Any) -> None:
    global _db
    _db = db


def db() -> Any:
    if _db is None:
        raise RuntimeError("the harness has no database yet")
    return _db


def bound() -> bool:
    return _db is not None
