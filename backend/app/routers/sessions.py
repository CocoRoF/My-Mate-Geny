from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel

from app.routers._deps import session_service, workspace_service
from app.schemas.models import SessionCreate, SessionUpdate
from app.services import folder_routing
from app.services import folders as folder_model
from app.services.session_service import SessionService, TurnBusyError
from app.services.workspace_service import WorkspaceService

router = APIRouter(prefix="/api/sessions")


@router.get("")
async def list_sessions(response: Response, svc: SessionService = Depends(session_service)) -> list[dict]:
    # Version read BEFORE the query: a change racing the read carries a newer
    # version, so the client's feed (/ws/sessions) fetches again — never misses.
    response.headers["X-Sessions-Version"] = str(svc.list_version)
    response.headers["Cache-Control"] = "no-store"
    return svc.list_all()


@router.post("")
async def create_session(body: SessionCreate, svc: SessionService = Depends(session_service),
                         ws: WorkspaceService = Depends(workspace_service)) -> dict:
    try:
        folders = None
        if body.folders:
            stub = {"connection_id": body.connection_id, "workspace_path": body.workspace_path, "folders": []}
            folders = await folder_routing.prepare(stub, [f.model_dump() for f in body.folders], ws)
        return svc.create(
            provider=body.provider,
            model=body.model,
            effort=body.effort,
            connection_id=body.connection_id,
            workspace_path=body.workspace_path,
            title=body.title,
            mode=body.mode,
            extra_dirs=body.extra_dirs,
            folders=folders,
        )
    except folder_routing.FolderError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/{sid}")
async def update_session(
    sid: str, body: SessionUpdate, svc: SessionService = Depends(session_service),
    ws: WorkspaceService = Depends(workspace_service),
) -> dict:
    try:
        folders = None
        if body.folders is not None or body.extra_dirs is not None:
            # folders being attached are checked on their hosts first (reachable, there, a folder)
            session = svc.get(sid)
            wanted = ([f.model_dump() for f in body.folders] if body.folders is not None
                      else folder_model.merge_legacy(session["folders"], body.extra_dirs or [], session["connection_id"]))
            folders = await folder_routing.prepare(session, wanted, ws)
        return svc.update(
            sid, provider=body.provider, model=body.model, effort=body.effort,
            mode=body.mode, folders=folders, title=body.title,
            auto_compact_window=body.auto_compact_window, account_id=body.account_id,
            higgsfield=body.higgsfield, mcp=body.mcp,
        )
    except folder_routing.FolderError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{sid}/tasks")
async def list_tasks(sid: str, svc: SessionService = Depends(session_service)) -> list[dict]:
    return svc.list_tasks(sid)


@router.get("/{sid}/tasks/page")
async def tasks_page(sid: str, cursor: str | None = Query(None, max_length=2048),
                     svc: SessionService = Depends(session_service)) -> dict:
    try:
        return svc.task_page(sid, cursor)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail='session not found') from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{sid}/tasks/{task_id}/output")
async def task_output(sid: str, task_id: str, tail: int = 65536, svc: SessionService = Depends(session_service)) -> dict:
    try:
        return svc.task_output(sid, task_id, max(1024, min(tail, 4 * 1024 * 1024)))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc


@router.post("/{sid}/tasks/{task_id}/stop")
async def stop_task(sid: str, task_id: str, svc: SessionService = Depends(session_service)) -> dict:
    ok = await svc.stop_task(sid, task_id)
    if not ok:
        raise HTTPException(status_code=409, detail="no running engine for this session")
    return {"task_id": task_id, "stopping": True}


@router.get("/{sid}/changes/{eid}/diff")
async def changes_diff(sid: str, eid: int, repo: int = 0, path: str | None = None,
                       svc: SessionService = Depends(session_service)) -> dict:
    try:
        return {"patch": await svc.changes_patch(sid, eid, repo, path)}
    except (KeyError, IndexError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


class RevertBody(BaseModel):
    repo: int | None = None
    paths: list[str] | None = None


@router.post("/{sid}/changes/{eid}/revert")
async def changes_revert(sid: str, eid: int, body: RevertBody,
                         svc: SessionService = Depends(session_service)) -> dict:
    try:
        return await svc.revert_changes(sid, eid, body.repo, body.paths)
    except (KeyError, IndexError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except TurnBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/{sid}/stop")
async def stop_turn(sid: str, svc: SessionService = Depends(session_service)) -> dict:
    return {"id": sid, "stopped": svc.stop(sid)}


@router.post("/{sid}/seen")
async def mark_seen(sid: str, svc: SessionService = Depends(session_service)) -> dict:
    """The chat was opened: its last run's result ("Complete" / "Failed" / "Stopped" in the sidebar) is seen —
    on every device (announced on /ws/sessions when it changed). A chat socket that says it is on screen
    (``attach`` with ``visible: true``) does the same."""
    try:
        changed = svc.mark_seen(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"id": sid, "result_unseen": False, "changed": changed}


@router.post("/{sid}/reset-context")
async def reset_context(sid: str, svc: SessionService = Depends(session_service)) -> dict:
    """``/clear`` — the next turn starts a fresh provider conversation."""
    try:
        return svc.reset_context(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except TurnBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/{sid}")
async def get_session(sid: str, svc: SessionService = Depends(session_service)) -> dict:
    try:
        return svc.get(sid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{sid}/messages")
async def get_messages(sid: str, svc: SessionService = Depends(session_service)) -> list[dict]:
    return svc.messages(sid)


@router.get("/{sid}/events")
async def get_events(sid: str, svc: SessionService = Depends(session_service)) -> list[dict]:
    return svc.events(sid)


@router.delete("/{sid}")
async def delete_session(sid: str, svc: SessionService = Depends(session_service)) -> dict:
    svc.delete(sid)
    return {"id": sid, "deleted": True}
