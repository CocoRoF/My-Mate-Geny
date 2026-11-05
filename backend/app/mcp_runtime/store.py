from __future__ import annotations

import json
import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.db import Database
from app.services._ids import now_iso
from app.vault import SecretVault


class Definition(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=80)
    transport: Literal["stdio", "http", "sse"] = "stdio"
    command: str = Field(default="", max_length=1000)
    args: list[str] = Field(default_factory=list, max_length=100)
    cwd: str = Field(default="", max_length=2000)
    url: str = Field(default="", max_length=2000)
    env: dict[str, str] = Field(default_factory=dict, max_length=100)
    headers: dict[str, str] = Field(default_factory=dict, max_length=50)
    enabled: bool = True
    timeout_s: int = Field(default=120, ge=5, le=3600)
    log_stderr: bool = False

    @model_validator(mode="after")
    def validate_transport(self):
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("name_required")
        if any(len(a) > 8000 or "\0" in a for a in self.args):
            raise ValueError("invalid_arguments")
        if self.transport == "stdio":
            self.command = self.command.strip()
            if not self.command or any(c in self.command for c in "\r\n\0"):
                raise ValueError("command_required")
        else:
            u = urlsplit(self.url)
            if (
                u.scheme not in ("http", "https")
                or not u.hostname
                or u.username
                or u.password
                or u.fragment
            ):
                raise ValueError("invalid_url")
        for k, v in self.env.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", k) or "\0" in v or len(v) > 16000:
                raise ValueError("invalid_environment")
        for k, v in self.headers.items():
            if (
                not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}", k)
                or any(c in v for c in "\r\n\0")
                or len(v) > 16000
            ):
                raise ValueError("invalid_header")
            if k.lower() in ("host", "content-length", "connection", "origin"):
                raise ValueError("reserved_header")
        return self


class McpStore:
    """Only encrypted definitions are persisted; API secrets are write-only.

    A supplied env/header mapping replaces its keys. A null value keeps an
    existing secret, so editing a label never requires re-entering keys.
    Omitting the mapping keeps it; removing its row deletes that key.
    """

    def __init__(self, db: Database, vault: SecretVault):
        self.db, self.vault = db, vault
        db.execute("""CREATE TABLE IF NOT EXISTS mcp_catalog (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")

    def get(self, mid: str) -> dict:
        row = self.db.query_one("SELECT * FROM mcp_catalog WHERE id = ?", (mid,))
        if row is None:
            raise KeyError("mcp_not_found")
        raw = json.loads(self.vault.read(SecretVault.make_id("mcp", mid)))
        # Validate on read too: damaged or incompatible data never launches a command.
        spec = Definition.model_validate(raw).model_dump()
        return {**dict(row), **spec}

    def ids(self) -> list[str]:
        return [
            r["id"] for r in self.db.query("SELECT id FROM mcp_catalog ORDER BY created_at, id")
        ]

    def save(self, mid: str, patch: dict, *, create: bool = False) -> dict:
        old = {} if create else self.get(mid)
        data = {k: v for k, v in old.items() if k in Definition.model_fields}
        for field in ("env", "headers"):
            if field in patch:
                if not isinstance(patch[field], dict):
                    raise ValueError("invalid_" + field)
                values = {}
                for key, value in patch[field].items():
                    if value is None:
                        if key not in data.get(field, {}):
                            raise ValueError("missing_secret_value")
                        value = data[field][key]
                    values[key] = value
                patch = {**patch, field: values}
        spec = Definition.model_validate({**data, **patch}).model_dump()
        stamp = now_iso()
        self.vault.put("mcp", mid, json.dumps(spec, ensure_ascii=False))
        self.db.execute(
            """INSERT INTO mcp_catalog (id,name,enabled,created_at,updated_at) VALUES (?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, updated_at=excluded.updated_at""",
            (mid, spec["name"], int(spec["enabled"]), old.get("created_at", stamp), stamp),
        )
        return self.get(mid)

    def delete(self, mid: str):
        if not self.db.query_one("SELECT 1 FROM mcp_catalog WHERE id = ?", (mid,)):
            raise KeyError("mcp_not_found")
        self.db.execute("DELETE FROM mcp_catalog WHERE id = ?", (mid,))
        self.vault.delete(SecretVault.make_id("mcp", mid))

    @staticmethod
    def public(spec: dict) -> dict:
        return {
            **spec,
            "env": {k: None for k in spec["env"]},
            "headers": {k: None for k in spec["headers"]},
        }
