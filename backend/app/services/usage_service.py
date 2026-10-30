"""Usage aggregation — rolls up tokens/cost from persisted turn.complete events."""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from app.db import Database


def _engine_of(model: str) -> str | None:
    m = (model or "").lower()
    if m.startswith("claude") or m in ("sonnet", "opus", "haiku", "fable"):
        return "claude"
    if m.startswith(("gpt", "o3", "o4", "codex")):
        return "codex"
    return None


def _tok(usage: dict, key: str) -> int:
    try:
        return int(usage.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0


class UsageService:
    def __init__(self, db: Database) -> None:
        self._db = db

    def summary(self, days: int = 14) -> dict[str, Any]:
        rows = self._db.query(
            """
            SELECT e.data AS data, e.created_at AS at,
                   s.provider AS provider, s.model AS model, s.title AS title, s.id AS sid
            FROM events e JOIN sessions s ON e.session_id = s.id
            WHERE e.type = 'turn.complete'
            ORDER BY e.id DESC
            """
        )

        total = {"turns": 0, "cost_usd": 0.0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
        by_provider: dict[str, dict] = defaultdict(
            lambda: {"turns": 0, "cost_usd": 0.0, "input": 0, "output": 0}
        )
        by_model: dict[str, dict] = defaultdict(lambda: {"turns": 0, "cost_usd": 0.0, "tokens": 0})
        by_day: dict[str, dict] = defaultdict(lambda: {"turns": 0, "cost_usd": 0.0, "tokens": 0})
        recent: list[dict] = []

        for r in rows:
            try:
                data = json.loads(r["data"])
            except Exception:
                continue
            usage = data.get("usage") or {}
            cost = float(data.get("cost_usd", 0.0) or 0.0)
            inp = _tok(usage, "input_tokens")
            out = _tok(usage, "output_tokens")
            cread = _tok(usage, "cache_read_input_tokens")
            cwrite = _tok(usage, "cache_creation_input_tokens")
            tokens = inp + out + cread + cwrite
            model = data.get("model") or r["model"] or "unknown"
            # The engine that ran THIS turn (recorded since engines can be
            # switched mid-chat); older turns are inferred from the model.
            provider = data.get("provider") or _engine_of(model) or r["provider"] or "unknown"
            day = (r["at"] or "")[:10]

            total["turns"] += 1
            total["cost_usd"] += cost
            total["input"] += inp
            total["output"] += out
            total["cache_read"] += cread
            total["cache_write"] += cwrite

            bp = by_provider[provider]
            bp["turns"] += 1
            bp["cost_usd"] += cost
            bp["input"] += inp
            bp["output"] += out

            bm = by_model[model]
            bm["turns"] += 1
            bm["cost_usd"] += cost
            bm["tokens"] += tokens

            bd = by_day[day]
            bd["turns"] += 1
            bd["cost_usd"] += cost
            bd["tokens"] += tokens

            if len(recent) < 25:
                recent.append(
                    {
                        "session_id": r["sid"],
                        "title": r["title"],
                        "provider": provider,
                        "model": model,
                        "cost_usd": round(cost, 4),
                        "tokens": tokens,
                        "at": r["at"],
                    }
                )

        # last `days` days, ascending, zero-filled
        today = datetime.now(timezone.utc).date()
        series = []
        for i in range(days - 1, -1, -1):
            d = (today.toordinal() - i)
            key = datetime.fromordinal(d).date().isoformat()
            e = by_day.get(key, {"turns": 0, "cost_usd": 0.0, "tokens": 0})
            series.append({"day": key, "turns": e["turns"], "cost_usd": round(e["cost_usd"], 4), "tokens": e["tokens"]})

        total["cost_usd"] = round(total["cost_usd"], 4)
        return {
            "total": total,
            "by_provider": {k: {**v, "cost_usd": round(v["cost_usd"], 4)} for k, v in by_provider.items()},
            "by_model": {k: {**v, "cost_usd": round(v["cost_usd"], 4)} for k, v in by_model.items()},
            "series": series,
            "recent": recent,
        }
