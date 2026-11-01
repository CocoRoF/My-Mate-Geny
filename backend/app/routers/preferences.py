"""GET / PUT /api/preferences — the account's UI preferences (app/preferences.py)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.preferences import get_preferences, set_preferences

router = APIRouter(prefix="/api")


class PreferencesBody(BaseModel):
    # None clears the choice (each device follows its own system language again)
    language: Literal["en", "ko"] | None = None


@router.get("/preferences")
async def read_preferences(request: Request) -> dict:
    return get_preferences(request.app.state.db)


@router.put("/preferences")
async def write_preferences(body: PreferencesBody, request: Request) -> dict:
    patch = body.model_dump(exclude_unset=True)
    return set_preferences(request.app.state.db, patch)
