"""Voice providers set up in Global settings (docs/mate.md §5).

Which TTS / STT services are configured (key / URL present) and whether they
answer. A verification only uses free, read-only calls (model / voice
listings, health) — it never synthesizes or transcribes anything. Results are
kept in ``mate_settings`` (``verify:<provider>``), dropped when that
provider's key/URL changes, and re-checked when older than :data:`TTL` or on
demand.

Providers: ``openai`` (TTS + STT, one key), ``elevenlabs`` (TTS + realtime
STT, one key: Scribe v2 Realtime streamed from the page with a single-use token),
``omnivoice`` (TTS, geny-audio-services), ``http`` (any OpenAI-shaped
``/audio/speech`` server), ``whisper`` (an OpenAI-compatible
``/v1/audio/transcriptions`` server, e.g. vLLM's whisper).
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any

from app.config import settings
from app.mate import netio
from app.mate.store import MateError, MateStore

TTL = 30 * 60              # re-check a provider's verification after this many seconds
VERIFY_TIMEOUT = 10.0       # one verification request

PROVIDERS: dict[str, dict[str, Any]] = {
    "google": {"label": "Google Gemini", "kinds": ("tts", "stt"), "needs": ("google_key",)},
    "openai": {"label": "OpenAI", "kinds": ("tts", "stt"), "needs": ("openai_key",)},
    "elevenlabs": {"label": "ElevenLabs", "kinds": ("tts", "stt"), "needs": ("elevenlabs_key",)},
    "omnivoice": {"label": "OmniVoice", "kinds": ("tts",), "needs": ("omnivoice_url",)},
    "http": {"label": "OpenAI-compatible TTS server", "kinds": ("tts",), "needs": ("http_tts_url",)},
    "whisper": {"label": "Whisper server", "kinds": ("stt",), "needs": ("whisper_url",)},
}
TTS_ORDER = ("openai", "google", "elevenlabs", "omnivoice", "http")
STT_ORDER = ("openai", "google", "whisper", "elevenlabs")
# The realtime model a mate's mic streams to (ElevenLabs …/speech-to-text/realtime) and the batch model the same
# key transcribes a recording with when the stream can't be used (docs/mate.md §5).
ELEVEN_REALTIME_MODELS = [
    {"id": "scribe_v2_realtime", "name": "Scribe v2 Realtime",
     "description": "Live transcript while you speak (~150 ms), 90+ languages"},
]
ELEVEN_BATCH_STT = "scribe_v2"

# Fixed OpenAI catalogues (no listing API tells TTS models / voices apart).
OPENAI_TTS_MODELS = [
    {"id": "gpt-4o-mini-tts", "name": "GPT-4o mini TTS", "description": "Natural, steerable: the reply's emotion shapes the tone"},
    {"id": "tts-1", "name": "TTS-1", "description": "Fastest, lower quality"},
    {"id": "tts-1-hd", "name": "TTS-1 HD", "description": "Higher quality, slower"},
]
OPENAI_STT_MODELS = [
    {"id": "gpt-4o-mini-transcribe", "name": "GPT-4o mini Transcribe", "description": "Fast and accurate"},
    {"id": "gpt-4o-transcribe", "name": "GPT-4o Transcribe", "description": "Most accurate"},
    {"id": "whisper-1", "name": "Whisper", "description": "The classic Whisper model"},
]
# ballad and verse speak only on gpt-4o-mini-tts
OPENAI_VOICES = [
    ("alloy", "neutral, balanced"), ("ash", "warm, clear"), ("ballad", "soft, expressive"),
    ("coral", "bright, friendly"), ("echo", "calm, male"), ("fable", "storyteller, British"),
    ("nova", "youthful, female"), ("onyx", "deep, male"), ("sage", "gentle, measured"),
    ("shimmer", "light, female"), ("verse", "versatile, expressive"),
]
_GPT4O_ONLY = {"ballad", "verse"}


def openai_api() -> str:
    return settings.mate_openai_base.rstrip("/")


def elevenlabs_api() -> str:
    return settings.mate_elevenlabs_base.rstrip("/")


def v1_base(url: str) -> str:
    """An OpenAI-compatible server URL → its ``…/v1`` base."""
    base = url.rstrip("/")
    for tail in ("/audio/transcriptions", "/audio/speech"):
        if base.endswith(tail):
            base = base[: -len(tail)]
    return base if base.endswith("/v1") else base + "/v1"


def http_base(url: str) -> str:
    """The HTTP TTS URL → the base ``/audio/speech`` and ``/models`` hang off."""
    base = url.rstrip("/")
    return base[: -len("/audio/speech")] if base.endswith("/audio/speech") else base


def openai_voices() -> list[dict[str, Any]]:
    return [{"id": v, "name": v.capitalize(), "description": d,
             "models": ["gpt-4o-mini-tts"] if v in _GPT4O_ONLY else [m["id"] for m in OPENAI_TTS_MODELS]}
            for v, d in OPENAI_VOICES]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _list_ids(resp: netio.Response) -> list[str] | None:
    """The model ids of an OpenAI-shaped ``/models`` answer (None: not that)."""
    try:
        data = resp.json()
    except ValueError:
        return None
    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return None
    return [str(m.get("id")) for m in items if isinstance(m, dict) and m.get("id")]


def _fail(resp: netio.Response, service: str) -> str:
    msg = netio.error_text(resp)
    if resp.status in (401, 403):
        return f"{service} rejected the key (HTTP {resp.status}): {msg}"
    return f"{service}: {msg} (HTTP {resp.status})"


class Providers:
    def __init__(self, store: MateStore) -> None:
        self.store = store
        self._inflight: dict[str, asyncio.Task] = {}
        # short-lived listings (model lists of self-hosted servers), by URL
        self._lists: dict[str, tuple[float, Any]] = {}

    # ---- configuration ----

    def value(self, name: str) -> str:
        if name.endswith("_key"):
            return self.store.secret(name)
        return str(self.store.settings().get(name) or "")

    def configured(self, provider: str) -> bool:
        spec = PROVIDERS.get(provider)
        return bool(spec) and all(self.value(n) for n in spec["needs"])

    def missing_reason(self, provider: str) -> str:
        label = PROVIDERS[provider]["label"]
        what = "API key" if PROVIDERS[provider]["needs"][0].endswith("_key") else "URL"
        return f"{label} isn't set up (no {what}) — add it in Settings → Image and voice providers"

    # ---- verification ----

    async def verify(self, provider: str) -> dict[str, Any]:
        """Check one provider now (concurrent callers share one check)."""
        if provider not in PROVIDERS:
            raise MateError(f"unknown voice provider: {provider}")
        task = self._inflight.get(provider)
        if task is None or task.done():
            task = asyncio.ensure_future(self._verify(provider))
            self._inflight[provider] = task
        return await asyncio.shield(task)

    async def _verify(self, provider: str) -> dict[str, Any]:
        if not self.configured(provider):
            self.store.set_verification(provider, None)
            return self.entry(provider)
        try:
            detail, info = await getattr(self, f"_check_{provider}")()
            doc = {"ok": True, "error": None, "detail": detail, "info": info}
        except netio.UpstreamError as exc:
            doc = {"ok": False, "error": str(exc), "detail": None, "info": {}}
        except MateError as exc:
            doc = {"ok": False, "error": str(exc), "detail": None, "info": {}}
        except (ValueError, TypeError, KeyError, AttributeError) as exc:  # an answer of the wrong shape
            doc = {"ok": False, "error": f"{PROVIDERS[provider]['label']} gave an unexpected answer: {exc}",
                   "detail": None, "info": {}}
        doc.update(checked_at=_now_iso(), at=time.time())
        self.store.set_verification(provider, doc)
        return self.entry(provider)

    def entry(self, provider: str, kind: str | None = None) -> dict[str, Any]:
        spec = PROVIDERS[provider]
        configured = self.configured(provider)
        v = self.store.verification(provider) if configured else None
        out = {"engine": provider, "label": spec["label"], "configured": configured,
               "ok": bool(v and v.get("ok")) if v else (False if not configured else None),
               "error": (v or {}).get("error"), "detail": (v or {}).get("detail"),
               "checked_at": (v or {}).get("checked_at")}
        out["media_models"] = ((v or {}).get("info") or {}).get("media_models", {})
        if kind:
            out["kind"] = kind
        return out

    def _stale(self, provider: str) -> bool:
        if not self.configured(provider):
            return False
        v = self.store.verification(provider)
        return v is None or time.time() - float(v.get("at") or 0) > TTL

    async def status(self, refresh: bool = False) -> dict[str, list[dict[str, Any]]]:
        """Every provider's state; configured ones without a fresh check (or
        all of them with ``refresh``) are verified first, concurrently."""
        todo = [p for p in PROVIDERS if self.configured(p) and (refresh or self._stale(p))]
        if todo:
            await asyncio.gather(*(self.verify(p) for p in todo))
        return {"tts": [self.entry(p, "tts") for p in TTS_ORDER],
                "stt": [self.entry(p, "stt") for p in STT_ORDER]}

    def info(self, provider: str) -> dict[str, Any]:
        v = self.store.verification(provider) if self.configured(provider) else None
        return (v or {}).get("info") or {}

    async def _check_openai(self) -> tuple[str, dict[str, Any]]:
        resp = await netio.request("GET", f"{openai_api()}/models", timeout=VERIFY_TIMEOUT,
                                   headers={"Authorization": f"Bearer {self.value('openai_key')}"})
        if resp.status >= 400:
            raise netio.UpstreamError(_fail(resp, "OpenAI"), status=resp.status)
        ids = _list_ids(resp) or []
        missing = [m["id"] for m in OPENAI_TTS_MODELS[:1] + OPENAI_STT_MODELS[:1] if ids and m["id"] not in ids]
        detail = "Key accepted"
        if missing:
            detail += f" — this key can't see {', '.join(missing)}"
        media = {"tts": [], "stt": [], "image": []}
        for mid in ids:
            kind = "tts" if "tts" in mid else "stt" if "transcribe" in mid or mid == "whisper-1" else "image" if "image" in mid or "dall-e" in mid else None
            if kind:
                media[kind].append({"id": mid, "name": mid})
        return detail, {"media_models": media}

    async def _check_google(self):
        from app.mate.google import verify
        return await verify(self.value("google_key"))

    async def _check_elevenlabs(self) -> tuple[str, dict[str, Any]]:
        resp = await netio.request("GET", f"{elevenlabs_api()}/voices", timeout=VERIFY_TIMEOUT,
                                   headers={"xi-api-key": self.value("elevenlabs_key")})
        if resp.status >= 400:
            raise netio.UpstreamError(_fail(resp, "ElevenLabs"), status=resp.status)
        try:
            n = len((resp.json() or {}).get("voices") or [])
        except (ValueError, AttributeError):
            raise netio.UpstreamError("ElevenLabs answered something that isn't a voice list") from None
        return f"Key accepted · {n} voice{'' if n == 1 else 's'} in the account", {"voices": n}

    async def _check_omnivoice(self) -> tuple[str, dict[str, Any]]:
        url = self.value("omnivoice_url").rstrip("/")
        phase = None
        health = await netio.request("GET", f"{url}/health", timeout=VERIFY_TIMEOUT)
        if health.status < 400:
            try:
                h = health.json() or {}
                phase = str(h.get("phase") or h.get("status") or "") or None
            except (ValueError, AttributeError):
                phase = None
            if phase == "error":
                raise netio.UpstreamError("OmniVoice is up but its engine reports an error (see its logs)")
        voices = await netio.request("GET", f"{url}/voices", timeout=VERIFY_TIMEOUT)
        if voices.status >= 400:
            raise netio.UpstreamError(_fail(voices, "OmniVoice"), status=voices.status)
        try:
            data = voices.json()
            profiles = data.get("voices") if isinstance(data, dict) else data
            n = len([p for p in profiles or [] if isinstance(p, dict)])
        except (ValueError, AttributeError):
            raise netio.UpstreamError(f"{url} doesn't look like an OmniVoice server (no voice list)") from None
        state = "Ready" if phase in (None, "ok") else f"Starting ({phase})"
        return f"{state} · {n} voice profile{'' if n == 1 else 's'}", {"profiles": n, "phase": phase}

    async def _check_http(self) -> tuple[str, dict[str, Any]]:
        base = http_base(self.value("http_tts_url"))
        key = self.value("http_tts_key")
        resp = await netio.request("GET", f"{base}/models", timeout=VERIFY_TIMEOUT,
                                   headers={"Authorization": f"Bearer {key}"} if key else {})
        if resp.status in (401, 403):
            raise netio.UpstreamError(_fail(resp, "The TTS server"), status=resp.status)
        if resp.status >= 500:
            raise netio.UpstreamError(_fail(resp, "The TTS server"), status=resp.status)
        ids = _list_ids(resp) if resp.status < 400 else None
        if ids is None:
            return "Reachable (it lists no models)", {"models": []}
        return f"Reachable · {len(ids)} model{'' if len(ids) == 1 else 's'}", {"models": ids[:200]}

    async def _check_whisper(self) -> tuple[str, dict[str, Any]]:
        base = v1_base(self.value("whisper_url"))
        resp = await netio.request("GET", f"{base}/models", timeout=VERIFY_TIMEOUT)
        ids = _list_ids(resp) if resp.status < 400 else None
        if ids is not None:
            return (f"Reachable · {', '.join(ids[:3])}" if ids else "Reachable"), {"models": ids[:200]}
        if resp.status in (401, 403):
            raise netio.UpstreamError(_fail(resp, "The Whisper server"), status=resp.status)
        root = base[: -len("/v1")]
        health = await netio.request("GET", f"{root}/health", timeout=VERIFY_TIMEOUT)
        if health.status < 400:
            return "Reachable (it lists no models)", {"models": []}
        raise netio.UpstreamError(f"The Whisper server answers neither /v1/models nor /health "
                                  f"(HTTP {resp.status} / {health.status})", status=health.status)

    # ---- model listings ----

    async def _cached_list(self, key: str, fetch: Any, ttl: float = 60.0) -> Any:
        hit = self._lists.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return hit[1]
        value = await fetch()
        self._lists[key] = (time.monotonic(), value)
        return value

    async def models(self, engine: str, kind: str) -> dict[str, Any]:
        """``{engine, kind, models: [{id, name, description?, languages?}], default}``;
        omnivoice also gets ``languages`` (what its /languages lists)."""
        if kind not in ("tts", "stt"):
            raise MateError("kind must be tts or stt")
        out: dict[str, Any] = {"engine": engine, "kind": kind, "models": [], "default": ""}
        if engine in ("browser", "off"):
            return out
        if engine not in PROVIDERS or kind not in PROVIDERS[engine]["kinds"]:
            raise MateError(f"{engine} has no {kind.upper()} models")
        if engine == "openai":
            out["models"] = OPENAI_TTS_MODELS if kind == "tts" else OPENAI_STT_MODELS
            out["default"] = out["models"][0]["id"]
            return out
        if not self.configured(engine):
            raise MateError(self.missing_reason(engine))
        if engine == "google":
            from app.mate.google import default_model
            out["models"] = self.info("google").get("media_models", {}).get(kind) or []
            out["default"] = default_model(self, kind)
            return out
        if engine == "elevenlabs" and kind == "stt":
            out["models"] = ELEVEN_REALTIME_MODELS
            out["default"] = ELEVEN_REALTIME_MODELS[0]["id"]
            return out
        if engine == "elevenlabs":
            key = self.value("elevenlabs_key")

            async def fetch() -> list[dict[str, Any]]:
                resp = await netio.request("GET", f"{elevenlabs_api()}/models", timeout=20,
                                           headers={"xi-api-key": key})
                if resp.status >= 400:
                    raise netio.UpstreamError(_fail(resp, "ElevenLabs"), status=resp.status)
                items = resp.json()
                return [{"id": m.get("model_id"), "name": m.get("name") or m.get("model_id"),
                         "description": (m.get("description") or "").strip() or None,
                         "languages": [str(lang.get("language_id") or lang.get("name"))
                                       for lang in m.get("languages") or [] if isinstance(lang, dict)]}
                        for m in items if isinstance(m, dict) and m.get("model_id")
                        and m.get("can_do_text_to_speech", True)] if isinstance(items, list) else []
            out["models"] = await self._cached_list("eleven-models:" + key[-6:], fetch, ttl=600)
            out["default"] = "eleven_multilingual_v2"
            return out
        if engine == "omnivoice":
            url = self.value("omnivoice_url").rstrip("/")

            async def langs() -> list[str]:
                resp = await netio.request("GET", f"{url}/languages", timeout=15)
                if resp.status >= 400:
                    return []
                data = resp.json()
                items = data.get("languages") if isinstance(data, dict) else data
                return [str(x) for x in items or [] if isinstance(x, (str, int))]
            try:
                out["languages"] = await self._cached_list("omni-langs:" + url, langs, ttl=3600)
            except (netio.UpstreamError, ValueError):
                out["languages"] = []
            return out
        # self-hosted OpenAI-compatible servers: their own /models, if any
        if engine == "whisper":
            base = v1_base(self.value("whisper_url"))
            headers: dict[str, str] = {}
        else:
            base = http_base(self.value("http_tts_url"))
            key = self.value("http_tts_key")
            headers = {"Authorization": f"Bearer {key}"} if key else {}

        async def ids() -> list[str]:
            resp = await netio.request("GET", f"{base}/models", timeout=15, headers=headers)
            if resp.status >= 400:
                return []
            return _list_ids(resp) or []
        try:
            found = await self._cached_list(f"models:{base}", ids)
        except netio.UpstreamError:
            found = self.info(engine).get("models") or []
        out["models"] = [{"id": i, "name": i} for i in found]
        out["default"] = found[0] if found else ("whisper-1" if engine == "whisper" else "tts-1")
        return out

    def default_model(self, engine: str) -> str:
        """What a self-hosted server is asked for when the mate names no model:
        the first model it listed (vLLM serves e.g. openai/whisper-large-v3)."""
        listed = self.info(engine).get("models") or []
        if listed:
            return str(listed[0])
        return "whisper-1" if engine == "whisper" else "tts-1"
