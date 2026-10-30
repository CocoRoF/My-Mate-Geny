"""Request/response models for the HTTP API."""

from __future__ import annotations

from pydantic import BaseModel, Field


# ---- providers ----

class ProviderConnect(BaseModel):
    auth_mode: str = Field("oauth", description="oauth | api_key")
    api_key: str = ""


# ---- connections (remote SSH) ----

class ConnectionCreate(BaseModel):
    name: str
    host: str
    port: int = 22
    username: str
    private_key_pem: str | None = None
    default_path: str = "."


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

class SessionCreate(BaseModel):
    provider: str = "claude"
    model: str = ""
    effort: str = "default"
    connection_id: str | None = None
    workspace_path: str
    title: str = "New chat"


class SessionUpdate(BaseModel):
    provider: str | None = None
    model: str | None = None
    effort: str | None = None


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
