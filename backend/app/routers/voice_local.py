"""Local voice models (app/voicehost, docs/local-voice.md): this machine's GPU, the models to download and serve, the
voices they speak with, and a line said or heard to try them.

    GET    /api/voice/status?lang=ko             gate (can this machine serve them, and why not), system, models
    POST   /api/voice/models/{id}/install        {accept_license: true} → progress (refused without a suitable GPU)
    POST   /api/voice/models/{id}/cancel
    DELETE /api/voice/models/{id}                weights (and its engine environment once no model needs it)
    POST   /api/voice/models/{id}/load · /unload {park?}
    GET    /api/voice/voices                     built-in (한채린, 메스가키) and the user's own
    POST   /api/voice/voices {name, language}    · PATCH / DELETE /api/voice/voices/{vid}
    POST   /api/voice/voices/{vid}/references    multipart: file, label (feeling), transcript?
    PATCH  /api/voice/references/{rid} · DELETE /api/voice/references/{rid}
    GET    /api/voice/voices/{vid}/references/{rid}/audio
    POST   /api/voice/preview {model_id, voice_id?, text, emotion?, language?, instruct?, params?} → audio/wav
    POST   /api/voice/transcribe                 multipart: file, language? → {text, language}
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from app.preferences import request_language
from app.voicehost.service import PREVIEW, VoiceError, VoiceHost

router = APIRouter(prefix="/api/voice")


def _host(request: Request) -> VoiceHost:
    h = getattr(request.app.state, "voice_host", None)
    if h is None:
        raise HTTPException(status_code=503, detail="local voice is not available")
    return h


def _lang(request: Request) -> str:
    q = request.query_params.get("lang")
    if q in ("ko", "en"):
        return q
    try:
        return request_language(request) or "en"
    except Exception:  # noqa: BLE001
        return "en"


def _fail(e: VoiceError) -> JSONResponse:
    return JSONResponse({"detail": str(e), "code": e.code, "data": e.data}, status_code=e.status)


async def _body(request: Request) -> dict[str, Any]:
    try:
        b = await request.json()
    except ValueError:
        return {}
    return b if isinstance(b, dict) else {}


@router.get("/status")
async def status(request: Request) -> Any:
    import asyncio

    h = _host(request)
    return await asyncio.to_thread(h.status, _lang(request))


@router.post("/models/{model_id}/install")
async def install(model_id: str, request: Request) -> Any:
    b = await _body(request)
    try:
        return {"progress": _host(request).install(model_id, bool(b.get("accept_license")))}
    except VoiceError as e:
        return _fail(e)


@router.post("/models/{model_id}/cancel")
async def cancel(model_id: str, request: Request) -> Any:
    try:
        return {"cancelled": _host(request).cancel_install(model_id)}
    except VoiceError as e:
        return _fail(e)


@router.delete("/models/{model_id}")
async def remove(model_id: str, request: Request) -> Any:
    try:
        return await _host(request).remove(model_id)
    except VoiceError as e:
        return _fail(e)


@router.post("/models/{model_id}/load")
async def load(model_id: str, request: Request) -> Any:
    try:
        return {"resident": await _host(request).load(model_id)}
    except VoiceError as e:
        return _fail(e)


@router.post("/models/{model_id}/unload")
async def unload(model_id: str, request: Request) -> Any:
    b = await _body(request)
    try:
        return {"unloaded": await _host(request).unload(model_id, park=bool(b.get("park")))}
    except VoiceError as e:
        return _fail(e)


# ---- voices ----

def _public_voice(v: dict[str, Any]) -> dict[str, Any]:
    refs = [{k: r.get(k) for k in ("id", "label", "transcript", "language", "duration", "stats")}
            for r in v.get("references") or []]
    return {**{k: v.get(k) for k in ("id", "name", "language", "instruct", "builtin", "source", "rights",
                                     "created_at", "updated_at")}, "references": refs}


@router.get("/voices")
async def voices(request: Request) -> Any:
    return {"voices": [_public_voice(v) for v in _host(request).voices.list()]}


@router.post("/voices")
async def create_voice(request: Request) -> Any:
    b = await _body(request)
    h = _host(request)
    try:
        v = h.voices.create(str(b.get("name") or ""), str(b.get("language") or "auto"), str(b.get("instruct") or ""))
    except ValueError as e:
        return JSONResponse({"detail": str(e), "code": "bad_input"}, status_code=400)
    h.on_change("voices")
    return _public_voice({**v, "builtin": False})


@router.patch("/voices/{vid}")
async def update_voice(vid: str, request: Request) -> Any:
    b = await _body(request)
    h = _host(request)
    if vid.startswith("builtin:"):
        return JSONResponse({"detail": "A built-in voice can't be changed", "code": "builtin"}, status_code=400)
    v = h.store.update_voice(vid, name=b.get("name"), language=b.get("language"), instruct=b.get("instruct"))
    if v is None:
        raise HTTPException(status_code=404, detail="no such voice")
    h.on_change("voices")
    return _public_voice({**v, "builtin": False})


@router.delete("/voices/{vid}")
async def delete_voice(vid: str, request: Request) -> Any:
    h = _host(request)
    try:
        ok = h.voices.delete(vid)
    except ValueError as e:
        return JSONResponse({"detail": str(e), "code": "builtin"}, status_code=400)
    h.on_change("voices")
    return {"deleted": ok}


@router.post("/voices/{vid}/references")
async def add_reference(vid: str, request: Request, file: UploadFile = File(...), label: str = Form("neutral"),
                        transcript: str = Form(""), language: str = Form("")) -> Any:
    h = _host(request)
    data = await file.read(h.s.max_upload_mb * 1024 * 1024 + 1)
    try:
        ref = await h.add_reference(vid, data, label=label, transcript=transcript, language=language)
    except VoiceError as e:
        return _fail(e)
    return {k: ref.get(k) for k in ("id", "label", "transcript", "language", "duration", "stats")}


@router.patch("/references/{rid}")
async def update_reference(rid: str, request: Request) -> Any:
    b = await _body(request)
    h = _host(request)
    r = h.store.update_reference(rid, label=b.get("label"), transcript=b.get("transcript"), language=b.get("language"))
    if r is None:
        raise HTTPException(status_code=404, detail="no such reference")
    h.on_change("voices")
    return {k: r.get(k) for k in ("id", "label", "transcript", "language", "duration", "stats")}


@router.delete("/references/{rid}")
async def delete_reference(rid: str, request: Request) -> Any:
    h = _host(request)
    ok = h.voices.delete_reference(rid)
    h.on_change("voices")
    return {"deleted": ok}


@router.get("/voices/{vid}/references/{rid}/audio")
async def reference_audio(vid: str, rid: str, request: Request) -> Any:
    f = _host(request).voices.reference_file(vid, rid)
    if f is None:
        raise HTTPException(status_code=404, detail="no such reference")
    return FileResponse(str(f), media_type="audio/wav", headers={"Cache-Control": "private, max-age=3600"})


# ---- trying it ----

@router.post("/preview")
async def preview(request: Request) -> Any:
    b = await _body(request)
    h = _host(request)
    vid = str(b.get("voice_id") or "")
    ref = h.voices.resolve(vid, b.get("emotion")) if vid else None
    if vid and ref is None:
        return JSONResponse({"detail": "That voice has no usable clip", "code": "needs_voice"}, status_code=400)
    try:
        wav, info = await h.synthesize(str(b.get("model_id") or h.default_model("tts")), str(b.get("text") or ""),
                                       reference=ref, language=str(b.get("language") or (ref or {}).get("language")
                                                                    or "auto"),
                                       instruct=str(b.get("instruct") or ""), params=b.get("params") or {},
                                       seed=b.get("seed"), priority=PREVIEW)
    except VoiceError as e:
        return _fail(e)
    headers = {"X-Voice-Info": ";".join(f"{k}={v}" for k, v in info.items() if v is not None)[:900]}
    return Response(wav, media_type="audio/wav", headers=headers)


@router.post("/transcribe")
async def transcribe(request: Request, file: UploadFile = File(...), language: str = Form("auto")) -> Any:
    h = _host(request)
    data = await file.read(h.s.max_upload_mb * 1024 * 1024 + 1)
    try:
        return await h.transcribe(data, language=language, priority=PREVIEW)
    except VoiceError as e:
        return _fail(e)
