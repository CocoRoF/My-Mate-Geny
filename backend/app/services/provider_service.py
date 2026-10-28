"""Provider orchestration — auth status + credential storage.

Provider credentials live in the vault; the ``provider_auth`` table keeps
only metadata (mode, status, secret reference) — never plaintext.
"""

from __future__ import annotations

from app.db import Database
from app.providers import get_provider, list_providers
from app.providers.base import AuthStatus
from app.services._ids import now_iso
from app.vault import SecretVault


class ProviderService:
    def __init__(self, db: Database, vault: SecretVault) -> None:
        self._db = db
        self._vault = vault

    def _stored_api_key(self, provider: str) -> str | None:
        row = self._db.query_one(
            "SELECT secret_ref FROM provider_auth WHERE provider = ? AND auth_mode = 'api_key'",
            (provider,),
        )
        if row and row["secret_ref"] and self._vault.exists(row["secret_ref"]):
            return self._vault.read(row["secret_ref"])
        return None

    async def status(self, provider: str) -> AuthStatus:
        p = get_provider(provider)
        return await p.auth_status(api_key=self._stored_api_key(provider))

    async def status_all(self) -> list[dict]:
        out = []
        for name in list_providers():
            st = await self.status(name)
            out.append(
                {
                    "provider": st.provider,
                    "connected": st.connected,
                    "auth_mode": st.auth_mode,
                    "detail": st.detail,
                }
            )
        return out

    def connect_api_key(self, provider: str, api_key: str) -> None:
        """Store an API key for a provider (encrypted in vault)."""
        get_provider(provider)  # validates provider name
        ref = self._vault.put("provider", f"{provider}.api_key", api_key)
        self._db.execute(
            """
            INSERT INTO provider_auth (provider, auth_mode, secret_ref, status, updated_at)
            VALUES (?, 'api_key', ?, 'connected', ?)
            ON CONFLICT(provider) DO UPDATE SET
                auth_mode='api_key', secret_ref=excluded.secret_ref,
                status='connected', updated_at=excluded.updated_at
            """,
            (provider, ref, now_iso()),
        )

    def mark_oauth(self, provider: str) -> None:
        """Record that a provider uses its CLI's native OAuth (no stored key)."""
        self._db.execute(
            """
            INSERT INTO provider_auth (provider, auth_mode, secret_ref, status, updated_at)
            VALUES (?, 'oauth', NULL, 'connected', ?)
            ON CONFLICT(provider) DO UPDATE SET
                auth_mode='oauth', secret_ref=NULL, status='connected',
                updated_at=excluded.updated_at
            """,
            (provider, now_iso()),
        )

    def disconnect(self, provider: str) -> None:
        row = self._db.query_one(
            "SELECT secret_ref FROM provider_auth WHERE provider = ?", (provider,)
        )
        if row and row["secret_ref"]:
            self._vault.delete(row["secret_ref"])
        self._db.execute("DELETE FROM provider_auth WHERE provider = ?", (provider,))

    def resolved_api_key(self, provider: str) -> str | None:
        """For the executor: the API key to pass, or None (OAuth path)."""
        return self._stored_api_key(provider)
