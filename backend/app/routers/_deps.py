"""Shared FastAPI dependencies — pull services off ``app.state``."""

from __future__ import annotations

from fastapi import Request

from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService


def provider_service(request: Request) -> ProviderService:
    return request.app.state.provider_service


def connection_service(request: Request) -> ConnectionService:
    return request.app.state.connection_service


def workspace_service(request: Request) -> WorkspaceService:
    return request.app.state.workspace_service


def session_service(request: Request) -> SessionService:
    return request.app.state.session_service
