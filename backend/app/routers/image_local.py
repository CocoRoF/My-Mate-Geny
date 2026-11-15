"""Local image models (app/imagehost, docs/local-image.md): this machine's GPU, the models to download, the recipes to
try, and what they made. Image Studio (Settings → 로컬 모델 호스팅 → Image Studio) sets things up here; the avatar
maker uses them (app/avatar/local.py).

    GET    /api/image/status?lang=ko             gate (can this machine run it, and why not), engine, models, recipes
    POST   /api/image/models/{id}/install        {accept_license: true} → progress (refused without a suitable GPU)
    POST   /api/image/models/{id}/cancel
    DELETE /api/image/models/{id}                its files (those another installed model needs stay)
    GET/PUT /api/image/settings                  idle time, history size, the model each use takes, recipe knobs,
                                                 the avatar maker's engine per stage
    POST   /api/image/engine/stop                stop ComfyUI now (its GPU memory back)
    POST   /api/image/jobs                       multipart: kind (draft|edit|loop|cutout|matte), prompt?, negative?,
                                                 params? (JSON), model_id?, image? end_image? clip? refs*, or
                                                 image_from / clip_from = "<job id>/<file>" (a result as the input)
    GET    /api/image/jobs?kind&source&starred&limit&offset · GET /api/image/jobs/{id}
    POST   /api/image/jobs/{id}/cancel · PATCH /api/image/jobs/{id} {starred} · POST /api/image/jobs/delete {ids}
    GET    /api/image/jobs/{id}/files/{name}?download=1
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from app.imagehost.service import KINDS, ImageError, ImageHost
from app.preferences import request_language

router = APIRouter(prefix="/api/image")

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXT = {".mp4", ".webm", ".mov"}
IMAGE_MAX = 25 << 20
VIDEO_MAX = 300 << 20
MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4",
               ".webm": "video/webm"}


def _host(request: Request) -> ImageHost:
    h = getattr(request.app.state, "image_host", None)
    if h is None:
        raise HTTPException(status_code=503, detail="local image is not available")
    return h


def _lang(request: Request) -> str:
    q = request.query_params.get("lang")
    if q in ("ko", "en"):
        return q
    try:
        return request_language(request) or "en"
    except Exception:  # noqa: BLE001
        return "en"


def _fail(e: ImageError) -> JSONResponse:
    return JSONResponse({"detail": str(e), "code": e.code, "data": e.data}, status_code=e.status)


async def _body(request: Request) -> dict[str, Any]:
    try:
        b = await request.json()
    except ValueError:
        return {}
    return b if isinstance(b, dict) else {}


@router.get("/status")
async def status(request: Request) -> Any:
    h = _host(request)
    return await asyncio.to_thread(h.status, _lang(request))


@router.post("/models/{model_id}/install")
async def install(model_id: str, request: Request) -> Any:
    b = await _body(request)
    try:
        return {"progress": _host(request).install(model_id, bool(b.get("accept_license")))}
    except ImageError as e:
        return _fail(e)


@router.post("/models/{model_id}/cancel")
async def cancel_install(model_id: str, request: Request) -> Any:
    try:
        return {"cancelled": _host(request).cancel_install(model_id)}
    except ImageError as e:
        return _fail(e)


@router.delete("/models/{model_id}")
async def remove(model_id: str, request: Request) -> Any:
    try:
        return await _host(request).remove(model_id)
    except ImageError as e:
        return _fail(e)


@router.get("/settings")
async def get_settings(request: Request) -> Any:
    return _host(request).settings_doc()


@router.put("/settings")
async def put_settings(request: Request) -> Any:
    try:
        return _host(request).put_settings(await _body(request))
    except ImageError as e:
        return _fail(e)


@router.post("/engine/stop")
async def stop_engine(request: Request) -> Any:
    try:
        return {"stopped": await _host(request).stop_engine()}
    except ImageError as e:
        return _fail(e)


# ---- jobs ----

async def _save_upload(h: ImageHost, up: Any, video: bool) -> Path:
    name = str(getattr(up, "filename", "") or "")
    ext = Path(name).suffix.lower()
    if ext not in (VIDEO_EXT if video else IMAGE_EXT):
        raise ImageError(f"{name or 'the file'}: not a {'video' if video else 'picture'} this can read",
                         code="bad_input")
    data = await up.read()
    if len(data) > (VIDEO_MAX if video else IMAGE_MAX):
        raise ImageError(f"{name}: too large", code="too_large", status=413)
    h.s.tmp_dir.mkdir(parents=True, exist_ok=True)
    p = h.s.tmp_dir / f"up-{uuid.uuid4().hex}{ext}"
    p.write_bytes(data)
    return p


def _from_job(h: ImageHost, ref: str) -> Path:
    jid, _, name = str(ref).partition("/")
    p = h.job_file(jid, name)
    if p is None:
        raise ImageError(f"{ref}: no such result", code="bad_input")
    return p


@router.post("/jobs")
async def submit(request: Request) -> Any:
    h = _host(request)
    form = await request.form()
    kind = str(form.get("kind") or "")
    if kind not in KINDS:
        return JSONResponse({"detail": f"kind: one of {', '.join(KINDS)}", "code": "bad_input"}, status_code=400)
    temp: list[Path] = []
    try:
        params: dict[str, Any] = {}
        if form.get("params"):
            try:
                params = json.loads(str(form.get("params")))
            except ValueError:
                raise ImageError("params: not JSON", code="bad_input") from None
            if not isinstance(params, dict):
                raise ImageError("params: an object", code="bad_input")
        inputs: dict[str, Any] = {"prompt": str(form.get("prompt") or ""), "negative": str(form.get("negative") or "")}
        for key, video in (("image", False), ("end_image", False), ("clip", True)):
            up = form.get(key)
            if up is not None and hasattr(up, "read"):
                p = await _save_upload(h, up, video)
                temp.append(p)
                inputs[key] = str(p)
            elif form.get(f"{key}_from"):
                inputs[key] = str(_from_job(h, str(form.get(f"{key}_from"))))
        refs = []
        for up in form.getlist("refs"):
            if hasattr(up, "read"):
                p = await _save_upload(h, up, False)
                temp.append(p)
                refs.append(str(p))
        for ref in form.getlist("refs_from"):
            refs.append(str(_from_job(h, str(ref))))
        if refs:
            inputs["refs"] = refs
        for key in ("box", "exclude"):
            if form.get(key):
                try:
                    inputs[key] = [int(x) for x in json.loads(str(form.get(key)))][:4]
                except (ValueError, TypeError):
                    raise ImageError(f"{key}: [x0, y0, x1, y1]", code="bad_input") from None
        return h.submit(kind, inputs=inputs, params=params, source="studio", model_id=str(form.get("model_id") or ""))
    except ImageError as e:
        return _fail(e)
    finally:
        for p in temp:  # (the job keeps its own copies)
            p.unlink(missing_ok=True)


@router.get("/jobs")
async def jobs(request: Request) -> Any:
    q = request.query_params
    try:
        limit, offset = min(200, int(q.get("limit") or 60)), int(q.get("offset") or 0)
    except ValueError:
        limit, offset = 60, 0
    starred = True if q.get("starred") in ("1", "true") else None
    return _host(request).history(kind=q.get("kind") or "", source=q.get("source") or "", starred=starred,
                                  limit=limit, offset=offset)


@router.get("/jobs/{jid}")
async def job(jid: str, request: Request) -> Any:
    j = _host(request).job(jid)
    if j is None:
        raise HTTPException(status_code=404, detail="no such job")
    return j


@router.post("/jobs/{jid}/cancel")
async def cancel_job(jid: str, request: Request) -> Any:
    return {"cancelled": await _host(request).cancel(jid)}


@router.patch("/jobs/{jid}")
async def update_job(jid: str, request: Request) -> Any:
    b = await _body(request)
    if not isinstance(b.get("starred"), bool):
        return JSONResponse({"detail": "starred: true or false", "code": "bad_input"}, status_code=400)
    j = _host(request).star(jid, b["starred"])
    if j is None:
        raise HTTPException(status_code=404, detail="no such job")
    return j


@router.post("/jobs/delete")
async def delete_jobs(request: Request) -> Any:
    b = await _body(request)
    ids = [str(x) for x in (b.get("ids") or []) if x][:1000]
    return {"deleted": await asyncio.to_thread(_host(request).delete_jobs, ids)}


@router.get("/jobs/{jid}/files/{name}")
async def job_file(jid: str, name: str, request: Request) -> Any:
    h = _host(request)
    p = h.job_file(jid, name)
    if p is None:
        raise HTTPException(status_code=404, detail="no such file")
    disp = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(f'{jid}-{name}')}"} \
        if request.query_params.get("download") else {}
    return FileResponse(str(p), media_type=MEDIA_TYPES.get(p.suffix.lower(), "application/octet-stream"),
                        headers={"Cache-Control": "private, max-age=86400", **disp})
