"""Admin console API — error logs, system status, security (login bans)."""

from __future__ import annotations

import asyncio
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
from collections import deque
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from app import __version__
from app.auth import AuthManager
from app.config import settings
from app.routers._deps import provider_service
from app.services.log_service import LogService
from app.services.provider_service import ProviderService

router = APIRouter(prefix="/api/admin")

_STARTED = time.time()
_STARTED_ISO = datetime.now(timezone.utc).isoformat()


def _logs(request: Request) -> LogService:
    return request.app.state.logs


# ---- logs -------------------------------------------------------------------


@router.get("/logs")
async def list_logs(
    request: Request,
    level: str | None = None,
    source: str | None = None,
    q: str | None = None,
    session_id: str | None = None,
    before_id: int | None = None,
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    return _logs(request).list(
        level=level or None, source=source or None, q=(q or "").strip() or None,
        session_id=session_id or None, before_id=before_id, limit=limit,
    )


@router.get("/logs/stats")
async def log_stats(request: Request) -> dict:
    return _logs(request).stats()


@router.get("/logs/{log_id}")
async def get_log(log_id: int, request: Request) -> dict:
    row = _logs(request).get(log_id)
    if row is None:
        raise HTTPException(status_code=404, detail="log not found")
    return row


@router.delete("/logs")
async def clear_logs(request: Request) -> dict:
    return {"deleted": _logs(request).clear()}


class ClientError(BaseModel):
    message: str
    kind: str = "error"          # error | unhandledrejection | api
    stack: str | None = None
    url: str | None = None
    source: str | None = None    # file:line:col for window.onerror
    user_agent: str | None = None


# Browser reports are rate-limited so a render loop can't flood the table.
_client_hits: deque[float] = deque()
_CLIENT_MAX_PER_MIN = 30


@router.post("/client-log")
async def client_log(body: ClientError, request: Request) -> dict:
    now = time.time()
    while _client_hits and now - _client_hits[0] > 60:
        _client_hits.popleft()
    if len(_client_hits) >= _CLIENT_MAX_PER_MIN:
        return {"ok": False, "throttled": True}
    _client_hits.append(now)
    _logs(request).record(
        "error", "client", body.message[:2000], code=f"client.{body.kind}"[:64],
        detail={"stack": body.stack, "url": body.url, "source": body.source,
                "user_agent": body.user_agent or request.headers.get("user-agent")},
        path=body.url, ip=AuthManager.client_ip(request),
    )
    return {"ok": True}


# ---- system -----------------------------------------------------------------

_cli_cache: dict[str, tuple[float, str]] = {}


def _cli_version(binary: str) -> str:
    hit = _cli_cache.get(binary)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    try:
        p = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=8)
        v = (p.stdout or p.stderr).strip().splitlines()[0] if (p.stdout or p.stderr) else "?"
    except (OSError, subprocess.TimeoutExpired) as exc:
        v = f"unavailable ({type(exc).__name__})"
    _cli_cache[binary] = (time.time(), v)
    return v


def _count(db, table: str) -> int:
    row = db.query_one(f"SELECT COUNT(*) AS c FROM {table}")  # noqa: S608 - fixed table names
    return row["c"] if row else 0


@router.get("/system")
async def system(request: Request, providers: ProviderService = Depends(provider_service)) -> dict:
    state = request.app.state
    db = state.db
    db_file = settings.db_file
    db_size = sum(
        os.path.getsize(p) for p in (str(db_file), f"{db_file}-wal", f"{db_file}-shm") if os.path.exists(p)
    )
    uploads_size = await asyncio.to_thread(state.attachment_service.disk_usage)
    disk = shutil.disk_usage("/home") if os.path.exists("/home") else None
    claude_v, codex_v = await asyncio.gather(
        asyncio.to_thread(_cli_version, settings.claude_binary),
        asyncio.to_thread(_cli_version, settings.codex_binary),
    )
    return {
        "version": __version__,
        "started_at": _STARTED_ISO,
        "uptime_s": int(time.time() - _STARTED),
        "hostname": socket.gethostname(),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cli": {"claude": claude_v, "codex": codex_v},
        "providers": await providers.status_all(),
        "active_runs": list(state.session_service.active_runs.values()),
        "engines": state.session_service.engines(),
        "live_usage": state.session_service.live_usage,
        "counts": {
            "sessions": _count(db, "sessions"),
            "messages": _count(db, "messages"),
            "events": _count(db, "events"),
            "attachments": _count(db, "attachments"),
            "connections": _count(db, "connections"),
            "error_logs": _count(db, "error_logs"),
        },
        "storage": {
            "db_bytes": db_size,
            "uploads_bytes": uploads_size,
            "disk_total": disk.total if disk else None,
            "disk_used": disk.used if disk else None,
            "disk_free": disk.free if disk else None,
        },
        "monitor": state.system_monitor.sampler_stats() if getattr(state, "system_monitor", None) else None,
        "limits": {
            "upload_max_mb": settings.upload_max_mb,
            "upload_max_files": settings.upload_max_files,
            "turn_timeout_s": settings.turn_timeout_s,
            "log_max_rows": settings.log_max_rows,
        },
    }


# ---- system monitor (docs/monitoring.md) --------------------------------------


def _monitor(request: Request):
    mon = getattr(request.app.state, "system_monitor", None)
    if mon is None:
        raise HTTPException(status_code=503, detail="system monitor is disabled (MONITOR_ENABLED=false)")
    return mon


@router.get("/system/now")
async def system_now(request: Request) -> dict:
    """The latest sample: metrics, per-core CPU, processes, GPUs, alerts."""
    mon = _monitor(request)
    if mon.latest is None:
        raise HTTPException(status_code=503, detail="system monitor is warming up")
    return {k: v for k, v in mon.latest.items() if k != "new_events"}


@router.get("/system/metrics")
async def system_metrics(
    request: Request,
    range: str = Query("1h", pattern="^(15m|30m|1h|6h|24h|7d|30d|90d)$"),  # noqa: A002
) -> dict:
    """Time series for a range, columnar: ``t`` (epoch s) + ``series[metric]
    = {avg, min?, max?}``; 15m/30m come from the live ring (2 s), the rest
    from the 1-min / 15-min history. Includes the monitor events in range."""
    mon = _monitor(request)
    out = await asyncio.to_thread(mon.series, range)
    out["thresholds"] = mon.thresholds()
    return out


# ---- security ---------------------------------------------------------------


@router.get("/security")
async def security(request: Request) -> dict:
    auth: AuthManager = request.app.state.auth
    rows = request.app.state.db.query("SELECT * FROM login_attempts ORDER BY updated_at DESC")
    return {
        "your_ip": AuthManager.client_ip(request),
        "max_login_fails": settings.max_login_fails,
        "ban_hours": settings.ban_hours,
        "attempts": [{**dict(r), "banned": auth.is_banned(r["ip"])} for r in rows],
    }


@router.delete("/security/{ip}")
async def unban(ip: str, request: Request) -> dict:
    auth: AuthManager = request.app.state.auth
    auth.clear_failures(ip)
    _logs(request).record(
        "info", "auth", f"login block cleared for {ip}", code="auth.unbanned",
        ip=AuthManager.client_ip(request), detail={"target_ip": ip},
    )
    return {"ip": ip, "cleared": True}
