"""Avatar Create API (docs/avatar-create.md §7).

User routes (the console's cookie; the agent can't reach them): projects, the reference upload, the estimate
card's Confirm / Change plan / Cancel, checkpoint decisions, redo and extra confirmations, pause / resume / cancel,
apply / restore, the project's files, and the processing tools' install.

``/api/internal/avatar/call`` is the agent's MCP bridge (loopback, its conversation token; app.auth).
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from app.avatar.plan import GateError
from app.avatar.presets import BriefError
from app.avatar.store import AvatarError
from app.higgsfield.oauth import HiggsfieldError

router = APIRouter(prefix="/api/avatar")
internal = APIRouter(prefix="/api/internal/avatar")

TOKEN_HEADER = "x-avatar-token"


def _svc(request: Request) -> Any:
    return request.app.state.avatar_service


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, GateError):
        return HTTPException(status_code=409, detail=str(exc), headers={"X-Avatar-Gate": exc.code})
    if isinstance(exc, AvatarError):
        return HTTPException(status_code=exc.status, detail=str(exc))
    if isinstance(exc, (BriefError, HiggsfieldError)):
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, KeyError):
        return HTTPException(status_code=404, detail="not found")
    raise exc


async def _body(request: Request) -> dict[str, Any]:
    try:
        b = await request.json()
    except ValueError:
        return {}
    return b if isinstance(b, dict) else {}


@router.get("/env")
async def env(request: Request) -> dict:
    return await _svc(request).env()


@router.post("/env/install")
async def install(request: Request) -> StreamingResponse:
    """Create the processing venv (streams NDJSON {phase, line} … then the status)."""
    deps = _svc(request).deps

    async def gen():
        async for item in deps.install_stream():
            yield json.dumps(item, ensure_ascii=False) + "\n"
    return StreamingResponse(gen(), media_type="application/x-ndjson")


@router.get("/projects")
async def list_projects(request: Request) -> list[dict]:
    return _svc(request).list()


@router.post("/projects")
async def create_project(request: Request) -> dict:
    b = await _body(request)
    try:
        return _svc(request).create(mate_id=b.get("mate_id") or None, language=str(b.get("language") or "en"),
                                    provider=str(b.get("provider") or "claude"))
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None


@router.get("/projects/{pid}")
async def get_project(pid: str, request: Request) -> dict:
    try:
        return _svc(request).view(pid)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None


@router.delete("/projects/{pid}")
async def delete_project(pid: str, request: Request) -> dict:
    try:
        _svc(request).delete(pid)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None
    return {"ok": True}


@router.post("/projects/{pid}/reference")
async def upload_reference(pid: str, request: Request, file: UploadFile = File(...)) -> dict:
    data = await file.read(30 * 1024 * 1024 + 1)
    try:
        return await _svc(request).upload_reference(pid, file.filename or "ref.png", data)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None


async def _act(request: Request, pid: str, action: str) -> dict:
    svc = _svc(request)
    b = await _body(request)
    try:
        if action == "answer":
            await svc.answer(pid)
            return svc.view(pid)
        if action == "estimate":
            return await svc.estimate(pid)
        if action == "confirm":
            return await svc.confirm(pid, b.get("plan_id"), b.get("total"))
        if action in ("change", "decline"):
            return await svc.decline(pid)
        if action == "discard":
            return await svc.decline(pid, cancel=True)
        if action == "pause":
            svc.pause(pid)
        elif action == "resume":
            svc.resume(pid)
        elif action == "cancel":
            svc.cancel(pid)
        elif action == "checkpoint":
            return await svc.checkpoint(pid, str(b.get("action") or ""), candidate=b.get("candidate"))
        elif action == "redo":
            return await svc.user_redo(pid, str(b.get("item") or ""), str(b.get("note") or ""))
        elif action == "apply":
            return await svc.apply(pid, mate_id=b.get("mate_id") or None,
                                   new_name=b.get("new_name") if b.get("new") else None)
        elif action == "restore":
            return await svc.restore(pid)
        else:
            raise HTTPException(status_code=404, detail="unknown action")
        return svc.view(pid)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None


for _a in ("answer", "estimate", "confirm", "change", "discard", "pause", "resume", "cancel", "checkpoint", "redo",
           "apply", "restore"):
    async def _route(pid: str, request: Request, _action: str = _a) -> dict:
        return await _act(request, pid, _action)
    router.add_api_route(f"/projects/{{pid}}/{_a}", _route, methods=["POST"], name=f"avatar_{_a}")


# ---- the Mate Create studio (docs/avatar-create.md §11) ----

@router.post("/studio")
async def studio_open(request: Request) -> dict:
    """``{mate_id?, language, fresh?, outfit?: {id}}`` → the studio's project: a new draft mate (no ``mate_id``), a
    draft's own project, an existing mate's latest project (``fresh``: a new one) or the one filling an outfit of hers."""
    b = await _body(request)
    try:
        return _svc(request).studio_open(mate_id=b.get("mate_id") or None, language=str(b.get("language") or "en"),
                                         provider=str(b.get("provider") or "claude"), fresh=bool(b.get("fresh")),
                                         outfit=b["outfit"] if isinstance(b.get("outfit"), dict) else None)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None


@router.get("/studio/drafts")
async def studio_drafts(request: Request) -> list[dict]:
    return _svc(request).drafts()


@router.patch("/studio/{pid}/fields")
async def studio_fields(pid: str, request: Request) -> dict:
    """The user's edits on the right: ``{name?, persona?, prefs?, voice?, llm?, concept?}`` (merged)."""
    try:
        return await _svc(request).studio_fields(pid, await _body(request))
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None


@router.post("/studio/{pid}/{action}")
async def studio_action(pid: str, action: str, request: Request) -> dict:
    svc = _svc(request)
    b = await _body(request)
    try:
        if action == "undo":
            return await svc.studio_undo(pid, str(b.get("field") or ""))
        if action == "finish":
            return await svc.studio_finish(pid)
        if action == "skip-avatar":
            return await svc.studio_skip_avatar(pid, b.get("skip", True) is not False)
        if action == "template":
            return await svc.studio_template(pid, str(b.get("mate_id") or ""))
        if action == "voice-ok":
            return await svc.studio_voice_ok(pid)
        if action == "brought-avatar":
            return await svc.studio_brought_avatar(pid)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None
    raise HTTPException(status_code=404, detail="unknown action")


@router.delete("/studio/{pid}")
async def studio_discard(pid: str, request: Request) -> dict:
    try:
        _svc(request).studio_discard(pid)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None
    return {"ok": True}


@router.post("/projects/{pid}/extras/{xid}/confirm")
async def confirm_extra(pid: str, xid: str, request: Request) -> dict:
    b = await _body(request)
    try:
        return await _svc(request).confirm_extra(pid, xid, b.get("total"))
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None


@router.post("/projects/{pid}/extras/{xid}/decline")
async def decline_extra(pid: str, xid: str, request: Request) -> dict:
    try:
        return await _svc(request).decline_extra(pid, xid)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None


@router.get("/projects/{pid}/files/{rel:path}")
async def project_file(pid: str, rel: str, request: Request) -> FileResponse:
    try:
        p = _svc(request).file_path(pid, rel)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from None
    from app.avatar.service import SERVE_EXT

    return FileResponse(p, media_type=SERVE_EXT.get(p.suffix.lower(), "application/octet-stream"),
                        headers={"Cache-Control": "private, max-age=3600" if request.query_params.get("v")
                                 else "no-cache"})


@internal.post("/call")
async def call_tool(request: Request) -> dict:
    svc = _svc(request)
    ctx = svc.token_info(request.headers.get(TOKEN_HEADER))
    if ctx is None:
        raise HTTPException(status_code=401, detail="invalid avatar token")
    b = await _body(request)
    if not isinstance(b.get("name"), str):
        raise HTTPException(status_code=400, detail="expected {name, arguments}")
    text, is_error, images = await svc.call_tool(ctx, b["name"], b.get("arguments") or {})
    return {"text": text, "is_error": is_error, **({"images": images} if images else {})}
