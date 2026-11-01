"""Serving the built web console (STATIC_DIR) with cache headers that survive redeploys.

A deploy replaces ``index.html`` and the content-hashed files under ``assets/``. Without a Cache-Control header
browsers cache ``index.html`` heuristically (10 % of its age, hours for an old build) and keep loading the OLD page,
whose ``assets/<name>-<hash>.js`` may no longer exist -> a blank window. So:

- ``index.html`` (and every other non-hashed file): ``no-cache`` — always revalidated (a cheap 304 when unchanged);
- ``assets/*`` (hashed names, never change): cached for a year, ``immutable``;
- a missing file: ``no-store`` (a 404 for a chunk must never be remembered);
- ``index.html`` missing for a moment (a deploy swapping the directory): a tiny page that retries, not a 500.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.responses import FileResponse, HTMLResponse
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

HTML_CACHE = "no-cache"
ASSET_CACHE = "private, max-age=31536000, immutable"
MISSING_CACHE = "no-store"

# Shown while index.html is briefly absent (mid-swap) — retries by itself.
SWAP_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>My Mate Geny</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#0a0c10;color:#9aa3b4;font:13px system-ui,sans-serif;display:grid;place-items:center}
.s{width:22px;height:22px;margin:0 auto 12px;border-radius:50%;border:2px solid #6e8bff40;border-top-color:#6e8bff;animation:r .8s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}</style></head>
<body><div><div class="s"></div>Updating My Mate Geny…</div>
<script>setTimeout(function(){location.reload()},1500)</script></body></html>"""


def cache_control_for(path: str, status: int) -> str:
    """The Cache-Control for a file under STATIC_DIR (``path`` relative, no leading slash)."""
    if status >= 400:
        return MISSING_CACHE
    p = path.lstrip("/")
    if p.startswith("assets/"):
        return ASSET_CACHE
    return HTML_CACHE


class ConsoleStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            resp = await super().get_response(path, scope)
        except Exception as exc:  # HTTPException(404) and friends
            status = getattr(exc, "status_code", None)
            if status is None:
                raise
            return Response("Not Found" if status == 404 else "", status_code=status,
                            headers={"Cache-Control": MISSING_CACHE})
        resp.headers["Cache-Control"] = cache_control_for(path, resp.status_code)
        return resp


def index_response(static: Path) -> Response:
    index = static / "index.html"
    if not index.is_file():
        return HTMLResponse(SWAP_PAGE, status_code=503, headers={"Cache-Control": MISSING_CACHE, "Retry-After": "2"})
    return FileResponse(index, headers={"Cache-Control": HTML_CACHE})
