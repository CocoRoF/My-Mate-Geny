"""Kernel-file parsers and the per-tick collector.

Everything here reads plain text from ``/proc``, ``/sys`` and the cgroup
filesystem — no psutil. Parsers are pure functions over the file's text so
the tests can feed them fixtures; the :class:`Collector` keeps the previous
counters to turn cumulative ones (CPU ticks, bytes, sectors) into rates.

What a Docker container sees (the deployed backend): ``/proc/stat``,
``/proc/meminfo``, ``/proc/loadavg``, ``/proc/diskstats`` and
``/proc/pressure/*`` are host-wide; ``/proc/net/dev`` is the container's own
network namespace; ``/sys/fs/cgroup`` is the container's cgroup.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
PAGE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
SECTOR = 512

# ---------------------------------------------------------------- helpers


def read_text(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def read_int(path: str) -> int | None:
    raw = read_text(path)
    if raw is None:
        return None
    raw = raw.strip()
    if not raw or raw == "max":
        return None
    try:
        return int(raw.split()[0])
    except ValueError:
        return None


_SIZE_RE = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*([kmgt]?)i?b?\s*$", re.I)


def parse_size(text: str | None) -> int | None:
    """'1.5G' / '600M' / '2048' -> bytes (binary units)."""
    if not text:
        return None
    m = _SIZE_RE.match(str(text))
    if not m:
        return None
    mult = {"": 1, "k": 1 << 10, "m": 1 << 20, "g": 1 << 30, "t": 1 << 40}[m.group(2).lower()]
    return int(float(m.group(1)) * mult)


# ---------------------------------------------------------------- CPU


@dataclass
class CpuTimes:
    user: int = 0      # user + nice
    system: int = 0    # system + irq + softirq
    idle: int = 0
    iowait: int = 0
    steal: int = 0

    @property
    def total(self) -> int:
        return self.user + self.system + self.idle + self.iowait + self.steal


def _cpu_line(parts: list[str]) -> CpuTimes:
    v = [int(x) for x in parts[1:]] + [0] * 10
    user, nice, system, idle, iowait, irq, softirq, steal = v[:8]
    # guest/guest_nice are already included in user/nice.
    return CpuTimes(user=user + nice, system=system + irq + softirq, idle=idle, iowait=iowait, steal=steal)


def parse_proc_stat(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {"total": CpuTimes(), "cores": [], "btime": None,
                           "procs_running": None, "procs_blocked": None, "ctxt": None}
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        key = parts[0]
        if key == "cpu":
            out["total"] = _cpu_line(parts)
        elif key.startswith("cpu") and key[3:].isdigit():
            out["cores"].append(_cpu_line(parts))
        elif key == "btime":
            out["btime"] = int(parts[1])
        elif key == "procs_running":
            out["procs_running"] = int(parts[1])
        elif key == "procs_blocked":
            out["procs_blocked"] = int(parts[1])
        elif key == "ctxt":
            out["ctxt"] = int(parts[1])
    return out


def cpu_percent(prev: CpuTimes, cur: CpuTimes) -> dict[str, float]:
    """Share of wall time per state between two readings (0-100). ``busy`` is
    user + system + steal; iowait is idle time waiting on disk, kept apart."""
    dt = cur.total - prev.total
    if dt <= 0:
        return {"busy": 0.0, "user": 0.0, "system": 0.0, "iowait": 0.0, "steal": 0.0}

    def pct(a: int, b: int) -> float:
        return max(0.0, min(100.0, (a - b) * 100.0 / dt))

    user, system = pct(cur.user, prev.user), pct(cur.system, prev.system)
    steal, iowait = pct(cur.steal, prev.steal), pct(cur.iowait, prev.iowait)
    return {"busy": min(100.0, user + system + steal), "user": user, "system": system,
            "iowait": iowait, "steal": steal}


def parse_loadavg(text: str) -> dict[str, Any]:
    parts = text.split()
    running, _, total = parts[3].partition("/")
    return {"load1": float(parts[0]), "load5": float(parts[1]), "load15": float(parts[2]),
            "runnable": int(running), "threads": int(total)}


def cpu_model(proc: str = "/proc") -> str:
    for line in (read_text(f"{proc}/cpuinfo") or "").splitlines():
        if line.startswith(("model name", "Model", "Hardware")):
            return line.split(":", 1)[1].strip()
    return ""


# ---------------------------------------------------------------- memory


def parse_meminfo(text: str) -> dict[str, int]:
    """Bytes per field (the kernel prints kB)."""
    out: dict[str, int] = {}
    for line in text.splitlines():
        name, _, rest = line.partition(":")
        parts = rest.split()
        if not parts:
            continue
        try:
            n = int(parts[0])
        except ValueError:
            continue
        out[name.strip()] = n * 1024 if len(parts) > 1 and parts[1] == "kB" else n
    return out


def memory_summary(mi: dict[str, int]) -> dict[str, int]:
    total = mi.get("MemTotal", 0)
    free = mi.get("MemFree", 0)
    avail = mi.get("MemAvailable")
    if avail is None:  # pre-3.14 kernels
        avail = free + mi.get("Buffers", 0) + mi.get("Cached", 0)
    # Page cache the kernel can drop (htop's definition).
    cache = mi.get("Buffers", 0) + mi.get("Cached", 0) + mi.get("SReclaimable", 0) - mi.get("Shmem", 0)
    swap_total = mi.get("SwapTotal", 0)
    return {
        "total": total,
        "available": avail,
        "used": max(0, total - avail),
        "free": free,
        "cache": max(0, cache),
        "shmem": mi.get("Shmem", 0),
        "dirty": mi.get("Dirty", 0),
        "swap_total": swap_total,
        "swap_used": max(0, swap_total - mi.get("SwapFree", 0)),
        "swap_cached": mi.get("SwapCached", 0),
    }


def parse_pressure(text: str | None) -> dict[str, dict[str, float]] | None:
    """PSI (``/proc/pressure/*`` or ``<cgroup>/*.pressure``)."""
    if not text:
        return None
    out: dict[str, dict[str, float]] = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts or parts[0] not in ("some", "full"):
            continue
        vals: dict[str, float] = {}
        for kv in parts[1:]:
            k, _, v = kv.partition("=")
            try:
                vals[k] = float(v)
            except ValueError:
                pass
        out[parts[0]] = vals
    return out or None


# ---------------------------------------------------------------- cgroup


def parse_flat_keyed(text: str | None) -> dict[str, int]:
    """``key value`` lines (memory.stat, memory.events, cpu.stat)."""
    out: dict[str, int] = {}
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            try:
                out[parts[0]] = int(parts[1])
            except ValueError:
                pass
    return out


def own_cgroup_path(proc: str = "/proc", pid: str = "self") -> str | None:
    """The v2 path of a process's cgroup (``0::/path``), or None on v1-only."""
    for line in (read_text(f"{proc}/{pid}/cgroup") or "").splitlines():
        if line.startswith("0::"):
            return line[3:].strip() or "/"
    return None


@dataclass
class CgroupInfo:
    path: str
    version: int
    current: int | None = None
    max: int | None = None           # None = unlimited
    peak: int | None = None
    working_set: int | None = None   # current - inactive_file (what OOM decisions see)
    anon: int | None = None
    file: int | None = None
    swap: int | None = None
    events: dict[str, int] = field(default_factory=dict)  # oom, oom_kill, max, high
    cpu_usage_us: int | None = None
    cpu_quota: float | None = None   # cores, None = unlimited
    pressure: dict[str, Any] | None = None
    limit_path: str | None = None    # nearest ancestor with a memory.max (incl. itself)
    limit_max: int | None = None
    limit_current: int | None = None


def read_cgroup_v2(root: str, rel: str) -> CgroupInfo:
    base = os.path.join(root, rel.lstrip("/")) if rel not in ("", "/") else root
    info = CgroupInfo(path=rel or "/", version=2)
    info.current = read_int(f"{base}/memory.current")
    info.max = read_int(f"{base}/memory.max")
    info.peak = read_int(f"{base}/memory.peak")
    info.swap = read_int(f"{base}/memory.swap.current")
    stat = parse_flat_keyed(read_text(f"{base}/memory.stat"))
    info.anon = stat.get("anon")
    info.file = stat.get("file")
    if info.current is not None:
        info.working_set = max(0, info.current - stat.get("inactive_file", 0))
    info.events = parse_flat_keyed(read_text(f"{base}/memory.events"))
    cpu = parse_flat_keyed(read_text(f"{base}/cpu.stat"))
    info.cpu_usage_us = cpu.get("usage_usec")
    quota = (read_text(f"{base}/cpu.max") or "").split()
    if len(quota) == 2 and quota[0] != "max":
        try:
            info.cpu_quota = int(quota[0]) / int(quota[1])
        except (ValueError, ZeroDivisionError):
            pass
    mp = parse_pressure(read_text(f"{base}/memory.pressure"))
    if mp:
        info.pressure = {"memory": mp}
    # The limit that actually binds may sit on an ancestor (e.g. a user slice).
    probe = rel
    while True:
        b = os.path.join(root, probe.lstrip("/")) if probe not in ("", "/") else root
        mx = read_int(f"{b}/memory.max")
        if mx is not None:
            info.limit_path, info.limit_max = probe or "/", mx
            info.limit_current = read_int(f"{b}/memory.current")
            break
        if probe in ("", "/"):
            break
        probe = os.path.dirname(probe.rstrip("/")) or "/"
    return info


def read_cgroup_v1(root: str) -> CgroupInfo | None:
    mem = os.path.join(root, "memory")
    usage = read_int(f"{mem}/memory.usage_in_bytes")
    if usage is None:
        return None
    info = CgroupInfo(path="/", version=1, current=usage)
    limit = read_int(f"{mem}/memory.limit_in_bytes")
    info.max = limit if limit is not None and limit < (1 << 60) else None
    info.peak = read_int(f"{mem}/memory.max_usage_in_bytes")
    stat = parse_flat_keyed(read_text(f"{mem}/memory.stat"))
    info.anon = stat.get("rss")
    info.file = stat.get("cache")
    info.working_set = max(0, usage - stat.get("total_inactive_file", stat.get("inactive_file", 0)))
    oom = parse_flat_keyed(read_text(f"{mem}/memory.oom_control"))
    if "oom_kill" in oom:
        info.events = {"oom_kill": oom["oom_kill"]}
    cpuacct = read_int(os.path.join(root, "cpuacct", "cpuacct.usage"))
    info.cpu_usage_us = cpuacct // 1000 if cpuacct is not None else None
    info.limit_path, info.limit_max, info.limit_current = ("/", info.max, usage) if info.max else (None, None, None)
    return info


# ---------------------------------------------------------------- disk + net


def parse_diskstats(text: str) -> dict[str, tuple[int, int, int]]:
    """device -> (sectors read, sectors written, ms doing I/O)."""
    out: dict[str, tuple[int, int, int]] = {}
    for line in text.splitlines():
        p = line.split()
        if len(p) < 14:
            continue
        try:
            out[p[2]] = (int(p[5]), int(p[9]), int(p[12]))
        except ValueError:
            continue
    return out


_VIRTUAL_DISK = re.compile(r"^(loop|ram|zram|fd|sr|dm-|md|nbd)")


def physical_disks(sys: str = "/sys") -> list[str]:
    """Whole block devices (no partitions, loops or device-mapper)."""
    try:
        names = os.listdir(f"{sys}/block")
    except OSError:
        return []
    return sorted(n for n in names if not _VIRTUAL_DISK.match(n))


def parse_net_dev(text: str) -> dict[str, tuple[int, int]]:
    """iface -> (rx bytes, tx bytes)."""
    out: dict[str, tuple[int, int]] = {}
    for line in text.splitlines()[2:]:
        name, _, rest = line.partition(":")
        p = rest.split()
        if len(p) >= 9:
            try:
                out[name.strip()] = (int(p[0]), int(p[8]))
            except ValueError:
                continue
    return out


_VIRTUAL_NET = re.compile(r"^(lo|veth|docker|br-|virbr|cni|flannel|tun|tap)")


# ---------------------------------------------------------------- processes


@dataclass
class PidStat:
    pid: int
    comm: str
    state: str
    ppid: int
    ticks: int        # utime + stime
    start: int        # starttime (clock ticks since boot)
    threads: int
    rss: int          # bytes


def parse_pid_stat(text: str) -> PidStat | None:
    """``/proc/<pid>/stat`` — comm may contain spaces and parentheses."""
    try:
        head, _, tail = text.rpartition(")")
        pid_s, _, comm = head.partition(" (")
        f = tail.split()
        # f[0] = state (field 3); fields are 1-based in proc(5).
        return PidStat(
            pid=int(pid_s), comm=comm, state=f[0], ppid=int(f[1]),
            ticks=int(f[11]) + int(f[12]), threads=int(f[17]), start=int(f[19]),
            rss=int(f[21]) * PAGE,
        )
    except (ValueError, IndexError):
        return None


@dataclass
class ProcView:
    pid: int
    comm: str
    state: str
    cmd: str
    rss: int
    rss_tree: int
    cpu: float          # % of one core (top-style, can exceed 100)
    cpu_tree: float
    threads: int
    nprocs: int         # processes in the tree (itself + descendants)
    started: float      # epoch seconds
    zombies: int = 0


class Collector:
    """Reads everything once per tick and keeps the counters for rates."""

    def __init__(
        self,
        *,
        proc: str = "/proc",
        sys: str = "/sys",
        cgroup_root: str = "/sys/fs/cgroup",
        disk_paths: list[tuple[str, str]] | None = None,
        self_pid: int | None = None,
    ) -> None:
        self.proc, self.sys, self.cgroup_root = proc, sys, cgroup_root
        self.disk_paths = disk_paths or []
        self.self_pid = self_pid or os.getpid()
        self._prev_cpu: tuple[CpuTimes, list[CpuTimes]] | None = None
        self._prev_disk: tuple[float, dict[str, tuple[int, int, int]]] | None = None
        self._prev_net: tuple[float, dict[str, tuple[int, int]]] | None = None
        self._prev_ticks: dict[tuple[int, int], tuple[float, int]] = {}
        self._prev_cg_cpu: tuple[float, int] | None = None
        self._disks = physical_disks(sys)
        self._cg_rel = own_cgroup_path(proc, str(self.self_pid) if self_pid else "self")
        self._has_children_file: bool | None = None
        self._cmds: dict[tuple[int, int], str] = {}
        self.cpu_model = cpu_model(proc)
        self.in_container = os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")

    # -- cpu

    def cpu(self) -> dict[str, Any]:
        st = parse_proc_stat(read_text(f"{self.proc}/stat") or "")
        total, cores = st["total"], st["cores"]
        prev = self._prev_cpu
        self._prev_cpu = (total, cores)
        if prev is None:
            pct = {"busy": 0.0, "user": 0.0, "system": 0.0, "iowait": 0.0, "steal": 0.0}
            core_pct: list[float] = [0.0] * len(cores)
        else:
            pct = cpu_percent(prev[0], total)
            core_pct = [cpu_percent(p, c)["busy"] for p, c in zip(prev[1], cores)]
        load = parse_loadavg(read_text(f"{self.proc}/loadavg") or "0 0 0 0/0 0")
        return {**pct, "cores": core_pct, "count": len(cores), "btime": st["btime"],
                "procs_blocked": st["procs_blocked"], **load, "first": prev is None}

    # -- memory

    def memory(self) -> dict[str, int]:
        return memory_summary(parse_meminfo(read_text(f"{self.proc}/meminfo") or ""))

    def pressure(self) -> dict[str, Any] | None:
        out = {}
        for res in ("cpu", "memory", "io"):
            p = parse_pressure(read_text(f"{self.proc}/pressure/{res}"))
            if p:
                out[res] = p
        return out or None

    def cgroup(self, now: float) -> tuple[CgroupInfo | None, float | None]:
        if self._cg_rel is not None and os.path.exists(f"{self.cgroup_root}/cgroup.controllers"):
            info: CgroupInfo | None = read_cgroup_v2(self.cgroup_root, self._cg_rel)
        else:
            info = read_cgroup_v1(self.cgroup_root)
        cpu_pct = None
        if info is not None and info.cpu_usage_us is not None:
            prev = self._prev_cg_cpu
            self._prev_cg_cpu = (now, info.cpu_usage_us)
            if prev is not None and now > prev[0]:
                cpu_pct = max(0.0, (info.cpu_usage_us - prev[1]) / 1e6 / (now - prev[0]) * 100)
        return info, cpu_pct

    # -- disk

    def disk_usage(self) -> list[dict[str, Any]]:
        out, seen = [], set()
        for label, path in self.disk_paths:
            try:
                st = os.statvfs(path)
                dev = os.stat(path).st_dev
            except OSError:
                continue
            if dev in seen:
                continue
            seen.add(dev)
            total = st.f_blocks * st.f_frsize
            free = st.f_bavail * st.f_frsize
            used = total - st.f_bfree * st.f_frsize
            out.append({"label": label, "path": path, "total": total, "used": used, "free": free,
                        "pct": round(used * 100.0 / (used + free), 2) if used + free else 0.0})
        return out

    def disk_io(self, now: float) -> dict[str, float]:
        stats = parse_diskstats(read_text(f"{self.proc}/diskstats") or "")
        disks = {d: stats[d] for d in self._disks if d in stats} or {
            d: v for d, v in stats.items() if not _VIRTUAL_DISK.match(d) and not re.search(r"\d+p?\d+$", d)
        }
        prev = self._prev_disk
        self._prev_disk = (now, disks)
        if prev is None or now <= prev[0]:
            return {"read": 0.0, "write": 0.0, "busy": 0.0}
        dt = now - prev[0]
        rd = wr = 0
        busy = 0.0
        for d, (r, w, ms) in disks.items():
            p = prev[1].get(d)
            if p is None:
                continue
            rd += max(0, r - p[0])
            wr += max(0, w - p[1])
            busy = max(busy, min(100.0, max(0, ms - p[2]) / (dt * 10)))
        return {"read": rd * SECTOR / dt, "write": wr * SECTOR / dt, "busy": busy}

    # -- network

    def network(self, now: float) -> dict[str, Any]:
        ifaces = {k: v for k, v in parse_net_dev(read_text(f"{self.proc}/net/dev") or "").items()
                  if not _VIRTUAL_NET.match(k)}
        prev = self._prev_net
        self._prev_net = (now, ifaces)
        rx = tx = 0.0
        if prev is not None and now > prev[0]:
            dt = now - prev[0]
            for k, (r, t) in ifaces.items():
                p = prev[1].get(k)
                if p is not None:
                    rx += max(0, r - p[0]) / dt
                    tx += max(0, t - p[1]) / dt
        return {"rx": rx, "tx": tx, "ifaces": sorted(ifaces),
                "rx_total": sum(v[0] for v in ifaces.values()), "tx_total": sum(v[1] for v in ifaces.values())}

    # -- processes

    def _children(self, pid: int) -> list[int] | None:
        """Direct children via /proc/<pid>/task/*/children (every thread: a
        child spawned from a worker thread is listed under that thread)."""
        if self._has_children_file is False:
            return None
        try:
            tids = os.listdir(f"{self.proc}/{pid}/task")
        except OSError:
            return []
        kids: list[int] = []
        found = False
        for tid in tids:
            raw = read_text(f"{self.proc}/{pid}/task/{tid}/children")
            if raw is None:
                continue
            found = True
            kids.extend(int(x) for x in raw.split())
        if not found and self._has_children_file is None and tids:
            self._has_children_file = False
            return None
        self._has_children_file = True
        return kids

    def _scan_ppids(self) -> dict[int, list[int]]:
        tree: dict[int, list[int]] = {}
        for name in os.listdir(self.proc):
            if not name.isdigit():
                continue
            st = parse_pid_stat(read_text(f"{self.proc}/{name}/stat") or "")
            if st is not None:
                tree.setdefault(st.ppid, []).append(st.pid)
        return tree

    def processes(self, now: float, btime: int | None) -> tuple[ProcView | None, dict[int, ProcView]]:
        """The backend itself and each of its direct children, every one with
        its whole subtree aggregated (an engine + its shells, MCP servers…)."""
        ppid_map: dict[int, list[int]] | None = None

        def children(pid: int) -> list[int]:
            nonlocal ppid_map
            kids = self._children(pid)
            if kids is None:
                if ppid_map is None:
                    ppid_map = self._scan_ppids()
                kids = ppid_map.get(pid, [])
            return kids

        stats: dict[int, PidStat] = {}
        seen_keys: set[tuple[int, int]] = set()

        def stat(pid: int) -> PidStat | None:
            if pid not in stats:
                s = parse_pid_stat(read_text(f"{self.proc}/{pid}/stat") or "")
                if s is None:
                    return None
                stats[pid] = s
            return stats[pid]

        def cpu_of(s: PidStat) -> float:
            key = (s.pid, s.start)
            seen_keys.add(key)
            prev = self._prev_ticks.get(key)
            self._prev_ticks[key] = (now, s.ticks)
            if prev is None or now <= prev[0]:
                return 0.0
            return max(0.0, (s.ticks - prev[1]) / CLK_TCK / (now - prev[0]) * 100)

        def view(pid: int, *, recurse: bool = True) -> ProcView | None:
            s = stat(pid)
            if s is None:
                return None
            own_cpu = cpu_of(s)
            rss_tree, cpu_tree, n, zombies = s.rss, own_cpu, 1, 0
            if recurse:
                stack = list(children(pid))
                guard = 0
                while stack and guard < 5000:
                    guard += 1
                    c = stack.pop()
                    cs = stat(c)
                    if cs is None:
                        continue
                    n += 1
                    if cs.state == "Z":
                        zombies += 1
                        continue
                    rss_tree += cs.rss
                    cpu_tree += cpu_of(cs)
                    stack.extend(children(c))
            started = (btime + s.start / CLK_TCK) if btime else now
            return ProcView(
                pid=pid, comm=s.comm, state=s.state, cmd=self._cmd(pid, s),
                rss=s.rss, rss_tree=rss_tree, cpu=own_cpu, cpu_tree=cpu_tree, threads=s.threads,
                nprocs=n, started=started, zombies=zombies,
            )

        me = view(self.self_pid, recurse=False)
        kids: dict[int, ProcView] = {}
        zombies_direct = 0
        for c in children(self.self_pid):
            s = stat(c)
            if s is None:
                continue
            if s.state == "Z":   # defunct: counted, not listed (nothing else to read)
                zombies_direct += 1
                continue
            v = view(c)
            if v is not None:
                kids[c] = v
        if me is not None:
            me.zombies = zombies_direct + sum(v.zombies for v in kids.values())
            me.nprocs = 1 + zombies_direct + sum(v.nprocs for v in kids.values())
            me.rss_tree = me.rss + sum(v.rss_tree for v in kids.values())
            me.cpu_tree = me.cpu + sum(v.cpu_tree for v in kids.values())
        # Forget processes that are gone.
        for key in [k for k in self._prev_ticks if k not in seen_keys]:
            del self._prev_ticks[key]
        for key in [k for k in self._cmds if k not in seen_keys]:
            del self._cmds[key]
        return me, kids

    def _cmd(self, pid: int, s: PidStat) -> str:
        """Command line, read once per process (it does not change)."""
        key = (pid, s.start)
        hit = self._cmds.get(key)
        if hit is None:
            hit = self._cmds[key] = _cmdline(self.proc, pid, s.comm)
        return hit


def _cmdline(proc: str, pid: int, fallback: str) -> str:
    raw = read_text(f"{proc}/{pid}/cmdline")
    if not raw:
        return fallback
    parts = [p for p in raw.split("\0") if p]
    if not parts:
        return fallback
    cmd = " ".join([os.path.basename(parts[0]), *parts[1:]])
    return cmd[:300]


