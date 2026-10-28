"""Application settings, loaded from environment (.env supported).

Mirrors the geny-executor-web config pattern: a single ``settings`` singleton
read at import time, with sensible zero-config defaults so the service boots
even when nothing is configured.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_home() -> Path:
    return Path(os.path.expanduser("~/.hr-harnessor"))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server
    host: str = "0.0.0.0"
    port: int = 8080

    # CORS — comma-separated string in env, parsed to list
    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    # Storage
    db_path: str = "./data/harnessor.db"

    # Secret vault. Empty -> auto key file at ~/.hr-harnessor/vault.key.
    vault_key: str = ""

    # Where remote workspaces get sshfs-mounted on this runtime host.
    mount_root: str = "~/.hr-harnessor/mounts"

    # Provider CLI binaries
    claude_binary: str = "claude"
    codex_binary: str = "codex"

    # Single agent turn wall-clock timeout (seconds)
    turn_timeout_s: float = 600.0

    # ---- derived helpers ----

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def db_file(self) -> Path:
        return Path(os.path.expanduser(self.db_path)).resolve()

    @property
    def mount_root_path(self) -> Path:
        return Path(os.path.expanduser(self.mount_root)).resolve()

    @property
    def home_dir(self) -> Path:
        return _default_home()

    @property
    def vault_key_file(self) -> Path:
        return self.home_dir / "vault.key"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
