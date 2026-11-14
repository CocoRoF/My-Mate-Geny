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

Voice Studio (Settings → 로컬 모델 호스팅 → Voice Studio):
    GET    /api/voice/overview?lang=ko           GPUs (load, temperature, power; whose memory: this app's models,
                                                 other programs, unseen), models on the GPU, the GPU queue, events
    GET/PUT /api/voice/settings                  GPU budget, idle times, history limits, default models / profile
    GET/PUT /api/voice/models/{id}/defaults      a model's default parameters
    POST   /api/voice/generate {model_id?, voice_id?, feeling?, mode?, language?, instruct?, params?, seed?, text,
                                source?} → the history entry (its audio: /history/{id}/audio)
    GET    /api/voice/history?q&voice_id&model_id&source&starred&limit&offset · /history/facets
    GET    /api/voice/history/{id}/audio?format=wav|mp3|ogg|flac&download=1
    PATCH  /api/voice/history/{id} {starred?, note?} · POST /api/voice/history/delete {ids}
    POST   /api/voice/history/{id}/save-as-reference {voice_id, label, transcript?}
    POST   /api/voice/voices/{vid}/duplicate {name?} · POST /api/voice/references/{rid}/trim {start, end}
    POST   /api/voice/analyze                    multipart: file, transcribe?, window? → probe, stats, windows, words
    POST   /api/voice/batches {label, settings, content, format} · GET /api/voice/batches · GET /batches/{id}
    POST   /api/voice/batches/{id}/cancel · /retry {failed_only?} · DELETE /api/voice/batches/{id}
    GET    /api/voice/batches/{id}/zip?format=wav|mp3|ogg|flac
"""

from __future__ import annotations

import asyncio
import re
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.background import BackgroundTask

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
    b = await _body(request)
    try:
        return {"resident": await _host(request).load(model_id, source=str(b.get("source") or "settings")[:40])}
    except VoiceError as e:
        return _fail(e)


@router.get("/models/{model_id}/defaults")
async def model_defaults(model_id: str, request: Request) -> Any:
    try:
        return {"params": _host(request).model_defaults(model_id)}
    except VoiceError as e:
        return _fail(e)


@router.put("/models/{model_id}/defaults")
async def put_model_defaults(model_id: str, request: Request) -> Any:
    b = await _body(request)
    try:
        return {"params": _host(request).put_model_defaults(model_id, b.get("params") or {})}
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
                                     "description", "default_model", "default_params", "tags", "starred",
                                     "created_at", "updated_at")}, "references": refs}


@router.get("/voices")
async def voices(request: Request) -> Any:
    return {"voices": [_public_voice(v) for v in _host(request).voices.list()]}


@router.post("/voices")
async def create_voice(request: Request) -> Any:
    b = await _body(request)
    h = _host(request)
    more = {k: b[k] for k in ("description", "default_model", "default_params", "tags") if b.get(k) is not None}
    try:
        v = h.voices.create(str(b.get("name") or ""), str(b.get("language") or "auto"), str(b.get("instruct") or ""),
                            **more)
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
    name = b.get("name")
    if name is not None and not " ".join(str(name).split()):
        return JSONResponse({"detail": "A voice needs a name", "code": "bad_input"}, status_code=400)
    tags = b.get("tags")
    v = h.store.update_voice(vid, name=" ".join(str(name).split())[:80] if name is not None else None,
                             language=b.get("language"), instruct=b.get("instruct"),
                             description=str(b["description"])[:1000] if b.get("description") is not None else None,
                             default_model=b.get("default_model"),
                             default_params=b.get("default_params") if isinstance(b.get("default_params"), dict) else None,
                             tags=[str(t)[:30] for t in tags][:20] if isinstance(tags, list) else None,
                             starred=b.get("starred") if isinstance(b.get("starred"), bool) else None)
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


@router.post("/voices/{vid}/duplicate")
async def duplicate_voice(vid: str, request: Request) -> Any:
    b = await _body(request)
    try:
        return _public_voice(_host(request).duplicate_voice(vid, str(b.get("name") or "")))
    except VoiceError as e:
        return _fail(e)


def _seconds(v: str) -> float | None:
    try:
        return float(v) if str(v).strip() != "" else None
    except ValueError:
        return None


@router.post("/voices/{vid}/references")
async def add_reference(vid: str, request: Request, file: UploadFile = File(...), label: str = Form("neutral"),
                        transcript: str = Form(""), language: str = Form(""), start: str = Form(""),
                        end: str = Form(""), replace: str = Form("1")) -> Any:
    h = _host(request)
    data = await file.read(h.s.max_upload_mb * 1024 * 1024 + 1)
    try:
        ref = await h.add_reference(vid, data, label=label, transcript=transcript, language=language,
                                    start=_seconds(start), end=_seconds(end), replace=replace not in ("0", "false"))
    except VoiceError as e:
        return _fail(e)
    return {k: ref.get(k) for k in ("id", "label", "transcript", "language", "duration", "stats")}


@router.post("/references/{rid}/trim")
async def trim_reference(rid: str, request: Request) -> Any:
    b = await _body(request)
    try:
        r = await _host(request).trim_reference(rid, b.get("start"), b.get("end"))
    except VoiceError as e:
        return _fail(e)
    return {k: r.get(k) for k in ("id", "label", "transcript", "language", "duration", "stats")}


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
    # (numbers and ids only: a header is latin-1, an instruction may be Korean)
    shown = ("model_id", "sample_rate", "seconds", "segments", "elapsed", "ready_seconds", "generate_seconds", "rtf", "seed")
    headers = {"X-Voice-Info": ";".join(f"{k}={info[k]}" for k in shown if info.get(k) is not None)[:900]}
    return Response(wav, media_type="audio/wav", headers=headers)


@router.post("/transcribe")
async def transcribe(request: Request, file: UploadFile = File(...), language: str = Form("auto")) -> Any:
    h = _host(request)
    data = await file.read(h.s.max_upload_mb * 1024 * 1024 + 1)
    try:
        return await h.transcribe(data, language=language, priority=PREVIEW, source="studio")
    except VoiceError as e:
        return _fail(e)


# ---- Voice Studio ----

@router.get("/overview")
async def overview(request: Request) -> Any:
    h = _host(request)
    return await asyncio.to_thread(h.overview, _lang(request))


@router.get("/settings")
async def get_settings(request: Request) -> Any:
    return _host(request).settings_doc()


@router.put("/settings")
async def put_settings(request: Request) -> Any:
    b = await _body(request)
    try:
        return _host(request).put_settings(b)
    except VoiceError as e:
        return _fail(e)


@router.post("/generate")
async def generate(request: Request) -> Any:
    b = await _body(request)
    h = _host(request)
    seed = b.get("seed")
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, (int, float))):
        return JSONResponse({"detail": "seed must be a number", "code": "bad_input"}, status_code=400)
    source = str(b.get("source") or "studio")
    if source not in ("studio", "compare", "seed"):
        source = "studio"
    try:
        return await h.generate(model_id=str(b.get("model_id") or ""), text=str(b.get("text") or ""),
                                voice_id=str(b.get("voice_id") or ""), feeling=str(b.get("feeling") or "neutral"),
                                mode=str(b.get("mode") or "auto"), language=str(b.get("language") or "auto"),
                                instruct=str(b.get("instruct") or ""), params=b.get("params") or {},
                                seed=None if seed is None else int(seed), source=source)
    except VoiceError as e:
        return _fail(e)


@router.get("/history")
async def history(request: Request) -> Any:
    q = request.query_params
    h = _host(request)
    try:
        limit, offset = int(q.get("limit") or 50), int(q.get("offset") or 0)
    except ValueError:
        limit, offset = 50, 0
    out = h.history.list(q=q.get("q") or "", voice_id=q.get("voice_id") or "", model_id=q.get("model_id") or "",
                         source=q.get("source") or "", starred=q.get("starred") in ("1", "true"),
                         batch_id=q.get("batch_id"), limit=limit, offset=offset)
    out["usage"] = h.history.usage()
    out["limits"] = {"entries": h.s.history_max_entries, "bytes": int(h.s.history_max_gb * (1 << 30))}
    return out


@router.get("/history/facets")
async def history_facets(request: Request) -> Any:
    return _host(request).history.facets()


def _name_part(s: str, n: int = 32) -> str:
    return re.sub(r"[^\w가-힣]+", "_", s, flags=re.UNICODE).strip("_")[:n] or "voice"


@router.get("/history/{hid}/audio")
async def history_audio(hid: str, request: Request) -> Any:
    from app.voicehost import audio

    h = _host(request)
    e = h.history.get(hid)
    if e is None or not h.history.path(e).is_file():
        raise HTTPException(status_code=404, detail="no such line")
    fmt = request.query_params.get("format") or "wav"
    if fmt not in audio.FORMATS:
        raise HTTPException(status_code=400, detail="format: wav, mp3, ogg or flac")
    name = f"{_name_part(e['voice_name'] or e['model_id'])}-{_name_part(e['text'], 24)}-{e['seed']}.{fmt}"
    disp = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"} \
        if request.query_params.get("download") else {}
    if fmt == "wav":
        return FileResponse(str(h.history.path(e)), media_type="audio/wav",
                            headers={"Cache-Control": "private, max-age=86400", **disp})
    try:
        data = await asyncio.to_thread(audio.encode, h.history.path(e), fmt)
    except audio.AudioError as err:
        return JSONResponse({"detail": str(err), "code": "format"}, status_code=400)
    return Response(data, media_type=audio.FORMATS[fmt], headers=disp)


@router.patch("/history/{hid}")
async def update_history(hid: str, request: Request) -> Any:
    b = await _body(request)
    h = _host(request)
    e = h.history.update(hid, starred=b.get("starred") if isinstance(b.get("starred"), bool) else None,
                         note=b.get("note") if isinstance(b.get("note"), str) else None)
    if e is None:
        raise HTTPException(status_code=404, detail="no such line")
    h.on_change("history")
    return e


@router.post("/history/delete")
async def delete_history(request: Request) -> Any:
    b = await _body(request)
    h = _host(request)
    ids = [str(x) for x in (b.get("ids") or []) if x][:1000]
    n = await asyncio.to_thread(h.history.delete, ids)
    h.on_change("history")
    return {"deleted": n}


@router.post("/history/{hid}/save-as-reference")
async def save_as_reference(hid: str, request: Request) -> Any:
    b = await _body(request)
    try:
        ref = await _host(request).save_as_reference(hid, str(b.get("voice_id") or ""), str(b.get("label") or "neutral"),
                                                     str(b.get("transcript") or ""))
    except VoiceError as e:
        return _fail(e)
    return {k: ref.get(k) for k in ("id", "label", "transcript", "language", "duration", "stats")}


@router.post("/analyze")
async def analyze(request: Request, file: UploadFile = File(...), transcribe: str = Form("0"),
                  window: str = Form("10")) -> Any:
    h = _host(request)
    data = await file.read(h.s.max_upload_mb * 1024 * 1024 + 1)
    if len(data) > h.s.max_upload_mb * 1024 * 1024:
        return JSONResponse({"detail": f"larger than {h.s.max_upload_mb} MB", "code": "too_large"}, status_code=400)
    try:
        return await h.analyze(data, transcribe=transcribe in ("1", "true"), window=_seconds(window) or 10.0)
    except VoiceError as e:
        return _fail(e)


@router.get("/batches")
async def batches(request: Request) -> Any:
    h = _host(request)
    return {"batches": h.batches.list(), "running": h.batch_runner.running()}


@router.post("/batches")
async def create_batch(request: Request) -> Any:
    b = await _body(request)
    try:
        return _host(request).create_batch(label=str(b.get("label") or ""), settings=b.get("settings") or {},
                                           content=str(b.get("content") or ""), fmt=str(b.get("format") or "txt"))
    except VoiceError as e:
        return _fail(e)


@router.get("/batches/{bid}")
async def get_batch(bid: str, request: Request) -> Any:
    try:
        return _host(request).batch(bid)
    except VoiceError as e:
        return _fail(e)


@router.post("/batches/{bid}/cancel")
async def cancel_batch(bid: str, request: Request) -> Any:
    h = _host(request)
    ok = h.batch_runner.cancel(bid)
    h.on_change(f"batch:{bid}")
    return {"cancelled": ok}


@router.post("/batches/{bid}/retry")
async def retry_batch(bid: str, request: Request) -> Any:
    b = await _body(request)
    try:
        return _host(request).retry_batch(bid, failed_only=b.get("failed_only", True) is not False)
    except VoiceError as e:
        return _fail(e)


@router.delete("/batches/{bid}")
async def delete_batch(bid: str, request: Request) -> Any:
    try:
        return {"deleted": await _host(request).delete_batch(bid)}
    except VoiceError as e:
        return _fail(e)


@router.get("/batches/{bid}/zip")
async def batch_zip(bid: str, request: Request) -> Any:
    from app.voicehost import audio

    h = _host(request)
    fmt = request.query_params.get("format") or "wav"
    if fmt not in audio.FORMATS:
        raise HTTPException(status_code=400, detail="format: wav, mp3, ogg or flac")
    b = h.batches.get(bid)
    if b is None:
        raise HTTPException(status_code=404, detail="no such batch")
    fd, tmp = tempfile.mkstemp(suffix=".zip", dir=str(h.s.tmp_dir))
    import os

    os.close(fd)
    try:
        await asyncio.to_thread(h.batch_runner.zip_to, bid, Path(tmp), fmt)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise
    name = f"voice-batch-{_name_part(b['label'] or bid, 40)}.zip"
    return FileResponse(tmp, media_type="application/zip", filename=name,
                        background=BackgroundTask(lambda: Path(tmp).unlink(missing_ok=True)))
