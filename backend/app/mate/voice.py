"""Speech synthesis + transcription for mates (docs/mate.md §5).

TTS engines: ``openai`` (/v1/audio/speech), ``elevenlabs``, ``omnivoice``
(geny-audio-services: ``/tts`` with a voice profile; the emotion picks the
profile's reference clip, like Geny's ``_resolve_emotion_ref`` but resolved
through the service's own ``GET /voices``), ``http`` (any OpenAI-shaped
``/audio/speech``). ``browser`` / ``off`` are spoken (or not) by the page.

STT engines: ``openai`` and ``whisper`` (an OpenAI-compatible
``/v1/audio/transcriptions`` server such as geny-audio-services' whisper)
transcribe a recording; ``elevenlabs`` is realtime (Scribe v2 Realtime): the
page streams the mic to ElevenLabs itself with a single-use token minted here
(:meth:`VoiceService.realtime_token`), so the key never reaches a browser.

Synthesized audio is cached on disk by a hash of everything that shapes it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

from app.mate import files, netio
from app.mate.providers import (ELEVEN_BATCH_STT, ELEVEN_DEFAULT_MODEL, ELEVEN_REALTIME_MODELS, Providers, elevenlabs_api,
                                openai_api, openai_voices)
from app.mate.store import MateError, MateStore, normalize_voice

log = logging.getLogger(__name__)

# API bases: app.mate.providers.openai_api() / elevenlabs_api() (settings.mate_*_base)
OPENAI_TTS_DEFAULT = "gpt-4o-mini-tts"
OPENAI_STT_DEFAULT = "gpt-4o-mini-transcribe"
MINT_PER_MINUTE = 20      # realtime STT tokens per mate and minute (a client stuck reconnecting can't loop)
CALL_SILENCE = 0.7        # a phone call's end of a sentence: this much quiet at most (realtime_token(call=True))
MAX_TEXT = 4000
MAX_AUDIO_IN = 25 * 1024 * 1024   # the OpenAI transcription limit
CACHE_MAX_BYTES = 300 * 1024 * 1024
_EXT = {"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
        "audio/ogg": "ogg", "audio/opus": "opus", "audio/aac": "aac", "audio/flac": "flac", "audio/webm": "webm"}
_TYPE = {v: k for k, v in _EXT.items() if k not in ("audio/mp3", "audio/x-wav", "audio/wave")}

# OmniVoice /voices is cheap but not free: remember it for a minute.
_voices_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


# ── what reaches a TTS engine ──
# The page sends clean sentences (frontend/src/mate/markdown.ts speechText). This is the cheap safety net for any
# other caller (or an older page): fenced code, tables, HTML, images, URLs and markdown symbols are not read aloud.
_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|\Z)", re.M)
_TABLE_ROW = re.compile(r"^[ \t]*\|.*$", re.M)
_HTML_BLOCK = re.compile(r"<(script|style|iframe|object|template)\b[\s\S]*?(?:</\1\s*>|$)", re.I)
_TAG = re.compile(r"</?[A-Za-z][\w:-]*(?:\s[^<>]*)?/?>")
_IMAGE = re.compile(r"!\[[^\]\n]*\]\([^)\n]*\)?")
_LINK = re.compile(r"\[([^\[\]\n]*)\]\([^)\n]*\)?")
_URL = re.compile(r"<?\b(?:https?://|www\.)[^\s<>]+>?", re.I)
_CODE = re.compile(r"(`+)(.+?)\1")
_LINE_MARK = re.compile(r"^[ \t]*(?:#{1,6}[ \t]+|(?:>[ \t]?)+|(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)", re.M)
_RULE = re.compile(r"^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$", re.M)
_SYMBOLS = re.compile(r"[*_#>|`\[\]]")


def speakable_text(text: str) -> str:
    """Text for a TTS engine without markdown: what a person would say."""
    s = (text or "").replace("\r\n", "\n")
    if not re.search(r"[`~|<>\[\]*_#]|https?://|www\.|-{3}|^[ \t]*(?:[-+]|\d{1,3}[.)])[ \t]", s, re.M):
        return s.strip()
    s = _FENCE.sub(" ", s)
    s = _TABLE_ROW.sub(" ", s)
    s = _HTML_BLOCK.sub(" ", s)
    s = _TAG.sub(" ", s)
    s = _IMAGE.sub(" ", s)
    s = _LINK.sub(r"\1", s)
    s = _URL.sub(" ", s)
    s = _CODE.sub(lambda m: m.group(2).strip(), s)
    s = _RULE.sub(" ", s)
    s = _LINE_MARK.sub("", s)
    s = _SYMBOLS.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


class RealtimeError(MateError):
    """The realtime mic can't start: ``code`` says why (``missing`` · ``auth`` · ``quota`` · ``busy`` ·
    ``network`` · ``upstream``), ``fallback`` what transcribes a recording instead (None: nothing here)."""

    def __init__(self, message: str, code: str, fallback: str | None, status: int = 502) -> None:
        super().__init__(message, status=status)
        self.code, self.fallback = code, fallback


def _no_secret(text: str, *secrets_: str) -> str:
    """Never echo a key back (an upstream error quoting the request, a proxy's page…)."""
    for s in secrets_:
        if s and len(s) >= 6:
            text = text.replace(s, "[redacted]")
    return text


def _eleven_failure(resp: netio.Response) -> tuple[str, str]:
    """(code, readable message) of a failed ElevenLabs call. Its 401s also mean "out of credits"
    (``detail.status: quota_exceeded``) or "this key may not use speech to text" (``missing_permissions``)."""
    status = ""
    try:
        j = resp.json()
        d = j.get("detail") if isinstance(j, dict) else None
        if isinstance(d, dict):
            status = str(d.get("status") or d.get("code") or "")
    except ValueError:
        pass
    msg = netio.error_text(resp)
    if "quota" in status or "credit" in status or resp.status == 402:
        return "quota", f"ElevenLabs: out of credits or quota — {msg}"
    if resp.status in (401, 403):
        if "permission" in status:
            return "auth", f"ElevenLabs: this API key may not use speech to text — {msg}"
        return "auth", f"ElevenLabs rejected the key (HTTP {resp.status}): {msg}"
    if resp.status == 429:
        return "busy", f"ElevenLabs is busy (too many sessions) — {msg}"
    return "upstream", f"ElevenLabs: {msg} (HTTP {resp.status})"


class Speech:
    """Audio for one utterance. ``fallback`` (no audio): the engine isn't set
    up in Global settings — the page speaks with the browser voice instead."""

    def __init__(self, body: bytes, media_type: str, cached: bool, fallback: str | None = None) -> None:
        self.body, self.media_type, self.cached, self.fallback = body, media_type, cached, fallback


def _need(value: str, what: str, where: str = "Settings → Image and voice providers") -> str:
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
                 "surprised": "surprise", "sad": "sadness", "worried": "sadness", "angry": "anger", "shy": "neutral",
                 "thinking": "neutral", "sleepy": "neutral", "neutral": "neutral"}


class VoiceService:
    def __init__(self, store: MateStore) -> None:
        self.store = store
        self.providers = Providers(store)
        self._local: Any = None
        self._minted: dict[str, list[float]] = {}   # realtime STT tokens per mate (monotonic times)

    @property
    def local(self) -> Any:
        """the local voice models (app/voicehost VoiceHost) — the "local" engine — when the server runs them"""
        return self._local

    @local.setter
    def local(self, host: Any) -> None:
        self._local = host
        self.providers.local = host

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
        if not self.providers.configured(engine, "tts"):
            return Speech(b"", "", False, fallback=self.providers.missing_reason(engine, "tts"))
        text = speakable_text(text)
        if not re.search(r"\w", text):
            raise MateError("nothing to say")
        if len(text) > MAX_TEXT:
            raise MateError(f"text is longer than {MAX_TEXT} characters")
        emotion = re.sub(r"[^a-z_-]", "", (emotion or "").lower())[:24]  # an emotion tag, nothing else
        cfg = self.store.settings()
        if engine == "google" and not tts.get("model"):
            from app.mate.google import default_model
            tts["model"] = default_model(self.providers, "tts")
        shape = {"engine": engine, "voice": tts.get("voice"), "model": tts.get("model"), "speed": tts.get("speed"),
                 "profile": tts.get("profile"), "language": tts.get("language") or mate["persona"].get("language"),
                 "emotion": emotion, "text": text,
                 "url": cfg.get("omnivoice_url") if engine == "omnivoice" else cfg.get("http_tts_url")}
        if engine == "local":
            # (her model, her voice's clip for this feeling, its instruction: a new clip is a new line)
            lv = self._local_voice(mate, tts, emotion)
            tts["_local_ref"] = lv["ref"]
            tts["_source"] = f"mate:{mate.get('name') or mate.get('id', '')}"  # (Voice Studio's GPU queue: for whom)
            shape.update(model=lv["model"], ref=lv["key"], instruct=lv["instruct"], url="")
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

    async def _tts_google(self, tts, text, shape, cfg):
        from app.mate.google import speech
        return await speech(_need(self.store.secret("google_key"), "The Gemini API key"), tts["model"], text,
                            tts.get("voice"), float(tts.get("speed") or 1))

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

    def _local_voice(self, mate: dict[str, Any], tts: dict, emotion: str | None) -> dict[str, Any]:
        """What a local model speaks with (docs/local-voice.md "A mate's voice"): her model while it is installed (else the
        default: VoiceHost.model_for), and the clip of this feeling from — her chosen voice (``tts.voice``: a built-in
        voice like "builtin:chaerin" or one of the user's), else her built-in voice (a built-in mate), else her own
        reference clip (``tts.ref``); none: a model that makes a voice itself (OmniVoice, with ``tts.instruct``)."""
        h = self._local
        model = h.model_for("tts", str(tts.get("model") or "")) if h else str(tts.get("model") or "")
        ref = None
        language = (tts.get("language") or mate.get("persona", {}).get("language") or "auto").split("-")[0]
        if h is not None:
            vid = str(tts.get("voice") or "")
            if vid:
                ref = h.voices.resolve(vid, emotion)
            if ref is None and mate.get("builtin"):
                ref = h.voices.resolve(f"builtin:{mate['builtin']}", emotion)
        if ref is None and tts.get("ref"):
            base = files.assets_dir(mate["id"]).resolve()
            f = (base / str(tts["ref"])).resolve()
            if f.is_file() and base in f.parents:
                ref = {"path": str(f), "text": str(tts.get("ref_text") or ""), "language": language}
        key = ""
        if ref is not None:
            try:
                st = os.stat(ref["path"])
                key = f"{ref['path']}:{st.st_mtime_ns}:{st.st_size}:{ref.get('text', '')}"
            except OSError:
                ref, key = None, ""
        return {"model": model, "ref": ref, "key": key, "instruct": str(tts.get("instruct") or "")}

    async def _tts_local(self, tts: dict, text: str, shape: dict, cfg: dict) -> tuple[bytes, str]:
        from app.voicehost.service import VoiceError

        h = self._local
        if h is None:
            raise MateError("Local voice models aren't available on this server")
        params: dict[str, Any] = {}
        speed = float(tts.get("speed") or 1.0)
        if abs(speed - 1.0) > 1e-3:
            params["speed"] = speed
        ref = tts.get("_local_ref")
        language = (shape.get("language") or (ref or {}).get("language") or "auto").split("-")[0]
        try:
            wav, _info = await h.synthesize(shape["model"], text, reference=ref, language=language,
                                            instruct=shape.get("instruct") or "", params=params,
                                            source=str(tts.get("_source") or "mate"))
        except VoiceError as e:
            raise MateError(str(e), status=e.status if e.status < 500 else 502) from None
        return wav, "audio/wav"

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

    def stt_fallback(self, *, eleven: bool = True) -> str | None:
        """The engine that transcribes a *recording* when the realtime stream can't be used: a Whisper server,
        else OpenAI, else ElevenLabs' batch model with the same key (``eleven=False``: not that one — the key or
        the credits are the problem); None = nothing on the server (the page may still have Web Speech)."""
        if self.providers.configured("local", "stt"):
            return "local"  # (this server's own GPU: no key, no network)
        for engine in ("whisper", "openai"):
            if self.providers.configured(engine):
                return engine
        if eleven and self.providers.configured("elevenlabs"):
            return "elevenlabs"
        if self.providers.configured("google"):
            return "google"
        return None

    async def realtime_token(self, mate: dict[str, Any], *, call: bool = False) -> dict[str, Any]:
        """A single-use ElevenLabs token for the mate's mic (Scribe v2 Realtime, docs/mate.md §5).

        The page connects to ElevenLabs itself with the returned ``url`` (the token rides in it; it is consumed
        on use and expires after 15 minutes): the API key never leaves this server, and is never logged. Every
        (re)connect asks for a fresh token. Failure → :class:`RealtimeError` with a ``code`` (``missing`` /
        ``auth`` / ``quota`` / ``busy`` / ``network`` / ``upstream``) and the ``fallback`` engine to use.
        ``call``: for a phone call (app/mate/calls.py) — the end of a sentence is told sooner (at most
        :data:`CALL_SILENCE` s of quiet), so she answers like on the phone."""
        stt = mate["voice"]["stt"]
        if (stt.get("engine") or "browser") != "elevenlabs":
            raise MateError("this mate's speech recognition is not ElevenLabs realtime")
        if not self.providers.configured("elevenlabs"):
            raise RealtimeError(self.providers.missing_reason("elevenlabs"), "missing", self.stt_fallback(), 400)
        now = time.monotonic()
        recent = [t for t in self._minted.get(mate["id"], []) if now - t < 60]
        if len(recent) >= MINT_PER_MINUTE:
            raise RealtimeError("Too many microphone sessions in a minute — wait a moment", "busy",
                                self.stt_fallback(), 429)
        key = self.store.secret("elevenlabs_key")
        try:
            resp = await netio.request("POST", f"{elevenlabs_api()}/single-use-token/realtime_scribe", data=b"",
                                       timeout=15, headers={"xi-api-key": key})
        except netio.UpstreamError as exc:
            raise RealtimeError(f"ElevenLabs can't be reached: {_no_secret(str(exc), key)}", "network",
                                self.stt_fallback(), 502) from None
        if resp.status >= 400:
            code, msg = _eleven_failure(resp)
            raise RealtimeError(_no_secret(msg, key), code, self.stt_fallback(eleven=code not in ("auth", "quota")), 502)
        try:
            token = str((resp.json() or {}).get("token") or "")
        except (ValueError, AttributeError):
            token = ""
        if not token:
            raise RealtimeError("ElevenLabs gave no token", "upstream", self.stt_fallback(), 502)
        recent.append(now)
        self._minted[mate["id"]] = recent
        language = (stt.get("language") or mate["persona"].get("language") or "").split("-")[0].lower()
        silence = float(stt.get("silence") or 1.2)
        if call:
            silence = min(silence, CALL_SILENCE)
        query ={"model_id": ELEVEN_REALTIME_MODELS[0]["id"], "token": token, "audio_format": "pcm_16000",
                 "commit_strategy": "vad", "vad_silence_threshold_secs": f"{silence:g}"}
        if language:
            query["language_code"] = language
        ws = re.sub(r"^http", "ws", elevenlabs_api()) + "/speech-to-text/realtime?" + urlencode(query)
        log.info("mate %s: realtime speech-to-text token issued (lang=%s)", mate["id"], language or "auto")
        return {"url": ws, "model": query["model_id"], "sample_rate": 16000, "language": language,
                "commit_strategy": "vad", "silence": silence, "expires_in": 900,
                "fallback": self.stt_fallback()}

    async def transcribe(self, mate: dict[str, Any], audio: bytes, filename: str, content_type: str,
                         engine: str | None = None) -> dict[str, Any]:
        """A recording → ``{text, language?, engine}``. ``engine``: transcribe with this provider instead (the
        realtime mic's fallback, "auto" = :meth:`stt_fallback`); a mate on ElevenLabs realtime uses the fallback."""
        stt = mate["voice"]["stt"]
        mine = stt.get("engine") or "browser"
        if engine in (None, "") and mine == "elevenlabs":
            engine = "auto"
        if engine == "auto":
            engine = self.stt_fallback()
            if engine is None:
                raise MateError("no speech-to-text service on the server can transcribe a recording "
                                "(set up Whisper, OpenAI, Google or ElevenLabs in Settings → Image and voice providers)")
        elif engine:
            if engine not in ("openai", "whisper", "elevenlabs", "google", "local"):
                raise MateError(f"unknown stt engine: {engine}")
        else:
            engine = mine
        if engine in ("browser", "off"):
            raise MateError(f"speech recognition for this mate is '{engine}' (done in the page, not here)")
        if not audio:
            raise MateError("no audio")
        if len(audio) > MAX_AUDIO_IN:
            raise MateError("audio is larger than 25 MB", status=413)
        if not self.providers.configured(engine, "stt"):
            raise MateError(self.providers.missing_reason(engine, "stt"))
        cfg = self.store.settings()
        language = (stt.get("language") or mate["persona"].get("language") or "").split("-")[0]
        if engine == "local":
            from app.voicehost.service import VoiceError

            model = self._local.model_for("stt", str((stt.get("model") if engine == mine else "") or ""))
            try:
                heard = await self._local.transcribe(audio, language=language or "auto", model_id=model,
                                                     source=f"mate:{mate.get('name') or mate.get('id', '')}")
            except VoiceError as e:
                raise MateError(str(e), status=e.status if e.status < 500 else 502) from None
            return {"text": heard["text"], "language": heard.get("language") or language, "engine": "local"}
        if engine == "google":
            from app.mate.google import default_model, transcribe
            model = (stt.get("model") if engine == mine else "") or default_model(self.providers, "stt")
            return await transcribe(self.store.secret("google_key"), model, audio, content_type, language)
        if engine == "elevenlabs":
            key = self.store.secret("elevenlabs_key")
            fields = {"model_id": ELEVEN_BATCH_STT}
            if language:
                fields["language_code"] = language
            body, ctype = netio.multipart(fields, {"file": (filename or "speech.wav", audio, content_type or "audio/wav")})
            resp = await netio.request("POST", f"{elevenlabs_api()}/speech-to-text", data=body, timeout=120,
                                       headers={"xi-api-key": key, "Content-Type": ctype})
            if resp.status >= 400:
                raise netio.UpstreamError(_no_secret(_eleven_failure(resp)[1], key), status=resp.status)
            try:
                data = resp.json() or {}
            except ValueError:
                data = {}
            return {"text": str(data.get("text") or "").strip(), "language": data.get("language_code"),
                    "engine": "elevenlabs"}
        if engine == "openai":
            url = f"{openai_api()}/audio/transcriptions"
            headers = {"Authorization": f"Bearer {_need(self.store.secret('openai_key'), 'The OpenAI API key')}"}
            model = (stt.get("model") if engine == mine else "") or OPENAI_STT_DEFAULT
        else:  # whisper
            url = _transcription_url(_need(cfg.get("whisper_url") or "", "The Whisper server URL"))
            headers = {}
            model = (stt.get("model") if engine == mine else "") or self.providers.default_model("whisper")
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
            return {"text": resp.body.decode("utf-8", errors="replace").strip(), "engine": engine}
        return {"text": str((data or {}).get("text") or "").strip(), "language": (data or {}).get("language"),
                "engine": engine}

    # ---- voices ----

    async def voices(self, engine: str) -> list[dict[str, Any]]:
        """The voices an engine offers: ``[{id, name, language?, …}]``.
        ElevenLabs: everything in the account (premade, cloned, generated,
        added from the library) with ``category``, ``labels``, ``languages``,
        ``preview_url``; OmniVoice: its profiles with their ``emotions``."""
        if engine == "google":
            from app.mate.google import VOICES
            return [{"id": v, "name": v} for v in VOICES]
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
