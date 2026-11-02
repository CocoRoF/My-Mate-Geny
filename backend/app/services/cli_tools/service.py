"""CLI versions: installed vs latest for Claude Code, Codex and Higgsfield, and
their upgrade (Settings → Providers → CLI versions; docs/providers.md, "CLI versions").

* installed: ``<binary> --version`` of the binary sessions actually launch
  (:func:`tools.effective_binary`, resolved on this process's PATH — inside the
  container when the backend runs in one), cached until that file changes;
* latest: the npm registry's dist-tags (Claude: the ``latest`` or ``stable``
  channel), cached ``cli_check_ttl_h``; "Check now" refreshes;
* upgrade: one job at a time — the install method's own updater (see
  :func:`versions.plan_upgrade`), optionally once no chat is running, under
  the host's memory cap (``capped``) and a timeout, its output pushed line by
  line over /ws/sessions (``cli.log``); verified by running ``--version``
  again. Claude's persistent engines are restarted once idle so new turns use
  the new binary.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shlex
import shutil
import signal
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from app import __version__
from app.config import settings
from app.services.cli_tools import tools as T
from app.services.cli_tools.versions import (
    Install,
    PlanError,
    capped_argv,
    channel_target,
    compare_versions,
    detect_install,
    is_exact_version,
    is_newer,
    npm_for_prefix,
    parse_changelog,
    parse_dist_tags,
    parse_version,
    plan_upgrade,
    release_bullets,
    split_output,
)

LOG_KEEP = 2000          # lines kept per job (older ones are dropped, counted)
LOG_SNAPSHOT = 400       # lines sent with the status
VERSION_TIMEOUT_S = 20
IDLE_RECHECK_S = 30      # "when idle": re-check this often even without a turn-end signal
IDLE_SETTLE_S = 2        # …and stay idle this long (a background turn may follow a turn at once)
CHANGELOG_BYTES = 262144  # Claude's CHANGELOG.md: the newest part is enough


def _iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else time.time(), tz=timezone.utc).isoformat(timespec="seconds")


class UpgradeError(Exception):
    def __init__(self, code: str, message: str = "", status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.status = status


@dataclass
class Job:
    tool: str
    target: str
    from_version: str | None
    when: str                     # now | idle
    reason: str                   # manual | auto | pin
    method: str
    command: str
    switch_to_managed: bool
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    state: str = "queued"         # queued | waiting | running | verifying | succeeded | failed | cancelled
    created_at: str = field(default_factory=_iso)
    started_at: str | None = None
    finished_at: str | None = None
    lines: list[str] = field(default_factory=list)
    dropped: int = 0
    pushed: int = 0               # absolute index of the first line not yet pushed
    error_code: str | None = None
    error: str | None = None
    result: dict[str, Any] = field(default_factory=dict)
    waiting_for: int = 0          # chats running while waiting for idle
    mem_cap: str | None = None

    @property
    def active(self) -> bool:
        return self.state in ("queued", "waiting", "running", "verifying")

    def add(self, line: str) -> None:
        self.lines.append(line[:2000])
        if len(self.lines) > LOG_KEEP:
            cut = len(self.lines) - LOG_KEEP
            del self.lines[:cut]
            self.dropped += cut

    @property
    def end(self) -> int:
        return self.dropped + len(self.lines)

    def to_dict(self) -> dict[str, Any]:
        snap = self.lines[-LOG_SNAPSHOT:]
        return {
            "id": self.id, "tool": self.tool, "target": self.target, "from_version": self.from_version,
            "when": self.when, "reason": self.reason, "method": self.method, "command": self.command,
            "switch_to_managed": self.switch_to_managed, "state": self.state, "active": self.active,
            "created_at": self.created_at, "started_at": self.started_at, "finished_at": self.finished_at,
            "log": snap, "log_start": self.end - len(snap), "error_code": self.error_code, "error": self.error,
            "result": self.result, "waiting_for": self.waiting_for, "mem_cap": self.mem_cap,
        }


# ---- outbound HTTP (registry / GitHub), run in a worker thread ----


def _http_get(url: str, *, headers: dict[str, str] | None = None, timeout: float = 12,
              max_bytes: int = 4_000_000) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": f"my-mate-geny/{__version__}", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - fixed https endpoints
        return r.read(max_bytes)


async def fetch_json(url: str, headers: dict[str, str] | None = None) -> Any:
    return json.loads(await asyncio.to_thread(_http_get, url, headers=headers))


async def fetch_text(url: str, headers: dict[str, str] | None = None, max_bytes: int = 4_000_000) -> str:
    return (await asyncio.to_thread(_http_get, url, headers=headers, max_bytes=max_bytes)).decode("utf-8", "replace")


def _err(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code}"
    if isinstance(exc, urllib.error.URLError):
        return f"network: {exc.reason}"
    return f"{type(exc).__name__}: {exc}"[:300]


def capped_path() -> str | None:
    """``capped`` (this host's per-command memory cap, ~/server-hardening) when
    it can actually cap here: a systemd user session is reachable — or we
    already run inside a cap (CAPPED_MEM), which then also bounds the upgrade.
    In a container there is neither: the upgrade runs uncapped (logged)."""
    c = shutil.which("capped") or next(
        (p for p in (os.path.expanduser("~/.local/bin/capped"),) if os.access(p, os.X_OK)), None)
    if not c:
        return None
    if os.environ.get("CAPPED_MEM"):
        return c
    xdg = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    if os.path.exists(os.path.join(xdg, "bus")) and shutil.which("systemd-run"):
        return c
    return None


async def wait_until_idle(busy: Callable[[], int], signal_evt: asyncio.Event, *,
                          recheck_s: float = IDLE_RECHECK_S, settle_s: float = IDLE_SETTLE_S,
                          on_wait: Callable[[int], None] | None = None) -> None:
    """Return once ``busy()`` is 0 and stays 0 for ``settle_s``. Woken by
    ``signal_evt`` (a turn ended), re-checked every ``recheck_s`` regardless."""
    while True:
        n = busy()
        if n == 0:
            if settle_s <= 0:
                return
            await asyncio.sleep(settle_s)
            if busy() == 0:
                return
            continue
        if on_wait:
            on_wait(n)
        signal_evt.clear()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(signal_evt.wait(), timeout=recheck_s)


class CliToolsService:
    def __init__(
        self,
        sessions: Any = None,
        logs: Any = None,
        *,
        get_json: Callable[[str, dict[str, str] | None], Awaitable[Any]] | None = None,
        get_text: Callable[..., Awaitable[str]] | None = None,
    ) -> None:
        self._sessions = sessions
        self._logs = logs
        self._get_json = get_json or fetch_json
        self._get_text = get_text or fetch_text
        self._installed: dict[str, dict[str, Any]] = {}   # resolved path -> probe
        self._latest: dict[str, dict[str, Any]] = {}      # tool -> {tags, checked_at, ts, error}
        self._notes: dict[tuple, dict[str, Any]] = {}     # (tool, from, to) -> notes
        self._job: Job | None = None
        self._last: dict[str, Job] = {}
        self._task: asyncio.Task | None = None
        self._check_task: asyncio.Task | None = None
        self._loop_task: asyncio.Task | None = None
        self._idle_evt: asyncio.Event | None = None
        self._flush_task: asyncio.Task | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self.version = int(time.time() * 1000)
        if sessions is not None and hasattr(sessions, "add_turn_end_listener"):
            sessions.add_turn_end_listener(self._on_turn_end)

    # ---- lifecycle ----

    async def start(self) -> None:
        self._loop_task = asyncio.create_task(self._auto_loop())

    async def stop(self) -> None:
        for t in (self._loop_task, self._check_task):
            if t is not None:
                t.cancel()
        if self._job is not None and self._job.state in ("queued", "waiting") and self._task is not None:
            self._task.cancel()

    # ---- pushes (/ws/sessions) ----

    def _publish(self, msg: dict[str, Any]) -> None:
        pub = getattr(self._sessions, "broadcast_list", None)
        if pub is not None:
            with contextlib.suppress(Exception):
                pub(msg)

    def _changed(self, tool: str | None = None) -> None:
        self.version += 1
        self._publish({"type": "cli.changed", "data": {"version": self.version, "tool": tool}})

    def _push_log(self, job: Job) -> None:
        if job.pushed >= job.end:
            return
        start = max(job.pushed, job.dropped)
        lines = job.lines[start - job.dropped:]
        job.pushed = job.end
        self._publish({"type": "cli.log", "data": {"tool": job.tool, "job_id": job.id, "start": start, "lines": lines}})

    def _queue_log(self, job: Job) -> None:
        if self._flush_task is not None and not self._flush_task.done():
            return

        async def flush() -> None:
            await asyncio.sleep(0.2)
            self._push_log(job)

        self._flush_task = asyncio.create_task(flush())

    def _on_turn_end(self, sid: str, outcome: dict[str, Any]) -> None:
        if self._idle_evt is not None:
            self._idle_evt.set()

    def running_chats(self) -> int:
        runs = getattr(self._sessions, "active_runs", None)
        return len(runs) if runs else 0

    # ---- installed ----

    @staticmethod
    def _env() -> dict[str, str]:
        env = dict(os.environ)
        env.update({"NO_COLOR": "1", "npm_config_update_notifier": "false", "npm_config_fund": "false"})
        return env

    async def _probe(self, tool: str, binary: str, *, fresh: bool = False) -> dict[str, Any]:
        spec = T.TOOLS[tool]
        path = T.resolve_path(binary, spec.fallbacks)
        real = os.path.realpath(path) if path else None
        try:
            st = os.stat(real) if real else None
            stamp = (path, real, st.st_mtime_ns, st.st_size) if st else (path, None)
        except OSError:
            stamp = (path, real)
        key = f"{tool}:{binary}"
        hit = self._installed.get(key)
        if hit and not fresh and hit["stamp"] == stamp:
            return hit
        inst = detect_install(spec.pkg, path, real, T.managed_prefix(), native=spec.native)
        raw, err = None, None
        if path:
            raw, err = await self._run_version(path)
        elif binary:
            err = "not_found"
        info = {
            "stamp": stamp, "binary": binary, "path": path, "realpath": real,
            "version": parse_version(raw), "raw": raw, "error": err if not parse_version(raw) else None,
            "method": inst.method, "prefix": inst.prefix, "writable": inst.writable,
            "checked_at": _iso(),
        }
        if raw is not None and info["version"] is None and not err:
            info["error"] = "unparsed"
        self._installed[key] = info
        return info

    async def _run_version(self, path: str) -> tuple[str | None, str | None]:
        try:
            proc = await asyncio.create_subprocess_exec(
                path, "--version", stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT, env=self._env(), start_new_session=True,
            )
        except OSError as exc:
            return None, f"{type(exc).__name__}: {exc}"[:300]
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=VERSION_TIMEOUT_S)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            return None, "timeout"
        text = out.decode("utf-8", "replace").strip()
        if proc.returncode != 0 and not parse_version(text):
            return text[:300] or None, f"exit {proc.returncode}"
        return text[:300], None

    # ---- latest ----

    def _stale(self, tool: str) -> bool:
        lat = self._latest.get(tool)
        if not lat:
            return True
        ttl = settings.cli_check_ttl_h * 3600 if not lat.get("error") else 1800
        return time.time() - lat["ts"] > ttl

    async def _check_latest(self, tool: str) -> dict[str, Any]:
        spec = T.TOOLS[tool]
        url = f"{settings.cli_npm_registry.rstrip('/')}/-/package/{spec.pkg}/dist-tags"
        try:
            tags = parse_dist_tags(await self._get_json(url, None))
            if not tags.get("latest"):
                raise ValueError("no latest tag")
            lat = {"tags": tags, "ts": time.time(), "checked_at": _iso(), "error": None, "source": url}
        except Exception as exc:  # noqa: BLE001 - shown to the user, retried
            prev = self._latest.get(tool) or {}
            lat = {"tags": prev.get("tags") or {}, "ts": time.time(), "checked_at": _iso(),
                   "error": _err(exc), "source": url}
        self._latest[tool] = lat
        return lat

    async def _check_notes(self, tool: str, installed: str | None, target: str) -> None:
        key = (tool, installed, target)
        hit = self._notes.get(key)
        if hit and time.time() - hit["ts"] < (settings.cli_check_ttl_h * 3600 if not hit.get("error") else 1800):
            return
        spec = T.TOOLS[tool]
        notes: dict[str, Any] = {"url": T.release_url(spec, target), "sections": [], "error": None, "ts": time.time()}
        try:
            if spec.notes == "claude_changelog":
                md = await self._get_text(
                    f"https://raw.githubusercontent.com/{spec.gh_repo}/main/CHANGELOG.md",
                    {"Range": f"bytes=0-{CHANGELOG_BYTES - 1}"}, CHANGELOG_BYTES,
                )
                notes["sections"] = parse_changelog(md, installed, target, limit=12)
            elif spec.gh_repo:
                rel = await self._get_json(
                    f"https://api.github.com/repos/{spec.gh_repo}/releases/tags/{spec.gh_tag.format(v=target)}",
                    {"Accept": "application/vnd.github+json"},
                )
                items, count = release_bullets(rel.get("body") if isinstance(rel, dict) else None, limit=8)
                notes["sections"] = [{"version": target, "items": items, "count": count}]
                if isinstance(rel, dict) and rel.get("html_url"):
                    notes["url"] = rel["html_url"]
        except Exception as exc:  # noqa: BLE001 - notes are a nicety: the link still works
            notes["error"] = _err(exc)
        self._notes[key] = notes

    async def _refresh(self, tool: str, *, fresh: bool) -> None:
        """Latest (and the installed version), plus release notes when it is newer."""
        info = await self._probe(tool, T.effective_binary(tool), fresh=fresh)
        if not settings.cli_update_check:
            return
        if fresh or self._stale(tool):
            await self._check_latest(tool)
        target = channel_target((self._latest.get(tool) or {}).get("tags") or {}, self._channel(tool))
        if target and is_newer(target, info["version"]):
            await self._check_notes(tool, info["version"], target)

    async def check(self, tool: str | None = None) -> None:
        """Refresh installed + latest (+ notes when newer) now ("Check now")."""
        names = [tool] if tool else list(T.TOOLS)
        for key in [k for k in self._installed if tool is None or k.startswith(f"{tool}:")]:
            self._installed.pop(key, None)
        await asyncio.gather(*(self._refresh(n, fresh=True) for n in names))
        self._changed(tool)

    def _needs_refresh(self, tool: str) -> bool:
        if self._stale(tool):
            return True
        # newer than installed but its notes not fetched yet (e.g. after a channel change)
        info = next((v for k, v in self._installed.items() if k == f"{tool}:{T.effective_binary(tool)}"), None)
        target = channel_target((self._latest.get(tool) or {}).get("tags") or {}, self._channel(tool))
        return bool(info and target and is_newer(target, info["version"])
                    and (tool, info["version"], target) not in self._notes)

    def _kick_check(self) -> None:
        if not settings.cli_update_check:
            return
        if self._check_task is not None and not self._check_task.done():
            return
        todo = [t for t in T.TOOLS if self._needs_refresh(t)]
        if not todo:
            return

        async def run() -> None:
            await asyncio.gather(*(self._refresh(t, fresh=False) for t in todo))
            self._changed()

        self._check_task = asyncio.create_task(run())

    # ---- status ----

    def _channel(self, tool: str) -> str:
        spec = T.TOOLS[tool]
        ch = T.tool_state(tool).get("channel")
        if ch in spec.channels:
            return ch
        if tool == "claude":
            cfg = _read_json(os.path.expanduser("~/.claude/settings.json"))
            ch = cfg.get("autoUpdatesChannel") if isinstance(cfg, dict) else None
            if ch in spec.channels:
                return ch
        return spec.channels[0]

    def _plan(self, tool: str, info: dict[str, Any], version: str) -> Any:
        spec = T.TOOLS[tool]
        inst = Install(info["method"], info["prefix"], info["writable"])
        npm = npm_for_prefix(inst.prefix if inst.method in ("npm", "managed") else None, shutil.which, os.path.exists)
        return plan_upgrade(pkg=spec.pkg, install=inst, binary_path=info["path"], version=version,
                            npm=npm, managed_prefix=T.managed_prefix())

    def _self_update(self, tool: str, info: dict[str, Any]) -> dict[str, Any] | None:
        """Claude Code's own auto-updater, as configured for this HOME (read-only here:
        it is the user's global Claude setting, shared with their terminal)."""
        if tool != "claude":
            return None
        cfg = _read_json(os.path.expanduser("~/.claude/settings.json"))
        glob = _read_json(os.path.expanduser("~/.claude.json"))
        env = cfg.get("env") if isinstance(cfg.get("env"), dict) else {}
        channel = cfg.get("autoUpdatesChannel") or "latest"
        if info["method"] == "managed":
            # its own updater would go through npm's global prefix, not this one: the app upgrades it
            return {"enabled": False, "source": "app_managed", "channel": channel}
        if info["method"] != "native" and not info["writable"]:
            return {"enabled": False, "source": "read_only", "channel": channel}
        if str(env.get("DISABLE_AUTOUPDATER", "")).strip() not in ("", "0", "false"):
            return {"enabled": False, "source": "settings_env", "channel": channel}
        if os.environ.get("DISABLE_AUTOUPDATER", "").strip() not in ("", "0", "false"):
            return {"enabled": False, "source": "process_env", "channel": channel}
        if glob.get("autoUpdates") is False and not (info["method"] == "native" and glob.get("autoUpdatesProtectedForNative")):
            return {"enabled": False, "source": "global_config", "channel": channel}
        return {"enabled": True, "source": "default", "channel": channel}

    def _engines(self) -> dict[str, int]:
        try:
            es = self._sessions.engines() if self._sessions is not None else []
        except Exception:  # noqa: BLE001
            es = []
        return {"total": len(es), "stale": sum(1 for e in es if e.get("stale"))}

    async def tool_status(self, tool: str) -> dict[str, Any]:
        spec = T.TOOLS[tool]
        st = T.tool_state(tool)
        managed = T.using_managed(tool)
        info = await self._probe(tool, T.effective_binary(tool))
        bundled = None
        if managed:
            b = await self._probe(tool, T.configured_binary(tool))
            bundled = {k: b[k] for k in ("path", "version", "method", "error")}
        channel = self._channel(tool)
        lat = self._latest.get(tool) or {}
        tags = lat.get("tags") or {}
        target = channel_target(tags, channel)
        update = is_newer(target, info["version"])
        try:
            plan = self._plan(tool, info, target or "latest")
            upgrade = {"possible": True, "method": plan.method, "in_place": plan.in_place,
                       "switch_to_managed": plan.switch_to_managed, "reason": plan.reason,
                       "command": shlex.join(plan.argv), "prefix": plan.prefix}
        except PlanError as exc:
            upgrade = {"possible": False, "code": exc.code}
        notes = self._notes.get((tool, info["version"], target)) if update else None
        job = self._job if self._job is not None and self._job.tool == tool else self._last.get(tool)
        return {
            "id": tool, "label": spec.label, "package": spec.pkg,
            "installed": {k: info[k] for k in ("binary", "path", "realpath", "version", "raw", "error",
                                               "method", "prefix", "writable", "checked_at")},
            "using_managed": managed, "managed_path": T.managed_binary(tool), "bundled": bundled,
            "managed_installed": os.path.exists(T.managed_binary(tool)),
            "channel": channel, "channels": list(spec.channels),
            "latest": {"version": target, "tags": {c: tags.get(c) for c in spec.channels if tags.get(c)},
                       "checked_at": lat.get("checked_at"), "error": lat.get("error")},
            "update_available": update,
            "notes": {k: notes[k] for k in ("url", "sections", "error")} if notes else None,
            "release_url": T.release_url(spec, target or info["version"]),
            "upgrade": upgrade,
            "previous_version": st.get("previous"),
            "auto_upgrade": bool(st.get("auto_upgrade")),
            "self_update": self._self_update(tool, info),
            "restart": spec.restart,
            "engines": self._engines() if spec.restart == "engine_restart" else None,
            "job": job.to_dict() if job else None,
        }

    async def status(self) -> dict[str, Any]:
        tools = await asyncio.gather(*(self.tool_status(t) for t in T.TOOLS))
        self._kick_check()
        cap = capped_path()
        return {
            "tools": list(tools),
            "running_chats": self.running_chats(),
            "checking": self._check_task is not None and not self._check_task.done(),
            "check_enabled": settings.cli_update_check,
            "ttl_h": settings.cli_check_ttl_h,
            "mem_cap": {"available": cap is not None, "size": settings.cli_upgrade_mem},
            "managed_prefix": T.managed_prefix(),
            "version": self.version,
        }

    # ---- settings ----

    def update_settings(self, tool: str, *, auto_upgrade: bool | None = None, channel: str | None = None,
                        use_managed: bool | None = None) -> None:
        spec = T.TOOLS[tool]
        if channel is not None and channel not in spec.channels:
            raise UpgradeError("invalid_channel", f"channel must be one of {', '.join(spec.channels)}")
        if use_managed and not os.path.exists(T.managed_binary(tool)):
            raise UpgradeError("no_managed_copy", "the app has not installed its own copy yet")
        if use_managed is not None and self._job is not None and self._job.tool == tool and self._job.active:
            raise UpgradeError("busy", "an upgrade of this CLI is in progress", 409)
        T.update_state(tool, auto_upgrade=auto_upgrade, channel=channel, use_managed=use_managed)
        if use_managed is not None:
            self._after_switch(tool)
        self._changed(tool)

    def _after_switch(self, tool: str) -> None:
        if T.TOOLS[tool].restart == "engine_restart" and self._sessions is not None:
            retire = getattr(self._sessions, "retire_engines", None)
            if retire is not None:
                asyncio.ensure_future(retire())

    # ---- upgrade ----

    async def upgrade(self, tool: str, *, version: str | None = None, when: str = "now",
                      reason: str = "manual") -> dict[str, Any]:
        if tool not in T.TOOLS:
            raise UpgradeError("unknown_tool", tool, 404)
        if when not in ("now", "idle"):
            raise UpgradeError("invalid_when", "when must be now or idle")
        if self._job is not None and self._job.active:
            raise UpgradeError("busy", f"an upgrade of {T.TOOLS[self._job.tool].label} is in progress", 409)
        spec = T.TOOLS[tool]
        info = await self._probe(tool, T.effective_binary(tool), fresh=True)
        pin = bool(version) and version not in spec.channels
        if pin:
            assert version is not None
            if not is_exact_version(version):
                raise UpgradeError("invalid_version", "give a version like 1.2.3")
            target = version.strip().lstrip("v")
        else:
            lat = self._latest.get(tool)
            if not lat or not lat.get("tags") or self._stale(tool):
                lat = await self._check_latest(tool)
            target = channel_target(lat.get("tags") or {}, version or self._channel(tool))
            if not target:
                raise UpgradeError("latest_unknown", lat.get("error") or "the latest version is not known", 502)
        if info["version"] and compare_versions(target, info["version"]) == 0:
            raise UpgradeError("up_to_date", f"{spec.label} {target} is already installed", 409)
        if not pin and info["version"] and not is_newer(target, info["version"]):
            raise UpgradeError("up_to_date", f"{spec.label} {info['version']} is not older than {target}", 409)
        try:
            plan = self._plan(tool, info, target)
        except PlanError as exc:
            raise UpgradeError(exc.code, str(exc)) from exc
        job = Job(tool=tool, target=target, from_version=info["version"], when=when,
                  reason="pin" if pin and reason == "manual" else reason, method=plan.method,
                  command=shlex.join(plan.argv), switch_to_managed=plan.switch_to_managed)
        self._job = job
        self._task = asyncio.create_task(self._run(job, plan, info))
        self._changed(tool)
        return job.to_dict()

    async def cancel(self, tool: str) -> dict[str, Any]:
        job = self._job
        if job is None or job.tool != tool or not job.active:
            raise UpgradeError("no_job", "no upgrade is waiting", 404)
        if job.state not in ("queued", "waiting"):
            raise UpgradeError("running", "the upgrade is already running — it can't be stopped halfway safely", 409)
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        return job.to_dict()

    async def _run(self, job: Job, plan: Any, before: dict[str, Any]) -> None:
        loop_started = time.monotonic()  # (reset once it actually starts: waiting for idle not counted)
        prev_managed = T.tool_state(job.tool).get("use_managed")
        try:
            if job.when == "idle" and self.running_chats() > 0:
                job.state = "waiting"
                job.waiting_for = self.running_chats()
                job.add(f"waiting for {job.waiting_for} running chat(s) to finish…")
                self._changed(job.tool)
                if self._idle_evt is None:
                    self._idle_evt = asyncio.Event()

                def on_wait(n: int) -> None:
                    if n != job.waiting_for:
                        job.waiting_for = n
                        self._changed(job.tool)

                await wait_until_idle(self.running_chats, self._idle_evt, on_wait=on_wait)
                job.waiting_for = 0
                job.add("no chat is running — starting")
            job.state = "running"
            loop_started = time.monotonic()
            job.started_at = _iso()
            cap = capped_path()
            argv = capped_argv(plan.argv, cap, settings.cli_upgrade_mem)
            # (inside an existing cap, capped runs it in that one: the outer size applies)
            job.mem_cap = (os.environ.get("CAPPED_MEM") or settings.cli_upgrade_mem) if cap else None
            if plan.switch_to_managed:
                job.add(f"the copy in use ({before['path'] or T.configured_binary(job.tool)}) can't be replaced "
                        f"here ({plan.reason}) — installing the app's own copy in {plan.prefix}")
            job.add("$ " + shlex.join(plan.argv))
            if not cap:
                job.add("(no memory cap here — `capped` needs a systemd user session; running without one)")
            self._changed(job.tool)
            rc = await self._exec(job, argv)
            if rc != 0:
                code = "killed" if rc in (137, -9) else "exit_code"
                raise UpgradeError(code, f"the updater exited with code {rc}")
            job.state = "verifying"
            self._changed(job.tool)
            if plan.switch_to_managed:
                T.update_state(job.tool, use_managed=True)
            after = await self._probe(job.tool, T.effective_binary(job.tool), fresh=True)
            job.add(f"$ {after['path'] or T.effective_binary(job.tool)} --version → {after['raw'] or after['error']}")
            ok = bool(after["version"]) and compare_versions(after["version"], job.target) == 0
            if not ok:
                raise UpgradeError("verify_failed",
                                   f"{after['version'] or 'no version'} after the upgrade (expected {job.target})")
            if job.from_version and job.from_version != after["version"]:
                T.update_state(job.tool, previous=job.from_version)
            job.result = {"version": after["version"], "path": after["path"], "method": after["method"],
                          "seconds": round(time.monotonic() - loop_started, 1)}
            if T.TOOLS[job.tool].restart == "engine_restart" and self._sessions is not None:
                retire = getattr(self._sessions, "retire_engines", None)
                if retire is not None:
                    job.result["engines"] = await retire()
            job.state = "succeeded"
            job.add(f"✓ {T.TOOLS[job.tool].label} {job.from_version or '?'} → {after['version']}")
            if job.reason == "auto":
                T.update_state(job.tool, auto_failed=None)
        except asyncio.CancelledError:
            job.state = "cancelled"
            job.add("cancelled")
        except Exception as exc:  # noqa: BLE001 - reported on the job
            job.state = "failed"
            job.error_code = exc.code if isinstance(exc, UpgradeError) else "error"
            job.error = str(exc)[:500]
            job.add(f"✗ {job.error}")
            if plan.switch_to_managed:
                T.update_state(job.tool, use_managed=prev_managed if prev_managed is not None else False)
            if job.reason == "auto":
                T.update_state(job.tool, auto_failed=job.target)
        finally:
            job.finished_at = _iso()
            self._push_log(job)
            self._installed.clear()
            if self._job is job:
                self._job = None
            self._last[job.tool] = job
            self._log(job)
            self._changed(job.tool)
            if job.reason == "auto" and job.state != "cancelled":
                asyncio.ensure_future(self._auto_upgrade())

    async def _exec(self, job: Job, argv: list[str]) -> int:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env=self._env(), cwd=os.path.expanduser("~"),
            start_new_session=True,
        )
        self._proc = proc
        assert proc.stdout is not None
        rest = ""

        async def pump() -> None:
            nonlocal rest
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.read(8192)
                if not chunk:
                    break
                lines, rest = split_output(rest + chunk.decode("utf-8", "replace"))
                for ln in lines:
                    job.add(ln)
                if lines:
                    self._queue_log(job)
            await proc.wait()

        try:
            await asyncio.wait_for(pump(), timeout=settings.cli_upgrade_timeout_s)
        except asyncio.TimeoutError:
            _signal(proc, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), timeout=10)
            except asyncio.TimeoutError:
                _signal(proc, signal.SIGKILL)
            raise UpgradeError("timeout", f"the updater took longer than {int(settings.cli_upgrade_timeout_s)} s")
        except asyncio.CancelledError:
            _signal(proc, signal.SIGKILL)
            raise
        finally:
            self._proc = None
        if rest.strip():
            job.add(rest.strip())
        return proc.returncode if proc.returncode is not None else -1

    def _log(self, job: Job) -> None:
        if self._logs is None:
            return
        level = {"succeeded": "info", "cancelled": "info"}.get(job.state, "error")
        with contextlib.suppress(Exception):
            self._logs.record(
                level, "system",
                f"CLI upgrade {job.tool} {job.from_version} → {job.target}: {job.state}"
                + (f" ({job.error})" if job.error else ""),
                code=f"cli.upgrade.{job.state}",
                detail={"command": job.command, "log_tail": job.lines[-40:], "result": job.result},
            )

    # ---- automatic upgrades (opt-in per CLI) ----

    async def _auto_upgrade(self) -> None:
        if self._job is not None and self._job.active:
            return
        for tool in T.TOOLS:
            st = T.tool_state(tool)
            if not st.get("auto_upgrade"):
                continue
            info = await self._probe(tool, T.effective_binary(tool))
            target = channel_target((self._latest.get(tool) or {}).get("tags") or {}, self._channel(tool))
            if not target or not is_newer(target, info["version"]) or st.get("auto_failed") == target:
                continue
            try:
                await self.upgrade(tool, when="idle", reason="auto")
                return
            except UpgradeError:
                continue

    async def _auto_loop(self) -> None:
        await asyncio.sleep(60)
        while True:
            try:
                if settings.cli_update_check:
                    await asyncio.gather(*(self._refresh(t, fresh=True) for t in T.TOOLS))
                    self._changed()
                    await self._auto_upgrade()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - keep checking
                pass
            await asyncio.sleep(max(600.0, settings.cli_check_ttl_h * 3600))


def _signal(proc: asyncio.subprocess.Process, sig: signal.Signals) -> None:
    """The updater's whole process group (npm runs install scripts as children)."""
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, sig)


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}
