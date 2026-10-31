"""Speech synthesis + transcription for mates (docs/mate.md §5).

TTS engines: ``openai`` (/v1/audio/speech), ``elevenlabs``, ``omnivoice``
(geny-audio-services: ``/tts`` with a voice profile; the emotion picks the
profile's reference clip, like Geny's ``_resolve_emotion_ref`` but resolved
through the service's own ``GET /voices``), ``http`` (any OpenAI-shaped
``/audio/speech``). ``browser`` / ``off`` are spoken (or not) by the page.

STT engines: ``openai`` and ``whisper`` (an OpenAI-compatible
``/v1/audio/transcriptions`` server such as geny-audio-services' whisper).

Synthesized audio is cached on disk by a hash of everything that shapes it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

from app.mate import files, netio
from app.mate.providers import Providers, elevenlabs_api, openai_api, openai_voices
from app.mate.store import MateError, MateStore, normalize_voice

# API bases: app.mate.providers.openai_api() / elevenlabs_api() (settings.mate_*_base)
OPENAI_TTS_DEFAULT = "gpt-4o-mini-tts"
OPENAI_STT_DEFAULT = "gpt-4o-mini-transcribe"
ELEVEN_DEFAULT_MODEL = "eleven_multilingual_v2"
MAX_TEXT = 4000
MAX_AUDIO_IN = 25 * 1024 * 1024   # the OpenAI transcription limit
CACHE_MAX_BYTES = 300 * 1024 * 1024
_EXT = {"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
        "audio/ogg": "ogg", "audio/opus": "opus", "audio/aac": "aac", "audio/flac": "flac", "audio/webm": "webm"}
_TYPE = {v: k for k, v in _EXT.items() if k not in ("audio/mp3", "audio/x-wav", "audio/wave")}

# OmniVoice /voices is cheap but not free: remember it for a minute.
_voices_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


class Speech:
    """Audio for one utterance. ``fallback`` (no audio): the engine isn't set
    up in Global settings — the page speaks with the browser voice instead."""

    def __init__(self, body: bytes, media_type: str, cached: bool, fallback: str | None = None) -> None:
        self.body, self.media_type, self.cached, self.fallback = body, media_type, cached, fallback


def _need(value: str, what: str, where: str = "Global settings → Voice services") -> str:
    if not value:
        raise MateError(f"{what} is not set — add it in {where}")
    return value


# mate TTS overrides a preview may send (POST …/speech {tts: {...}}): never saved
_TTS_OVERRIDE = ("engine", "voice", "model", "speed", "profile", "language", "instruct")


def _check(resp: netio.Response, service: str) -> netio.Response:
    if resp.status >= 400:
        raise netio.UpstreamError(f"{service}: {netio.error_text(resp)}", status=resp.status)
    return resp


def _audio(resp: netio.Response, service: str, fallback: str) -> tuple[bytes, str]:
    _check(resp, service)
    if not resp.body:
        raise netio.UpstreamError(f"{service} returned no audio")
    ctype = resp.content_type
    if not ctype.startswith("audio/"):
        if ctype.startswith(("application/json", "text/")):
            raise netio.UpstreamError(f"{service} returned no audio: {netio.error_text(resp)}")
        ctype = fallback
    return resp.body, ctype


def _speech_url(base: str) -> str:
    base = base.rstrip("/")
    if base.endswith("/audio/speech"):
        return base
    return base + "/audio/speech"


def _transcription_url(base: str) -> str:
    base = base.rstrip("/")
    if base.endswith("/audio/transcriptions"):
        return base
    if not base.endswith("/v1"):
        base += "/v1"
    return base + "/audio/transcriptions"


# ---- OmniVoice ----

async def omnivoice_profiles(url: str) -> list[dict[str, Any]]:
    url = url.rstrip("/")
    hit = _voices_cache.get(url)
    if hit and time.monotonic() - hit[0] < 60:
        return hit[1]
    resp = _check(await netio.request("GET", f"{url}/voices", timeout=15), "OmniVoice")
    data = resp.json()
    voices = data.get("voices") if isinstance(data, dict) else data
    voices = [v for v in voices or [] if isinstance(v, dict)]
    _voices_cache[url] = (time.monotonic(), voices)
    return voices


def resolve_emotion_ref(profile: dict[str, Any], emotion: str) -> tuple[str | None, str]:
    """(ref_audio_path, ref_text) for an emotion: that emotion's clip, else
    neutral, else the profile's first clip (Geny's fallback order)."""
    refs = [r for r in profile.get("ref_audios") or [] if isinstance(r, dict) and r.get("file")]
    by = {str(r.get("emotion") or "").lower(): r for r in refs}
    for emo in ((emotion or "neutral").lower(), "neutral"):
        if emo in by:
            return by[emo]["file"], by[emo].get("prompt_text") or ""
    if refs:
        return refs[0]["file"], refs[0].get("prompt_text") or ""
    return None, ""


# Emotion tags of the mate (docs/mate.md §3) -> OmniVoice profile emotions.
_OMNI_EMOTION = {"joy": "joy", "smile": "joy", "laugh": "joy", "greet": "joy", "agree": "neutral",
                 "surprised": "surprise", "sad": "sadness", "angry": "anger", "shy": "neutral",
                 "thinking": "neutral", "sleepy": "neutral", "neutral": "neutral"}


class VoiceService:
    def __init__(self, store: MateStore) -> None:
        self.store = store
        self.providers = Providers(store)

    # ---- TTS ----

    def _cache_dir(self) -> Path:
        d = files.root() / "_cache" / "tts"
        d.mkdir(parents=True, exist_ok=True)
        return d

    async def speech(self, mate: dict[str, Any], text: str, emotion: str | None = None,
                     override: dict[str, Any] | None = None) -> Speech | None:
        """Audio for one utterance, or None when the page speaks itself
        (engine browser/off). ``override``: unsaved TTS fields (a preview in
        the settings). An engine that isn't set up in Global settings (any
        more) is not an error: the answer says to fall back to the browser."""
        tts = dict(mate["voice"]["tts"])
        if override:
            if not isinstance(override, dict):
                raise MateError("tts must be an object")
            patch = {k: override[k] for k in _TTS_OVERRIDE if k in override}
            tts = normalize_voice({"tts": patch}, {"tts": tts})["tts"]
        engine = tts.get("engine") or "browser"
        if engine in ("browser", "off"):
            return None
        if not self.providers.configured(engine):
            return Speech(b"", "", False, fallback=self.providers.missing_reason(engine))
        text = (text or "").strip()
        if not text:
            raise MateError("nothing to say")
        if len(text) > MAX_TEXT:
            raise MateError(f"text is longer than {MAX_TEXT} characters")
        emotion = re.sub(r"[^a-z_-]", "", (emotion or "").lower())[:24]  # an emotion tag, nothing else
        cfg = self.store.settings()
        shape = {"engine": engine, "voice": tts.get("voice"), "model": tts.get("model"), "speed": tts.get("speed"),
                 "profile": tts.get("profile"), "language": tts.get("language") or mate["persona"].get("language"),
                 "emotion": emotion, "text": text,
                 "url": cfg.get("omnivoice_url") if engine == "omnivoice" else cfg.get("http_tts_url")}
        key = hashlib.sha256(json.dumps(shape, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:40]
        cache = self._cache_dir()
        for ext, mtype in _TYPE.items():
            p = cache / f"{key}.{ext}"
            if p.is_file():
                os.utime(p)  # recently used: kept when the cache is pruned
                return Speech(p.read_bytes(), mtype, True)
        body, mtype = await getattr(self, f"_tts_{engine}")(tts, text, shape, cfg)
        ext = _EXT.get(mtype, "mp3")
        tmp = cache / f"{key}.{ext}.part"
        tmp.write_bytes(body)
        os.replace(tmp, cache / f"{key}.{ext}")
        self._prune(cache)
        return Speech(body, _TYPE.get(ext, mtype), False)

    @staticmethod
    def _prune(cache: Path) -> None:
        entries = sorted((p.stat().st_mtime, p.stat().st_size, p) for p in cache.iterdir() if p.is_file())
        total = sum(s for _, s, _ in entries)
        for _, size, p in entries:
            if total <= CACHE_MAX_BYTES:
                break
            p.unlink(missing_ok=True)
            total -= size

    async def _tts_openai(self, tts: dict, text: str, shape: dict, cfg: dict) -> tuple[bytes, str]:
        key = _need(self.store.secret("openai_key"), "The OpenAI API key")
        model = tts.get("model") or OPENAI_TTS_DEFAULT
        body: dict[str, Any] = {"model": model, "voice": tts.get("voice") or "alloy", "input": text,
                                "response_format": "mp3", "speed": float(tts.get("speed") or 1.0)}
        if shape["emotion"] and model.startswith("gpt-4o"):
            body["instructions"] = f"Speak in a natural, {shape['emotion']} tone."
        resp = await netio.request("POST", f"{openai_api()}/audio/speech", json_body=body, timeout=90,
                                   headers={"Authorization": f"Bearer {key}"})
        return _audio(resp, "OpenAI", "audio/mpeg")

    async def _tts_elevenlabs(self, tts: dict, text: str, shape: dict, cfg: dict) -> tuple[bytes, str]:
        key = _need(self.store.secret("elevenlabs_key"), "The ElevenLabs API key")
        voice = quote(_need(tts.get("voice") or "", "The ElevenLabs voice", "this mate's settings → Voice"), safe="")
        body: dict[str, Any] = {"text": text, "model_id": tts.get("model") or ELEVEN_DEFAULT_MODEL}
        speed = float(tts.get("speed") or 1.0)
        if speed != 1.0:
            body["voice_settings"] = {"speed": max(0.7, min(1.2, speed))}
        resp = await netio.request(
            "POST", f"{elevenlabs_api()}/text-to-speech/{voice}?output_format=mp3_44100_128", json_body=body,
            timeout=90, headers={"xi-api-key": key, "Accept": "audio/mpeg"})
        return _audio(resp, "ElevenLabs", "audio/mpeg")

    async def _tts_omnivoice(self, tts: dict, text: str, shape: dict, cfg: dict) -> tuple[bytes, str]:
        url = _need(cfg.get("omnivoice_url") or "", "The OmniVoice URL").rstrip("/")
        profile_id = tts.get("profile") or tts.get("voice") or ""
        body: dict[str, Any] = {"text": text, "mode": "auto", "speed": float(tts.get("speed") or 1.0),
                                "audio_format": "wav", "language": shape["language"] or None}
        if profile_id:
            profiles = await omnivoice_profiles(url)
            prof = next((p for p in profiles if p.get("id") == profile_id or p.get("name") == profile_id), None)
            if prof is None:
                raise MateError(f"OmniVoice has no voice profile {profile_id!r}")
            emo = _OMNI_EMOTION.get(shape["emotion"], shape["emotion"] or "neutral")
            ref, ref_text = resolve_emotion_ref(prof, emo)
            if ref:
                body.update(mode="clone", ref_audio_path=ref)
                if ref_text:
                    body["ref_text"] = ref_text
            if not body["language"] and prof.get("language"):
                body["language"] = prof["language"]
        elif tts.get("instruct"):
            # voice design (no reference clip on the OmniVoice server)
            body.update(mode="design", instruct=tts["instruct"])
        resp = await netio.request("POST", f"{url}/tts", json_body=body, timeout=180)
        return _audio(resp, "OmniVoice", "audio/wav")

    async def _tts_http(self, tts: dict, text: str, shape: dict, cfg: dict) -> tuple[bytes, str]:
        url = _need(cfg.get("http_tts_url") or "", "The TTS server URL")
        key = self.store.secret("http_tts_key")
        body = {"model": tts.get("model") or "tts-1", "voice": tts.get("voice") or "default", "input": text,
                "response_format": "mp3", "speed": float(tts.get("speed") or 1.0)}
        resp = await netio.request("POST", _speech_url(url), json_body=body, timeout=120,
                                   headers={"Authorization": f"Bearer {key}"} if key else {})
        return _audio(resp, "TTS server", "audio/mpeg")

    # ---- STT ----

    async def transcribe(self, mate: dict[str, Any], audio: bytes, filename: str, content_type: str) -> dict[str, Any]:
        stt = mate["voice"]["stt"]
        engine = stt.get("engine") or "browser"
        if engine in ("browser", "off"):
            raise MateError(f"speech recognition for this mate is '{engine}' (done in the page, not here)")
        if not audio:
            raise MateError("no audio")
        if len(audio) > MAX_AUDIO_IN:
            raise MateError("audio is larger than 25 MB", status=413)
        if not self.providers.configured(engine):
            raise MateError(self.providers.missing_reason(engine))
        cfg = self.store.settings()
        language = (stt.get("language") or mate["persona"].get("language") or "").split("-")[0]
        if engine == "openai":
            url = f"{openai_api()}/audio/transcriptions"
            headers = {"Authorization": f"Bearer {_need(self.store.secret('openai_key'), 'The OpenAI API key')}"}
            model = stt.get("model") or OPENAI_STT_DEFAULT
        else:  # whisper
            url = _transcription_url(_need(cfg.get("whisper_url") or "", "The Whisper server URL"))
            headers = {}
            model = stt.get("model") or self.providers.default_model("whisper")
        fields = {"model": model, "response_format": "json"}
        if language:
            fields["language"] = language
        body, ctype = netio.multipart(fields, {"file": (filename or "speech.webm", audio,
                                                         content_type or "audio/webm")})
        resp = _check(await netio.request("POST", url, data=body, timeout=120,
                                          headers={**headers, "Content-Type": ctype}),
                      "OpenAI" if engine == "openai" else "Whisper")
        try:
            data = resp.json()
        except ValueError:
            return {"text": resp.body.decode("utf-8", errors="replace").strip()}
        return {"text": str((data or {}).get("text") or "").strip(), "language": (data or {}).get("language")}

    # ---- voices ----

    async def voices(self, engine: str) -> list[dict[str, Any]]:
        """The voices an engine offers: ``[{id, name, language?, …}]``.
        ElevenLabs: everything in the account (premade, cloned, generated,
        added from the library) with ``category``, ``labels``, ``languages``,
        ``preview_url``; OmniVoice: its profiles with their ``emotions``."""
        if engine == "openai":
            return openai_voices()
        if engine == "elevenlabs":
            if not self.providers.configured("elevenlabs"):
                raise MateError(self.providers.missing_reason("elevenlabs"))
            key = self.store.secret("elevenlabs_key")
            resp = _check(await netio.request("GET", f"{elevenlabs_api()}/voices?show_legacy=true", timeout=20,
                                              headers={"xi-api-key": key}), "ElevenLabs")
            return [_eleven_voice(v) for v in (resp.json() or {}).get("voices") or []
                    if isinstance(v, dict) and v.get("voice_id")]
        if engine == "omnivoice":
            if not self.providers.configured("omnivoice"):
                raise MateError(self.providers.missing_reason("omnivoice"))
            url = self.store.settings().get("omnivoice_url") or ""
            return [{"id": p.get("id"), "name": p.get("name") or p.get("id"), "language": p.get("language"),
                     "emotions": sorted({str(r.get("emotion")) for r in p.get("ref_audios") or []
                                         if isinstance(r, dict) and r.get("emotion")}),
                     **({"category": "template"} if p.get("is_template") else {})}
                    for p in await omnivoice_profiles(url)]
        if engine in ("browser", "http", "off"):
            return []  # the page lists its own voices; a generic server has no listing
        raise MateError(f"unknown tts engine: {engine}")


def _eleven_voice(v: dict[str, Any]) -> dict[str, Any]:
    labels = {str(k): str(val) for k, val in (v.get("labels") or {}).items() if val not in (None, "")}
    verified = [x for x in v.get("verified_languages") or [] if isinstance(x, dict)]
    languages = sorted({str(x.get("language")) for x in verified if x.get("language")})
    out: dict[str, Any] = {"id": v["voice_id"], "name": v.get("name") or v["voice_id"],
                           "language": labels.get("language") or (languages[0] if languages else None)
                           or labels.get("accent"),
                           "category": v.get("category") or None,
                           "labels": labels,
                           "preview_url": v.get("preview_url")}
    if languages:
        out["languages"] = languages
    if v.get("description"):
        out["description"] = str(v["description"])[:300]
    # a library voice's preview per language (e.g. the Korean sample of a multilingual voice)
    previews = {str(x["language"]): x["preview_url"] for x in verified if x.get("language") and x.get("preview_url")}
    if previews:
        out["previews"] = previews
    return out
