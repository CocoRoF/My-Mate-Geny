"""Remote SSH connection CRUD. Private keys live in the vault only."""

from __future__ import annotations

from typing import Any

from app.db import Database
from app.services._ids import new_id, now_iso
from app.vault import SecretVault
from app.workspaces.remote_ssh import RemoteSshConnector, SshSpec


class ConnectionService:
    def __init__(self, db: Database, vault: SecretVault) -> None:
        self._db = db
        self._vault = vault

    def create(
        self,
        *,
        name: str,
        host: str,
        port: int,
        username: str,
        private_key_pem: str | None,
        default_path: str = ".",
    ) -> dict[str, Any]:
        cid = new_id("conn_")
        key_ref = None
        if private_key_pem:
            key_ref = self._vault.put("connection", f"{cid}.key", private_key_pem)
        now = now_iso()
        self._db.execute(
            """
            INSERT INTO connections
                (id, name, kind, host, port, username, key_ref, default_path, created_at, updated_at)
            VALUES (?, ?, 'remote_ssh', ?, ?, ?, ?, ?, ?, ?)
            """,
            (cid, name, host, port, username, key_ref, default_path, now, now),
        )
        return self.get(cid)

    def _row_to_public(self, row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "kind": row["kind"],
            "host": row["host"],
            "port": row["port"],
            "username": row["username"],
            "default_path": row["default_path"],
            "has_key": bool(row["key_ref"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def get(self, cid: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT * FROM connections WHERE id = ?", (cid,))
        if row is None:
            raise KeyError(f"connection not found: {cid}")
        return self._row_to_public(row)

    def list_all(self) -> list[dict[str, Any]]:
        rows = self._db.query("SELECT * FROM connections ORDER BY created_at DESC")
        return [self._row_to_public(r) for r in rows]

    def delete(self, cid: str) -> None:
        row = self._db.query_one("SELECT key_ref FROM connections WHERE id = ?", (cid,))
        if row and row["key_ref"]:
            self._vault.delete(row["key_ref"])
        self._db.execute("DELETE FROM connections WHERE id = ?", (cid,))
        # Decrypted key + pinned host key live in the connection's runtime dir.
        import shutil

        from app.config import settings

        shutil.rmtree(settings.mount_root_path / cid, ignore_errors=True)

    def build_connector(self, cid: str) -> RemoteSshConnector:
        """Construct a live connector, decrypting the key into memory."""
        row = self._db.query_one("SELECT * FROM connections WHERE id = ?", (cid,))
        if row is None:
            raise KeyError(f"connection not found: {cid}")
        key_pem = None
        if row["key_ref"] and self._vault.exists(row["key_ref"]):
            key_pem = self._vault.read(row["key_ref"])
        spec = SshSpec(
            connection_id=row["id"],
            host=row["host"],
            port=row["port"],
            username=row["username"],
            private_key_pem=key_pem,
            default_path=row["default_path"] or ".",
        )
        return RemoteSshConnector(spec)
