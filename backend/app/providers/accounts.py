"""Multi-account pool with load balancing — adapted from memora's claude_pool.

Connect multiple provider accounts (e.g. several Claude Code subscriptions) and
spread turns across them with rate-limit-aware failover. Each account is
isolated by its own HOME + CLAUDE_CONFIG_DIR so one account never reads
another's tokens.

Three layers:
  * pure balancer functions (strategy + health policy) — easy to reason about,
  * ``AccountStore`` — DB-backed CRUD + health persistence,
  * ``AccountPool`` — in-memory counters (active turns, live leases), live
    rate-limit state, select()/begin_turn()/end_turn()/release().

Chats are sticky: a chat goes back to the account it ran on last (its prompt
cache lives there — moving a big context to another account means writing it
into that account's cache again, at twice the input price) unless that
account is unusable, or close to a limit while another one has headroom.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings
from app.db import Database
from app.providers import login_session
from app.providers.plan_fetch import PlanFetcher
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


# Everything in the host's ~/.claude / ~/.codex is shared with pooled accounts
# EXCEPT their own credentials. Sessions/projects (so --resume works whichever
# account the balancer picks next), memory, CLAUDE.md/AGENTS.md, settings and
# hooks, skills, commands, agents, plugins — identical on every account.
_PRIVATE = {
    "claude": {".credentials.json", ".claude.json", "backups", ".last-cleanup", ".last-update-result.json"},
    "codex": {"auth.json", ".tmp", "tmp", "installation_id"},
}
_link_lock = threading.Lock()


def _host_config_dir(provider: str) -> Path:
    return Path(os.path.expanduser("~/.codex" if provider == "codex" else "~/.claude"))


def _merge_into(src: Path, dst: Path) -> None:
    """Move files from an account-local dir into the shared host dir (host
    copies win), so nothing an account wrote before linking is lost."""
    for root, _dirs, files in os.walk(src):
        rel = Path(root).relative_to(src)
        for f in files:
            target = dst / rel / f
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    shutil.move(str(Path(root) / f), str(target))
                except OSError:
                    pass


def link_shared_state(provider: str, account_id: str) -> None:
    """Point a pooled account's config dir at the host's shared state."""
    host = _host_config_dir(provider)
    if not host.is_dir():
        return
    _, cfg = ensure_account_dirs(provider, account_id)
    private = _PRIVATE.get(provider, set())
    with _link_lock:
        for entry in host.iterdir():
            if entry.name in private:
                continue
            target = cfg / entry.name
            if target.is_symlink():
                if os.readlink(target) == str(entry):
                    continue
                target.unlink()
            elif target.is_dir() and entry.is_dir():
                _merge_into(target, entry)
                shutil.rmtree(target, ignore_errors=True)
            elif target.exists():
                target.rename(target.with_name(target.name + ".account-local"))
            try:
                target.symlink_to(entry)
            except OSError:
                pass
        if provider == "claude":
            _sync_mcp_servers(cfg)


def _sync_mcp_servers(cfg: Path) -> None:
    """User-scope MCP servers live in ~/.claude.json, which is per-account
    (it also holds the account's oauth identity) — copy just that key over."""
    try:
        host_cfg = json.load(open(os.path.expanduser("~/.claude.json")))
    except (OSError, ValueError):
        return
    servers = host_cfg.get("mcpServers")
    if not servers:
        return
    path = cfg / ".claude.json"
    try:
        acc_cfg = json.load(open(path)) if path.exists() else {}
    except (OSError, ValueError):
        return
    if acc_cfg.get("mcpServers") == servers:
        return
    acc_cfg["mcpServers"] = servers
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w") as fh:
        json.dump(acc_cfg, fh, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def write_claude_credentials(account_id: str, creds: dict) -> None:
    """Write a Claude account's OAuth credentials to its isolated config dir.

    The CLI reads+refreshes ``.credentials.json`` there on every turn (via
    CLAUDE_CONFIG_DIR), so the account's token stays fresh automatically.
    """
    _, cfg = ensure_account_dirs("claude", account_id)
    merge_claude_credentials(str(cfg / ".credentials.json"), creds)


def merge_claude_credentials(path: str, creds: dict) -> None:
    """Merge new OAuth credentials into a CLI credentials file atomically,
    keeping fields the CLI wrote itself (rateLimitTier, refreshTokenExpiresAt,
    other top-level keys) instead of replacing the whole file."""
    try:
        with open(path) as fh:
            current = json.load(fh)
        if not isinstance(current, dict):
            current = {}
    except (OSError, ValueError):
        current = {}
    for key, value in creds.items():
        if isinstance(value, dict) and isinstance(current.get(key), dict):
            merged = {**current[key], **value}
            if key == "claudeAiOauth" and "refreshTokenExpiresAt" not in value and value.get("refreshToken"):
                # a new refresh token: the old one's end date isn't its own
                merged.pop("refreshTokenExpiresAt", None)
            current[key] = merged
        else:
            current[key] = value
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(current, fh)
    os.replace(tmp, path)


# ---------------------------------------------------------------- balancer (pure)

# An account this close to a plan limit isn't picked (nor kept, on respawn)
# while another account has headroom: switching costs one cache re-write of
# the chat's context, hitting the limit mid-turn costs a failed turn. Per
# provider in the pool settings; these are the defaults.
NEAR_LIMIT_5H = 90.0
NEAR_LIMIT_7D = 95.0
# How the host's own login ("Primary · this machine", shared with e.g. VS
# Code) takes part when load balancing is on.
PRIMARY_MODES = ("normal", "fallback", "off")


@dataclass(frozen=True)
class AccountSnapshot:
    id: str
    enabled: bool = True
    usable: bool = True
    status: str = "ready"
    weight: int = 1
    max_concurrency: int = 8
    in_flight: int = 0                # active turns on this account
    cooldown_until: float = 0.0
    last_used: float = 0.0
    total_leases: int = 0
    consecutive_failures: int = 0
    utilization: float | None = 0.0  # plan usage % (0..100); None = unknown (API key, fetch failed)
    five: float | None = None        # 5-hour window % (live or fetched); None = unknown
    seven: float | None = None       # 7-day window %
    is_primary: bool = False
    label: str = ""
    # False when the login can't work without the user (needs a sign-in,
    # renewal failed) — read locally from the credentials (login_session.py).
    session_ok: bool = True

    @property
    def load(self) -> float:
        return self.in_flight / max(1, self.max_concurrency)

    @property
    def remaining(self) -> float | None:
        return None if self.utilization is None else max(0.0, 100.0 - self.utilization)


# Which plan window decides between accounts: "balanced" = whichever window
# is fuller; "seven_day" spreads the weekly budget first (keeps every account
# alive until its 7-day reset), with the 5-hour window as the tiebreak;
# "five_hour" the reverse.
LIMIT_PRIORITIES = ("balanced", "seven_day", "five_hour")


@dataclass(frozen=True)
class LimitPolicy:
    five_hour: float = NEAR_LIMIT_5H
    seven_day: float = NEAR_LIMIT_7D
    priority: str = "balanced"


@dataclass
class BalancerState:
    cursor: int = 0
    current_weights: dict[str, int] = field(default_factory=dict)


def ineligible_reason(a: AccountSnapshot, *, now: float) -> str | None:
    """Why an account can't take a new engine/turn at all (hard reasons)."""
    if not a.enabled:
        return "disabled"
    if not a.usable:
        return "no_credentials"
    if a.status == "expired":
        return "expired"
    if not a.session_ok:
        return "session_expired"
    if a.cooldown_until and a.cooldown_until > now:
        return "cooling_down"
    if a.max_concurrency > 0 and a.in_flight >= a.max_concurrency:
        return "at_capacity"
    return None


def near_limit_reason(a: AccountSnapshot, limits: LimitPolicy) -> str | None:
    """Soft reason: the account works but is close to a plan limit (the
    prioritized window is reported first when both are)."""
    near5 = a.five is not None and a.five >= limits.five_hour
    near7 = a.seven is not None and a.seven >= limits.seven_day
    if near7 and (limits.priority == "seven_day" or not near5):
        return "near_7d"
    return "near_5h" if near5 else None


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


def _usage_key(a: AccountSnapshot, priority: str) -> tuple[float, float]:
    """(deciding %, tiebreak %) for an account under a window priority. A
    missing window falls back to the overall utilization."""
    util = a.utilization or 0.0
    seven = a.seven if a.seven is not None else util
    five = a.five if a.five is not None else util
    if priority == "seven_day":
        return round(seven, 2), round(five, 2)
    if priority == "five_hour":
        return round(five, 2), round(seven, 2)
    return round(util, 2), round(min(seven, five), 2)  # the fuller window decides, the other breaks ties


def _most_remaining(cands: list[AccountSnapshot], priority: str = "balanced") -> AccountSnapshot:
    # Pick the account with the most plan headroom in the prioritized window,
    # then the least busy. Unknown usage (API-key accounts, failed fetch)
    # sorts LAST — it must not look like an empty plan and soak up every turn.
    return min(cands, key=lambda a: (
        a.utilization is None and a.five is None and a.seven is None,
        *_usage_key(a, priority), round(a.load, 6), a.last_used, a.id,
    ))


def _by_strategy(
    cands: list[AccountSnapshot], strategy: str, state: BalancerState, priority: str = "balanced",
) -> AccountSnapshot:
    if strategy == "round_robin":
        return _round_robin(cands, state)
    if strategy == "weighted":
        return _weighted(cands, state)
    if strategy == "least_recently_used":
        return _lru(cands)
    if strategy == "most_remaining":
        return _most_remaining(cands, priority)
    return _least_busy(cands)


def candidates(
    accounts: list[AccountSnapshot], *, now: float, limits: LimitPolicy | None = None,
    primary_mode: str = "normal", avoid: frozenset[str] | set[str] = frozenset(),
) -> list[list[AccountSnapshot]]:
    """Usable accounts in preference tiers: accounts with headroom first, then
    near-limit ones (better than failing). With ``primary_mode="fallback"``
    the host login comes after every other account with headroom; ``"off"``
    leaves it out."""
    limits = limits or LimitPolicy()
    usable = [
        a for a in accounts
        if a.id not in avoid and ineligible_reason(a, now=now) is None
        and not (a.is_primary and primary_mode == "off")
    ]
    fresh = [a for a in usable if near_limit_reason(a, limits) is None]
    near = [a for a in usable if near_limit_reason(a, limits) is not None]
    # With a prioritized window, an account near only the OTHER window beats
    # one near the prioritized window (7-day first: a full 5-hour window
    # resets within hours; a full week doesn't).
    if limits.priority in ("seven_day", "five_hour"):
        worst = "near_7d" if limits.priority == "seven_day" else "near_5h"
        near_groups = [[a for a in near if near_limit_reason(a, limits) != worst],
                       [a for a in near if near_limit_reason(a, limits) == worst]]
    else:
        near_groups = [near]
    tiers: list[list[AccountSnapshot]] = []
    for group in [fresh, *near_groups]:
        if primary_mode == "fallback":
            tiers += [[a for a in group if not a.is_primary], [a for a in group if a.is_primary]]
        else:
            tiers.append(group)
    return [t for t in tiers if t]


def choose(
    accounts: list[AccountSnapshot], *, strategy: str, now: float, state: BalancerState,
    limits: LimitPolicy | None = None, primary_mode: str = "normal",
    avoid: frozenset[str] | set[str] = frozenset(),
) -> AccountSnapshot | None:
    tiers = candidates(accounts, now=now, limits=limits, primary_mode=primary_mode, avoid=avoid)
    if not tiers:
        return None
    limits = limits or LimitPolicy()
    if tiers[0] and near_limit_reason(tiers[0][0], limits) is not None:
        # every option is near a limit: the one furthest from it
        return _most_remaining(tiers[0], limits.priority)
    return _by_strategy(tiers[0], strategy, state, limits.priority)


def sticky_reason(
    prev: AccountSnapshot, accounts: list[AccountSnapshot], *, now: float, limits: LimitPolicy | None = None,
    primary_mode: str = "normal", avoid: frozenset[str] | set[str] = frozenset(),
) -> str | None:
    """Why a chat's previous account should NOT be reused (None = reuse it).

    Staying put keeps the prompt cache (it is per account), so only hard
    reasons always move a chat; soft ones (near a limit, the primary login
    in fallback mode) move it only when a better account exists."""
    limits = limits or LimitPolicy()
    if prev.id in avoid:
        return "failed"
    if prev.is_primary and primary_mode == "off":
        return "excluded"
    hard = ineligible_reason(prev, now=now)
    if hard:
        return hard
    others = [a for a in accounts if a.id != prev.id]
    tiers = candidates(others, now=now, limits=limits, primary_mode=primary_mode, avoid=avoid)
    better = bool(tiers) and near_limit_reason(tiers[0][0], limits) is None and not (
        primary_mode == "fallback" and tiers[0][0].is_primary
    )
    near = near_limit_reason(prev, limits)
    if near and better:
        return near
    if prev.is_primary and primary_mode == "fallback" and better:
        return "fallback_only"
    return None


def over_capacity(accounts: list[AccountSnapshot], *, now: float) -> AccountSnapshot | None:
    full = [a for a in accounts if ineligible_reason(a, now=now) == "at_capacity"]
    return min(full, key=lambda a: (a.in_flight, a.id)) if full else None


@dataclass(frozen=True)
class HealthPolicy:
    failure_threshold: int = 3
    failure_cooldown_s: float = 120.0
    rate_limit_cooldown_s: float = 900.0
    quota_cooldown_s: float = 3600.0     # a limit whose reset time is unknown
    max_cooldown_s: float = 6 * 3600.0   # cap for the failure backoff
    max_reset_wait_s: float = 8 * 86400.0  # a known reset can be days away (7-day window)


@dataclass(frozen=True)
class HealthDecision:
    status: str
    consecutive_failures: int
    cooldown_until: float


_NEUTRAL = {"cancelled", "context_limit", "credits_exhausted", "not_implemented"}


def _until(reset: float | None, default: float, now: float, policy: HealthPolicy) -> float:
    """Cooldown end: the limit's own reset time when known (+ a little slack
    for clock skew), else the policy default."""
    if reset and reset > now:
        return min(reset + 15.0, now + policy.max_reset_wait_s)
    return default


def apply_outcome(
    a: AccountSnapshot, *, ok: bool, code: str | None, now: float, policy: HealthPolicy,
    until: float | None = None,
) -> HealthDecision:
    if ok:
        return HealthDecision("ready", 0, 0.0)
    if code in _NEUTRAL:
        return HealthDecision(a.status, a.consecutive_failures, a.cooldown_until)
    fails = a.consecutive_failures + 1
    if code == "provider_auth":
        return HealthDecision("expired", fails, 0.0)
    if code == "rate_limited":
        return HealthDecision("cooldown", fails, _until(until, now + policy.rate_limit_cooldown_s, now, policy))
    if code == "provider_quota":
        return HealthDecision("cooldown", fails, _until(until, now + policy.quota_cooldown_s, now, policy))
    if fails >= policy.failure_threshold:
        backoff = min(
            policy.max_cooldown_s,
            policy.failure_cooldown_s * (2 ** (fails - policy.failure_threshold)),
        )
        return HealthDecision("cooldown", fails, now + backoff)
    return HealthDecision(a.status, fails, a.cooldown_until)


# Word-boundary patterns: "generated" must not read as "rate", a path like
# "/author-site" must not read as "auth", an id containing 429 isn't HTTP 429.
_RATE = re.compile(r"\b(rate[ _-]?limit\w*|too many requests|overloaded(_error)?|http\s*429|status\s*429|\b429\b(?=\s*(too many|rate)))", re.I)
# Plan / spend limits in the CLI's own words ("You've hit your limit · resets
# 2pm", "You've reached your weekly limit", "You're out of usage credits"…).
_QUOTA = re.compile(
    r"\b(usage limit|quota|credit balance|out of credits|limit reached|out of usage credits|"
    r"(you'?ve|you have) (hit|reached) your\b[^.\n]{0,40}?\blimit|spend limit|shared budget)\b",
    re.I,
)
_AUTH = re.compile(
    r"\b(invalid api key|authentication[_ ]error|unauthori[sz]ed|oauth token (has )?expired|"
    r"token (is )?expired|please run /login|not logged in|log in again|invalid_grant|http\s*401|status\s*401)\b",
    re.I,
)
# Outcomes that say the ACCOUNT can't serve this turn: worth another account.
ACCOUNT_OUTCOMES = ("provider_quota", "rate_limited", "provider_auth")


def classify_error(code: str | None, message: str | None, api_error: dict | None = None) -> str:
    """Map a provider error event to a balancer outcome code.

    Only errors that say something about the ACCOUNT move it into cooldown /
    expired; workspace, tool, MCP or user-caused failures never do. The CLI's
    typed API error (``api_error`` on its synthetic error message) wins over
    the message text when present.
    """
    code = code or ""
    if code in ("exec.cli.timeout",):
        return "timeout"
    if code == "exec.cli.not_implemented":
        return "not_implemented"
    if code.startswith(("exec.workspace", "attachment", "turn.", "upload", "account.")):
        return "failed"
    if api_error:
        kind, err = api_error.get("kind"), api_error.get("error")
        if kind == "usage_limit_reached" or err == "billing_error":
            return "provider_quota"
        if err in ("authentication_failed", "oauth_org_not_allowed"):
            return "provider_auth"
        if err == "rate_limit":
            return "provider_quota" if _QUOTA.search(message or "") else "rate_limited"
    text = message or ""
    if "mcp" in text.lower() and _AUTH.search(text):
        return "failed"  # an MCP server's own auth, not the account
    if _QUOTA.search(text):
        return "provider_quota"
    if _RATE.search(text):
        return "rate_limited"
    if _AUTH.search(text):
        return "provider_auth"
    return "failed"


_LIMIT_NAMES = {
    "five_hour": "5-hour limit", "seven_day": "weekly limit", "seven_day_opus": "weekly Opus limit",
    "seven_day_sonnet": "weekly Sonnet limit", "seven_day_overage_included": "weekly limit",
    "overage": "extra-usage limit",
}


def limit_name(rate_limit_type: str | None) -> str:
    return _LIMIT_NAMES.get(rate_limit_type or "", "usage limit")


def fmt_clock(ts: float | None, now: float | None = None) -> str:
    """'14:20' (today-ish) or 'Thu 14:20' (further out), server local time."""
    if not ts:
        return ""
    now = now or time.time()
    dt = datetime.fromtimestamp(ts).astimezone()
    return dt.strftime("%H:%M") if ts - now < 20 * 3600 else dt.strftime("%a %H:%M")


def describe_reason(reason: str | None, a: AccountSnapshot | None = None, *, now: float | None = None,
                    limit: dict | None = None) -> str:
    """A balancer reason as a phrase after the account's name."""
    now = now or time.time()
    if reason == "cooling_down" and a is not None:
        if limit and limit.get("resets_at"):
            return f"hit its {limit_name(limit.get('type'))} (resets {fmt_clock(limit['resets_at'], now)})"
        return f"is cooling down until {fmt_clock(a.cooldown_until, now)}"
    if reason == "near_5h" and a is not None:
        return f"is at {round(a.five or 0)}% of its 5-hour limit"
    if reason == "near_7d" and a is not None:
        return f"is at {round(a.seven or 0)}% of its weekly limit"
    if reason == "at_capacity" and a is not None:
        return f"is busy ({a.in_flight}/{a.max_concurrency} turns)"
    return {
        "disabled": "is disabled",
        "no_credentials": "has no credentials",
        "expired": "needs to sign in again",
        "session_expired": "needs to sign in again (its login can't be renewed)",
        "excluded": "is excluded from load balancing",
        "fallback_only": "is only used when no other account is available",
        "removed": "is no longer connected",
        "failed": "just failed this turn",
        "manual": "was switched away from by hand",
    }.get(reason or "", reason or "is unavailable")


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

    # pool config (+ the provider's engine settings that live with it)
    _POOL_DEFAULTS: dict[str, Any] = {
        "enabled": False, "strategy": "least_busy", "primary_mode": "normal",
        "near_5h": NEAR_LIMIT_5H, "near_7d": NEAR_LIMIT_7D, "limit_priority": "balanced",
        # Claude: CLAUDE_CODE_AUTO_COMPACT_WINDOW for every chat without its
        # own value; 0 = the CLI's default (the model's full window).
        "auto_compact_window": 0,
    }

    def pool(self, provider: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT * FROM provider_pool WHERE provider = ?", (provider,))
        out: dict[str, Any] = {"provider": provider, **self._POOL_DEFAULTS}
        if row is None:
            return out
        keys = row.keys()
        out["enabled"] = bool(row["enabled"])
        out["strategy"] = row["strategy"]
        if "primary_mode" in keys and row["primary_mode"] in PRIMARY_MODES:
            out["primary_mode"] = row["primary_mode"]
        if "limit_priority" in keys and row["limit_priority"] in LIMIT_PRIORITIES:
            out["limit_priority"] = row["limit_priority"]
        for k in ("near_5h", "near_7d"):
            if k in keys and row[k] is not None:
                out[k] = float(row[k])
        if "auto_compact_window" in keys and row["auto_compact_window"]:
            out["auto_compact_window"] = int(row["auto_compact_window"])
        return out

    def set_pool(self, provider: str, **fields: Any) -> dict:
        cur = self.pool(provider)
        for k, v in fields.items():
            if k in self._POOL_DEFAULTS and v is not None:
                cur[k] = v
        if cur["primary_mode"] not in PRIMARY_MODES:
            raise ValueError(f"unknown primary mode: {cur['primary_mode']}")
        if cur["limit_priority"] not in LIMIT_PRIORITIES:
            raise ValueError(f"unknown limit priority: {cur['limit_priority']}")
        for k in ("near_5h", "near_7d"):
            cur[k] = min(100.0, max(50.0, float(cur[k])))
        cur["auto_compact_window"] = max(0, int(cur["auto_compact_window"] or 0))
        self._db.execute(
            """
            INSERT INTO provider_pool (provider, enabled, strategy, primary_mode, near_5h, near_7d,
                                       limit_priority, auto_compact_window, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider) DO UPDATE SET enabled=excluded.enabled, strategy=excluded.strategy,
                primary_mode=excluded.primary_mode, near_5h=excluded.near_5h, near_7d=excluded.near_7d,
                limit_priority=excluded.limit_priority,
                auto_compact_window=excluded.auto_compact_window, updated_at=excluded.updated_at
            """,
            (provider, 1 if cur["enabled"] else 0, cur["strategy"], cur["primary_mode"], cur["near_5h"],
             cur["near_7d"], cur["limit_priority"], cur["auto_compact_window"], now_iso()),
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
        self._db.execute("DELETE FROM provider_plan_cache WHERE account_id = ?", (account_id,))

    # plan-usage cache: last numbers + backoff (plan_fetch.PlanFetcher's persist)
    def load_plan_entries(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for r in self._db.query("SELECT account_id, data FROM provider_plan_cache"):
            try:
                out[r["account_id"]] = json.loads(r["data"])
            except ValueError:
                continue
        return out

    def save_plan_entry(self, key: str, data: dict) -> None:
        self._db.execute(
            """INSERT INTO provider_plan_cache (account_id, data, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(account_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at""",
            (key, json.dumps(data), now_iso()),
        )

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
    """An account bound to one engine (persistent Claude) or one turn (one-shot).

    ``turn_active`` marks that this lease currently counts as an active turn
    on its account (``in_flight``); begin/end are idempotent per lease, so a
    crash, cancel or double cleanup can never leak or double-release a slot.
    """

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
    turn_active: bool = False
    # Why the balancer picked it: sticky (the chat's previous account),
    # strategy (first pick / previous one unusable), and what happened to the
    # previous account (for the "switched account" notice).
    reason: str = "strategy"
    previous_id: str | None = None
    previous_label: str | None = None
    previous_why: str | None = None


class AccountUnavailable(RuntimeError):
    """Load balancing is on but no account can take the turn right now."""

    def __init__(self, message: str, *, earliest: float | None = None) -> None:
        super().__init__(message)
        self.earliest = earliest


PRIMARY_PREFIX = "__primary__"
PRIMARY_LABEL = "Primary · this machine"
# Plan usage is fetched over HTTPS through one PlanFetcher (plan_fetch.py): at
# most one request per account per PLAN_TTL_S, Retry-After / backoff on errors.
PLAN_TTL_S = PlanFetcher.ttl_s
SESSION_CHECK_S = 300.0  # background login-session check (local files only)


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


class AccountPool:
    def __init__(self, store: AccountStore, *, persist_plans: bool = False, fetch_plans: bool = True) -> None:
        self._store = store
        self._in_flight: dict[str, int] = {}   # active turns per account
        self._bound: dict[str, int] = {}       # live leases (engines / one-shot turns) per account
        self._state = BalancerState()
        self._lock = threading.Lock()
        # In-memory health for the synthetic "primary" (host) account per provider.
        self._primary_health: dict[str, dict] = {}
        self._primary_last_used: dict[str, float] = {}
        # Plan usage per account (windows, last fetch, backoff): one fetcher
        # for the page, the balancer and the Usage dialog (plan_fetch.py).
        self._plans = PlanFetcher(persist=store if persist_plans else None, enabled=fetch_plans)
        # What engines saw live (rate_limit_event), per account:
        # {"five_hour": (pct, resets_at, at), "seven_day": (...), "status", "at", "limit"?}
        self._live: dict[str, dict[str, Any]] = {}
        # Login sessions: the last renewal per account ({at, ok, method, code,
        # error, definitive, sig}) and the last health the background check saw.
        self._renew: dict[str, dict] = {}
        self._renew_locks: dict[str, threading.Lock] = {}
        self._session_seen: dict[str, str] = {}

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
        if any(os.path.exists(os.path.join(cfg, f)) for f in (".credentials.json", "credentials.json", "auth.json")):
            return True
        from .native_login import logged_in
        from app.services.cli_tools.tools import effective_binary
        return logged_in(provider, effective_binary(provider))

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
            is_primary=True,
            label=PRIMARY_LABEL,
            session_ok=self._session_ok(provider, pid, primary=True, now=now),
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
            label=acc["label"],
            session_ok=self._session_ok(acc["provider"], acc["id"], account=acc, now=now),
        )

    # ---- login sessions (local files only: login_session.py) ----

    def cred_dir(self, provider: str, acc_id: str, *, primary: bool | None = None) -> str:
        if primary is None:
            primary = acc_id.startswith(PRIMARY_PREFIX)
        return self._host_cred_dir(provider) if primary else str(account_config_dir(provider, acc_id))

    def _session_facts(self, provider: str, acc_id: str, *, primary: bool = False,
                       account: dict | None = None) -> dict:
        if account is not None and account.get("auth_mode") == "api_key":
            return login_session.stored_key_facts("api_key")
        cdir = self.cred_dir(provider, acc_id, primary=primary)
        if provider == "codex":
            return login_session.codex_facts(cdir)
        if primary and os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
            return login_session.stored_key_facts("setup_token")  # the CLI prefers it over the file
        # who it is: the CLI's .claude.json (~/.claude.json for the host login)
        ident = os.path.join(os.path.expanduser("~"), ".claude.json") if primary else os.path.join(cdir, ".claude.json")
        facts = login_session.claude_facts(cdir, identity_file=ident)
        if not facts["present"] and account is not None and self._store.oauth_token(account):
            return login_session.stored_key_facts("setup_token")
        return facts

    def _rejected(self, acc_id: str, account: dict | None) -> bool:
        """The provider refused this login on a turn (status 'expired')."""
        if acc_id.startswith(PRIMARY_PREFIX):
            return (self._primary_health.get(acc_id) or {}).get("status") == "expired"
        return bool(account and account.get("status") == "expired")

    def session_info(self, provider: str, acc_id: str, *, primary: bool | None = None,
                     account: dict | None = None, now: float | None = None) -> dict:
        """The card's view of an account's login (no secrets)."""
        if primary is None:
            primary = acc_id.startswith(PRIMARY_PREFIX)
        if account is None and not primary:
            account = self._store.get(acc_id)
        facts = self._session_facts(provider, acc_id, primary=primary, account=account)
        if primary and not facts.get("present") and self._host_usable(provider):
            facts = login_session.stored_key_facts("native_cli")
        out = login_session.public(facts, now=now, renew=self._renew.get(acc_id),
                                   rejected=self._rejected(acc_id, account))
        if not out["email"] or not out["plan"]:
            prof = (self._plans.entry(acc_id) or None)
            p = (prof.profile if prof else None) or {}
            out["email"] = out["email"] or p.get("email") or ""
            out["organization"] = out["organization"] or p.get("organization") or ""
            out["plan"] = out["plan"] or p.get("plan") or ""
        return out

    def _session_ok(self, provider: str, acc_id: str, *, primary: bool = False, account: dict | None = None,
                    now: float | None = None) -> bool:
        try:
            facts = self._session_facts(provider, acc_id, primary=primary, account=account)
        except Exception:  # noqa: BLE001 - an unreadable file never takes an account out by itself
            return True
        if not facts.get("present"):
            return True  # "no credentials" is its own reason (usable)
        health, _ = login_session.classify(
            now=now or time.time(), present=True, method=facts.get("method") or "oauth",
            expires_at=facts.get("expires_at"), has_refresh=bool(facts.get("has_refresh_token")),
            refresh_expires_at=facts.get("refresh_expires_at"),
            renew_failure=self._failure_for(acc_id, facts), rejected=False,
        )
        return health not in login_session.ACTIONABLE

    def _failure_for(self, acc_id: str, facts: dict) -> dict | None:
        r = self._renew.get(acc_id)
        return r if r and not r.get("ok") and r.get("sig") == facts.get("sig") else None

    def renew_session(self, provider: str, acc_id: str) -> dict:
        """Renew an account's login the CLI's way (session_renew.py). Blocking
        (a CLI run / one HTTPS call): call it off the event loop."""
        from app.providers import session_renew
        from app.services.cli_tools.tools import effective_binary

        primary = acc_id.startswith(PRIMARY_PREFIX)
        account = None if primary else self._store.get(acc_id)
        if not primary and account is None:
            return {"ok": False, "code": "removed", "error": "no such account", "session": None}
        if account is not None and account.get("auth_mode") == "api_key":
            return {"ok": False, "code": "api_key", "error": "an API key has no session to renew",
                    "session": self.session_info(provider, acc_id, account=account)}
        with self._lock:
            lock = self._renew_locks.setdefault(acc_id, threading.Lock())
        if not lock.acquire(blocking=False):
            return {"ok": False, "code": "busy", "error": "already renewing",
                    "session": self.session_info(provider, acc_id, account=account)}
        try:
            cdir = self.cred_dir(provider, acc_id, primary=primary)
            # Same environment a chat on this account runs with (session_service):
            # the real HOME, only the credentials dir differs per account.
            from app.services.managed_node import environment
            env = environment()
            env["HOME"] = os.path.expanduser("~")
            if provider == "codex":
                env.pop("CODEX_HOME", None)
                if not primary:
                    env["CODEX_HOME"] = cdir
                res = session_renew.renew_codex(cdir, env=env, binary=effective_binary("codex"))
            else:
                env.pop("CLAUDE_CONFIG_DIR", None)  # the host login: the CLI's default (~/.claude)
                if not primary:
                    env["CLAUDE_CONFIG_DIR"] = cdir
                    env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)  # would win over the account's own file
                res = session_renew.renew_claude(cdir, env=env, binary=effective_binary("claude"))
            facts = self._session_facts(provider, acc_id, primary=primary, account=account)
            self._renew[acc_id] = {**res, "at": _iso(time.time()), "sig": facts.get("sig")}
            if res.get("ok"):
                # it works again: forget a refusal the engines saw
                if primary:
                    h = self._primary_health.get(acc_id)
                    if h and h.get("status") == "expired":
                        self._primary_health.pop(acc_id, None)
                elif account is not None and account.get("status") in ("expired", "unknown"):
                    self._store.update(acc_id, status="ready")
            return {"ok": bool(res.get("ok")), "method": res.get("method"), "code": res.get("code") or "",
                    "error": res.get("error") or "",
                    "session": self.session_info(provider, acc_id, primary=primary)}
        finally:
            lock.release()

    def check_sessions(self, providers: tuple[str, ...] = ("claude", "codex")) -> list[dict]:
        """The background check: every account's login health from its files
        (no network). Returns the actionable ones (the Settings badge) and
        logs each account once when it becomes actionable."""
        import logging

        log = logging.getLogger("app.providers.sessions")
        items: list[dict] = []
        for provider in providers:
            for acc in self.public_session_list(provider):
                key, health = acc["account_id"], acc["health"]
                prev = self._session_seen.get(key)
                self._session_seen[key] = health
                if acc["actionable"]:
                    items.append(acc)
                    if prev != health:
                        log.warning("%s account %s: login %s (%s)", provider, acc["label"], health, acc["detail"])
        return items

    def public_session_list(self, provider: str) -> list[dict]:
        """(account_id, label, health, detail, actionable) for every enabled
        account of the provider — what the Settings badge looks at."""
        now = time.time()
        out = []
        if self._host_usable(provider):
            pid = self._primary_id(provider)
            s = self.session_info(provider, pid, primary=True, now=now)
            out.append({"provider": provider, "account_id": pid, "label": PRIMARY_LABEL, "primary": True,
                        "health": s["health"], "detail": s["detail"], "actionable": s["actionable"]})
        for a in self._store.list(provider):
            if not a["enabled"]:
                continue
            if not self._store.usable(a):
                continue  # never signed in: the card's own "Sign in" — not a session problem
            s = self.session_info(provider, a["id"], account=a, now=now)
            out.append({"provider": provider, "account_id": a["id"], "label": a["label"], "primary": False,
                        "health": s["health"], "detail": s["detail"], "actionable": s["actionable"]})
        return out

    # ---- plan usage: fetched (plan_fetch.py) + live (rate_limit_event) ----

    def _plan_block(self, provider: str, acc_id: str, *, primary: bool, account: dict | None) -> tuple[dict, tuple[str, str] | None]:
        """(session facts, local block) — a request that can't succeed isn't
        sent: no credentials, an access token that has run out (the CLI
        renews it on its next use; asking with it only earns a 401/429)."""
        facts = self._session_facts(provider, acc_id, primary=primary, account=account)
        if not facts.get("present"):
            return facts, ("no_credentials", "not signed in")
        if facts.get("method") in ("api_key", "setup_token"):
            return facts, None
        health, _ = login_session.classify(
            now=time.time(), present=True, method=facts.get("method") or "oauth", expires_at=facts.get("expires_at"),
            has_refresh=bool(facts.get("has_refresh_token")), refresh_expires_at=facts.get("refresh_expires_at"),
            renew_failure=self._failure_for(acc_id, facts), rejected=self._rejected(acc_id, account),
        )
        if health == "needs_login":
            return facts, ("needs_login", "this login needs a new sign-in")
        if health in ("expired", "refresh_failed"):
            return facts, ("token_expired", "access token expired — renewed on the account's next use")
        return facts, None

    def plan_usage(self, provider: str, acc_id: str, *, primary: bool = False, account: dict | None = None,
                   force: bool = False, want_profile: bool = False) -> dict | None:
        """Plan usage windows (5h, 7d, per-model weekly) for an account — at
        most one request per account per PLAN_TTL_S, shared by every caller,
        backing off on errors (Retry-After on a 429). None when it can't be
        known (API-key account). A failed or skipped fetch keeps the last good
        windows and says why (``error``, ``stale_reason``, ``retry_at``)."""
        if account is not None and account.get("auth_mode") == "api_key":
            return None
        from app.providers import subscription as sub

        cdir = self.cred_dir(provider, acc_id, primary=primary)
        facts, block = self._plan_block(provider, acc_id, primary=primary, account=account)
        if facts.get("method") == "setup_token" and provider == "claude":
            token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") if primary else (
                self._store.oauth_token(account) if account else None)
            if token:
                def fetch(with_profile: bool) -> dict:
                    return sub.claude_usage_from_token(token)

                return self._plans.get(acc_id, fetch, cred_sig=facts.get("sig") or "", force=force)

        def fetch(with_profile: bool) -> dict:
            return sub.subscription_usage(provider, cdir, with_profile=with_profile)

        return self._plans.get(acc_id, fetch, cred_sig=facts.get("sig") or "", local_block=block, force=force,
                               want_profile=want_profile)

    def subscription(self, provider: str, account_id: str | None, *, force: bool = False) -> dict:
        """The Usage dialog's view (``/api/usage/subscription``): the same
        fetcher as the cards (no second cache, no extra requests)."""
        primary = not account_id or account_id.startswith(PRIMARY_PREFIX)
        acc_id = self._primary_id(provider) if primary else account_id
        account = None if primary else self._store.get(acc_id)
        plan = self.plan_usage(provider, acc_id, primary=primary, account=account, force=force, want_profile=True)
        if plan is None:
            return {"provider": provider, "available": False, "error": "API-key account: no plan usage"}
        sess = self.session_info(provider, acc_id, primary=primary, account=account)
        acct = dict(plan.get("account") or {})
        acct.setdefault("auth_method", "ChatGPT" if provider == "codex" else "Claude AI")
        acct["email"] = acct.get("email") or sess.get("email") or ""
        acct["organization"] = acct.get("organization") or sess.get("organization") or ""
        acct["plan"] = acct.get("plan") or sess.get("plan") or ""
        out: dict[str, Any] = {
            "provider": provider,
            "available": bool(plan.get("windows")) or not plan.get("error"),
            "account": acct,
            "windows": plan.get("windows") or [],
            "model_windows": plan.get("model_windows") or [],
            "manage_url": "https://chatgpt.com/#settings" if provider == "codex" else "https://claude.ai/settings/usage",
            "fetched_at": plan.get("fetched_at"),
            "stale_reason": plan.get("stale_reason"),
            "retry_at": plan.get("retry_at"),
        }
        if plan.get("error"):
            if out["windows"]:
                out["stale"] = plan["error"]
            else:
                out["error"] = plan["error"]
        return out

    def _utilization(self, provider: str, acc_id: str, *, primary: bool = False, account: dict | None = None) -> float | None:
        """Highest plan window % for an account (usage-based balancing). None
        when it can't be known (API-key account, no credentials, fetch failed)."""
        plan = self.plan_usage(provider, acc_id, primary=primary, account=account)
        if plan is None or (plan.get("error") and not plan.get("windows")):
            return None
        from app.providers.subscription import max_utilization

        return max_utilization({"available": True, **plan})

    def record_live(self, provider: str, account_id: str | None, info: dict[str, Any]) -> None:
        """Fold an engine's ``rate_limit_event`` into the account's state, so
        balancing uses fresh numbers (not only the 60s plan fetch).

        ``status`` is the server's verdict on requests: ``rejected`` means the
        account is refused until ``resetsAt`` (cooldown until then);
        ``allowed_warning`` only says a warning threshold was passed (the
        near-limit thresholds decide about that); ``allowed`` after a cooldown
        means the account serves requests again."""
        if not account_id or not isinstance(info, dict):
            return
        now = time.time()
        st = dict(self._live.get(account_id) or {})
        uw = info.get("unifiedWindows") or {}
        for kind in ("five_hour", "seven_day"):
            w = uw.get(kind) if isinstance(uw, dict) else None
            if isinstance(w, dict) and isinstance(w.get("utilization"), (int, float)):
                st[kind] = (float(w["utilization"]) * 100.0, _num(w.get("resetsAt")), now)
        rlt = info.get("rateLimitType")
        if rlt in ("five_hour", "seven_day") and isinstance(info.get("utilization"), (int, float)) and not (
            isinstance(uw, dict) and uw.get(rlt)
        ):  # older CLIs report one window at a time
            st[rlt] = (float(info["utilization"]) * 100.0, _num(info.get("resetsAt")), now)
        status = info.get("status")
        st["status"], st["at"] = status, now
        if status == "rejected":
            reset = _num(info.get("resetsAt"))
            st["limit"] = {"type": rlt, "resets_at": reset, "at": now}
            self._live[account_id] = st
            self._cooldown(provider, account_id, reset, code="provider_quota")
            return
        if status in ("allowed", "allowed_warning"):
            st.pop("limit", None)
            self._live[account_id] = st
            self._lift_cooldown(account_id)
            return
        self._live[account_id] = st

    def limit_info(self, account_id: str | None) -> dict | None:
        """The limit that refused this account, while it's still in force."""
        lim = (self._live.get(account_id or "") or {}).get("limit")
        if not lim:
            return None
        reset = lim.get("resets_at")
        if reset and reset <= time.time():
            return None
        return lim

    def _windows(self, provider: str, acc_id: str, *, primary: bool = False, account: dict | None = None,
                 fetch: bool = True) -> tuple[float | None, float | None, float | None]:
        """(5h %, 7d %, highest %) — whichever of live / fetched is newer per
        window. A window whose reset time has passed reads as 0."""
        now = time.time()
        live = self._live.get(acc_id) or {}
        fresh_live = all(k in live and now - live[k][2] < PLAN_TTL_S for k in ("five_hour", "seven_day"))
        plan = None
        if fetch and not fresh_live:
            plan = self.plan_usage(provider, acc_id, primary=primary, account=account)
        else:
            plan = self._plans.cached(acc_id)
        fetched_at = _ts((plan or {}).get("fetched_at"))
        vals: dict[str, float | None] = {"five_hour": None, "seven_day": None}
        for w in (plan or {}).get("windows") or []:
            if w.get("kind") in vals and vals[w["kind"]] is None:
                reset = _ts(w.get("resets_at")) if isinstance(w.get("resets_at"), str) else _num(w.get("resets_at"))
                vals[w["kind"]] = 0.0 if reset and reset <= now else float(w.get("percent") or 0.0)
        for kind in vals:
            lv = live.get(kind)
            if lv and (vals[kind] is None or lv[2] >= fetched_at):
                pct, reset, _at = lv
                vals[kind] = 0.0 if reset and reset <= now else pct
        known = [v for v in vals.values() if v is not None]
        util = max(known) if known else (None if plan is None or (plan.get("error") and not plan.get("windows")) else 0.0)
        return vals["five_hour"], vals["seven_day"], util

    def _plan_fields(self, provider: str, acc_id: str, *, primary: bool = False,
                     account: dict | None = None, usable: bool = True) -> dict:
        """The account-card view of :meth:`plan_usage`, with live engine
        numbers folded in when they're newer (and standing in when no fetch
        has worked yet)."""
        if not usable:
            plan, util = None, None
        else:
            plan = self.plan_usage(provider, acc_id, primary=primary, account=account)
            util = self._utilization(provider, acc_id, primary=primary, account=account)  # cached: no refetch
        windows = [dict(w) for w in (plan or {}).get("windows") or []]
        fetched = (plan or {}).get("fetched_at")
        live = self._live.get(acc_id) or {}
        newest = _ts(fetched)
        if plan is not None and not windows:
            # nothing fetched yet (throttled / token expired): what the engines saw
            labels = {"five_hour": "Session (5hr)", "seven_day": "Weekly (7 day)"}
            for kind in ("five_hour", "seven_day"):
                if live.get(kind):
                    windows.append({"label": labels[kind], "percent": 0, "resets_at": None, "kind": kind})
        for w in windows:
            lv = live.get(w.get("kind"))
            if lv and lv[2] > _ts(fetched):
                w["percent"] = round(lv[0])
                if lv[1]:
                    w["resets_at"] = _iso(lv[1])
                w["source"] = "live"
                newest = max(newest, lv[2])
        live_pcts = [float(w.get("percent") or 0) for w in windows if w.get("source") == "live"]
        if live_pcts:
            util = max([util or 0.0, *live_pcts])
        return {
            "utilization": util,
            "windows": windows,
            "model_windows": (plan or {}).get("model_windows") or [],
            "plan_fetched_at": _iso(newest) if newest else fetched,
            "plan_error": (plan or {}).get("error"),
            "plan_stale_reason": (plan or {}).get("stale_reason"),
            "plan_retry_at": (plan or {}).get("retry_at"),
            "plan_checked_at": (plan or {}).get("checked_at"),
            "live_status": live.get("status"),
        }

    # ---- selection ----

    def _snapshots(self, provider: str, cfg: dict, *, fetch: bool = True) -> tuple[list[AccountSnapshot], dict[str, dict]]:
        """Every account as the balancer sees it (windows fetched OUTSIDE the
        lock: cached, may do a short HTTP call)."""
        accounts = self._store.list(provider)
        by_id = {a["id"]: a for a in accounts}
        pid = self._primary_id(provider)
        now = time.time()
        wins: dict[str, tuple] = {}
        host = self._host_usable(provider)
        if host and cfg.get("primary_mode") != "off":
            wins[pid] = self._windows(provider, pid, primary=True, fetch=fetch)
        for a in accounts:
            if a["enabled"] and self._store.usable(a):
                wins[a["id"]] = self._windows(provider, a["id"], account=a, fetch=fetch)
        snaps: list[AccountSnapshot] = []
        if host:
            s = self._primary_snapshot(provider, now)
            five, seven, util = wins.get(pid, (None, None, None))
            snaps.append(replace(s, five=five, seven=seven, utilization=util))
        for a in accounts:
            s = self._snapshot(a, now)
            five, seven, util = wins.get(a["id"], (None, None, None))
            snaps.append(replace(s, five=five, seven=seven, utilization=util))
        return snaps, by_id

    def select(
        self, provider: str, *, prefer: str | None = None, avoid: set[str] | frozenset[str] = frozenset(),
        begin_turn: bool = False,
    ) -> Lease | None:
        """Lease an account for a chat.

        Sticky: ``prefer`` (the account the chat ran on last) is reused unless
        :func:`sticky_reason` says it shouldn't be — staying on one account
        keeps its prompt cache. Otherwise the pool strategy picks among the
        usable accounts (headroom first). ``avoid`` excludes accounts that
        just failed (failover). ``begin_turn`` counts the lease as an active
        turn atomically with the pick, so concurrent picks can't exceed an
        account's ``max_concurrency``.

        Returns None when load balancing is off (the host login runs it).
        Raises :class:`AccountUnavailable` when it's on and nothing is usable.
        """
        cfg = self._store.pool(provider)
        if not cfg["enabled"]:
            return None
        snaps_all, by_id = self._snapshots(provider, cfg)
        limits = LimitPolicy(cfg.get("near_5h", NEAR_LIMIT_5H), cfg.get("near_7d", NEAR_LIMIT_7D),
                             cfg.get("limit_priority") or "balanced")
        mode = cfg.get("primary_mode") or "normal"
        pid = self._primary_id(provider)
        with self._lock:
            now = time.time()
            # Counters may have moved since the snapshot: re-read them under the lock.
            snaps = [replace(s, in_flight=self._in_flight.get(s.id, 0)) for s in snaps_all]
            by_snap = {s.id: s for s in snaps}
            prev = by_snap.get(prefer) if prefer else None
            prev_why = None
            if prefer and prev is None:
                prev_why = "removed"
            elif prev is not None:
                prev_why = sticky_reason(prev, snaps, now=now, limits=limits, primary_mode=mode, avoid=avoid)
            if prev is not None and prev_why is None:
                pick, reason = prev, "sticky"
            else:
                pick, reason = choose(snaps, strategy=cfg["strategy"], now=now, state=self._state,
                                      limits=limits, primary_mode=mode, avoid=avoid), "strategy"
            if pick is None:
                raise self._unavailable(provider, snaps, now, mode)
            self._bound[pick.id] = self._bound.get(pick.id, 0) + 1
            if begin_turn:
                self._in_flight[pick.id] = self._in_flight.get(pick.id, 0) + 1
        info = dict(
            reason=reason, turn_active=begin_turn,
            previous_id=prefer if prefer and prefer != pick.id else None,
            previous_label=(prev.label if prev is not None else None) if prefer != pick.id else None,
            previous_why=(describe_reason(prev_why, prev, now=now, limit=self.limit_info(prefer))
                          if prev_why and prefer != pick.id else None),
        )
        if pick.id == pid:
            self._primary_last_used[pid] = now
            return Lease(
                account_id=pid, label=PRIMARY_LABEL, provider=provider, auth_mode="oauth",
                home=os.path.expanduser("~"), config_dir=self._host_cred_dir(provider), is_primary=True, **info,
            )
        acc = by_id[pick.id]
        self._store.mark_used(acc["id"])
        token = self._store.oauth_token(acc) if acc["auth_mode"] == "oauth" else ""
        api_key = self._store.api_key(acc) if acc["auth_mode"] == "api_key" else ""
        return Lease(
            account_id=acc["id"], label=acc["label"], provider=provider, auth_mode=acc["auth_mode"],
            home=str(account_home(provider, acc["id"])), config_dir=str(account_config_dir(provider, acc["id"])),
            api_key=api_key or "", oauth_token=token or "", **info,
        )

    def _unavailable(self, provider: str, snaps: list[AccountSnapshot], now: float, mode: str) -> AccountUnavailable:
        parts, waits = [], []
        for s in snaps:
            why = "excluded" if (s.is_primary and mode == "off") else ineligible_reason(s, now=now)
            if why is None:
                continue
            if why == "cooling_down":
                waits.append(s.cooldown_until)
            parts.append(f"{s.label or s.id} {describe_reason(why, s, now=now, limit=self.limit_info(s.id))}")
        earliest = min(waits) if waits else None
        name = "Claude" if provider == "claude" else provider.capitalize()
        msg = f"No {name} account can take this turn right now"
        if parts:
            msg += ": " + "; ".join(parts)
        if earliest:
            msg += f". The earliest one is available again at {fmt_clock(earliest, now)}"
        return AccountUnavailable(msg + ".", earliest=earliest)

    def acquire(self, provider: str) -> Lease | None:
        """Lease for one turn (one-shot providers); None when nothing is usable."""
        try:
            return self.select(provider, begin_turn=True)
        except AccountUnavailable:
            return None

    def peek(self, provider: str, account_id: str) -> tuple[str | None, str]:
        """(hard reason, phrase) an engine's account can't serve another turn
        now — disabled, signed out, cooling down/refused — or (None, "").
        Uses cached numbers only (no HTTP)."""
        cfg = self._store.pool(provider)
        if not cfg["enabled"]:
            return None, ""
        now = time.time()
        if account_id.startswith(PRIMARY_PREFIX):
            s = self._primary_snapshot(provider, now)
            if cfg.get("primary_mode") == "off":
                return "excluded", describe_reason("excluded")
        else:
            acc = self._store.get(account_id)
            if acc is None:
                return "removed", describe_reason("removed")
            s = self._snapshot(acc, now)
        why = ineligible_reason(replace(s, in_flight=0), now=now)  # its own engine's turns don't count
        return (why, describe_reason(why, s, now=now, limit=self.limit_info(account_id))) if why else (None, "")

    def near_limit_move(self, provider: str, account_id: str) -> tuple[str | None, str]:
        """(soft reason, phrase) a LIVE engine should move off its account
        before the next turn: the account is near a plan limit (or is the
        primary login in fallback mode) and another account has headroom —
        the same rule a respawn applies (see :func:`sticky_reason`). Without
        this a busy chat kept its engine until the account was refused at
        100 %. Cached / live numbers only (no HTTP)."""
        cfg = self._store.pool(provider)
        if not cfg["enabled"]:
            return None, ""
        snaps, _ = self._snapshots(provider, cfg, fetch=False)
        cur = next((s for s in snaps if s.id == account_id), None)
        if cur is None:
            return None, ""
        cur = replace(cur, in_flight=0)  # its own engine's turn doesn't count
        snaps = [cur if s.id == account_id else s for s in snaps]
        limits = LimitPolicy(cfg.get("near_5h", NEAR_LIMIT_5H), cfg.get("near_7d", NEAR_LIMIT_7D),
                             cfg.get("limit_priority") or "balanced")
        now = time.time()
        why = sticky_reason(cur, snaps, now=now, limits=limits, primary_mode=cfg.get("primary_mode") or "normal")
        if why in ("near_5h", "near_7d", "fallback_only"):
            return why, describe_reason(why, cur, now=now, limit=self.limit_info(account_id))
        return None, ""

    # ---- turns + release ----

    def begin_turn(self, lease: Lease | None) -> None:
        """Count a turn on the lease's account (idempotent per lease)."""
        if lease is None or lease.released:
            return
        with self._lock:
            if not lease.turn_active:
                lease.turn_active = True
                self._in_flight[lease.account_id] = self._in_flight.get(lease.account_id, 0) + 1

    def end_turn(self, lease: Lease | None) -> None:
        if lease is None:
            return
        with self._lock:
            self._end_turn_locked(lease)

    def _end_turn_locked(self, lease: Lease) -> None:
        if lease.turn_active:
            lease.turn_active = False
            n = self._in_flight.get(lease.account_id, 0) - 1
            if n > 0:
                self._in_flight[lease.account_id] = n
            else:
                self._in_flight.pop(lease.account_id, None)

    def report(self, lease: Lease | None, *, ok: bool, code: str | None = None, error: str | None = None) -> None:
        """Record a turn's outcome and release the lease (one-shot turns)."""
        self.record_outcome(lease, ok=ok, code=code, error=error)
        if lease is not None:
            self._release(lease)

    def release(self, lease: Lease | None) -> None:
        """Release a lease (engine shutdown / end of a one-shot turn). Idempotent."""
        if lease is not None:
            self._release(lease)

    def record_outcome(
        self, lease: Lease | None, *, ok: bool, code: str | None = None, error: str | None = None,
        until: float | None = None,
    ) -> None:
        """Update account health from a turn's outcome without releasing.
        ``until``: when the limit that refused the turn resets (cooldown end)."""
        if lease is None:
            return
        if not ok and code in ("provider_quota", "rate_limited") and not until:
            until = (self.limit_info(lease.account_id) or {}).get("resets_at")
        self._apply(lease.provider, lease.account_id, ok=ok, code=code, error=error, until=until)

    def _apply(self, provider: str, account_id: str, *, ok: bool, code: str | None, error: str | None = None,
               until: float | None = None) -> None:
        now = time.time()
        if account_id.startswith(PRIMARY_PREFIX):
            snap = self._primary_snapshot(provider, now)
            d = apply_outcome(snap, ok=ok, code=code, now=now, policy=HealthPolicy(), until=until)
            self._primary_health[account_id] = {
                "status": d.status,
                "cooldown_until": d.cooldown_until,
                "consecutive_failures": d.consecutive_failures,
            }
            return
        acc = self._store.get(account_id)
        if acc is not None:
            snap = self._snapshot(acc, now)
            d = apply_outcome(snap, ok=ok, code=code, now=now, policy=HealthPolicy(), until=until)
            self._store.set_health(account_id, d)
            if ok:
                self._store.mark_ok(account_id)
            elif error is not None or code:
                self._store.mark_failure(account_id, f"{code or 'unknown'}: {error or ''}")

    def _cooldown(self, provider: str, account_id: str, until: float | None, *, code: str) -> None:
        """Cool an account down until ``until`` (a refused request seen live)."""
        now = time.time()
        end = _until(until, now + HealthPolicy().quota_cooldown_s, now, HealthPolicy())
        if account_id.startswith(PRIMARY_PREFIX):
            h = self._primary_health.get(account_id, {})
            if h.get("status") == "cooldown" and h.get("cooldown_until", 0) >= end - 1:
                return
            self._primary_health[account_id] = {"status": "cooldown", "cooldown_until": end,
                                                "consecutive_failures": h.get("consecutive_failures", 0)}
            return
        acc = self._store.get(account_id)
        if acc is None or (acc["status"] == "cooldown" and _ts(acc.get("cooldown_until")) >= end - 1):
            return
        self._store.set_health(account_id, HealthDecision("cooldown", acc["consecutive_failures"], end))

    def _lift_cooldown(self, account_id: str) -> None:
        """The account just served a request: a cooldown it's in is over."""
        if account_id.startswith(PRIMARY_PREFIX):
            h = self._primary_health.get(account_id)
            if h and h.get("status") == "cooldown":
                self._primary_health.pop(account_id, None)
            return
        acc = self._store.get(account_id)
        if acc is not None and acc["status"] == "cooldown":
            self._store.set_health(account_id, HealthDecision("ready", 0, 0.0))

    def _release(self, lease: Lease) -> None:
        with self._lock:
            self._end_turn_locked(lease)
            if lease.released:
                return
            lease.released = True
            n = self._bound.get(lease.account_id, 0) - 1
            if n > 0:
                self._bound[lease.account_id] = n
            else:
                self._bound.pop(lease.account_id, None)

    def labels(self, provider: str) -> dict[str, str]:
        """id -> label of every account of the provider (no network)."""
        out = {self._primary_id(provider): PRIMARY_LABEL} if self._host_usable(provider) else {}
        out.update({a["id"]: a["label"] for a in self._store.list(provider)})
        return out

    def enabled(self, provider: str) -> bool:
        return bool(self._store.pool(provider)["enabled"])

    def settings(self, provider: str) -> dict[str, Any]:
        return self._store.pool(provider)

    def counters(self, account_id: str) -> tuple[int, int]:
        """(active turns, live leases) — for tests and the admin view."""
        return self._in_flight.get(account_id, 0), self._bound.get(account_id, 0)

    # ---- admin view ----

    def public_accounts(self, provider: str) -> list[dict]:
        """Accounts with live health for the admin UI (no secrets).

        The host subscription is surfaced first as a non-deletable "primary"
        account so the whole page is account-centric."""
        now = time.time()
        cfg = self._store.pool(provider)
        out = []
        if self._host_usable(provider):
            snap = self._primary_snapshot(provider, now)
            mode = cfg.get("primary_mode") or "normal"
            reason = "excluded" if (cfg["enabled"] and mode == "off") else ineligible_reason(snap, now=now)
            out.append({
                "id": snap.id,
                "label": PRIMARY_LABEL,
                "primary": True,
                "primary_mode": mode,
                "auth_mode": "oauth",
                "enabled": True,
                "weight": snap.weight,
                "max_concurrency": snap.max_concurrency,
                "status": snap.status,
                "usable": True,
                "in_flight": snap.in_flight,
                "engines": self._bound.get(snap.id, 0),
                "eligible": reason is None,
                "ineligible_reason": reason,
                **self._plan_fields(provider, snap.id, primary=True),
                "session": self.session_info(provider, snap.id, primary=True, now=now),
                "total_leases": 0,
                "total_failures": 0,
                "consecutive_failures": snap.consecutive_failures,
                "cooldown_until": _iso(snap.cooldown_until) if snap.cooldown_until > now else None,
                "limit": self.limit_info(snap.id),
                "last_used_at": _iso(snap.last_used) if snap.last_used else None,
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
                "engines": self._bound.get(a["id"], 0),
                "eligible": reason is None,
                "ineligible_reason": reason,
                **self._plan_fields(provider, a["id"], account=a, usable=snap.usable),
                "session": self.session_info(provider, a["id"], account=a, now=now),
                "total_leases": a["total_leases"],
                "total_failures": a["total_failures"],
                "consecutive_failures": a["consecutive_failures"],
                "cooldown_until": a.get("cooldown_until") if snap.cooldown_until > now else None,
                "limit": self.limit_info(a["id"]),
                "last_used_at": a.get("last_used_at"),
                "last_ok_at": a.get("last_ok_at"),
                "last_error": a.get("last_error"),
            })
        return out

    def note_signed_in(self, account_id: str) -> None:
        """A new sign-in landed for this account: forget the old login's
        renewal failure / refusal (its file is new anyway)."""
        self._renew.pop(account_id, None)
        if account_id.startswith(PRIMARY_PREFIX):
            h = self._primary_health.get(account_id)
            if h and h.get("status") == "expired":
                self._primary_health.pop(account_id, None)

    def clear_cooldown(self, account_id: str) -> None:
        self._live.get(account_id, {}).pop("limit", None)
        if account_id.startswith(PRIMARY_PREFIX):
            self._primary_health.pop(account_id, None)
            return
        self._store.set_health(account_id, HealthDecision("ready", 0, 0.0))
