"""Mates API (docs/mate.md): CRUD, conversation, memory, assets/avatar
imports, Live2D Cubism Core, voice (settings, speech, transcription, voices)."""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from app.config import settings
from app.mate import files, live2d_core, netio
from app.mate.capture import CaptureError
from app.mate import memory as M
from app.mate.service import MateService
from app.mate.store import SETTING_PROVIDERS, MateError
from app.mate.voice import RealtimeError, VoiceService
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
async def put_settings(request: Request, verify: bool = False) -> dict:
    """Keys / URLs (docs/mate.md §1). ``?verify=1``: the providers whose
    settings changed are checked right away; the answer then also carries
    ``providers`` (the GET /providers shape)."""
    store = _svc(request).store
    try:
        out = store.update_settings(await _json(request))
    except MateError as exc:
        raise _http(exc) from exc
    if "timezone" in store.last_changed:
        # (the relationships' days are counted in it: again from the history — app/mate/service.py)
        _svc(request).timezone_changed()
    if verify:
        providers = _voice(request).providers
        changed = {SETTING_PROVIDERS[k] for k in store.last_changed if k in SETTING_PROVIDERS}
        await asyncio.gather(*(providers.verify(p) for p in sorted(changed)))
        out = {**out, "providers": await providers.status()}
    return out


@router.get("/providers")
async def list_providers(request: Request, refresh: bool = False) -> dict:
    """``{tts: [...], stt: [...]}``, each ``{engine, label, configured, ok,
    error, detail, checked_at, kind}``. Configured providers are verified when
    their last check is missing or old (``?refresh=1``: all of them now)."""
    return await _voice(request).providers.status(refresh=refresh)


@router.post("/providers/{engine}/verify")
async def verify_provider(engine: str, request: Request) -> dict:
    try:
        return await _voice(request).providers.verify(engine)
    except MateError as exc:
        raise _http(exc) from exc


@router.get("/models")
async def list_models(request: Request, engine: str = "openai", kind: str = "tts") -> dict:
    """What a voice engine can be asked for: OpenAI's fixed lists, ElevenLabs'
    TTS models (``can_do_text_to_speech``), a self-hosted server's /models."""
    try:
        return await _voice(request).providers.models(engine, kind)
    except (MateError, netio.UpstreamError) as exc:
        raise _http(exc) from exc


@router.get("/voices")
async def list_voices(request: Request, engine: str = "openai") -> dict:
    try:
        return {"engine": engine, "voices": await _voice(request).voices(engine)}
    except (MateError, netio.UpstreamError) as exc:
        raise _http(exc) from exc


@router.get("/live2d/core")
async def core_status() -> dict:
    """{installed, installing, size?, source, received?, total?, error?}"""
    return live2d_core.installer.status()


@router.post("/live2d/core/install")
async def core_install(request: Request) -> StreamingResponse:
    """Download the Cubism Core from Live2D's CDN (the user accepted the
    Live2D licence in the UI; it is not redistributed with the app). Streams
    NDJSON progress (docs/mate.md §2): ``downloading`` lines, ``verifying``,
    then ``done`` or ``error``. Concurrent requests share one download."""
    body = {}
    if request.headers.get("content-type", "").startswith("application/json"):
        body = await _json(request)
    if body.get("accept_license") is False:
        raise HTTPException(status_code=400, detail="the Live2D licence must be accepted")
    return StreamingResponse(live2d_core.installer.stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.get("/live2d/core.js")
async def core_js() -> FileResponse:
    p = files.core_path()
    if not p.is_file():
        # never cached: the body retries the same URL right after an install
        raise HTTPException(status_code=404, detail="Live2D Cubism Core is not installed",
                            headers={"Cache-Control": "no-store"})
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
        mate = await _import_one(svc, info, body.get("mate_id"), body.get("name"), str(body.get("outfit") or ""))
        return {"mate": mate, "mates": [mate], "imported": info["kind"]}
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


async def _import_one(svc: Any, info: dict[str, Any], target: Any, name: Any, outfit: str = "") -> dict[str, Any]:
    created = False
    if target:
        mate = svc.get(str(target))
    elif info["kind"] == "ailism":
        mate_name, persona = files.ailism_persona(info["doc"], styled=True)  # (its speech/address: the style)
        same = next((m for m in svc.list() if m["name"] == mate_name), None)
        if same is not None:
            mate = svc.update(same["id"], {"persona": persona})
        else:
            mate, created = svc.create({"name": mate_name, "persona": persona}), True
        voice = await asyncio.to_thread(files.ailism_voice, info["doc"], info.get("voice_dir"), mate["id"])
        if voice:
            mate = svc.update(mate["id"], {"voice": voice})
    elif info["kind"] == "livliv":
        mate, created = svc.create({"name": name or info.get("name") or "Mate"}), True
    else:
        base = info["folder"] if info["kind"] == "pack" else info["model"].parent
        label = base.name if base.name not in ("runtime", "model", "assets") else base.parent.name
        mate, created = svc.create({"name": name or label or "Mate"}), True
    try:
        if info["kind"] == "live2d":
            avatar = await asyncio.to_thread(files.import_folder_live2d, mate["id"], info["model"])
        elif info["kind"] == "livliv":
            avatar = await asyncio.to_thread(files.import_local_livliv, mate["id"], info)
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
        mate = svc.set_outfit_avatar(mate["id"], outfit, avatar) if outfit else svc.update(mate["id"], {"avatar": avatar})
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


@router.post("/{mate_id}/avatar/reset")
async def reset_avatar(mate_id: str, request: Request) -> dict:
    """A built-in mate: put the bundled avatar back (clip/trigger edits undone).
    ``customized`` turns off again only if the persona is still the bundled one."""
    try:
        return _svc(request).reset_builtin_avatar(mate_id)
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


@router.post("/{mate_id}/capture/{rid}")
async def capture_result(mate_id: str, rid: str, request: Request) -> dict:
    """The desktop app's answer to the mate's screen-capture request (docs/mate.md §4 "Seeing the screen"):
    ``{ok: true, attachment_id, source?}`` (the picture was uploaded to the mate's conversation first) or
    ``{ok: false, code, message?}``. 404: no such request is waiting (answered, timed out, cancelled)."""
    _mate(request, mate_id)
    body = await _json(request)
    try:
        ok = _svc(request).capture_result(mate_id, rid, body)
    except CaptureError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(status_code=404, detail="no capture request is waiting under that id")
    return {"id": rid, "ok": True}


@router.post("/{mate_id}/conversation/reset")
async def conversation_reset(mate_id: str, request: Request) -> dict:
    """Fresh context (like /clear): history stays, the engine forgets it."""
    try:
        return _svc(request).reset(mate_id)
    except (KeyError, MateError, TurnBusyError) as exc:
        raise _http(exc) from exc


@router.post("/{mate_id}/memory/wipe")
async def wipe_memory(mate_id: str, request: Request) -> dict:
    """``{confirm: her name}``: all her memories and the whole conversation go, for good"""
    body = await _json(request)
    svc = _svc(request)
    try:
        if str(body.get("confirm") or "").strip() != svc.get(mate_id)["name"].strip():
            raise MateError("type her name to confirm", status=400)
        return svc.wipe_memory(mate_id)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


# ---- the relationship (docs/mate-memory-affinity.md §5) ----

@router.get("/{mate_id}/relation")
async def get_relation(mate_id: str, request: Request) -> dict:
    try:
        return _svc(request).relation_view(mate_id)
    except KeyError as exc:
        raise _http(exc) from exc


@router.get("/{mate_id}/state")
async def get_state(mate_id: str, request: Request) -> dict:
    """How she feels right now and why (app/mate/state.py)"""
    try:
        return _svc(request).state_view(mate_id)
    except KeyError as exc:
        raise _http(exc) from exc


@router.get("/{mate_id}/life")
async def get_life(mate_id: str, request: Request) -> dict:
    """Her own day: where she is, what she is doing, her needs (app/mate/life)"""
    try:
        return _svc(request).life.view(mate_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.put("/{mate_id}/life/plan/{slot}")
async def set_life_plan(mate_id: str, slot: str, body: dict, request: Request) -> dict:
    """A suggestion for how she spends this slot of the week (activity null: it's up to her). -> her day as it is now."""
    try:
        return _svc(request).life.set_plan(mate_id, slot, body.get("activity"))
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/{mate_id}/life/gift")
async def send_gift(mate_id: str, body: dict, request: Request) -> dict:
    """They send her something (app/mate/life). -> her day as it is now."""
    try:
        return _svc(request).life_gift(mate_id, body.get("item"))
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except MateError as exc:
        raise _http(exc) from exc


@router.post("/{mate_id}/state/poke")
async def poke_state(mate_id: str, request: Request) -> dict:
    """The user tapped her avatar"""
    try:
        return _svc(request).state_poke(mate_id)
    except KeyError as exc:
        raise _http(exc) from exc


@router.get("/{mate_id}/relation/journal")
async def relation_journal(mate_id: str, request: Request, days: int = 30) -> dict:
    """The Relationship panel: ``days`` (7 – 90) daily values, the next stage's needs (earned and warmth), stats,
    milestones and anniversaries, the change log with kinds, the latest memories — reads only."""
    try:
        return _svc(request).relation_journal(mate_id, days)
    except KeyError as exc:
        raise _http(exc) from exc


@router.patch("/{mate_id}/relation")
async def patch_relation(mate_id: str, request: Request) -> dict:
    """``{enabled?, paused?, sensitivity? (0.5 – 1.5), show_indicator?, avatar_mood?, affinity? (0 – 100)}``"""
    body = await _json(request)
    try:
        return _svc(request).relation_update(mate_id, body)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.post("/{mate_id}/relation/reset")
async def reset_relation(mate_id: str, request: Request) -> dict:
    """``{mode: "zero" | "recompute"}`` — a fresh start, or rebuilt from the conversation's real history."""
    body = await _json(request)
    try:
        return _svc(request).relation_reset(mate_id, str(body.get("mode") or ""))
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


# ---- memory ----

@router.get("/{mate_id}/memories")
async def list_memories(mate_id: str, request: Request, q: str | None = None, kind: str | None = None,
                        status: str = "active", sort: str = "created") -> list[dict]:
    """``status`` active | done | archived | all; ``sort`` created | recent | importance | due; each memory
    says whether it is in the core (always in the system prompt)."""
    _mate(request, mate_id)
    store = _svc(request).store
    if status not in ("active", "done", "archived", "all"):
        raise HTTPException(status_code=400, detail="status: active | done | archived | all")
    core = {m["id"] for m in M.core(store.memories(mate_id))}
    flags = _svc(request).memory_style_flags(mate_id)  # (looks like a rule about how she talks: a hint, read-only)
    return [{**m, "core": m["id"] in core, "style_flag": flags.get(m["id"])}
            for m in store.memories(mate_id, status=status, kind=kind or None, q=q, sort=sort)]


@router.post("/{mate_id}/memories/{mem_id}/to-style")
async def memory_to_style(mate_id: str, mem_id: str, request: Request) -> dict:
    """The user moves a memory into the conversation style (its text joins the speech habits; the memory is
    archived, not deleted) → {mate, memory}."""
    try:
        return _svc(request).memory_to_style(mate_id, mem_id)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.post("/{mate_id}/memories/{mem_id}/style-ok")
async def memory_style_ok(mate_id: str, mem_id: str, request: Request) -> dict:
    """The user says a flagged memory is fine where it is: no more "conversation style?" hint on it."""
    _mate(request, mate_id)
    _svc(request).store.dismiss_style_flag(mate_id, mem_id)
    return {"id": mem_id, "dismissed": True}


# ---- the mate's own conversation-style changes ----

@router.get("/{mate_id}/style-changes")
async def list_style_changes(mate_id: str, request: Request) -> list[dict]:
    """Her own changes of the conversation style, newest first: {id, created_at, actor, status (applied | proposed |
    dismissed | undone), reason, changes: {path: {from, to}}, session_id, resolved_at}."""
    try:
        return _svc(request).style_changes(mate_id)
    except KeyError as exc:
        raise _http(exc) from exc


@router.post("/{mate_id}/style-changes/{cid}/{action}")
async def resolve_style_change(mate_id: str, cid: str, action: str, request: Request) -> dict:
    """``undo`` an applied change (fields changed again since stay), ``apply`` / ``dismiss`` a proposed one →
    {change, mate, skipped}."""
    try:
        return _svc(request).resolve_style_change(mate_id, cid, action)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.get("/{mate_id}/memories/stats")
async def memory_stats(mate_id: str, request: Request) -> dict:
    _mate(request, mate_id)
    return _svc(request).store.memory_counts(mate_id)


@router.post("/{mate_id}/memories")
async def add_memory(mate_id: str, request: Request) -> dict:
    """``{text, kind?, importance?, pinned?, due_at?}`` → the memory (+ ``merged``: an active one of that kind
    said the same and was updated instead; ``similar``: close ones)."""
    body = await _json(request)
    try:
        return _svc(request).store.add_memory(mate_id, str(body.get("text") or ""), kind=body.get("kind"),
                                              importance=body.get("importance"), pinned=bool(body.get("pinned")),
                                              due_at=body.get("due_at"), by_user=True)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.post("/{mate_id}/memories/bulk")
async def bulk_memories(mate_id: str, request: Request) -> dict:
    body = await _json(request)
    _mate(request, mate_id)
    ids = body.get("ids")
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="ids must be a list")
    try:
        return {"changed": _svc(request).store.bulk_memories(mate_id, ids, str(body.get("action") or ""))}
    except MateError as exc:
        raise _http(exc) from exc


@router.post("/{mate_id}/memories/preview")
async def preview_memories(mate_id: str, request: Request) -> dict:
    """What the mate would get for this message: the core and the recalled memories, and the context block."""
    body = await _json(request)
    try:
        return _svc(request).preview_context(mate_id, str(body.get("text") or "")[:2000])
    except KeyError as exc:
        raise _http(exc) from exc


@router.patch("/{mate_id}/memories/{mem_id}")
async def update_memory(mate_id: str, mem_id: str, request: Request) -> dict:
    body = await _json(request)
    _mate(request, mate_id)
    try:
        return _svc(request).store.update_memory(mate_id, mem_id, body, by_user=True)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.delete("/{mate_id}/memories/{mem_id}")
async def delete_memory(mate_id: str, mem_id: str, request: Request) -> dict:
    _mate(request, mate_id)
    if not _svc(request).store.delete_memory(mate_id, mem_id, by_user=True):
        raise HTTPException(status_code=404, detail="memory not found")
    return {"id": mem_id, "deleted": True}


# ---- the wardrobe (docs/mate.md "Outfits") ----

@router.post("/{mate_id}/outfits")
async def add_outfit(mate_id: str, request: Request) -> dict:
    """``{name}`` → a new, empty place in her wardrobe: ``{id, mate}``."""
    svc = _svc(request)
    try:
        oid = svc.add_outfit(mate_id, str((await _json(request)).get("name") or ""))
        return {"id": oid, "mate": svc.get(mate_id)}
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.get("/{mate_id}/outfits/{oid}")
async def get_outfit(mate_id: str, oid: str, request: Request) -> dict:
    """``{id, name, avatar}``: one set, whether she has it on or not."""
    try:
        return _svc(request).outfit(mate_id, oid)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.post("/{mate_id}/outfits/{oid}/wear")
async def wear_outfit(mate_id: str, oid: str, request: Request) -> dict:
    """Puts the whole set on her (``default``: her default set); every window follows."""
    try:
        return _svc(request).wear_outfit(mate_id, oid)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.patch("/{mate_id}/outfits/{oid}")
async def patch_outfit(mate_id: str, oid: str, request: Request) -> dict:
    """``{name?, avatar?}``"""
    body = await _json(request)
    svc = _svc(request)
    try:
        if "name" in body:
            svc.rename_outfit(mate_id, oid, str(body.get("name") or ""))
        if body.get("avatar") is not None:
            svc.set_outfit_avatar(mate_id, oid, body["avatar"])
        return svc.get(mate_id)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.delete("/{mate_id}/outfits/{oid}")
async def delete_outfit(mate_id: str, oid: str, request: Request) -> dict:
    try:
        return _svc(request).delete_outfit(mate_id, oid)
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


# ---- assets / avatar ----

@router.post("/{mate_id}/assets")
async def upload_asset(mate_id: str, request: Request, file: UploadFile = File(...),
                       path: str = Form("")) -> dict:
    _mate(request, mate_id)
    try:
        return await files.save_upload(mate_id, path or (file.filename or ""), file)
    except MateError as exc:
        raise _http(exc) from exc


@router.get("/builtin/{key}/{rel:path}")
async def get_builtin_asset(key: str, rel: str, request: Request, v: str | None = None) -> Response:
    """Files of the bundled characters (shipped with the app). A mate's JSON names them with their version (``?v=``,
    app/mate/asset_versions.py): under that URL a file is kept for good, since a changed file has another. Asked without it,
    it is asked again every time and answered "not modified" while the file is the same."""
    try:
        p = files.resolve_builtin(key, rel)
    except MateError as exc:
        raise HTTPException(status_code=404, detail="asset not found") from exc
    st = p.stat()
    etag = '"' + hashlib.md5(f"{st.st_mtime}-{st.st_size}".encode(), usedforsecurity=False).hexdigest() + '"'
    cache = "private, max-age=31536000, immutable" if v else "private, no-cache"
    headers = {**_ASSET_HEADERS, "Cache-Control": cache, "ETag": etag}
    if etag in [t.strip() for t in (request.headers.get("if-none-match") or "").split(",")]:
        return Response(status_code=304, headers=headers)
    return FileResponse(p, media_type=files.content_type(p), headers=headers)


@router.post("/builtin/restore")
async def restore_builtins(request: Request) -> list[dict]:
    """Bring back the bundled characters the user deleted."""
    return _svc(request).restore_builtins()


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
async def import_avatar(mate_id: str, request: Request, file: UploadFile = File(...), outfit: str = Form("")) -> dict:
    """A zip: an ailism-style pack (rig.json + files -> video/photo), a
    Live2D model (*.model3.json; geny-avatar's avatar-editor.json is read) or
    a LivLiv package (a .livliv is a zip: model.json + textures/)."""
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
            svc = _svc(request)
            mate = svc.set_outfit_avatar(mate_id, outfit, avatar) if outfit else svc.update(mate_id, {"avatar": avatar})
            return {"mate": mate, "avatar": avatar}
        except (KeyError, MateError) as exc:
            raise _http(exc) from exc
    finally:
        os.unlink(tmp)


# ---- voice ----

@router.post("/{mate_id}/speech")
async def speech(mate_id: str, request: Request) -> Response:
    """{text, emotion?, tts?} -> audio. 204 when the mate's TTS engine is
    ``browser``/``off`` (the page speaks), and when its engine isn't set up
    in Global settings (any more): then ``X-Speech-Fallback: browser`` +
    ``X-Speech-Fallback-Reason``. ``tts``: unsaved voice fields to try (a
    preview in the settings; never stored)."""
    mate = _mate(request, mate_id)
    body = await _json(request)
    try:
        out = await _voice(request).speech(mate, str(body.get("text") or ""), str(body.get("emotion") or ""),
                                           override=body.get("tts") or None)
    except (MateError, netio.UpstreamError) as exc:
        raise _http(exc) from exc
    if out is None:
        return Response(status_code=204)
    if out.fallback:
        reason = out.fallback.encode("ascii", "replace").decode().replace("?", "-")
        return Response(status_code=204, headers={"X-Speech-Fallback": "browser", "X-Speech-Fallback-Reason": reason,
                                                  "Cache-Control": "no-store"})
    return Response(content=out.body, media_type=out.media_type, headers={
        "Cache-Control": "private, max-age=86400", "X-Speech-Cache": "hit" if out.cached else "miss"})


@router.post("/{mate_id}/transcribe")
async def transcribe(mate_id: str, request: Request, file: UploadFile = File(...), engine: str | None = None) -> dict:
    """A recording → ``{text, language?, engine}``. ``?engine=auto|whisper|openai|elevenlabs``: another
    provider (the realtime mic's fallback); a mate on ElevenLabs realtime uses the fallback by itself."""
    mate = _mate(request, mate_id)
    audio = await file.read(26 * 1024 * 1024)
    try:
        return await _voice(request).transcribe(mate, audio, file.filename or "speech.webm",
                                                file.content_type or "audio/webm", engine=engine)
    except (MateError, netio.UpstreamError) as exc:
        raise _http(exc) from exc


@router.post("/{mate_id}/stt/realtime")
async def realtime_stt(mate_id: str, request: Request) -> Response:
    """A single-use ElevenLabs token for this mate's mic: ``{url, model, sample_rate, language,
    commit_strategy, silence, expires_in, fallback}`` — the page opens ``url`` (wss, the token inside) itself;
    the API key stays here. Failing: 4xx/502 ``{detail, code, fallback}`` (docs/mate.md §5)."""
    mate = _mate(request, mate_id)
    try:
        out = await _voice(request).realtime_token(mate)
    except RealtimeError as exc:
        return JSONResponse({"detail": str(exc), "code": exc.code, "fallback": exc.fallback}, status_code=exc.status,
                            headers={"Cache-Control": "no-store"})
    except MateError as exc:
        raise _http(exc) from exc
    return JSONResponse(out, headers={"Cache-Control": "no-store"})


# Source-backed memory. Existing memory CRUD remains compatible.
@router.get('/{mate_id}/knowledge/search')
async def search_knowledge(mate_id: str, request: Request, q: str = '', scope: str = 'mate',
                           session_id: str | None = None, since: str | None = None,
                           until: str | None = None, offset: int = 0, limit: int = 10) -> dict:
    _mate(request, mate_id)
    try:
        return await asyncio.to_thread(_svc(request).store.knowledge.search, mate_id, q, scope=scope,
                                       session_id=session_id, since=since, until=until, offset=offset, limit=limit)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/{mate_id}/knowledge/evidence/{source_id}')
async def get_evidence(mate_id: str, source_id: str, request: Request, revision: int | None = None,
                       before: int = 1, after: int = 1, offset: int = 0) -> dict:
    _mate(request, mate_id)
    try:
        return _svc(request).store.knowledge.evidence(mate_id, source_id, revision, before, after, offset)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete('/{mate_id}/knowledge/evidence/{source_id}')
async def forget_evidence(mate_id: str, source_id: str, request: Request) -> dict:
    _mate(request, mate_id)
    try:
        _svc(request).store.knowledge.exclude_source(mate_id, source_id)
        _svc(request).forget_engine_context(mate_id, interrupt=True)
        _svc(request).store._changed('memory', mate_id)
        return {'excluded': True, 'original_chat_retained': True}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get('/{mate_id}/memories/{mem_id}/history')
async def memory_history(mate_id: str, mem_id: str, request: Request) -> dict:
    _mate(request, mate_id)
    try:
        return _svc(request).store.knowledge.memory_details(mate_id, mem_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post('/{mate_id}/memories/{mem_id}/restore-version')
async def restore_memory_version(mate_id: str, mem_id: str, request: Request) -> dict:
    _mate(request, mate_id)
    body = await _json(request)
    svc = _svc(request)
    old = next((v for v in svc.store.knowledge.history(mate_id, mem_id) if v['revision'] == body.get('revision')), None)
    if not old:
        raise HTTPException(404, 'Version not found')
    if not isinstance(body.get('expected_revision'), int):
        raise HTTPException(400, 'expected_revision is required')
    patch = {k: old['snapshot'].get(k) for k in ('text', 'kind', 'importance', 'due_at', 'status', 'pinned')}
    patch['expected_revision'] = body['expected_revision']
    try:
        with svc.store._db.transaction():
            restored = svc.store.update_memory(mate_id, mem_id, patch, by_user=True)
            for evidence in svc.store._db.query("SELECT * FROM memory_evidence WHERE memory_id=? AND memory_revision=?", (mem_id, old['revision'])):
                try:
                    svc.store.knowledge.attach(mate_id, mem_id, evidence['source_id'], evidence['quote'], evidence['source_revision'], contextual=evidence['relation'] == 'context')
                except ValueError:
                    pass  # old evidence may have been edited or excluded
            return restored
    except (KeyError, MateError) as exc:
        raise _http(exc) from exc


@router.get('/{mate_id}/knowledge/status')
async def knowledge_status(mate_id: str, request: Request) -> dict:
    _mate(request, mate_id)
    return _svc(request).store.knowledge.stats(mate_id)


@router.post('/{mate_id}/knowledge/retry')
async def retry_memory(mate_id: str, request: Request) -> dict:
    _mate(request, mate_id)
    try:
        from app.mate.consolidation import Consolidator
        svc = _svc(request)
        queued = Consolidator(svc).retry_failed(mate_id)
        svc.store._changed('memory', mate_id)
        return {'queued': queued}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/{mate_id}/knowledge/tasks')
async def knowledge_tasks(mate_id: str, request: Request, limit: int = 20) -> list:
    _mate(request, mate_id)
    return _svc(request).tasks.list(mate_id, limit)


@router.post('/{mate_id}/knowledge/process-source')
async def process_memory_source(mate_id: str, request: Request) -> dict:
    """Explicitly queue an older source, without bypassing self_save or forget."""
    from app.services._ids import new_id, now_iso
    _mate(request, mate_id)
    body = await _json(request)
    svc = _svc(request)
    source = svc.store.knowledge.allowed(mate_id, str(body.get('source_id') or ''), 'mate')
    if not source or not svc.store.get(mate_id)['prefs']['memory']['self_save']:
        raise HTTPException(400, 'Source unavailable or automatic saving disabled')
    now = now_iso()
    svc.store._db.execute("INSERT INTO memory_jobs(id,mate_id,source_id,source_revision,available_at,updated_at) VALUES(?,?,?,?,?,?) "
                         "ON CONFLICT(mate_id,source_id,source_revision) DO UPDATE SET state=CASE WHEN state='failed' THEN 'pending' ELSE state END,available_at=excluded.available_at",
                         (new_id('mj_'), mate_id, source['id'], source['revision'], now, now))
    return {'queued': True}


@router.get('/{mate_id}/knowledge/tasks/{request_id}/receipts/{event_id}')
async def task_receipt(mate_id: str, request_id: str, event_id: int, request: Request) -> dict:
    _mate(request, mate_id)
    try:
        return _svc(request).tasks.read_receipt(mate_id, request_id, event_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get('/{mate_id}/knowledge/episodes')
async def memory_episodes(mate_id: str, request: Request, before: str | None = None, limit: int = 40, q: str = '') -> dict:
    _mate(request, mate_id)
    try:
        return _svc(request).store.knowledge.episodes(mate_id, before=before, limit=max(1, min(100, limit)), q=q)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
