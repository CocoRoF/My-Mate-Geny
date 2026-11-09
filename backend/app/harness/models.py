"""The model catalog of an API provider: what the vendor lists, which of it this app may use, and what each costs.

``refresh`` asks the vendor for its models with one of the provider's keys and keeps the chat models an agent can drive
(``vendors.chat_model``). The first time, the vendor's current main models are switched on; anything listed later starts
off. A model that disappears from the vendor's list stays (marked unlisted) so a chat on it keeps its settings.

Per model the user can switch it on or off, give it another name, set its context window (OpenAI doesn't report one)
and set its price (the default comes from ``pricing``). The New chat menu, the composer and the engine read it from
here.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from app.harness import pricing
from app.harness.vendors import VENDORS, chat_model, dated, effort_levels, guess_limits
from app.services._ids import now_iso

SCHEMA = """
CREATE TABLE IF NOT EXISTS api_models (
    provider       TEXT NOT NULL,
    model_id       TEXT NOT NULL,
    label          TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 0,
    listed         INTEGER NOT NULL DEFAULT 1,   -- in the vendor's list at the last refresh
    manual         INTEGER NOT NULL DEFAULT 0,   -- added by hand
    context_window INTEGER,
    max_output     INTEGER,
    window_set     INTEGER NOT NULL DEFAULT 0,   -- the user set the context window
    caps           TEXT,                         -- JSON: what the vendor says the model can do
    price          TEXT,                         -- JSON: the user's price (NULL = the list price)
    meta           TEXT,                         -- JSON: description, lifecycle, created
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (provider, model_id)
);
CREATE TABLE IF NOT EXISTS api_catalog_state (
    provider   TEXT PRIMARY KEY,
    fetched_at TEXT,
    error      TEXT,
    seeded     INTEGER NOT NULL DEFAULT 0
);
"""


def _iso(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v, UTC).isoformat()
    return str(v)


def _loads(raw: Any) -> Any:
    try:
        return json.loads(raw) if raw else None
    except (TypeError, ValueError):
        return None


class ModelCatalog:
    def __init__(self, db: Any) -> None:
        self.db = db

    # ---- the vendor's list ----

    async def refresh(self, provider: str, key: str) -> dict[str, Any]:
        """Fetch the vendor's models with this key and merge them in. → {added, total, error?}"""
        from app.harness.llm import adapter
        from app.harness.llm.base import LLMError

        try:
            listed = await adapter(provider).list_models(key)
        except LLMError as exc:
            self.db.execute(
                "INSERT INTO api_catalog_state (provider, fetched_at, error) VALUES (?, ?, ?) "
                "ON CONFLICT(provider) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error",
                (provider, now_iso(), str(exc)[:500]))
            raise
        return self.merge(provider, listed)

    def merge(self, provider: str, listed: list[dict[str, Any]]) -> dict[str, Any]:
        now = now_iso()
        keep = [m for m in listed if chat_model(provider, m["id"], actions=m.get("actions"), lifecycle=m.get("lifecycle"))]
        state = self.db.query_one("SELECT seeded FROM api_catalog_state WHERE provider = ?", (provider,))
        seeding = not (state and state["seeded"])
        known = {r["model_id"]: dict(r) for r in self.db.query("SELECT * FROM api_models WHERE provider = ?", (provider,))}
        recommended = VENDORS[provider].recommended
        turn_on: set[str] = set()
        if seeding:
            ids = {m["id"] for m in keep}
            turn_on = {r for r in recommended if r in ids}
            if not turn_on:  # (none of ours: the vendor's newest few)
                newest = sorted((m for m in keep if not dated(m["id"])),
                                key=lambda m: str(_iso(m.get("created")) or ""), reverse=True)
                turn_on = {m["id"] for m in newest[:3]}
        added = 0
        with self.db.transaction():
            for m in keep:
                guess_window, guess_out = guess_limits(provider, m["id"])
                meta = {k: m[k] for k in ("description", "lifecycle", "owned_by") if m.get(k)}
                meta["created"] = _iso(m.get("created"))
                caps = m.get("caps")
                old = known.get(m["id"])
                if old is None:
                    added += 1
                    self.db.execute(
                        "INSERT INTO api_models (provider, model_id, label, enabled, listed, context_window, max_output, "
                        "caps, meta, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
                        (provider, m["id"], m.get("label") or m["id"], int(m["id"] in turn_on),
                         m.get("context_window") or guess_window, m.get("max_output") or guess_out,
                         json.dumps(caps) if caps is not None else None, json.dumps(meta), now))
                else:
                    window = old["context_window"] if old["window_set"] else (m.get("context_window") or old["context_window"]
                                                                              or guess_window)
                    self.db.execute(
                        "UPDATE api_models SET listed = 1, context_window = ?, max_output = ?, caps = ?, meta = ?, "
                        "updated_at = ? WHERE provider = ? AND model_id = ?",
                        (window, m.get("max_output") or old["max_output"] or guess_out,
                         json.dumps(caps) if caps is not None else old["caps"], json.dumps(meta), now, provider, m["id"]))
            gone = set(known) - {m["id"] for m in keep}
            for mid in gone:
                if not known[mid]["manual"]:
                    self.db.execute("UPDATE api_models SET listed = 0 WHERE provider = ? AND model_id = ?", (provider, mid))
            self.db.execute(
                "INSERT INTO api_catalog_state (provider, fetched_at, error, seeded) VALUES (?, ?, NULL, 1) "
                "ON CONFLICT(provider) DO UPDATE SET fetched_at = excluded.fetched_at, error = NULL, seeded = 1",
                (provider, now))
        return {"added": added, "total": len(keep)}

    # ---- the user's choices ----

    def update(self, provider: str, model_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM api_models WHERE provider = ? AND model_id = ?", (provider, model_id))
        if row is None:
            raise KeyError(model_id)
        sets: dict[str, Any] = {}
        if "enabled" in patch:
            sets["enabled"] = int(bool(patch["enabled"]))
        if "label" in patch:
            label = str(patch["label"] or "").strip()[:120]
            sets["label"] = label or model_id
        if "price" in patch:
            price = pricing.valid_price(patch["price"]) if patch["price"] is not None else None
            if patch["price"] is not None and price is None:
                raise ValueError("a price needs at least input and output (USD per million tokens)")
            sets["price"] = json.dumps(price) if price else None
        if "context_window" in patch:
            n = patch["context_window"]
            if n in (None, "", 0):
                sets["window_set"] = 0
            else:
                n = int(n)
                if n < 1000:
                    raise ValueError("a context window is at least 1,000 tokens")
                sets["context_window"] = n
                sets["window_set"] = 1
        if not sets:
            return self.public(provider, model_id)
        sets["updated_at"] = now_iso()
        self.db.execute(
            f"UPDATE api_models SET {', '.join(f'{k} = ?' for k in sets)} WHERE provider = ? AND model_id = ?",
            (*sets.values(), provider, model_id))
        return self.public(provider, model_id)

    def set_all(self, provider: str, enabled: bool, ids: list[str] | None = None) -> None:
        if ids:
            q = ",".join("?" * len(ids))
            self.db.execute(f"UPDATE api_models SET enabled = ?, updated_at = ? WHERE provider = ? AND model_id IN ({q})",
                            (int(enabled), now_iso(), provider, *ids))
        else:
            self.db.execute("UPDATE api_models SET enabled = ?, updated_at = ? WHERE provider = ?",
                            (int(enabled), now_iso(), provider))

    def add(self, provider: str, model_id: str, label: str = "") -> dict[str, Any]:
        """A model the vendor doesn't list (yet) — a preview, a fine-tune — by its id."""
        model_id = model_id.strip()
        if not model_id or len(model_id) > 200 or any(c.isspace() for c in model_id):
            raise ValueError("a model id has no spaces")
        guess_window, guess_out = guess_limits(provider, model_id)
        self.db.execute(
            "INSERT INTO api_models (provider, model_id, label, enabled, listed, manual, context_window, max_output, "
            "meta, updated_at) VALUES (?, ?, ?, 1, 0, 1, ?, ?, '{}', ?) ON CONFLICT(provider, model_id) DO UPDATE SET "
            "enabled = 1", (provider, model_id, label.strip() or model_id, guess_window, guess_out, now_iso()))
        return self.public(provider, model_id)

    def remove(self, provider: str, model_id: str) -> None:
        self.db.execute("DELETE FROM api_models WHERE provider = ? AND model_id = ? AND manual = 1", (provider, model_id))

    # ---- reading ----

    def _row_public(self, provider: str, r: dict[str, Any]) -> dict[str, Any]:
        caps = _loads(r["caps"])
        custom = pricing.valid_price(_loads(r["price"]))
        listed_price = pricing.default_price(provider, r["model_id"])
        meta = _loads(r["meta"]) or {}
        return {
            "id": r["model_id"],
            "label": r["label"],
            "enabled": bool(r["enabled"]),
            "listed": bool(r["listed"]),
            "manual": bool(r["manual"]),
            "context_window": r["context_window"],
            "context_window_set": bool(r["window_set"]),
            "max_output": r["max_output"],
            "effort": effort_levels(provider, r["model_id"], caps),
            "thinking": _thinks(provider, r["model_id"], caps),
            "vision": _sees(caps),
            "price": custom or listed_price,
            "price_source": "custom" if custom else "list" if listed_price else None,
            "list_price": listed_price,
            "description": meta.get("description", ""),
            "created": meta.get("created"),
            "lifecycle": meta.get("lifecycle"),
        }

    def public(self, provider: str, model_id: str) -> dict[str, Any]:
        r = self.db.query_one("SELECT * FROM api_models WHERE provider = ? AND model_id = ?", (provider, model_id))
        if r is None:
            raise KeyError(model_id)
        return self._row_public(provider, dict(r))

    def models(self, provider: str) -> list[dict[str, Any]]:
        rows = [self._row_public(provider, dict(r))
                for r in self.db.query("SELECT * FROM api_models WHERE provider = ?", (provider,))]
        order = {m: i for i, m in enumerate(VENDORS[provider].recommended)}
        rows.sort(key=lambda m: (order.get(m["id"], len(order)), not m["listed"], dated(m["id"]),
                                 -_ts(m.get("created")), m["id"]))
        return rows

    def state(self, provider: str) -> dict[str, Any]:
        r = self.db.query_one("SELECT * FROM api_catalog_state WHERE provider = ?", (provider,))
        return {"fetched_at": r["fetched_at"] if r else None, "error": r["error"] if r else None}

    def enabled(self, provider: str) -> list[dict[str, Any]]:
        return [m for m in self.models(provider) if m["enabled"]]

    def default_model(self, provider: str) -> str:
        on = self.enabled(provider)
        return on[0]["id"] if on else ""

    def info(self, provider: str, model_id: str) -> dict[str, Any]:
        """What the engine needs to know about a model, also for one that isn't in the catalog."""
        r = self.db.query_one("SELECT * FROM api_models WHERE provider = ? AND model_id = ?", (provider, model_id))
        if r is not None:
            pub = self._row_public(provider, dict(r))
            return {"caps": _loads(r["caps"]) or {}, "context_window": pub["context_window"],
                    "max_output": pub["max_output"], "price": pub["price"], "label": pub["label"],
                    "vision": pub["vision"]}
        window, out = guess_limits(provider, model_id)
        return {"caps": {}, "context_window": window, "max_output": out,
                "price": pricing.default_price(provider, model_id), "label": model_id, "vision": True}

    def catalog_entry(self, provider: str) -> dict[str, Any]:
        """The provider as the New chat menu and the composer see it (``providers.catalog``)."""
        models = [{"id": m["id"], "label": m["label"], "description": m["description"] or None,
                   "effort": m["effort"], "default_effort": "default", "context_window": m["context_window"]}
                  for m in self.enabled(provider)]
        levels: list[str] = []
        for m in models:
            for lv in m["effort"]:
                if lv not in levels:
                    levels.append(lv)
        return {
            "label": VENDORS[provider].label,
            "models": models,
            "default_model": models[0]["id"] if models else "",
            "effort": levels or ["default"],
            "default_effort": "default",
            "models_source": "api",
            "kind": "api",
        }


def _ts(iso: str | None) -> float:
    try:
        return datetime.fromisoformat(iso).timestamp() if iso else 0.0
    except ValueError:
        return 0.0


def _thinks(provider: str, model_id: str, caps: dict | None) -> bool:
    if provider == "anthropic":
        th = (caps or {}).get("thinking")
        return bool(th.get("supported")) if isinstance(th, dict) else True
    if provider == "google":
        return bool((caps or {}).get("thinking", True))
    return bool(effort_levels(provider, model_id, caps))


def _sees(caps: dict | None) -> bool:
    img = (caps or {}).get("image_input")
    return bool(img.get("supported")) if isinstance(img, dict) else True
