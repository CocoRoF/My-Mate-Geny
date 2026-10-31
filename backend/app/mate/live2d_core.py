"""Installing the Live2D Cubism Core (docs/mate.md §2): one shared download
with progress, streamed to every caller as NDJSON.

The core is not redistributed with the app (Live2D licence): the user accepts
the licence in the UI and the backend fetches it from Live2D's CDN into
``<MATES_ROOT>/_runtime/``. Several install requests at once (two tabs, a
double click) share one download; each one streams the same progress:

    {"phase":"downloading","received":n,"total":m|null}   (repeated)
    {"phase":"verifying"}
    {"phase":"done","installed":true,"size":n,"source":url}   or   {"phase":"error","error":"…"}
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import urllib.error
import urllib.request
from collections.abc import AsyncIterator, Callable
from typing import Any

from app.mate import files
from app.mate.store import MateError

MAX_BYTES = 8 * 1024 * 1024
CHUNK = 32 * 1024
TIMEOUT = 60.0


def core_url() -> str:
    """Where the core comes from (``MATE_LIVE2D_CORE_URL`` overrides it, for tests)."""
    return os.environ.get("MATE_LIVE2D_CORE_URL") or files.CORE_URL


def fetch(url: str, progress: Callable[[int, int | None], None]) -> bytes:
    """Download ``url`` (blocking; runs in a worker thread), calling
    ``progress(received, total)`` as bytes arrive. Raises RuntimeError with a
    readable message. Tests replace this function."""
    req = urllib.request.Request(url, headers={"User-Agent": "my-mate-geny/1"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # noqa: S310 - fixed CDN URL
            length = resp.headers.get("Content-Length")
            total = int(length) if length and length.isdigit() else None
            if total is not None and total > MAX_BYTES:
                raise RuntimeError("the download is too large to be the Cubism Core")
            buf = bytearray()
            progress(0, total)
            while True:
                chunk = resp.read(CHUNK)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > MAX_BYTES:
                    raise RuntimeError("the download is too large to be the Cubism Core")
                progress(len(buf), total)
            return bytes(buf)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Live2D CDN: HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise RuntimeError(f"cannot reach {url.split('?')[0]}: {getattr(exc, 'reason', exc)}") from exc


class CoreInstaller:
    """The one install in flight (per backend process) and its progress."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._task: asyncio.Task[dict[str, Any]] | None = None
        self.phase = "idle"      # idle | downloading | verifying | done | error
        self.received = 0
        self.total: int | None = None
        self.error: str | None = None
        self._version = 0        # bumps on every change (streams emit when it moved)

    def _set(self, **kw: Any) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, v)
            self._version += 1

    @property
    def installing(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> dict[str, Any]:
        out: dict[str, Any] = {**files.core_status(), "installing": self.installing}
        if self.installing:
            out.update(received=self.received, total=self.total, phase=self.phase)
        elif self.phase == "error" and self.error and not out["installed"]:
            out["error"] = self.error
        return out

    def start(self) -> asyncio.Task[dict[str, Any]]:
        """The running install, or a new one."""
        loop = asyncio.get_running_loop()
        if self._task is None or self._task.done() or self._task.get_loop() is not loop:
            self._set(phase="downloading", received=0, total=None, error=None)
            self._task = loop.create_task(self._run())
            # the outcome is read by the streams; a stream that went away must not leave it "never retrieved"
            self._task.add_done_callback(lambda t: t.cancelled() or t.exception())
        return self._task

    async def _run(self) -> dict[str, Any]:
        url = core_url()
        last = [0.0]

        def progress(received: int, total: int | None) -> None:
            now = time.monotonic()
            # every ~80 ms (and the first/last chunk): enough for a smooth bar, few lines
            if received == 0 or now - last[0] >= 0.08 or (total is not None and received >= total):
                last[0] = now
                self._set(received=received, total=total)
            else:
                with self._lock:
                    self.received, self.total = received, total

        try:
            body = await asyncio.to_thread(fetch, url, progress)
            self._set(phase="verifying", received=len(body))
            result = await asyncio.to_thread(files.store_core, body)
            self._set(phase="done")
            return result
        except (MateError, RuntimeError) as exc:
            self._set(phase="error", error=str(exc))
            raise
        except Exception as exc:  # noqa: BLE001 - reported to the caller, never crashes the app
            self._set(phase="error", error=f"install failed: {exc}")
            raise RuntimeError(f"install failed: {exc}") from exc

    async def stream(self) -> AsyncIterator[bytes]:
        """NDJSON progress of the shared install, ending with done/error."""
        task = self.start()
        seen = -1
        verifying_sent = False

        def line(obj: dict[str, Any]) -> bytes:
            return (json.dumps(obj, ensure_ascii=False) + "\n").encode()

        while not task.done():
            with self._lock:
                v, phase, received, total = self._version, self.phase, self.received, self.total
            if v != seen:
                seen = v
                if phase == "downloading":
                    yield line({"phase": "downloading", "received": received, "total": total})
                elif phase == "verifying" and not verifying_sent:
                    verifying_sent = True
                    yield line({"phase": "verifying"})
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=0.1)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001 - the outcome is read below
                pass
        try:
            result = task.result()
        except Exception as exc:  # noqa: BLE001
            yield line({"phase": "error", "error": str(exc) or "install failed"})
            return
        if not verifying_sent:
            yield line({"phase": "downloading", "received": self.received, "total": self.total})
            yield line({"phase": "verifying"})
        yield line({"phase": "done", "installed": True, "size": result.get("size"), "source": result.get("source")})


installer = CoreInstaller()
