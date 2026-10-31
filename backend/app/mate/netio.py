"""Outbound HTTP for the Mate (voice services, the Live2D core download).

stdlib only (``urllib`` in a worker thread): the deployed image has no
httpx/requests. Every call goes through :func:`request`, so tests swap that
single function for a fake.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

MAX_BODY = 64 * 1024 * 1024  # never buffer more than this from a service


class UpstreamError(RuntimeError):
    """A voice service failed (or isn't reachable). ``status`` is the
    upstream HTTP status (0 = no response)."""

    def __init__(self, message: str, *, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class Response:
    status: int
    body: bytes
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def content_type(self) -> str:
        return (self.headers.get("content-type") or "").split(";")[0].strip().lower()

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8", errors="replace") or "null")


def _do(method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> Response:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - URLs are admin-configured
            data = resp.read(MAX_BODY + 1)
            if len(data) > MAX_BODY:
                raise UpstreamError("response too large", status=resp.status)
            return Response(resp.status, data, {k.lower(): v for k, v in resp.headers.items()})
    except urllib.error.HTTPError as exc:
        data = exc.read(65536) if exc.fp is not None else b""
        return Response(exc.code, data, {k.lower(): v for k, v in (exc.headers or {}).items()})
    except (urllib.error.URLError, OSError, ValueError) as exc:
        reason = getattr(exc, "reason", exc)
        raise UpstreamError(f"cannot reach {url.split('?')[0]}: {reason}") from exc


async def request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    json_body: Any = None,
    data: bytes | None = None,
    timeout: float = 60.0,
) -> Response:
    hdrs = dict(headers or {})
    body = data
    if json_body is not None:
        body = json.dumps(json_body).encode()
        hdrs.setdefault("Content-Type", "application/json")
    hdrs.setdefault("User-Agent", "my-mate-geny/1")
    return await asyncio.to_thread(_do, method, url, hdrs, body, timeout)


def multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    """Encode a multipart/form-data body -> (body, content type)."""
    boundary = "----mate" + secrets.token_hex(12)
    out = bytearray()
    for name, value in fields.items():
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").encode()
    for name, (filename, payload, ctype) in files.items():
        safe = filename.replace('"', "").replace("\r", "").replace("\n", "") or "audio"
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{safe}\"\r\n"
                f"Content-Type: {ctype}\r\n\r\n").encode()
        out += payload + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def error_text(resp: Response, limit: int = 300) -> str:
    """The most useful line of an upstream error body."""
    try:
        j = resp.json()
        if isinstance(j, dict):
            for key in ("detail", "error", "message"):
                v = j.get(key)
                if isinstance(v, dict):
                    v = v.get("message") or v.get("status") or json.dumps(v)
                if v:
                    return str(v)[:limit]
    except ValueError:
        pass
    return resp.body.decode("utf-8", errors="replace").strip()[:limit] or f"HTTP {resp.status}"
