"""The API key an API-key turn runs on, from the provider's account pool — and the next one when it fails.

A Claude or Codex turn that hits its account's limit fails over by restarting the CLI on another account
(``SessionService._failover``); a harness turn just makes its next call with another key. The key that failed is
recorded (cooldown, expired) and handed back; the chat sticks to the new one from then on.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from app.harness.engine import KeySource
from app.harness.llm.base import LLMError
from app.providers.accounts import AccountUnavailable


class PoolKeys(KeySource):
    def __init__(self, svc: Any, provider: str, lease: Any, sid: str, ctx: dict[str, Any]) -> None:
        self.svc, self.provider, self.sid, self.ctx = svc, provider, sid, ctx
        self.lease = lease
        self.tried = {lease.account_id}
        self._take(lease)

    def _take(self, lease: Any) -> None:
        self.key = lease.api_key or ""
        self.label = lease.label
        self.account_id = lease.account_id

    async def failover(self, err: LLMError) -> bool:
        pool = self.svc._pool
        if pool is None:
            return False
        try:
            new = await asyncio.to_thread(pool.select, self.provider, avoid=frozenset(self.tried), begin_turn=True)
        except AccountUnavailable:
            return False
        if new is None or new.account_id in self.tried or not new.api_key:
            if new is not None:
                pool.release(new)
            return False  # (nothing else: the turn's own outcome records this key's failure)
        until = time.time() + err.retry_after if err.retry_after else None
        pool.record_outcome(self.lease, ok=False, code=err.account_outcome, error=str(err)[:500], until=until)
        pool.release(self.lease)
        self.svc._log("warning", "account", f"{self.provider} key '{self.lease.label}' failed ({err.kind}); "
                      f"continuing on '{new.label}'", code=f"account.{err.account_outcome}",
                      detail={**self.ctx, "error": str(err)[:500]}, session_id=self.sid)
        self.lease = new
        self.tried.add(new.account_id)
        self._take(new)
        self.svc._remember_account(self.sid, self.provider, new)
        self.ctx.update(self.svc._account_ref(self.provider, new))
        run = self.svc.active_runs.get(self.sid)
        if run is not None:
            run["account"] = new.label
        return True
