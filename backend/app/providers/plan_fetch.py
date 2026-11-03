"""Plan-usage fetching that never hammers the provider (docs/providers.md).

The usage endpoints (Anthropic ``/api/oauth/usage``, ChatGPT ``codex/usage``)
are rate limited per account, and a 429 can come with ``Retry-After: 3600``.
Everything that wants an account's plan numbers — the Providers page, the
composer's account popover, the load balancer on every turn, the Usage
dialog — goes through one :class:`PlanFetcher` so that, per account:

* there is at most one request every :attr:`PlanFetcher.ttl_s` (a manual
  refresh may ask sooner, but never inside a backoff),
* concurrent callers share one request (coalescing); a caller that only needs
  numbers gets the last known ones right away while another one is fetching,
* a 429 waits for its ``Retry-After`` (or backs off exponentially without
  one), other errors back off too, and a refused / expired token isn't asked
  with again until the credentials file changes,
* the last good numbers are always served, with when they were fetched and
  why they're old (``stale_reason`` + ``retry_at``) — never "no data" just
  because the latest request failed,
* the state (last numbers + backoff) survives a restart (``persist``), so a
  restart doesn't ask an endpoint that said "come back in an hour" again.
"""

from __future__ import annotations

import random
import threading
import time
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from typing import Any, Callable, Protocol


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


@dataclass
class PlanEntry:
    windows: list = field(default_factory=list)
    model_windows: list = field(default_factory=list)
    fetched_at: float = 0.0       # last successful fetch (epoch s); 0 = never
    checked_at: float = 0.0       # last request (or local check that skipped one)
    next_at: float = 0.0          # no request before this
    failures: int = 0             # consecutive failed requests
    reason: str | None = None     # why the numbers are old (None = fresh)
    error: str | None = None      # the last error, for the tooltip
    cred_sig: str = ""            # credentials file signature when it failed
    profile: dict | None = None   # account identity from the last profile fetch
    profile_at: float = 0.0

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, data: dict) -> "PlanEntry":
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in (data or {}).items() if k in names})


class PlanPersist(Protocol):
    def load_plan_entries(self) -> dict[str, dict]: ...
    def save_plan_entry(self, key: str, data: dict) -> None: ...


# Errors whose cause is the credentials themselves: asking again with the same
# file can't help, a changed file (the CLI renewed it, a new sign-in) can.
CREDENTIAL_REASONS = ("auth", "token_expired", "no_credentials")
# Reasons set by a local check (no request was sent).
LOCAL_REASONS = ("token_expired", "needs_login")


class PlanFetcher:
    ttl_s = 120.0                 # min interval between requests per account
    force_min_s = 30.0            # a manual refresh still waits this long after the last request
    rate_base_s = 120.0           # 429 without Retry-After: 2, 4, 8 … min
    rate_max_s = 6 * 3600.0
    retry_after_min_s = 60.0      # clamp what the server asks for
    retry_after_max_s = 6 * 3600.0
    error_base_s = 60.0           # 5xx / network: 1, 2, 4 … min
    error_max_s = 30 * 60.0
    credential_wait_s = 3600.0    # refused token: ask again after this (or once the file changes)
    profile_ttl_s = 24 * 3600.0   # who the account is changes rarely
    wait_for_first_s = 20.0       # a caller with no numbers at all waits this long for a running fetch

    def __init__(self, *, clock: Callable[[], float] = time.time, persist: PlanPersist | None = None,
                 enabled: bool = True, jitter: Callable[[], float] | None = None) -> None:
        self._clock = clock
        self._persist = persist
        self.enabled = enabled
        self._jitter = jitter or (lambda: random.uniform(0.0, 0.1))
        self._entries: dict[str, PlanEntry] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        if persist is not None:
            try:
                for key, data in persist.load_plan_entries().items():
                    self._entries[key] = PlanEntry.from_json(data)
            except Exception:  # noqa: BLE001 - a broken cache must never break the app
                pass

    # ---- state ----

    def _lock_for(self, key: str) -> threading.Lock:
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = self._locks[key] = threading.Lock()
            return lock

    def entry(self, key: str) -> PlanEntry | None:
        return self._entries.get(key)

    def cached(self, key: str) -> dict | None:
        """The last known view, without any request (None = never asked)."""
        e = self._entries.get(key)
        return self.view(e) if e is not None else None

    def forget(self, key: str) -> None:
        self._entries.pop(key, None)

    def view(self, e: PlanEntry) -> dict:
        out: dict[str, Any] = {
            "windows": [dict(w) for w in e.windows],
            "model_windows": [dict(w) for w in e.model_windows],
            "fetched_at": _iso(e.fetched_at),
            "checked_at": _iso(e.checked_at),
            "stale_reason": e.reason,
            # when the next request may go out (only while something is wrong)
            "retry_at": _iso(e.next_at) if e.reason and e.next_at > self._clock() else None,
        }
        if e.reason:
            out["error"] = e.error or e.reason
        if e.profile:
            out["account"] = dict(e.profile)
        return out

    def _save(self, key: str, e: PlanEntry) -> None:
        if self._persist is None:
            return
        try:
            self._persist.save_plan_entry(key, e.to_json())
        except Exception:  # noqa: BLE001
            pass

    # ---- policy ----

    def backoff(self, kind: str, failures: int, retry_after: float | None) -> float:
        """Seconds to wait after the ``failures``-th failure in a row."""
        n = max(1, failures)
        if kind == "rate_limited":
            expo = min(self.rate_max_s, self.rate_base_s * 2 ** (n - 1))
            if retry_after is not None:
                asked = min(self.retry_after_max_s, max(self.retry_after_min_s, float(retry_after)))
                # the server's word, and never less than our own backoff once it keeps refusing
                return max(asked, expo if n > 1 else 0.0)
            return expo
        if kind in CREDENTIAL_REASONS:
            return self.credential_wait_s
        return min(self.error_max_s, self.error_base_s * 2 ** (n - 1))

    def _due(self, e: PlanEntry, now: float, force: bool) -> bool:
        if now >= e.next_at:
            return True
        # a manual refresh may skip the normal interval, never a backoff
        return force and e.reason is None and now - e.checked_at >= self.force_min_s

    # ---- the one way in ----

    def get(
        self, key: str, fetch: Callable[[bool], dict], *, cred_sig: str = "",
        local_block: tuple[str, str] | None = None, force: bool = False, want_profile: bool = False,
    ) -> dict:
        """Plan numbers for ``key``: fetched when due, else the last known.

        ``fetch(with_profile)`` does the request (raises on failure; a
        :class:`~app.providers.subscription.UsageError` carries ``kind`` /
        ``retry_after``). ``cred_sig`` identifies the credentials file's
        current content (mtime+size): a credentials-caused failure is retried
        as soon as it changes. ``local_block`` = (reason, message) when a
        request is known to fail without asking (the access token has expired:
        the CLI renews it on its next use), so none is sent."""
        lock = self._lock_for(key)
        if not lock.acquire(blocking=False):
            # another caller is fetching this account right now: share its result
            e = self._entries.get(key)
            if e is not None and (e.fetched_at or e.reason):
                return self.view(e)
            if not lock.acquire(timeout=self.wait_for_first_s):
                e = self._entries.get(key) or PlanEntry()
                return self.view(e)
        try:
            return self._get_locked(key, fetch, cred_sig=cred_sig, local_block=local_block, force=force,
                                    want_profile=want_profile)
        finally:
            lock.release()

    def _get_locked(self, key: str, fetch: Callable[[bool], dict], *, cred_sig: str,
                    local_block: tuple[str, str] | None, force: bool, want_profile: bool) -> dict:
        now = self._clock()
        e = self._entries.get(key)
        if e is None:
            e = self._entries[key] = PlanEntry()
        if e.reason in CREDENTIAL_REASONS and cred_sig and e.cred_sig and cred_sig != e.cred_sig:
            e.next_at = 0.0  # new credentials (renewed / signed in again): ask now
        if local_block is not None:
            # no request: it would fail. (next_at stays: once the block lifts —
            # renewed, signed in again — the next call asks right away.)
            reason, message = local_block
            if e.reason != reason or e.cred_sig != cred_sig:
                e.reason, e.error, e.cred_sig, e.checked_at = reason, message, cred_sig, now
                self._save(key, e)
            return self.view(e)
        if e.reason in LOCAL_REASONS:
            e.next_at = 0.0  # the block has lifted
        if not self.enabled:
            return self.view(e)
        if not self._due(e, now, force):
            return self.view(e)
        need_profile = want_profile and (not e.profile or now - e.profile_at >= self.profile_ttl_s)
        e.checked_at = now
        try:
            got = fetch(need_profile)
        except Exception as exc:  # noqa: BLE001 - kept on the entry, never raised to the page
            kind = getattr(exc, "kind", None) or "network"
            e.failures += 1
            e.reason = kind
            e.error = (str(exc) or type(exc).__name__)[:200]
            e.cred_sig = cred_sig
            wait = self.backoff(kind, e.failures, getattr(exc, "retry_after", None))
            e.next_at = now + wait * (1.0 + self._jitter())
        else:
            e.windows = list(got.get("windows") or [])
            e.model_windows = list(got.get("model_windows") or [])
            e.fetched_at = now
            e.failures = 0
            e.reason = e.error = None
            e.cred_sig = cred_sig
            e.next_at = now + self.ttl_s
            acc = got.get("account")
            if need_profile and isinstance(acc, dict) and any(acc.values()):
                e.profile, e.profile_at = dict(acc), now
        self._save(key, e)
        return self.view(e)
