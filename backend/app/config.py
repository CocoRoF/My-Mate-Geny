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

    # Where Git repos are cloned (becomes a local workspace).
    repos_root: str = "~/.hr-harnessor/repos"

    # Chat attachments (photos/files) — stored per session under this root.
    uploads_root: str = "~/.hr-harnessor/uploads"
    upload_max_mb: int = 50          # per file
    upload_max_files: int = 20       # per message

    # Admin error log retention (rows beyond this are pruned, oldest first).
    log_max_rows: int = 20000

    # Native app downloads: CI publishes builds to this repo's release; the
    # token (read access) lets the backend serve them from a private repo.
    github_token: str = ""
    apps_repo: str = "CocoRoF/hr-harnessor"
    apps_release_tag: str = "apps-latest"

    # Provider CLI binaries
    claude_binary: str = "claude"
    codex_binary: str = "codex"

    # Single agent turn wall-clock timeout (seconds)
    turn_timeout_s: float = 600.0

    # ---- auth ----
    # Login credentials. Password MUST be provided via env (never committed).
    auth_username: str = "admin"
    auth_password: str = ""
    # Signs the session cookie. Empty -> auto key file at ~/.hr-harnessor/session.key.
    session_secret: str = ""
    # Browser session lifetime after a successful login.
    session_ttl_days: int = 7
    # Set the session cookie's Secure flag (True behind HTTPS; False for http dev).
    cookie_secure: bool = True
    # Block an IP after this many failed logins, for this many hours.
    max_login_fails: int = 3
    ban_hours: int = 24
    # Directory of the built frontend (served as the SPA). Empty -> disabled.
    static_dir: str = ""

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
    def repos_root_path(self) -> Path:
        return Path(os.path.expanduser(self.repos_root)).resolve()

    @property
    def uploads_root_path(self) -> Path:
        return Path(os.path.expanduser(self.uploads_root)).resolve()

    @property
    def home_dir(self) -> Path:
        return _default_home()

    @property
    def vault_key_file(self) -> Path:
        return self.home_dir / "vault.key"

    @property
    def session_key_file(self) -> Path:
        return self.home_dir / "session.key"

    @property
    def static_path(self) -> Path | None:
        if not self.static_dir:
            return None
        p = Path(os.path.expanduser(self.static_dir)).resolve()
        return p if p.is_dir() else None


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
