"""Request/response models for the HTTP API."""

from __future__ import annotations

from pydantic import BaseModel, Field, StrictBool


# ---- providers ----

class ProviderConnect(BaseModel):
    auth_mode: str = Field("oauth", description="oauth | api_key")
    api_key: str = ""


# ---- connections (remote SSH) ----

class ConnectionCreate(BaseModel):
    name: str = ""                    # (empty: the host)
    host: str
    port: int = 22
    username: str
    # one of: a password (used once to install a key made here — never kept), or a private key of their own
    password: str | None = None
    private_key_pem: str | None = None
    default_path: str = ""            # (empty: the home folder there)


class ConnectionPassword(BaseModel):
    password: str


class ConnectionPatch(BaseModel):
    name: str | None = None
    default_path: str | None = None


class ConnectionOut(BaseModel):
    id: str
    name: str
    kind: str
    host: str | None
    port: int | None
    username: str | None
    default_path: str | None
    has_key: bool
    created_at: str
    updated_at: str


# ---- workspaces ----

class ListDirQuery(BaseModel):
    connection_id: str | None = None
    path: str = "~"


# ---- sessions ----

class FolderIn(BaseModel):
    """An additional folder: a path on this server (connection_id None) or on an SSH connection's host."""
    path: str
    connection_id: str | None = None


class SessionCreate(BaseModel):
    provider: str = "claude"
    model: str = ""
    effort: str = "default"
    connection_id: str | None = None
    workspace_path: str
    title: str = "New chat"
    mode: str = "agent"
    extra_dirs: list[str] = []
    folders: list[FolderIn] | None = None


class SessionUpdate(BaseModel):
    provider: str | None = None
    model: str | None = None
    effort: str | None = None
    mode: str | None = None
    extra_dirs: list[str] | None = None     # (older clients: paths on the workspace's own host)
    folders: list[FolderIn] | None = None   # every additional folder, with its host
    title: str | None = None
    auto_compact_window: int | None = None  # tokens; 0 = CLI default; -1 = back to the global default
    account_id: str | None = None           # run on this account from the next turn (load balancing on)
    mcp: dict[str, StrictBool] | None = None
    higgsfield: dict | None = None          # {enabled?, max_credits?}: this chat's Higgsfield (docs/higgsfield.md)


class SessionOut(BaseModel):
    id: str
    title: str
    provider: str
    model: str
    connection_id: str | None
    workspace_path: str
    cli_session_id: str | None = None
    created_at: str
    updated_at: str
    message_count: int = 0
