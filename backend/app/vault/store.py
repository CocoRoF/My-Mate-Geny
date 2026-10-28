"""Encrypted secret vault — Fernet-encrypted values in SQLite.

Adapted from GAPT's ``SecretVault`` invariants:

* Plaintext is **never** returned by any HTTP API — only ``read()`` (server
  side, during provider/SSH use) decrypts.
* The symmetric key comes from ``VAULT_KEY`` env, or an auto-generated key
  file at ``~/.hr-harnessor/vault.key`` (chmod 600).
* Each secret has a stable ``id`` (``<scope>:<name>``) referenced elsewhere
  (e.g. ``provider_auth.secret_ref``, ``connections.key_ref``).
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings
from app.db import Database


class VaultError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_or_create_key() -> bytes:
    """Resolve the Fernet key: env first, then a 0600 key file."""
    if settings.vault_key:
        return settings.vault_key.encode()

    key_file = settings.vault_key_file
    if key_file.exists():
        return key_file.read_bytes().strip()

    key_file.parent.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    # Write with restrictive perms from the start.
    fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key)
    return key


class SecretVault:
    """Stores encrypted secrets in the shared SQLite database."""

    _TABLE = """
        CREATE TABLE IF NOT EXISTS secrets (
            id         TEXT PRIMARY KEY,
            scope      TEXT NOT NULL,
            name       TEXT NOT NULL,
            ciphertext BLOB NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """

    def __init__(self, db: Database) -> None:
        self._db = db
        self._fernet = Fernet(_load_or_create_key())
        self._db.execute(self._TABLE)

    @staticmethod
    def make_id(scope: str, name: str) -> str:
        return f"{scope}:{name}"

    def put(self, scope: str, name: str, plaintext: str) -> str:
        """Encrypt and upsert a secret. Returns its reference id."""
        sid = self.make_id(scope, name)
        token = self._fernet.encrypt(plaintext.encode())
        now = _now()
        self._db.execute(
            """
            INSERT INTO secrets (id, scope, name, ciphertext, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                ciphertext = excluded.ciphertext,
                updated_at = excluded.updated_at
            """,
            (sid, scope, name, token, now, now),
        )
        return sid

    def read(self, secret_ref: str) -> str:
        """Decrypt and return plaintext. Server-side use only."""
        row = self._db.query_one("SELECT ciphertext FROM secrets WHERE id = ?", (secret_ref,))
        if row is None:
            raise VaultError(f"secret not found: {secret_ref}")
        try:
            return self._fernet.decrypt(row["ciphertext"]).decode()
        except InvalidToken as exc:  # pragma: no cover - key mismatch
            raise VaultError("vault key mismatch — cannot decrypt secret") from exc

    def exists(self, secret_ref: str) -> bool:
        return self._db.query_one("SELECT 1 FROM secrets WHERE id = ?", (secret_ref,)) is not None

    def delete(self, secret_ref: str) -> None:
        self._db.execute("DELETE FROM secrets WHERE id = ?", (secret_ref,))
