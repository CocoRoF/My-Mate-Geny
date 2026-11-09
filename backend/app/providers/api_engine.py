"""Anthropic, OpenAI and Google with an API key: providers whose agent loop is the app's own (``app.harness``).

They take the same turns and give the same events as Claude Code and Codex; the difference is where the loop runs (in
this process) and what pays for it (the provider's keys in Settings → Providers, balanced and failed over by the
account pool, the session layer's ``KeySource``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from app.harness import state
from app.harness.vendors import VENDORS
from app.providers.base import AuthStatus, Provider, ProviderEvent, TurnRequest


class ApiEngineProvider(Provider):
    kind = "api"

    def __init__(self, name: str) -> None:
        self.name = name
        self.label = VENDORS[name].label

    async def auth_status(self, *, api_key: str | None = None) -> AuthStatus:
        """Usable when the provider has a key and a model switched on (keys live in the account pool)."""
        if not state.bound():
            return AuthStatus(self.name, False, "none", "not ready")
        from app.harness.models import ModelCatalog

        db = state.db()
        keys = db.query_one(
            "SELECT COUNT(*) AS n FROM provider_accounts WHERE provider = ? AND enabled = 1 AND auth_mode = 'api_key' "
            "AND secret_ref IS NOT NULL", (self.name,))
        n = int(keys["n"]) if keys else 0
        if not n:
            return AuthStatus(self.name, False, "none", f"No {self.label} API key yet")
        models = ModelCatalog(db).enabled(self.name)
        if not models:
            return AuthStatus(self.name, False, "api_key", "No model switched on")
        return AuthStatus(self.name, True, "api_key", f"{n} key{'s' if n != 1 else ''} · {len(models)} model"
                                                     f"{'s' if len(models) != 1 else ''}")

    async def run_turn_stream(self, request: TurnRequest) -> AsyncIterator[ProviderEvent]:
        from app.harness.engine import run_turn

        async for ev in run_turn(self.name, request, state.db()):
            yield ev
