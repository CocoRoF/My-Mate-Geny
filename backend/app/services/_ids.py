"""Small id + time helpers shared across services."""

from __future__ import annotations

import secrets
from datetime import datetime, timezone


def new_id(prefix: str = "") -> str:
    token = secrets.token_hex(8)
    return f"{prefix}{token}" if prefix else token


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
