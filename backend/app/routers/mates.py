"""Mates API (docs/mate.md): CRUD, conversation, memory, assets/avatar
imports, Live2D Cubism Core, voice (settings, speech, transcription, voices)."""

from __future__ import annotations

import asyncio
import os
import tempfile
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse

from app.config import settings
from app.mate import files, netio
from app.mate.service import MateService
from app.mate.store import MateError
from app.mate.voice import VoiceService
from app.services.session_service import TurnBusyError

router = APIRouter(prefix="/api/mates")

_ASSET_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
}


def _svc(request: Request) -> MateService:
    return request.app.state.mate_service


def _voice(request: Request) -> VoiceService:
    return request.app.state.voice_service


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, KeyError):
        return HTTPException(status_code=404, detail=str(exc).strip("'\""))
    if isinstance(exc, MateError):
        return HTTPException(status_code=exc.status, detail=str(exc))
    if isinstance(exc, TurnBusyError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, netio.UpstreamError):
        return HTTPException(status_code=502, detail=str(exc))
    raise exc


def _mate(request: Request, mate_id: str) -> dict[str, Any]:
    try:
        return _svc(request).get(mate_id)
    except KeyError as exc:
        raise _http(exc) from exc


async def _json(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="expected a JSON object") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    return body


# ---- global (non-{id}) routes first ----

@router.get("")
async def list_mates(request: Request) -> list[dict]:
    """All mates (default first). With none yet, creates "Geny"."""
    return _svc(request).list()


@router.post("")
async def create_mate(request: Request) -> dict:
    try:
        return _svc(request).create(await _json(request))
    except MateError as exc:
        raise _http(exc) from exc


@router.get("/settings")
async def get_settings(request: Request) -> dict:
    return _svc(request).store.settings()


@router.put("/settings")
async def put_settings(request: Request) -> dict:
    try:
        return _svc(request).store.update_settings(await _json(request))
    except MateError as exc:
        raise _http(exc) from exc


@router.get("/voices")
async def list_voices(request: Request, engine: str = "openai") -> dict:
    try:
        return {"engine": engine, "voices": await _voice(request).voices(engine)}
    except (MateError, netio.UpstreamError) as exc:
        raise _http(exc) from exc


@router.get("/live2d/core")
async def core_status() -> dict:
    return files.core_status()


@router.post("/live2d/core/install")
async def core_install(request: Request) -> dict:
    """Download the Cubism Core from Live2D's CDN (the user accepted the
    Live2D licence in the UI; it is not redistributed with the app)."""
    body = {}
    if request.headers.get("content-type", "").startswith("application/json"):
        body = await _json(request)
    if body.get("accept_license") is False:
        raise HTTPException(status_code=400, detail="the Live2D licence must be accepted")
    try:
        resp = await netio.request("GET", files.CORE_URL, timeout=60)
        if resp.status >= 400:
            raise netio.UpstreamError(f"Live2D CDN: HTTP {resp.status}", status=resp.status)
        return await asyncio.to_thread(files.store_core, resp.body)
    except (MateError, netio.UpstreamError) as exc:
        raise _http(exc) from exc


@router.get("/live2d/core.js")
async def core_js() -> FileResponse:
    p = files.core_path()
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Live2D Cubism Core is not installed")
    return FileResponse(p, media_type="application/javascript",
                        headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"})


@router.post("/import-local")
async def import_local(request: Request) -> dict:
    """Import from a folder/file on this server: an ailism content mate
    (``mates/<key>.json`` + ``assets/<key>/`` + an optional ``voices/<key>/``),
    a whole ailism content folder (every character in it), a rig pack folder
    or a Live2D model folder. Creates a new mate unless ``mate_id`` is given
    (then only the avatar of that mate is replaced); an ailism character
    already imported (same name) is updated in place."""
    body = await _json(request)
    svc = _svc(request)
    try:
        info = await asyncio.to_thread(files.classify_local, str(body.get("path") or ""))
        if info["kind"] == "ailism_many":
            mates = [await _import_one(svc, item, None, None) for item in info["items"]]
            return {"mate": mates[0], "mates": mates, "imported": "ailism"}
        mate = await _import_one(svc, info, body.get("mate_id"), body.get("name"))
        return {"mate": mate, "mates": [mate], "imported": info["kind"]}
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


async def _import_one(svc: Any, info: dict[str, Any], target: Any, name: Any) -> dict[str, Any]:
    created = False
    if target:
        mate = svc.get(str(target))
    elif info["kind"] == "ailism":
        mate_name, persona = files.ailism_persona(info["doc"])
        same = next((m for m in svc.list() if m["name"] == mate_name), None)
        if same is not None:
            mate = svc.update(same["id"], {"persona": persona})
        else:
            mate, created = svc.create({"name": mate_name, "persona": persona}), True
        voice = await asyncio.to_thread(files.ailism_voice, info["doc"], info.get("voice_dir"), mate["id"])
        if voice:
            mate = svc.update(mate["id"], {"voice": voice})
    else:
        base = info["folder"] if info["kind"] == "pack" else info["model"].parent
        label = base.name if base.name not in ("runtime", "model", "assets") else base.parent.name
        mate, created = svc.create({"name": name or label or "Mate"}), True
    try:
        if info["kind"] == "live2d":
            avatar = await asyncio.to_thread(files.import_folder_live2d, mate["id"], info["model"])
        elif info["kind"] == "pack":
            avatar = await asyncio.to_thread(files.import_folder_pack, mate["id"], info["folder"])
        elif info.get("assets") is not None:
            fallback = ((info["doc"].get("doc") or {}).get("mate") or {}).get("body")
            avatar = await asyncio.to_thread(files.import_folder_pack, mate["id"], info["assets"], fallback)
        else:
            avatar = None  # persona only (no assets folder next to it)
    except Exception:
        if created:
            svc.delete(mate["id"])
        raise
    if avatar is not None:
        mate = svc.update(mate["id"], {"avatar": avatar})
    return mate


# ---- one mate ----

@router.get("/{mate_id}")
async def get_mate(mate_id: str, request: Request) -> dict:
    return _mate(request, mate_id)


@router.patch("/{mate_id}")
@router.put("/{mate_id}")
async def update_mate(mate_id: str, request: Request) -> dict:
    """Partial update: persona / llm / voice merge field by field; avatar is
    replaced. Persona or LLM changes reach the engine at its next turn."""
    try:
        return _svc(request).update(mate_id, await _json(request))
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.delete("/{mate_id}")
async def delete_mate(mate_id: str, request: Request) -> dict:
    try:
        _svc(request).delete(mate_id)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc
    return {"id": mate_id, "deleted": True}


@router.post("/{mate_id}/conversation")
async def conversation(mate_id: str, request: Request) -> dict:
    """The mate's conversation session (created on first use). Stream it
    with /api/history/{session_id} + /ws/chat/{session_id}."""
    try:
        return _svc(request).conversation(mate_id)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.post("/{mate_id}/conversation/reset")
async def conversation_reset(mate_id: str, request: Request) -> dict:
    """Fresh context (like /clear): history stays, the engine forgets it."""
    try:
        return _svc(request).reset(mate_id)
    except (KeyError, MateError, TurnBusyError) as exc:
        raise _http(exc) from exc


# ---- memory ----

@router.get("/{mate_id}/memories")
async def list_memories(mate_id: str, request: Request) -> list[dict]:
    _mate(request, mate_id)
    return _svc(request).store.memories(mate_id)


@router.post("/{mate_id}/memories")
async def add_memory(mate_id: str, request: Request) -> dict:
    body = await _json(request)
    try:
        return _svc(request).store.add_memory(mate_id, str(body.get("text") or ""), by_user=True)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.delete("/{mate_id}/memories/{mem_id}")
async def delete_memory(mate_id: str, mem_id: str, request: Request) -> dict:
    _mate(request, mate_id)
    if not _svc(request).store.delete_memory(mate_id, mem_id, by_user=True):
        raise HTTPException(status_code=404, detail="memory not found")
    return {"id": mem_id, "deleted": True}


# ---- assets / avatar ----

@router.post("/{mate_id}/assets")
async def upload_asset(mate_id: str, request: Request, file: UploadFile = File(...),
                       path: str = Form("")) -> dict:
    _mate(request, mate_id)
    try:
        return await files.save_upload(mate_id, path or (file.filename or ""), file)
    except MateError as exc:
        raise _http(exc) from exc


@router.get("/{mate_id}/assets/{rel:path}")
async def get_asset(mate_id: str, rel: str, request: Request, v: str | None = None) -> FileResponse:
    try:
        p = files.resolve_asset(mate_id, rel)
    except (KeyError, MateError) as exc:
        raise HTTPException(status_code=404, detail="asset not found") from exc
    # FileResponse answers Range requests (video seeking) and sets ETag/Last-Modified.
    immutable = v is not None or files.is_immutable(rel)
    return FileResponse(p, media_type=files.content_type(p), headers={
        **_ASSET_HEADERS,
        "Cache-Control": "private, max-age=31536000, immutable" if immutable else "private, no-cache",
    })


@router.post("/{mate_id}/avatar/import")
async def import_avatar(mate_id: str, request: Request, file: UploadFile = File(...)) -> dict:
    """A zip: an ailism-style pack (rig.json + files -> video/photo) or a
    Live2D model (*.model3.json; geny-avatar's avatar-editor.json is read)."""
    _mate(request, mate_id)
    limit = settings.mate_asset_max_mb * 1024 * 1024
    fd, tmp = tempfile.mkstemp(suffix=".zip", prefix="mate-import-")
    try:
        size = 0
        with os.fdopen(fd, "wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise HTTPException(status_code=413, detail=f"zip is larger than {settings.mate_asset_max_mb} MB")
                fh.write(chunk)
        try:
            avatar = await asyncio.to_thread(files.import_zip, mate_id, tmp)
            return {"mate": _svc(request).update(mate_id, {"avatar": avatar}), "avatar": avatar}
        except (KeyError, MateError) as exc:
            raise _http(exc) from exc
    finally:
        os.unlink(tmp)


# ---- voice ----

@router.post("/{mate_id}/speech")
async def speech(mate_id: str, request: Request) -> Response:
    """{text, emotion?} -> audio. 204 when the mate's TTS engine is
    ``browser``/``off`` (the page speaks)."""
    mate = _mate(request, mate_id)
    body = await _json(request)
    try:
        out = await _voice(request).speech(mate, str(body.get("text") or ""), str(body.get("emotion") or ""))
    except (MateError, netio.UpstreamError) as exc:
        raise _http(exc) from exc
    if out is None:
        return Response(status_code=204)
    return Response(content=out.body, media_type=out.media_type, headers={
        "Cache-Control": "private, max-age=86400", "X-Speech-Cache": "hit" if out.cached else "miss"})


@router.post("/{mate_id}/transcribe")
async def transcribe(mate_id: str, request: Request, file: UploadFile = File(...)) -> dict:
    mate = _mate(request, mate_id)
    audio = await file.read(26 * 1024 * 1024)
    try:
        return await _voice(request).transcribe(mate, audio, file.filename or "speech.webm",
                                                file.content_type or "audio/webm")
    except (MateError, netio.UpstreamError) as exc:
        raise _http(exc) from exc
