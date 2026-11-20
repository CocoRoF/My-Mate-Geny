"""What the two of them are, in her own view (app/mate/gss/ties.py): for the ♥ status window. Hers to decide: read only."""
from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/mates")


@router.get("/{mate_id}/ties")
async def get_ties(mate_id: str, request: Request) -> dict:
    """What she sees the user as: since when, in her words, how settled it is, how it came to be."""
    try:
        return request.app.state.mate_service.ties_view(mate_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
