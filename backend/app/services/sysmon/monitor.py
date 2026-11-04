"""SystemMonitor — the sampler task, live fan-out, history and alerts.

One asyncio task samples every ``monitor_interval_s`` (2 s). The kernel-file
reads run in a worker thread (a /proc read of a process stuck in D-state can
block), everything else is plain bookkeeping:

1. :class:`~.procfs.Collector` reads CPU / memory / PSI / cgroup / disk /
   network / the backend's process tree; :class:`~.gpu.GpuReader` the GPUs.
2. The flat metric dict goes to the ring buffer (live views) and to the
   1-minute aggregate, which is written to SQLite at each minute boundary and
   folded into the 15-minute aggregate (written at each 15-min boundary).
3. :mod:`.events` gauges turn threshold crossings into admin-log rows
   (source ``monitor``) with hysteresis.
4. The full snapshot is JSON-encoded once and handed to every live
   subscriber (``/ws/admin/system``). With nobody watching, nothing is sent.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import platform
import socket
import threading
import time
from collections import deque
from typing import Any

from app.config import settings as default_settings
from app.services._ids import now_iso
from app.services.sysmon.events import Gauges, Transition, Window
from app.services.sysmon.gpu import GpuReader
from app.services.sysmon.procfs import Collector, ProcView, parse_size, read_int
from app.services.sysmon.store import RANGES, RES_1M, RES_15M, Agg, MetricsStore, Ring, bucketize

log = logging.getLogger(__name__)

GB = 1 << 30
MB = 1 << 20
CORE_HISTORY = 150          # per-core heat strip: last 5 min at 2 s
PROC_HISTORY = 150          # per-process RSS sparkline
EVENT_MEMORY = 50           # recent monitor events kept for the live view


def _fmt_bytes(n: float | None) -> str:
    if n is None:
        return "?"
    for unit, size in (("TB", 1 << 40), ("GB", GB), ("MB", MB), ("KB", 1024)):
        if abs(n) >= size:
            return f"{n / size:.1f} {unit}"
    return f"{int(n)} B"


def _fmt_dur(s: float) -> str:
    s = int(max(0, s))
    if s >= 3600:
        return f"{s // 3600}h {s % 3600 // 60}m"
    if s >= 60:
        return f"{s // 60}m {s % 60}s"
    return f"{s}s"


class SystemMonitor:
    def __init__(
        self,
        db: Any,
        logs: Any = None,
        session_service: Any = None,
        *,
        cfg: Any = None,
        collector: Collector | None = None,
        gpu: GpuReader | None = None,
        clock: Any = time.time,
    ) -> None:
        self.cfg = cfg or default_settings
        self.db = db
        self.logs = logs
        self.sessions = session_service
        self.clock = clock
        self.interval = max(0.5, float(self.cfg.monitor_interval_s))
        self.store = MetricsStore(db, keep_1m_days=self.cfg.monitor_keep_1m_days,
                                  keep_15m_days=self.cfg.monitor_keep_15m_days)
        if collector is None and platform.system() != "Linux":
            from .portable import Collector as PortableCollector
            collector = PortableCollector(disk_paths=self._disk_paths())
        self.collector = collector or Collector(disk_paths=self._disk_paths())
        self.gpu = gpu or GpuReader(mode=self.cfg.monitor_gpu, interval_s=self.interval,
                                    cpu_model=self.collector.cpu_model)
        ring_len = int(self.cfg.monitor_ring_minutes * 60 / self.interval)
        self.ring = Ring(ring_len)
        self.cores: deque[bytes] = deque(maxlen=CORE_HISTORY)
        self.proc_hist: dict[str, deque[int]] = {}
        self.events: deque[dict[str, Any]] = deque(maxlen=EVENT_MEMORY)
        self.gauges = Gauges()
        self.swap_window = Window(span=300)
        self.agg_1m, self.agg_15m = Agg(), Agg()
        self.bucket_1m = self.bucket_15m = 0
        self.latest: dict[str, Any] | None = None
        self.started = clock()
        self._task: asyncio.Task | None = None
        self._subs: set[asyncio.Queue] = set()
        self._titles: dict[str, tuple[float, str, str]] = {}
        self._cg_events: dict[str, int] | None = None
        self._last_prune = 0.0
        self._last_cg_max_log = -1e18
        self._state: dict[str, Any] = {}
        self._mu = threading.Lock()   # ring / histories: written by the tick thread, read by requests
        self._rows_cache: dict[int, int] = {RES_1M: 0, RES_15M: 0}
        # Overhead accounting (CPU seconds of the sampler's own work).
        self.cost = {"ticks": 0, "cpu_s": 0.0, "wall_s": 0.0, "push_cpu_s": 0.0, "last_ms": 0.0}
        self.guard = self._detect_guard()
        self.host = {
            "hostname": socket.gethostname(),
            "kernel": platform.release(),
            "cpu_model": self.collector.cpu_model,
            "in_container": self.collector.in_container,
        }

    # ------------------------------------------------------------ config

    def _disk_paths(self) -> list[tuple[str, str]]:
        cfg = self.cfg
        out: list[tuple[str, str]] = []
        if os.path.isdir("/home"):
            out.append(("/home", "/home"))
        out.append(("data", str(cfg.db_file.parent)))
        out.append(("uploads", str(cfg.uploads_root_path)))
        for p in (cfg.monitor_disk_paths or "").split(","):
            p = p.strip()
            if p:
                out.append((p, os.path.expanduser(p)))
        return out

    def _detect_guard(self) -> dict[str, Any] | None:
        """Host memory protections worth drawing on the charts (docs/monitoring.md)."""
        if os.name == "nt":
            return None
        mode = (self.cfg.monitor_guard or "auto").lower()
        if mode == "off":
            return None
        found = None
        for path in ("/usr/local/sbin/memguard", os.path.expanduser("~/server-hardening/memguard.py")):
            if os.path.exists(path):
                found = path
                break
        if found is None and mode == "auto" and not self.cfg.monitor_guard_avail:
            return None
        ceiling = parse_size(self.cfg.monitor_user_ceiling)
        if ceiling is None:
            # Running on the host (not in a container): read the user slice limit.
            ceiling = read_int(f"/sys/fs/cgroup/user.slice/user-{os.getuid()}.slice/memory.max")
        readme = os.path.expanduser("~/server-hardening/README.md")
        return {
            "name": "memguard" if found else "guard",
            "path": found,
            "avail_min": parse_size(self.cfg.monitor_guard_avail or "1.5G"),
            "avail_hard": parse_size(self.cfg.monitor_guard_avail_hard or "600M"),
            "psi_full": float(self.cfg.monitor_guard_psi_full),
            "user_ceiling": ceiling,
            "readme": readme if os.path.exists(readme) else None,
        }

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        if self._task is not None:
            return
        await asyncio.to_thread(self._on_start)
        self.gpu.start()
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        await self.gpu.stop()
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self._on_stop)

    def _on_start(self) -> None:
        now = self.clock()
        self.store.prune(now)
        self._last_prune = now
        # Resume the 15-minute bucket from the 1-minute rows already written.
        self.bucket_1m = int(now // RES_1M * RES_1M)
        self.bucket_15m = int(now // RES_15M * RES_15M)
        for _, n, data in self.store.rows(RES_1M, self.bucket_15m, self.bucket_1m):
            self.agg_15m.merge(data, n)
        # Backend restart / host reboot detection.
        btime = self.collector.cpu().get("btime")
        prev = self.store.get_state("backend")
        if prev:
            down = now - float(prev.get("heartbeat") or prev.get("started") or now)
            detail = {"previous_start": prev.get("started"), "last_heartbeat": prev.get("heartbeat"),
                      "downtime_s": round(down), "previous_pid": prev.get("pid"), "pid": os.getpid()}
            if prev.get("btime") and btime and abs(int(prev["btime"]) - int(btime)) > 5:
                self._log("warning", "restart", "host_reboot",
                          f"Host rebooted — the backend is back after {_fmt_dur(down)}", detail)
            elif prev.get("clean"):
                self._log("info", "restart", "clean",
                          f"Backend restarted (clean shutdown, down {_fmt_dur(down)})", detail)
            else:
                self._log("warning", "restart", "unclean",
                          f"Backend restarted after an unexpected stop (no clean shutdown; last heartbeat "
                          f"{_fmt_dur(down)} before start) — crash, OOM kill or container kill", detail)
        self._state = {"started": now, "pid": os.getpid(), "btime": btime, "heartbeat": now, "clean": False}
        self.store.set_state("backend", self._state)
        self._rows_cache = {RES_1M: self.store.count(RES_1M), RES_15M: self.store.count(RES_15M)}

    def _on_stop(self) -> None:
        self.store.write(RES_1M, self.bucket_1m, self.agg_1m)
        self.agg_15m.absorb(self.agg_1m)
        self.store.write(RES_15M, self.bucket_15m, self.agg_15m)
        self.agg_1m, self.agg_15m = Agg(), Agg()
        self._state.update(heartbeat=self.clock(), clean=True)
        self.store.set_state("backend", self._state)

    async def _loop(self) -> None:
        # Prime the counters so the first published sample has real rates.
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self._tick, self.clock(), [], [], True)
        next_at = time.monotonic() + self.interval
        while True:
            await asyncio.sleep(max(0.0, next_at - time.monotonic()))
            next_at += self.interval
            if next_at < time.monotonic():   # fell behind (suspend, overload): re-anchor
                next_at = time.monotonic() + self.interval
            try:
                engines, runs = self._session_view()
                snap = await asyncio.to_thread(self._tick, self.clock(), engines, runs, False)
                if snap is not None:
                    self._publish(snap)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the sampler must never die
                log.exception("system monitor tick failed")
                await asyncio.sleep(self.interval)

    def _session_view(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Engine + run info, copied on the event loop (those dicts are not thread-safe)."""
        svc = self.sessions
        if svc is None:
            return [], []
        try:
            engines = [dict(e) for e in svc.engines()]
        except Exception:  # noqa: BLE001
            engines = []
        try:
            runs = [dict(r) for r in list(svc.active_runs.values())]
        except Exception:  # noqa: BLE001
            runs = []
        return engines, runs

    # ------------------------------------------------------------ tick

    def _tick(self, now: float, engines: list[dict[str, Any]], runs: list[dict[str, Any]],
              prime: bool) -> dict[str, Any] | None:
        c0, w0 = time.thread_time(), time.perf_counter()
        col = self.collector
        cpu = col.cpu()
        mem = col.memory()
        psi = col.pressure()
        cg, cg_cpu = col.cgroup(now)
        disks = col.disk_usage()
        io = col.disk_io(now)
        net = col.network(now)
        me, kids = col.processes(now, cpu.get("btime"))
        gpus = self.gpu.read()
        if prime:
            return None

        with self._mu:
            procs, zombies = self._classify(now, me, kids, engines, runs)
            m: dict[str, float] = {
                "cpu": cpu["busy"], "cpu_user": cpu["user"], "cpu_system": cpu["system"],
                "cpu_iowait": cpu["iowait"], "cpu_steal": cpu["steal"],
                "load1": cpu["load1"], "load5": cpu["load5"], "load15": cpu["load15"],
                "mem_used": mem["used"], "mem_avail": mem["available"], "mem_cache": mem["cache"],
                "mem_occupied": mem["occupied"], "mem_non_cache": mem["non_cache"], "mem_free": mem["free"],
                "mem_total": mem["total"], "swap_used": mem["swap_used"], "swap_total": mem["swap_total"],
                "disk_read": io["read"], "disk_write": io["write"], "disk_busy": io["busy"],
                "net_rx": net["rx"], "net_tx": net["tx"],
            }
            if psi:
                m["psi_cpu"] = psi.get("cpu", {}).get("some", {}).get("avg10", 0.0)
                m["psi_mem"] = psi.get("memory", {}).get("some", {}).get("avg10", 0.0)
                m["psi_mem_full"] = psi.get("memory", {}).get("full", {}).get("avg10", 0.0)
                m["psi_io"] = psi.get("io", {}).get("some", {}).get("avg10", 0.0)
            if cg is not None:
                if cg.current is not None:
                    m["cg_current"] = cg.current
                if cg.working_set is not None:
                    m["cg_mem"] = cg.working_set
                if cg.max is not None:
                    m["cg_limit"] = cg.max
                if cg_cpu is not None:
                    m["cg_cpu"] = cg_cpu
            if disks:
                m["disk_pct"] = max(d["pct"] for d in disks)
            if me is not None:
                m["be_rss"] = me.rss
                m["be_cpu"] = me.cpu
                m["tree_rss"] = me.rss_tree
            eng = [p for p in procs if p["kind"] == "engine"]
            m["eng_n"] = len(eng)
            m["eng_rss"] = sum(p["rss_tree"] for p in eng)
            m["eng_cpu"] = sum(p["cpu_tree"] for p in eng)
            for g in gpus:
                i = g["index"]
                for key, field in (("util", "util"), ("mem", "mem_used"), ("memt", "mem_total"),
                                   ("temp", "temp"), ("pwr", "power")):
                    if g.get(field) is not None:
                        m[f"g{i}_{key}"] = g[field]

            # History.
            self.ring.append(now, m)
            self.cores.append(bytes(int(min(100, max(0, x))) for x in cpu["cores"]))
            self._roll(now, m)

            snap = {
                "ts": now,
                "interval": self.interval,
                "m": m,
                "cores": [round(x, 1) for x in cpu["cores"]],
                "cpu": {"count": cpu["count"], "model": col.cpu_model, "runnable": cpu["runnable"],
                        "threads": cpu["threads"], "blocked": cpu["procs_blocked"], "btime": cpu["btime"],
                        "quota": cg.cpu_quota if cg else None},
                "mem": mem,
                "cgroup": self._cg_dict(cg),
                "pressure": psi,
                "disks": disks,
                "io": io,
                "net": net,
                "gpus": gpus,
                "gpu_source": self.gpu.source,
                "gpu_error": self.gpu.error,
                "procs": procs,
                "zombies": zombies,
                "runs": runs,
                "engines": engines,
                "host": self.host,
                "guard": self.guard,
                "uptime_s": round(now - self.started),
            }
            new_events = self._evaluate(now, m, snap)
            snap["alerts"] = self._alerts()
            snap["new_events"] = new_events

            cpu_s, wall_s = time.thread_time() - c0, time.perf_counter() - w0
            cost = self.cost
            cost["ticks"] += 1
            cost["cpu_s"] += cpu_s
            cost["wall_s"] += wall_s
            cost["last_ms"] = round(cpu_s * 1000, 2)
            snap["sampler"] = self.sampler_stats()
            self.latest = snap
            return snap

    def sampler_stats(self) -> dict[str, Any]:
        c = self.cost
        n = max(1, c["ticks"])
        return {
            "ticks": c["ticks"],
            "interval_s": self.interval,
            "last_ms": c["last_ms"],
            "avg_cpu_ms": round(c["cpu_s"] / n * 1000, 2),
            "avg_wall_ms": round(c["wall_s"] / n * 1000, 2),
            "push_cpu_ms": round(c["push_cpu_s"] / n * 1000, 2),
            # CPU spent sampling as a share of ONE core.
            "cpu_pct": round((c["cpu_s"] + c["push_cpu_s"]) / n / self.interval * 100, 3),
            "ring": len(self.ring),
            "ring_capacity": self.ring._d.maxlen,  # noqa: SLF001
            "subscribers": len(self._subs),
            "rows_1m": self._rows_cache.get(RES_1M, 0),
            "rows_15m": self._rows_cache.get(RES_15M, 0),
            "gpu_source": self.gpu.source,
        }

    @staticmethod
    def _cg_dict(cg: Any) -> dict[str, Any] | None:
        if cg is None:
            return None
        return {
            "path": cg.path, "version": cg.version, "current": cg.current, "max": cg.max,
            "peak": cg.peak, "working_set": cg.working_set, "anon": cg.anon, "file": cg.file,
            "swap": cg.swap, "events": cg.events, "cpu_quota": cg.cpu_quota,
            "pressure": cg.pressure, "limit_path": cg.limit_path, "limit_max": cg.limit_max,
            "limit_current": cg.limit_current,
        }

    def _roll(self, now: float, m: dict[str, float]) -> None:
        b1 = int(now // RES_1M * RES_1M)
        if b1 != self.bucket_1m and self.agg_1m:
            self.store.write(RES_1M, self.bucket_1m, self.agg_1m)
            self.agg_15m.absorb(self.agg_1m)
            self.agg_1m = Agg()
            if self._state:
                self._state["heartbeat"] = now
                self.store.set_state("backend", self._state)
            self._rows_cache = {RES_1M: self.store.count(RES_1M), RES_15M: self.store.count(RES_15M)}
        self.bucket_1m = b1
        b15 = int(now // RES_15M * RES_15M)
        if b15 != self.bucket_15m:
            if self.agg_15m:
                self.store.write(RES_15M, self.bucket_15m, self.agg_15m)
            self.agg_15m = Agg()
            self.bucket_15m = b15
        self.agg_1m.add(m)
        if now - self._last_prune > 3600:
            self._last_prune = now
            self.store.prune(now)

    # ------------------------------------------------------------ processes

    def _title(self, sid: str) -> tuple[str, str]:
        hit = self._titles.get(sid)
        if hit and time.monotonic() - hit[0] < 60:
            return hit[1], hit[2]
        title, kind = "", "chat"
        with contextlib.suppress(Exception):
            row = self.db.query_one("SELECT title, kind FROM sessions WHERE id = ?", (sid,))
            if row:
                title, kind = row["title"], row["kind"] or "chat"
        self._titles[sid] = (time.monotonic(), title, kind)
        return title, kind

    def _classify(self, now: float, me: ProcView | None, kids: dict[int, ProcView],
                  engines: list[dict[str, Any]], runs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
        procs: list[dict[str, Any]] = []
        run_by_sid = {r.get("session_id"): r for r in runs}
        zombies = me.zombies if me else 0

        def base(v: ProcView, kind: str, key: str) -> dict[str, Any]:
            return {
                "key": key, "kind": kind, "pid": v.pid, "name": v.comm, "cmd": v.cmd, "state": v.state,
                "rss": v.rss, "rss_tree": v.rss_tree, "cpu": round(v.cpu, 1), "cpu_tree": round(v.cpu_tree, 1),
                "threads": v.threads, "nprocs": v.nprocs, "uptime_s": round(now - v.started),
            }

        if me is not None:
            p = base(me, "backend", "backend")
            p["title"] = "Backend (uvicorn)"
            p["rss_tree"] = me.rss   # its children are listed separately
            p["cpu_tree"] = round(me.cpu, 1)
            p["nprocs"] = 1
            procs.append(p)

        claimed: set[int] = set()
        for e in engines:
            v = kids.get(e.get("pid") or -1)
            if v is None:
                continue
            claimed.add(v.pid)
            sid = e.get("session_id") or ""
            title, skind = self._title(sid)
            p = base(v, "engine", f"engine:{sid}")
            run = run_by_sid.get(sid)
            p.update(
                title=title or (run or {}).get("title") or "Claude engine", session_id=sid, session_kind=skind,
                provider="claude", model=e.get("model"), mode=e.get("mode"), account=e.get("account"),
                working=bool(e.get("turn_active")), idle_s=e.get("idle_s"), tasks=e.get("running_tasks") or 0,
                cost_usd=e.get("cost_total_usd"), tools=(run or {}).get("tools"),
            )
            procs.append(p)

        # One-shot CLI turns (Codex, non-persistent Claude): pair the active runs
        # without an engine with unclaimed CLI children, oldest with oldest.
        engine_sids = {e.get("session_id") for e in engines}
        loose_runs = sorted((r for r in runs if r.get("session_id") not in engine_sids),
                            key=lambda r: r.get("started_at") or "")
        others = sorted((v for pid, v in kids.items() if pid not in claimed and v.state != "Z"),
                        key=lambda v: v.started)
        for v in others:
            match = next((r for r in loose_runs if (r.get("provider") or "") in (v.comm + " " + v.cmd)), None)
            if match is not None:
                loose_runs.remove(match)
                sid = match.get("session_id") or ""
                p = base(v, "run", f"run:{sid}")
                p.update(title=match.get("title") or sid, session_id=sid, provider=match.get("provider"),
                         model=match.get("model"), account=match.get("account"), working=True,
                         tools=match.get("tools"))
            else:
                p = base(v, "child", f"pid:{v.pid}")
                p["title"] = _child_label(v)
            procs.append(p)

        # RSS sparklines.
        alive = set()
        for p in procs:
            alive.add(p["key"])
            h = self.proc_hist.get(p["key"])
            if h is None:
                h = self.proc_hist[p["key"]] = deque(maxlen=PROC_HISTORY)
            h.append(int(p["rss_tree"] // MB))
        for k in [k for k in self.proc_hist if k not in alive]:
            del self.proc_hist[k]
        procs.sort(key=lambda p: (p["kind"] != "backend", -p["rss_tree"]))
        return procs, zombies

    # ------------------------------------------------------------ alerts

    def _evaluate(self, now: float, m: dict[str, float], snap: dict[str, Any]) -> list[dict[str, Any]]:
        cfg = self.cfg
        out: list[dict[str, Any]] = []
        sus = max(1, round(6 / self.interval))          # ~6 s above a line before it counts
        clr = max(1, round(30 / self.interval))         # ~30 s below before it clears
        G = self.gauges

        def handle(rule: str, t: Transition | None, fmt: Any, detail: dict[str, Any] | None = None) -> None:
            if t is None or t.kind == "ease":
                return
            if not t.logged:
                return
            level = {"raise": "warning" if t.level == "warn" else "error", "escalate": "error",
                     "clear": "info"}[t.kind]
            msg = fmt(t)
            d = {"transition": t.kind, "level": t.level, "value": _round(t.value), "peak": _round(t.peak),
                 **(detail or {})}
            if t.kind == "clear":
                d["duration_s"] = round(now - t.since)
            ev = self._log(level, rule, t.kind, msg, d)
            if ev:
                out.append(ev)

        # Host memory (% used = (total - available) / total).
        total = m["mem_total"] or 1
        mem_pct = m["mem_used"] * 100 / total
        top = self._top_procs(snap)
        g = G.get("mem", warn=cfg.monitor_mem_warn_pct, crit=cfg.monitor_mem_crit_pct, margin=5,
                  sustain=sus, clear_sustain=clr)
        handle("mem", g.update(mem_pct, now), lambda t: (
            f"Host memory back to normal: {mem_pct:.0f}% used (peak {t.peak:.0f}%, for {_fmt_dur(now - t.since)})"
            if t.kind == "clear" else
            f"Host memory {'critical' if t.level == 'crit' else 'high'}: {mem_pct:.0f}% used "
            f"({_fmt_bytes(m['mem_used'])} of {_fmt_bytes(total)}, {_fmt_bytes(m['mem_avail'])} available)"),
            {"used": m["mem_used"], "available": m["mem_avail"], "total": total, "top": top})

        # memguard's line: it kills a runaway process when available < avail_min.
        guard = self.guard
        if guard and guard.get("avail_min"):
            lim = guard["avail_min"]
            g = G.get("guard", warn=total - lim - GB, crit=total - lim, margin=256 * MB,
                      sustain=sus, clear_sustain=clr)
            handle("guard", g.update(m["mem_used"], now), lambda t: (
                f"Available memory recovered to {_fmt_bytes(m['mem_avail'])} (memguard line {_fmt_bytes(lim)})"
                if t.kind == "clear" else
                f"Available memory {_fmt_bytes(m['mem_avail'])} — "
                + ("below memguard's kill line" if t.level == "crit" else "within 1 GB of memguard's kill line")
                + f" ({_fmt_bytes(lim)}); it will SIGTERM the fastest-growing big process"),
                {"available": m["mem_avail"], "guard_avail_min": lim, "top": top})

        # Container cgroup limit.
        if m.get("cg_limit") and m.get("cg_mem") is not None:
            pct = m["cg_mem"] * 100 / m["cg_limit"]
            g = G.get("cgroup", warn=cfg.monitor_mem_warn_pct, crit=cfg.monitor_mem_crit_pct, margin=5,
                      sustain=sus, clear_sustain=clr)
            handle("cgroup", g.update(pct, now), lambda t: (
                f"Container memory back to {pct:.0f}% of its limit" if t.kind == "clear" else
                f"Container memory at {pct:.0f}% of its {_fmt_bytes(m['cg_limit'])} limit "
                f"({_fmt_bytes(m['cg_mem'])} working set) — the kernel OOM-kills inside it at 100%"),
                {"working_set": m["cg_mem"], "limit": m["cg_limit"], "top": top})

        # Memory pressure (PSI full: every non-idle task stalled on memory).
        if "psi_mem_full" in m:
            g = G.get("psi", warn=cfg.monitor_psi_full_warn, crit=cfg.monitor_psi_full_warn * 4, margin=2,
                      sustain=sus, clear_sustain=clr)
            handle("psi", g.update(m["psi_mem_full"], now), lambda t: (
                f"Memory pressure eased (PSI full {m['psi_mem_full']:.1f}%, peak {t.peak:.1f}%)"
                if t.kind == "clear" else
                f"Memory pressure: all tasks stalled on memory {m['psi_mem_full']:.1f}% of the last 10 s "
                f"(PSI full; some {m.get('psi_mem', 0):.1f}%)"),
                {"psi": snap.get("pressure"), "top": top})

        # Swap: share used, and growth over 5 minutes.
        if m["swap_total"] > 0:
            pct = m["swap_used"] * 100 / m["swap_total"]
            g = G.get("swap", warn=cfg.monitor_swap_warn_pct, crit=95, margin=5, sustain=sus,
                      clear_sustain=clr * 2)
            handle("swap", g.update(pct, now), lambda t: (
                f"Swap use back to {pct:.0f}%" if t.kind == "clear" else
                f"Swap {pct:.0f}% used ({_fmt_bytes(m['swap_used'])} of {_fmt_bytes(m['swap_total'])})"),
                {"swap_used": m["swap_used"], "swap_total": m["swap_total"]})
        self.swap_window.add(now, m["swap_used"])
        growth = self.swap_window.growth()
        thr = cfg.monitor_swap_growth_mb * MB
        g = G.get("swap_growth", warn=thr, crit=thr * 4, margin=thr / 2, sustain=1,
                  clear_sustain=max(1, round(120 / self.interval)), cooldown=1800)
        handle("swap_growth", g.update(growth, now), lambda t: (
            "Swap stopped growing" if t.kind == "clear" else
            f"Swap grew by {_fmt_bytes(growth)} in 5 min (now {_fmt_bytes(m['swap_used'])}) — RAM is short"),
            {"growth": growth, "swap_used": m["swap_used"], "top": top})

        # Disks.
        alive = set()
        for d in snap["disks"]:
            key = f"disk:{d['label']}"
            alive.add(key)
            g = G.get(key, warn=cfg.monitor_disk_warn_pct, crit=cfg.monitor_disk_crit_pct, margin=1,
                      sustain=1, clear_sustain=3)
            handle("disk", g.update(d["pct"], now), lambda t, d=d: (
                f"Disk {d['label']} back to {d['pct']:.0f}% used" if t.kind == "clear" else
                f"Disk {d['label']} {'almost full' if t.level == 'crit' else 'filling up'}: {d['pct']:.0f}% used, "
                f"{_fmt_bytes(d['free'])} free"),
                {"path": d["path"], "free": d["free"], "total": d["total"]})
        G.drop_missing("disk:", alive)

        # Engines over N GB (tree RSS: the CLI + its shells / MCP servers).
        alive = set()
        lim = cfg.monitor_engine_rss_gb * GB
        for p in snap["procs"]:
            if p["kind"] not in ("engine", "run"):
                continue
            key = f"engine:{p['key']}"
            alive.add(key)
            g = G.get(key, warn=lim, crit=lim * 2, margin=lim * 0.1, sustain=sus, clear_sustain=clr)
            handle("engine", g.update(p["rss_tree"], now), lambda t, p=p: (
                f"Engine for “{p.get('title')}” back to {_fmt_bytes(p['rss_tree'])}" if t.kind == "clear" else
                f"Engine for “{p.get('title')}” uses {_fmt_bytes(p['rss_tree'])} RSS "
                f"({p['nprocs']} processes, pid {p['pid']})"),
                {"pid": p["pid"], "session_id": p.get("session_id"), "rss_tree": p["rss_tree"],
                 "nprocs": p["nprocs"], "model": p.get("model")})
        G.drop_missing("engine:", alive)

        # CPU saturated for a sustained period.
        g = G.get("cpu", warn=cfg.monitor_cpu_sat_pct, crit=None, margin=10,
                  sustain=max(1, round(cfg.monitor_cpu_sat_s / self.interval)), clear_sustain=clr)
        handle("cpu", g.update(m["cpu"], now), lambda t: (
            f"CPU no longer saturated ({m['cpu']:.0f}%, was saturated for {_fmt_dur(now - t.since)})"
            if t.kind == "clear" else
            f"CPU saturated: {m['cpu']:.0f}% busy for over {_fmt_dur(cfg.monitor_cpu_sat_s)} "
            f"(load {m['load1']:.1f} on {snap['cpu']['count']} cores)"),
            {"load1": m["load1"], "cores": snap["cpu"]["count"], "top": self._top_procs(snap, by="cpu_tree")})

        # GPUs.
        alive = set()
        for gp in snap["gpus"]:
            i = gp["index"]
            if gp.get("temp") is not None:
                key = f"gpu{i}:temp"
                alive.add(key)
                g = G.get(key, warn=cfg.monitor_gpu_temp_c, crit=cfg.monitor_gpu_temp_c + 7, margin=5,
                          sustain=sus, clear_sustain=clr)
                handle("gpu_temp", g.update(gp["temp"], now), lambda t, gp=gp: (
                    f"GPU {gp['index']} cooled to {gp['temp']:.0f}°C" if t.kind == "clear" else
                    f"GPU {gp['index']} ({gp['name']}) over temperature: {gp['temp']:.0f}°C"), {"gpu": gp})
            if gp.get("mem_used") is not None and gp.get("mem_total"):
                key = f"gpu{i}:mem"
                alive.add(key)
                pct = gp["mem_used"] * 100 / gp["mem_total"]
                g = G.get(key, warn=95, crit=None, margin=3, sustain=sus, clear_sustain=clr)
                handle("gpu_mem", g.update(pct, now), lambda t, gp=gp, pct=pct: (
                    f"GPU {gp['index']} memory back to {pct:.0f}%" if t.kind == "clear" else
                    f"GPU {gp['index']} memory {pct:.0f}% full ({_fmt_bytes(gp['mem_used'])})"), {"gpu": gp})
        G.drop_missing("gpu", alive)

        # Zombie (defunct) children piling up: nobody reaps them (no init in the container?).
        g = G.get("zombies", warn=cfg.monitor_zombie_warn, crit=None, margin=max(1, cfg.monitor_zombie_warn // 5),
                  sustain=1, clear_sustain=clr)
        handle("zombies", g.update(float(snap["zombies"]), now), lambda t: (
            f"Zombie processes cleared ({snap['zombies']})" if t.kind == "clear" else
            f"{snap['zombies']} zombie (defunct) child processes are piling up — nothing reaps them "
            "(run the container with an init, e.g. compose `init: true`)"), {"zombies": snap["zombies"]})

        # cgroup memory.events: OOM kills and limit hits are one-off events.
        cg = snap.get("cgroup") or {}
        ev = cg.get("events") or {}
        if self._cg_events is not None:
            killed = ev.get("oom_kill", 0) - self._cg_events.get("oom_kill", 0)
            if killed > 0:
                e = self._log("error", "oom", "kill",
                              f"OOM killer ended {killed} process(es) in the backend's cgroup "
                              f"({cg.get('path')})", {"events": ev, "top": top})
                if e:
                    out.append(e)
            hit = ev.get("max", 0) - self._cg_events.get("max", 0)
            if hit > 0 and now - self._last_cg_max_log > 600:
                self._last_cg_max_log = now
                e = self._log("warning", "cgroup", "limit_hit",
                              f"The backend's cgroup hit its memory limit {hit} time(s) — reclaiming / throttling",
                              {"events": ev, "top": top})
                if e:
                    out.append(e)
        self._cg_events = dict(ev)
        return out

    def _alerts(self) -> list[dict[str, Any]]:
        return self.gauges.active()

    @staticmethod
    def _top_procs(snap: dict[str, Any], by: str = "rss_tree", n: int = 5) -> list[dict[str, Any]]:
        procs = sorted(snap["procs"], key=lambda p: -p.get(by, 0))[:n]
        return [{"pid": p["pid"], "title": p.get("title"), "kind": p["kind"], "rss_tree": p["rss_tree"],
                 "cpu_tree": p["cpu_tree"]} for p in procs]

    def _log(self, level: str, rule: str, kind: str, message: str, detail: dict[str, Any]) -> dict[str, Any] | None:
        code = f"monitor.{rule}.{kind}"
        ev = {"id": None, "ts": now_iso(),
              "level": level, "source": "monitor", "code": code, "message": message}
        if self.logs is not None:
            ev["id"] = self.logs.record(level, "monitor", message, code=code, detail=detail)
        self.events.append(ev)
        return ev

    # ------------------------------------------------------------ live fan-out

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=4)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    @property
    def subscribers(self) -> int:
        return len(self._subs)

    def _publish(self, snap: dict[str, Any]) -> None:
        if not self._subs:
            return
        c0 = time.thread_time()
        msgs = [json.dumps({"type": "sample", "data": _public(snap)}, separators=(",", ":"), default=str)]
        for ev in snap.get("new_events") or []:
            msgs.append(json.dumps({"type": "event", "data": ev}, default=str))
        for q in list(self._subs):
            for msg in msgs:
                if q.full():  # a slow client: drop its oldest, keep it current
                    with contextlib.suppress(asyncio.QueueEmpty):
                        q.get_nowait()
                q.put_nowait(msg)
        self.cost["push_cpu_s"] += time.thread_time() - c0

    def hello(self) -> dict[str, Any]:
        """What a newly-opened live view needs: the latest snapshot plus the
        recent history (so the charts start full, not empty)."""
        now = self.clock()
        with self._mu:
            return self._hello(now)

    def _hello(self, now: float) -> dict[str, Any]:
        return {
            "now": _public(self.latest) if self.latest else None,
            "ring": self.ring.columnar(now - 900),
            "cores": [list(b) for b in self.cores],
            "proc_hist": {k: list(v) for k, v in self.proc_hist.items()},
            "events": list(self.events),
            "ranges": list(RANGES),
            "thresholds": self.thresholds(),
        }

    def thresholds(self) -> dict[str, Any]:
        c = self.cfg
        return {
            "mem_warn": c.monitor_mem_warn_pct, "mem_crit": c.monitor_mem_crit_pct,
            "disk_warn": c.monitor_disk_warn_pct, "disk_crit": c.monitor_disk_crit_pct,
            "engine_rss": c.monitor_engine_rss_gb * GB, "cpu_sat": c.monitor_cpu_sat_pct,
            "cpu_sat_s": c.monitor_cpu_sat_s, "gpu_temp": c.monitor_gpu_temp_c,
            "swap_growth": c.monitor_swap_growth_mb * MB, "swap_warn": c.monitor_swap_warn_pct,
            "psi_full_warn": c.monitor_psi_full_warn,
        }

    # ------------------------------------------------------------ history API

    def series(self, range_: str) -> dict[str, Any]:
        if range_ not in RANGES:
            raise KeyError(range_)
        with self._mu:
            return self._series(range_)

    def _series(self, range_: str) -> dict[str, Any]:
        src, span, step = RANGES[range_]
        now = self.clock()
        since = now - span
        if src == "ring":
            out = self.ring.columnar(since)
            out.update(range=range_, source="live", step=self.interval)
        else:
            res = int(src)
            rows = self.store.rows(res, since - res)
            extra = [(self.bucket_1m, self.agg_1m)]
            if res == RES_15M:
                partial = Agg()
                partial.absorb(self.agg_15m)
                partial.absorb(self.agg_1m)
                extra = [(self.bucket_15m, partial)]
            out = bucketize(rows, step, extra)
            out.update(range=range_, source=f"{res // 60}m", step=step)
        out.update(**{"from": since, "to": now})
        out["events"] = self._events_between(since)
        return out

    def _events_between(self, since: float) -> list[dict[str, Any]]:
        iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(since))
        try:
            rows = self.db.query(
                "SELECT id, ts, level, code, message FROM error_logs WHERE source = 'monitor' AND ts >= ? "
                "ORDER BY id DESC LIMIT 200", (iso,))
        except Exception:  # noqa: BLE001
            return []
        return [dict(r) for r in reversed(rows)]


def _child_label(v: ProcView) -> str:
    cmd = v.cmd
    if "mate" in cmd and "bridge" in cmd:
        return "Mate MCP bridge"
    if v.comm in ("claude", "node") and "claude" in cmd:
        return "Claude CLI"
    if "codex" in cmd:
        return "Codex CLI"
    return v.comm


def _round(v: float) -> float:
    return round(v, 2) if isinstance(v, float) else v


def _public(snap: dict[str, Any] | None) -> dict[str, Any] | None:
    if snap is None:
        return None
    return {k: v for k, v in snap.items() if k != "new_events"}
