from __future__ import annotations

from fastapi import APIRouter

from app import __version__

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    """Public liveness probe + server identity for native connect screens
    (``Access-Control-Allow-Origin: *``, see docs/auth.md). Old clients only
    look at ``status``; fields are only ever added."""
    return {"status": "ok", "service": "my-mate-geny", "version": __version__, "product": "My Mate Geny"}
