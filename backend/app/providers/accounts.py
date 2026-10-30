"""Multi-account pool with load balancing — adapted from memora's claude_pool.

Connect multiple provider accounts (e.g. several Claude Code subscriptions) and
spread turns across them with rate-limit-aware failover. Each account is
isolated by its own HOME + CLAUDE_CONFIG_DIR so one account never reads
another's tokens.

Three layers:
  * pure balancer functions (strategy + health policy) — easy to reason about,
  * ``AccountStore`` — DB-backed CRUD + health persistence,
  * ``AccountPool`` — in-memory in-flight counters, acquire()/report().
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings
from app.db import Database
from app.services._ids import new_id, now_iso
from app.vault import SecretVault

# ---------------------------------------------------------------- isolation


def account_home(provider: str, account_id: str) -> Path:
    return settings.home_dir / "accounts" / provider / account_id


def account_config_dir(provider: str, account_id: str) -> Path:
    # Claude reads ~/.claude; codex reads ~/.codex.
    sub = ".codex" if provider == "codex" else ".claude"
    return account_home(provider, account_id) / sub


def ensure_account_dirs(provider: str, account_id: str) -> tuple[Path, Path]:
    home = account_home(provider, account_id)
    cfg = account_config_dir(provider, account_id)
    cfg.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(home, 0o700)
        os.chmod(cfg, 0o700)
    except OSError:
        pass
    return home, cfg


def write_claude_credentials(account_id: str, creds: dict) -> None:
    """Write a Claude account's OAuth credentials to its isolated config dir.

    The CLI reads+refreshes ``.credentials.json`` there on every turn (via
    CLAUDE_CONFIG_DIR), so the account's token stays fresh automatically.
    """
    import json as _json

    _, cfg = ensure_account_dirs("claude", account_id)
    p = cfg / ".credentials.json"
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(_json.dumps(creds))


# ---------------------------------------------------------------- balancer (pure)


@dataclass(frozen=True)
class AccountSnapshot:
    id: str
    enabled: bool = True
    usable: bool = True
    status: str = "ready"
    weight: int = 1
    max_concurrency: int = 8
    in_flight: int = 0
    cooldown_until: float = 0.0
    last_used: float = 0.0
    total_leases: int = 0
    consecutive_failures: int = 0
    utilization: float = 0.0  # plan usage % (0..100) for usage-based balancing

    @property
    def load(self) -> float:
        return self.in_flight / max(1, self.max_concurrency)

    @property
    def remaining(self) -> float:
        return max(0.0, 100.0 - self.utilization)


@dataclass
class BalancerState:
    cursor: int = 0
    current_weights: dict[str, int] = field(default_factory=dict)


def ineligible_reason(a: AccountSnapshot, *, now: float) -> str | None:
    if not a.enabled:
        return "disabled"
    if not a.usable:
        return "no_credentials"
    if a.status == "expired":
        return "expired"
    if a.cooldown_until and a.cooldown_until > now:
        return "cooling_down"
    if a.max_concurrency > 0 and a.in_flight >= a.max_concurrency:
        return "at_capacity"
    return None


def _round_robin(cands: list[AccountSnapshot], state: BalancerState) -> AccountSnapshot:
    order = sorted(cands, key=lambda a: a.id)
    idx = state.cursor % len(order)
    state.cursor = idx + 1
    return order[idx]


def _weighted(cands: list[AccountSnapshot], state: BalancerState) -> AccountSnapshot:
    total = 0
    best = None
    best_cw = 0
    for a in sorted(cands, key=lambda x: x.id):
        w = max(1, a.weight)
        total += w
        cw = state.current_weights.get(a.id, 0) + w
        state.current_weights[a.id] = cw
        if best is None or cw > best_cw:
            best, best_cw = a, cw
    assert best is not None
    state.current_weights[best.id] = best_cw - total
    return best


def _least_busy(cands: list[AccountSnapshot]) -> AccountSnapshot:
    return min(cands, key=lambda a: (round(a.load, 6), a.total_leases, a.last_used, a.id))


def _lru(cands: list[AccountSnapshot]) -> AccountSnapshot:
    return min(cands, key=lambda a: (a.last_used, a.total_leases, a.id))


def _most_remaining(cands: list[AccountSnapshot]) -> AccountSnapshot:
    # Pick the account with the most plan headroom (lowest utilization), then
    # the least busy. This spreads load toward accounts with quota to spare.
    return min(cands, key=lambda a: (round(a.utilization, 2), round(a.load, 6), a.last_used, a.id))


def choose(
    accounts: list[AccountSnapshot], *, strategy: str, now: float, state: BalancerState
) -> AccountSnapshot | None:
    cands = [a for a in accounts if ineligible_reason(a, now=now) is None]
    if not cands:
        return None
    if strategy == "round_robin":
        return _round_robin(cands, state)
    if strategy == "weighted":
        return _weighted(cands, state)
    if strategy == "least_recently_used":
        return _lru(cands)
    if strategy == "most_remaining":
        return _most_remaining(cands)
    return _least_busy(cands)


def over_capacity(accounts: list[AccountSnapshot], *, now: float) -> AccountSnapshot | None:
    full = [a for a in accounts if ineligible_reason(a, now=now) == "at_capacity"]
    return min(full, key=lambda a: (a.in_flight, a.id)) if full else None


@dataclass(frozen=True)
class HealthPolicy:
    failure_threshold: int = 3
    failure_cooldown_s: float = 120.0
    rate_limit_cooldown_s: float = 900.0
    quota_cooldown_s: float = 3600.0
    max_cooldown_s: float = 6 * 3600.0


@dataclass(frozen=True)
class HealthDecision:
    status: str
    consecutive_failures: int
    cooldown_until: float


_NEUTRAL = {"cancelled", "context_limit", "credits_exhausted", "not_implemented"}


def apply_outcome(
    a: AccountSnapshot, *, ok: bool, code: str | None, now: float, policy: HealthPolicy
) -> HealthDecision:
    if ok:
        return HealthDecision("ready", 0, 0.0)
    if code in _NEUTRAL:
        return HealthDecision(a.status, a.consecutive_failures, a.cooldown_until)
    fails = a.consecutive_failures + 1
    if code == "provider_auth":
        return HealthDecision("expired", fails, 0.0)
    if code == "rate_limited":
        return HealthDecision("cooldown", fails, now + policy.rate_limit_cooldown_s)
    if code == "provider_quota":
        return HealthDecision("cooldown", fails, now + policy.quota_cooldown_s)
    if fails >= policy.failure_threshold:
        backoff = min(
            policy.max_cooldown_s,
            policy.failure_cooldown_s * (2 ** (fails - policy.failure_threshold)),
        )
        return HealthDecision("cooldown", fails, now + backoff)
    return HealthDecision(a.status, fails, a.cooldown_until)


def classify_error(code: str | None, message: str | None) -> str:
    """Map a provider error event to a balancer outcome code."""
    text = f"{code or ''} {message or ''}".lower()
    if "rate" in text or "overloaded" in text or "429" in text:
        return "rate_limited"
    if "quota" in text or "usage limit" in text:
        return "provider_quota"
    if "auth" in text or "login" in text or "credential" in text or "401" in text:
        return "provider_auth"
    if code == "exec.cli.timeout":
        return "timeout"
    if code == "exec.cli.not_implemented":
        return "not_implemented"
    return "failed"


# ---------------------------------------------------------------- store (DB)


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _ts(iso: str | None) -> float:
    if not iso:
        return 0.0
    try:
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return 0.0


class AccountStore:
    def __init__(self, db: Database, vault: SecretVault) -> None:
        self._db = db
        self._vault = vault

    # pool config
    def pool(self, provider: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT * FROM provider_pool WHERE provider = ?", (provider,))
        if row is None:
            return {"provider": provider, "enabled": False, "strategy": "least_busy"}
        return {"provider": provider, "enabled": bool(row["enabled"]), "strategy": row["strategy"]}

    def set_pool(self, provider: str, *, enabled: bool | None = None, strategy: str | None = None) -> dict:
        cur = self.pool(provider)
        en = cur["enabled"] if enabled is None else enabled
        st = cur["strategy"] if strategy is None else strategy
        self._db.execute(
            """
            INSERT INTO provider_pool (provider, enabled, strategy, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(provider) DO UPDATE SET enabled=excluded.enabled,
                strategy=excluded.strategy, updated_at=excluded.updated_at
            """,
            (provider, 1 if en else 0, st, now_iso()),
        )
        return self.pool(provider)

    def list(self, provider: str) -> list[dict]:
        rows = self._db.query(
            "SELECT * FROM provider_accounts WHERE provider = ? ORDER BY created_at", (provider,)
        )
        return [dict(r) for r in rows]

    def get(self, account_id: str) -> dict | None:
        row = self._db.query_one("SELECT * FROM provider_accounts WHERE id = ?", (account_id,))
        return dict(row) if row else None

    def create(self, provider: str, *, label: str, auth_mode: str = "oauth", weight: int = 1,
               max_concurrency: int = 8, api_key: str | None = None) -> dict:
        aid = new_id(f"acct_{provider}_")
        secret_ref = None
        if auth_mode == "api_key" and api_key:
            secret_ref = self._vault.put("account", f"{aid}.api_key", api_key)
        now = now_iso()
        self._db.execute(
            """
            INSERT INTO provider_accounts
                (id, provider, label, auth_mode, secret_ref, enabled, weight, max_concurrency,
                 status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
            """,
            (aid, provider, label, auth_mode, secret_ref, weight, max_concurrency,
             "ready" if auth_mode == "api_key" else "unknown", now, now),
        )
        return self.get(aid)  # type: ignore[return-value]

    def update(self, account_id: str, **fields: Any) -> dict | None:
        allowed = {"label", "enabled", "weight", "max_concurrency", "status"}
        sets, params = [], []
        for k, v in fields.items():
            if k in allowed and v is not None:
                sets.append(f"{k} = ?")
                params.append(int(v) if k == "enabled" else v)
        if sets:
            sets.append("updated_at = ?")
            params += [now_iso(), account_id]
            self._db.execute(f"UPDATE provider_accounts SET {', '.join(sets)} WHERE id = ?", params)
        return self.get(account_id)

    def delete(self, account_id: str) -> None:
        acc = self.get(account_id)
        if acc and acc.get("secret_ref"):
            self._vault.delete(acc["secret_ref"])
        self._db.execute("DELETE FROM provider_accounts WHERE id = ?", (account_id,))

    def api_key(self, account: dict) -> str | None:
        ref = account.get("secret_ref")
        if ref and self._vault.exists(ref):
            return self._vault.read(ref)
        return None

    def set_health(self, account_id: str, d: HealthDecision) -> None:
        self._db.execute(
            """UPDATE provider_accounts SET status=?, consecutive_failures=?, cooldown_until=?,
               updated_at=? WHERE id=?""",
            (d.status, d.consecutive_failures, _iso(d.cooldown_until) if d.cooldown_until else None,
             now_iso(), account_id),
        )

    def mark_used(self, account_id: str) -> None:
        self._db.execute(
            "UPDATE provider_accounts SET total_leases=total_leases+1, last_used_at=? WHERE id=?",
            (now_iso(), account_id),
        )

    def mark_ok(self, account_id: str) -> None:
        self._db.execute(
            "UPDATE provider_accounts SET last_ok_at=?, last_error=NULL WHERE id=?",
            (now_iso(), account_id),
        )

    def mark_failure(self, account_id: str, error: str) -> None:
        self._db.execute(
            "UPDATE provider_accounts SET total_failures=total_failures+1, last_error=? WHERE id=?",
            (error[:300], account_id),
        )

    def set_oauth_token(self, account_id: str, token: str) -> None:
        """Store a Claude long-lived token (from `claude setup-token`)."""
        ref = self._vault.put("account", f"{account_id}.token", token)
        self._db.execute(
            "UPDATE provider_accounts SET secret_ref=?, status='ready', updated_at=? WHERE id=?",
            (ref, now_iso(), account_id),
        )

    def oauth_token(self, account: dict) -> str | None:
        ref = account.get("secret_ref")
        if ref and self._vault.exists(ref):
            return self._vault.read(ref)
        return None

    def usable(self, account: dict) -> bool:
        # A credentials file in the account's isolated dir (claude .credentials.json
        # written at sign-in, or codex auth.json from device-auth).
        cfg = account_config_dir(account["provider"], account["id"])
        if any((cfg / f).exists() for f in (".credentials.json", "credentials.json", "auth.json")):
            return True
        # Or a stored API key.
        ref = account.get("secret_ref")
        return bool(ref and self._vault.exists(ref))


# ---------------------------------------------------------------- pool (in-memory)


@dataclass
class Lease:
    account_id: str
    label: str
    provider: str
    auth_mode: str
    home: str
    config_dir: str
    api_key: str = ""
    oauth_token: str = ""  # Claude long-lived token (CLAUDE_CODE_OAUTH_TOKEN)
    is_primary: bool = False
    released: bool = False


PRIMARY_PREFIX = "__primary__"


class AccountPool:
    def __init__(self, store: AccountStore) -> None:
        self._store = store
        self._in_flight: dict[str, int] = {}
        self._state = BalancerState()
        self._lock = threading.Lock()
        # In-memory health for the synthetic "primary" (host) account per provider.
        self._primary_health: dict[str, dict] = {}
        self._primary_last_used: dict[str, float] = {}
        # Plan-utilization cache for usage-based balancing: id -> (percent, fetched_at).
        self._util_cache: dict[str, tuple[float, float]] = {}

    # ---- primary (host) account: the subscription already on this machine ----

    @staticmethod
    def _primary_id(provider: str) -> str:
        return f"{PRIMARY_PREFIX}{provider}"

    @staticmethod
    def _host_cred_dir(provider: str) -> str:
        sub = ".codex" if provider == "codex" else ".claude"
        return os.path.join(os.path.expanduser("~"), sub)

    def _host_usable(self, provider: str) -> bool:
        cfg = self._host_cred_dir(provider)
        return any(
            os.path.exists(os.path.join(cfg, f))
            for f in (".credentials.json", "credentials.json", "auth.json")
        )

    def _primary_snapshot(self, provider: str, now: float) -> AccountSnapshot:
        pid = self._primary_id(provider)
        h = self._primary_health.get(pid, {})
        return AccountSnapshot(
            id=pid,
            enabled=True,
            usable=self._host_usable(provider),
            status=h.get("status", "ready"),
            weight=1,
            max_concurrency=8,
            in_flight=self._in_flight.get(pid, 0),
            cooldown_until=h.get("cooldown_until", 0.0),
            last_used=self._primary_last_used.get(pid, 0.0),
            total_leases=0,
            consecutive_failures=h.get("consecutive_failures", 0),
        )

    def _snapshot(self, acc: dict, now: float) -> AccountSnapshot:
        return AccountSnapshot(
            id=acc["id"],
            enabled=bool(acc["enabled"]),
            usable=self._store.usable(acc),
            status=acc["status"],
            weight=acc["weight"],
            max_concurrency=acc["max_concurrency"],
            in_flight=self._in_flight.get(acc["id"], 0),
            cooldown_until=_ts(acc.get("cooldown_until")),
            last_used=_ts(acc.get("last_used_at")),
            total_leases=acc["total_leases"],
            consecutive_failures=acc["consecutive_failures"],
        )

    def _utilization(self, provider: str, acc_id: str, *, primary: bool = False, account: dict | None = None) -> float:
        """Plan utilization % for an account, cached 60s (usage-based balancing)."""
        now = time.time()
        cached = self._util_cache.get(acc_id)
        if cached and now - cached[1] < 60:
            return cached[0]
        util = cached[0] if cached else 0.0
        try:
            from app.providers import subscription as sub

            if provider == "claude":
                cdir = self._host_cred_dir(provider) if primary else str(account_config_dir(provider, acc_id))
                util = sub.max_utilization(sub.claude_subscription(cdir))
            elif provider == "codex":
                cdir = self._host_cred_dir(provider) if primary else str(account_config_dir(provider, acc_id))
                util = sub.max_utilization(sub.codex_subscription(cdir))
        except Exception:
            pass
        self._util_cache[acc_id] = (util, now)
        return util

    def acquire(self, provider: str) -> Lease | None:
        cfg = self._store.pool(provider)
        if not cfg["enabled"]:
            return None
        accounts = self._store.list(provider)
        by_id = {a["id"]: a for a in accounts}
        pid = self._primary_id(provider)
        now = time.time()
        usage_based = cfg["strategy"] == "most_remaining"

        # Compute utilization OUTSIDE the lock (cached; may do a short HTTP call).
        util_map: dict[str, float] = {}
        if usage_based:
            if self._host_usable(provider):
                util_map[pid] = self._utilization(provider, pid, primary=True)
            for a in accounts:
                util_map[a["id"]] = self._utilization(provider, a["id"], account=a)

        with self._lock:
            snaps: list[AccountSnapshot] = []
            if self._host_usable(provider):
                s = self._primary_snapshot(provider, now)
                if usage_based:
                    s = replace(s, utilization=util_map.get(pid, 0.0))
                snaps.append(s)
            for a in accounts:
                s = self._snapshot(a, now)
                if usage_based:
                    s = replace(s, utilization=util_map.get(a["id"], 0.0))
                snaps.append(s)
            if not snaps:
                return None
            pick = choose(snaps, strategy=cfg["strategy"], now=now, state=self._state)
            if pick is None:
                pick = over_capacity(snaps, now=now)
            if pick is None:
                return None
            self._in_flight[pick.id] = self._in_flight.get(pick.id, 0) + 1
        if pick.id == pid:
            self._primary_last_used[pid] = now
            return Lease(
                account_id=pid,
                label="Primary · this machine",
                provider=provider,
                auth_mode="oauth",
                home=os.path.expanduser("~"),
                config_dir=self._host_cred_dir(provider),
                is_primary=True,
            )
        acc = by_id[pick.id]
        self._store.mark_used(acc["id"])
        token = self._store.oauth_token(acc) if acc["auth_mode"] == "oauth" else ""
        api_key = self._store.api_key(acc) if acc["auth_mode"] == "api_key" else ""
        return Lease(
            account_id=acc["id"],
            label=acc["label"],
            provider=provider,
            auth_mode=acc["auth_mode"],
            home=str(account_home(provider, acc["id"])),
            config_dir=str(account_config_dir(provider, acc["id"])),
            api_key=api_key or "",
            oauth_token=token or "",
        )

    def report(self, lease: Lease | None, *, ok: bool, code: str | None = None, error: str | None = None) -> None:
        if lease is None:
            return
        if lease.account_id.startswith(PRIMARY_PREFIX):
            snap = self._primary_snapshot(lease.provider, time.time())
            d = apply_outcome(snap, ok=ok, code=code, now=time.time(), policy=HealthPolicy())
            self._primary_health[lease.account_id] = {
                "status": d.status,
                "cooldown_until": d.cooldown_until,
                "consecutive_failures": d.consecutive_failures,
            }
            self._release(lease)
            return
        acc = self._store.get(lease.account_id)
        if acc is not None:
            snap = self._snapshot(acc, time.time())
            d = apply_outcome(snap, ok=ok, code=code, now=time.time(), policy=HealthPolicy())
            self._store.set_health(lease.account_id, d)
            if ok:
                self._store.mark_ok(lease.account_id)
            else:
                self._store.mark_failure(lease.account_id, f"{code or 'unknown'}: {error or ''}")
        self._release(lease)

    def _release(self, lease: Lease) -> None:
        if lease.released:
            return
        lease.released = True
        with self._lock:
            n = self._in_flight.get(lease.account_id, 0) - 1
            if n > 0:
                self._in_flight[lease.account_id] = n
            else:
                self._in_flight.pop(lease.account_id, None)

    def public_accounts(self, provider: str) -> list[dict]:
        """Accounts with live health for the admin UI (no secrets).

        The host subscription is surfaced first as a non-deletable "primary"
        account so the whole page is account-centric."""
        now = time.time()
        out = []
        if self._host_usable(provider):
            snap = self._primary_snapshot(provider, now)
            reason = ineligible_reason(snap, now=now)
            out.append({
                "id": snap.id,
                "label": "Primary · this machine",
                "primary": True,
                "auth_mode": "oauth",
                "enabled": True,
                "weight": snap.weight,
                "max_concurrency": snap.max_concurrency,
                "status": snap.status,
                "usable": True,
                "in_flight": snap.in_flight,
                "eligible": reason is None,
                "ineligible_reason": reason,
                "utilization": self._utilization(provider, snap.id, primary=True),
                "total_leases": 0,
                "total_failures": 0,
                "consecutive_failures": snap.consecutive_failures,
                "cooldown_until": None,
                "last_used_at": None,
                "last_ok_at": None,
                "last_error": None,
            })
        for a in self._store.list(provider):
            snap = self._snapshot(a, now)
            reason = ineligible_reason(snap, now=now)
            out.append({
                "id": a["id"],
                "label": a["label"],
                "primary": False,
                "auth_mode": a["auth_mode"],
                "enabled": bool(a["enabled"]),
                "weight": a["weight"],
                "max_concurrency": a["max_concurrency"],
                "status": a["status"],
                "usable": snap.usable,
                "in_flight": snap.in_flight,
                "eligible": reason is None,
                "ineligible_reason": reason,
                "utilization": self._utilization(provider, a["id"], account=a) if snap.usable else None,
                "total_leases": a["total_leases"],
                "total_failures": a["total_failures"],
                "consecutive_failures": a["consecutive_failures"],
                "cooldown_until": a.get("cooldown_until"),
                "last_used_at": a.get("last_used_at"),
                "last_ok_at": a.get("last_ok_at"),
                "last_error": a.get("last_error"),
            })
        return out

    def clear_cooldown(self, account_id: str) -> None:
        if account_id.startswith(PRIMARY_PREFIX):
            self._primary_health.pop(account_id, None)
            return
        self._store.set_health(account_id, HealthDecision("ready", 0, 0.0))
