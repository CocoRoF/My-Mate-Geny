"""The bundled characters' files under a URL of their own version (docs/mate.md "Bundled files").

A set redone under the same names (a clip encoded again, a still cleaned) must show at once on every device. Asking the server
again each time (ETag, 304) does that for whatever asks; a copy a browser already holds under an older rule (cached for a day) is
never asked about. So every ``/api/mates/builtin/<key>/<rel>`` a mate's JSON carries leaves with ``?v=<the file's version>`` (from
its time and size, as the ETag): a changed file is a new URL, and nothing anywhere can play the old one. What comes back (a rig
the user saved) has it taken off again, so what is stored, and what the bundle sync compares, never carries it.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any
from urllib.parse import unquote

from app.mate import files
from app.mate.store import MateError

_PREFIX = "/api/mates/builtin/"
# a bundled URL as a JSON string holds it ("..."), stamped or not
_URL = re.compile(rb'"(/api/mates/builtin/([^"/?\\]+)/([^"?\\]+))(\?v=[0-9a-f]{6,32})?"')
_STAMP = re.compile(rb'(/api/mates/builtin/[^"?\s\\]+)\?v=[0-9a-f]{6,32}')


def version(key: str, rel: str) -> str | None:
    """The file's version (what its ETag is made of), or None when there is no such file."""
    try:
        path = files.resolve_builtin(key, rel)
        st = path.stat()
    except (MateError, OSError):
        return None
    if not path.is_file():
        return None  # (a folder a pack's files are named from: base + name has to stay a URL)
    return hashlib.md5(f"{st.st_mtime}-{st.st_size}".encode(), usedforsecurity=False).hexdigest()[:12]


def stamp(body: bytes) -> bytes:
    def one(m: re.Match[bytes]) -> bytes:
        v = version(unquote(m.group(2).decode()), unquote(m.group(3).decode()))
        return b'"' + m.group(1) + (b"?v=" + v.encode() if v else b"") + b'"'
    return _URL.sub(one, body) if _PREFIX.encode() in body else body


def unstamp(body: bytes) -> bytes:
    return _STAMP.sub(rb"\1", body) if _PREFIX.encode() in body else body


def _json(headers: list[tuple[bytes, bytes]]) -> bool:
    return any(k.lower() == b"content-type" and b"json" in v.lower() for k, v in headers)


class BuiltinAssetVersions:
    """ASGI: on /api/mates (not the files themselves), JSON going out is stamped and JSON coming in unstamped; anything else
    passes untouched (uploads, audio, the asset files)."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        path = scope.get("path") or ""
        if scope["type"] != "http" or not path.startswith("/api/mates") or path.startswith(_PREFIX) or "/assets/" in path:
            await self.app(scope, receive, send)
            return
        if scope.get("method") in ("POST", "PUT", "PATCH") and _json(scope.get("headers") or []):
            chunks, more = [], True
            while more:
                msg = await receive()
                if msg["type"] != "http.request":
                    break
                chunks.append(msg.get("body", b""))
                more = msg.get("more_body", False)
            body, given = unstamp(b"".join(chunks)), False

            async def receive_body() -> dict:
                nonlocal given
                if not given:
                    given = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()
            inner_receive = receive_body
        else:
            inner_receive = receive
        start: dict | None = None
        held: list[bytes] = []

        async def send_stamped(msg: dict) -> None:
            nonlocal start
            if msg["type"] == "http.response.start":
                if _json(msg.get("headers") or []):
                    start = msg  # (held until the body is whole: its length changes)
                    return
                await send(msg)
                return
            if msg["type"] == "http.response.body" and start is not None:
                held.append(msg.get("body", b""))
                if msg.get("more_body"):
                    return
                out = stamp(b"".join(held))
                headers = [(k, v) for k, v in start.get("headers") or [] if k.lower() != b"content-length"]
                await send({**start, "headers": [*headers, (b"content-length", str(len(out)).encode())]})
                await send({"type": "http.response.body", "body": out, "more_body": False})
                return
            await send(msg)

        await self.app(scope, inner_receive, send_stamped)
