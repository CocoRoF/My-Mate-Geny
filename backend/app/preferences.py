"""The account's UI preferences (single admin account), shared by every device.

Kept as JSON in ``app_kv['ui_preferences']`` (the table AuthManager creates).
Today only ``language`` (``"en"`` | ``"ko"``; docs/i18n.md): the console
applies it after loading, so every signed-in device follows; the login page
uses it as a fallback before anyone is signed in.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import Request

from app.db import Database

LANGUAGES = ("en", "ko")
_KEY = "ui_preferences"
LANG_COOKIE = "hrh_lang"


def _ensure(db: Database) -> None:
    db.execute("CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")


def get_preferences(db: Database) -> dict[str, Any]:
    _ensure(db)
    row = db.query_one("SELECT value FROM app_kv WHERE key = ?", (_KEY,))
    try:
        data = json.loads(row["value"]) if row else {}
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    lang = data.get("language")
    return {"language": lang if lang in LANGUAGES else None}


def set_preferences(db: Database, patch: dict[str, Any]) -> dict[str, Any]:
    cur = get_preferences(db)
    nxt = {**cur, **patch}
    _ensure(db)
    db.execute(
        "INSERT INTO app_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_KEY, json.dumps(nxt)),
    )
    return get_preferences(db)


def _from_accept_language(header: str) -> str | None:
    """The first of en / ko the browser lists (by q-value)."""
    best: tuple[float, int, str] | None = None
    for i, part in enumerate(header.split(",")):
        tag, _, params = part.strip().partition(";")
        q = 1.0
        if params.strip().startswith("q="):
            try:
                q = float(params.strip()[2:])
            except ValueError:
                q = 0.0
        base = tag.strip().lower().split("-")[0]
        if base in LANGUAGES and q > 0 and (best is None or (q, -i) > (best[0], best[1])):
            best = (q, -i, base)
    return best[2] if best else None


def request_language(request: Request, db: Database | None = None) -> str:
    """The language for a page rendered before sign-in: ?lang= → the hrh_lang
    cookie (set by the console) → the account's stored choice → Accept-Language → en."""
    for v in (request.query_params.get("lang"), request.cookies.get(LANG_COOKIE)):
        if v in LANGUAGES:
            return v
    if db is not None:
        try:
            stored = get_preferences(db)["language"]
        except Exception:  # noqa: BLE001 - a page must render even if the DB hiccups
            stored = None
        if stored:
            return stored
    return _from_accept_language(request.headers.get("accept-language", "")) or "en"
