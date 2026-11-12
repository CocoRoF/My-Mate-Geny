"""System monitor: /proc + cgroup parsers, rates, process trees, GPU parsing,
downsampling / pruning, alert hysteresis, restart detection, API shapes."""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.services.log_service import LogService
from app.services.sysmon import procfs
from app.services.sysmon.events import Gauge, Window
from app.services.sysmon.gpu import GpuReader, parse_nvidia_csv_line, read_amd
from app.services.sysmon.monitor import SystemMonitor
from app.services.sysmon.procfs import (
    CgroupInfo, Collector, ProcView, cpu_percent, memory_summary, parse_diskstats, parse_loadavg,
    parse_meminfo, parse_net_dev, parse_pid_stat, parse_pressure, parse_proc_stat, parse_size,
    read_cgroup_v1, read_cgroup_v2,
)
from app.services.sysmon.store import RES_1M, RES_15M, Agg, MetricsStore, Ring, bucketize

FIX = Path(__file__).parent / "fixtures" / "sysmon"
GB = 1 << 30


def fx(name: str) -> str:
    return (FIX / name).read_text()


# ------------------------------------------------------------------ parsers


def test_proc_stat_and_cpu_percent():
    a, b = parse_proc_stat(fx("proc/stat_a")), parse_proc_stat(fx("proc/stat_b"))
    assert a["btime"] == 1793400000 and a["procs_blocked"] == 1 and len(a["cores"]) == 2
    pct = cpu_percent(a["total"], b["total"])
    # delta: user 600, system 200, idle 100, iowait 100 -> total 1000
    assert pct["user"] == pytest.approx(60) and pct["system"] == pytest.approx(20)
    assert pct["iowait"] == pytest.approx(10) and pct["busy"] == pytest.approx(80)
    cores = [cpu_percent(p, c)["busy"] for p, c in zip(a["cores"], b["cores"])]
    assert cores[0] == pytest.approx(650 / 700 * 100) and cores[1] == pytest.approx(150 / 300 * 100)
    # A counter that did not move (or went backwards) is 0, not a crash.
    assert cpu_percent(b["total"], a["total"])["busy"] == 0


def test_meminfo_summary():
    s = memory_summary(parse_meminfo(fx("proc/meminfo")))
    kb = 1024
    assert s["total"] == 16000000 * kb and s["available"] == 6000000 * kb
    assert s["used"] == 10000000 * kb
    assert s["cache"] == (500000 + 4000000 + 800000 - 300000) * kb
    assert s["swap_total"] == 2000000 * kb and s["swap_used"] == 500000 * kb


def test_small_parsers():
    assert parse_loadavg(fx("proc/loadavg")) == {"load1": 7.68, "load5": 7.84, "load15": 7.86,
                                                "runnable": 17, "threads": 1372}
    p = parse_pressure(fx("proc/pressure_memory"))
    assert p["some"]["avg10"] == 12.5 and p["full"]["avg60"] == 3.0
    assert parse_pressure("") is None
    net = parse_net_dev(fx("proc/net_dev"))
    assert net["eth0"] == (14634711, 220131653) and "lo" in net
    disks = parse_diskstats(fx("proc/diskstats"))
    assert disks["nvme0n1"] == (20000, 40000, 1500)
    st = parse_pid_stat(fx("proc/pid_stat"))
    assert st.comm == "tmux: server (x)" and st.state == "S" and st.ppid == 1
    assert st.ticks == 200 and st.threads == 3 and st.start == 50000 and st.rss == 2560 * procfs.PAGE
    assert parse_pid_stat("garbage") is None
    assert parse_size("1.5G") == int(1.5 * GB) and parse_size("600M") == 600 << 20 and parse_size("x") is None


def _write(root: Path, rel: str, text: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def test_cgroup_v2_with_ancestor_limit(tmp_path):
    cg = tmp_path / "cg"
    _write(cg, "cgroup.controllers", "cpu memory io")
    _write(cg, "user.slice/memory.max", str(22 * GB))
    _write(cg, "user.slice/memory.current", str(5 * GB))
    leaf = "user.slice/app.scope"
    _write(cg, f"{leaf}/memory.current", "1422180352")
    _write(cg, f"{leaf}/memory.max", "max")
    _write(cg, f"{leaf}/memory.peak", "1493102592")
    shutil.copy(FIX / "cgroup_v2" / "memory.stat", cg / leaf / "memory.stat")
    _write(cg, f"{leaf}/memory.events", "low 0\nhigh 0\nmax 2\noom 1\noom_kill 1\n")
    _write(cg, f"{leaf}/cpu.stat", "usage_usec 109453628\nuser_usec 88359805\n")
    _write(cg, f"{leaf}/cpu.max", "200000 100000")
    _write(cg, f"{leaf}/memory.pressure", fx("proc/pressure_memory"))
    info = read_cgroup_v2(str(cg), "/" + leaf)
    assert info.current == 1422180352 and info.max is None and info.peak == 1493102592
    assert info.working_set == 1422180352 - 400000000 and info.anon == 628363264
    assert info.events["oom_kill"] == 1 and info.cpu_usage_us == 109453628 and info.cpu_quota == 2.0
    assert info.limit_path == "/user.slice" and info.limit_max == 22 * GB and info.limit_current == 5 * GB
    assert info.pressure["memory"]["full"]["avg10"] == 6.25


def test_cgroup_v1(tmp_path):
    _write(tmp_path, "memory/memory.usage_in_bytes", str(3 * GB))
    _write(tmp_path, "memory/memory.limit_in_bytes", str(1 << 62))   # "unlimited"
    _write(tmp_path, "memory/memory.stat", "rss 100\ncache 200\ntotal_inactive_file 1000\n")
    info = read_cgroup_v1(str(tmp_path))
    assert info.version == 1 and info.max is None and info.working_set == 3 * GB - 1000
    assert read_cgroup_v1(str(tmp_path / "nope")) is None


def test_gpu_parsers(tmp_path):
    lines = fx("nvidia_smi.csv").splitlines()
    g0, g1 = parse_nvidia_csv_line(lines[0]), parse_nvidia_csv_line(lines[1])
    assert g0["name"] == "NVIDIA GeForce RTX 4090" and g0["util"] == 87 and g0["temp"] == 71
    assert g0["mem_used"] == 20480 << 20 and g0["power"] == 312.45 and g0["power_limit"] == 450
    assert g1["util"] is None and g1["power"] is None and g1["mem_total"] == 81920 << 20
    assert parse_nvidia_csv_line("nonsense") is None
    # AMD via sysfs.
    dev = tmp_path / "class/drm/card0/device"
    _write(dev, "uevent", "DRIVER=amdgpu\nPCI_ID=1002:1681\n")
    _write(dev, "gpu_busy_percent", "42")
    _write(dev, "mem_info_vram_used", "75878400")
    _write(dev, "mem_info_vram_total", "3221225472")
    _write(dev, "hwmon/hwmon5/temp1_input", "60000")
    _write(dev, "hwmon/hwmon5/power1_input", "47241000")
    g = read_amd(str(dev), 0, "x")
    assert g["util"] == 42 and g["temp"] == 60 and g["power"] == pytest.approx(47.241)
    r = GpuReader(mode="amd", interval_s=2, sys=str(tmp_path), cpu_model="AMD Ryzen 9 6900HX with Radeon Graphics")
    gpus = r.read()
    assert r.source == "amd" and gpus[0]["name"] == "AMD Radeon Graphics (integrated)"
    assert GpuReader(mode="off", interval_s=2).read() == [] and GpuReader(mode="amd", interval_s=2,
                                                                           sys=str(tmp_path / "x")).source == "none"


def _pid(root: Path, pid: int, comm: str, ppid: int, ticks: int, rss_pages: int, state: str = "S",
         kids: list[int] = (), cmd: str = "") -> None:
    utime = ticks
    fields = [state, str(ppid)] + ["0"] * 9 + [str(utime), "0", "0", "0", "20", "0", "1", "0", "1000", "0",
                                                str(rss_pages)] + ["0"] * 20
    _write(root, f"{pid}/stat", f"{pid} ({comm}) " + " ".join(fields))
    _write(root, f"{pid}/task/{pid}/children", " ".join(map(str, kids)))
    _write(root, f"{pid}/cmdline", (cmd or comm).replace(" ", "\0"))


def test_collector_rates_and_process_tree(tmp_path):
    proc = tmp_path / "proc"
    _write(proc, "stat", fx("proc/stat_a"))
    _write(proc, "meminfo", fx("proc/meminfo"))
    _write(proc, "loadavg", fx("proc/loadavg"))
    _write(proc, "net/dev", fx("proc/net_dev"))
    _write(proc, "diskstats", fx("proc/diskstats"))
    _write(tmp_path, "sys/block/nvme0n1/size", "1")
    _write(tmp_path, "sys/block/loop0/size", "1")
    # backend(100) -> engine(200) -> bash(201) ; zombie git(300)
    _pid(proc, 100, "uvicorn", 1, 1000, 10000, kids=[200, 300])
    _pid(proc, 200, "claude", 100, 500, 50000, kids=[201], cmd="claude --print --model x")
    _pid(proc, 201, "bash", 200, 100, 1000)
    _pid(proc, 300, "git", 100, 0, 0, state="Z")
    col = Collector(proc=str(proc), sys=str(tmp_path / "sys"), cgroup_root=str(tmp_path / "nocg"),
                    disk_paths=[("tmp", str(tmp_path))], self_pid=100)
    t0 = 1000.0
    assert col.cpu()["first"]
    col.disk_io(t0)
    col.network(t0)
    col.processes(t0, 1793400000)
    # Two seconds later.
    _write(proc, "stat", fx("proc/stat_b"))
    _write(proc, "diskstats", fx("proc/diskstats").replace("nvme0n1 1000 0 20000 300 2000 0 40000 900 0 1500",
                                                           "nvme0n1 1000 0 24000 300 2000 0 48000 900 0 2500"))
    _write(proc, "net/dev", fx("proc/net_dev").replace("14634711", "14644711"))
    _pid(proc, 200, "claude", 100, 500 + procfs.CLK_TCK, 50000, kids=[201], cmd="claude --print --model x")
    cpu = col.cpu()
    assert cpu["busy"] == pytest.approx(80) and cpu["count"] == 2 and cpu["load1"] == 7.68
    io = col.disk_io(t0 + 2)
    assert io["read"] == 4000 * 512 / 2 and io["write"] == 8000 * 512 / 2 and io["busy"] == pytest.approx(50)
    net = col.network(t0 + 2)
    assert net["rx"] == 5000 and net["tx"] == 0 and net["ifaces"] == ["eth0"]   # lo / veth skipped
    me, kids = col.processes(t0 + 2, 1793400000)
    assert me.pid == 100 and me.zombies == 1 and me.nprocs == 4
    eng = kids[200]
    assert eng.rss == 50000 * procfs.PAGE and eng.rss_tree == 51000 * procfs.PAGE and eng.nprocs == 2
    assert eng.cpu == pytest.approx(50) and eng.cmd.startswith("claude --print")
    assert 300 not in kids          # zombies are counted, not listed
    du = col.disk_usage()
    assert du[0]["label"] == "tmp" and 0 <= du[0]["pct"] <= 100


# ------------------------------------------------------------------ storage


def test_ring_columnar():
    r = Ring(3)
    for i in range(5):
        r.append(100 + i, {"cpu": float(i), **({"g0_util": 1.0} if i == 4 else {})})
    assert len(r) == 3
    col = r.columnar(0)
    assert col["t"] == [102, 103, 104] and col["series"]["cpu"]["avg"] == [2, 3, 4]
    assert col["series"]["g0_util"]["avg"] == [None, None, 1]
    assert r.values("cpu", 103) == [3.0, 4.0]


def test_agg_store_merge_bucketize_prune(db):
    store = MetricsStore(db, keep_1m_days=1, keep_15m_days=2)
    now = 1_800_000_000
    a = Agg()
    for v in (10.0, 20.0, 30.0):
        a.add({"cpu": v, "mem_total": 8.0})
    assert a.result() == {"cpu": [10, 20, 30], "mem_total": 8}   # constant -> bare number
    store.write(RES_1M, now, a)
    b = Agg()
    b.add({"cpu": 50.0})
    store.write(RES_1M, now, b)          # same bucket (restart mid-minute): merged, not replaced
    (ts, n, data), = store.rows(RES_1M, now)
    assert n == 4 and data["cpu"] == [10, 27.5, 50]
    for i in range(1, 6):
        x = Agg()
        x.add({"cpu": float(i)})
        store.write(RES_1M, now + i * 60, x)
    out = bucketize(store.rows(RES_1M, now), 300)
    assert out["t"] == [now, now + 300]
    cpu = out["series"]["cpu"]
    assert cpu["avg"] == [15, 5] and cpu["min"] == [1, 5] and cpu["max"] == [50, 5]   # n-weighted
    assert out["series"]["mem_total"]["avg"][-1] is None   # missing key -> null, not 0
    # Prune: 1-min rows older than a day go, 15-min rows are kept 2 days.
    old = Agg()
    old.add({"cpu": 1.0})
    store.write(RES_1M, now - 2 * 86400, old)
    store.write(RES_15M, now - 1.5 * 86400, old)
    store.write(RES_15M, now - 3 * 86400, old)
    assert store.prune(now + 60) == 2
    assert store.count(RES_15M) == 1 and store.count(RES_1M) == 6


# ------------------------------------------------------------------ hysteresis


def test_gauge_sustain_margin_cooldown():
    g = Gauge("mem", warn=85, crit=95, margin=5, sustain=3, clear_sustain=2, cooldown=600)
    t = 0.0
    assert g.update(90, t) is None and g.update(90, t) is None       # needs 3 in a row
    r = g.update(90, t)
    assert r.kind == "raise" and r.level == "warn" and r.logged
    assert g.update(84, 1) is None                                    # inside the margin: still warn
    for _ in range(3):
        e = g.update(99, 2)
    assert e.kind == "escalate" and g.level == "crit"
    # crit -> warn (eased silently) -> crit again: the second escalation is not logged.
    g.update(88, 2.5)
    e = g.update(88, 2.6)
    assert e.kind == "ease" and g.level == "warn"
    for _ in range(3):
        e = g.update(99, 2.7)
    assert e.kind == "escalate" and not e.logged
    assert g.update(79, 3) is None
    c = g.update(79, 4)
    assert c.kind == "clear" and c.peak == 99 and g.level == "ok"
    # Flapping right after a clear: state changes, but nothing is logged.
    for _ in range(3):
        r = g.update(90, 100)
    assert r.kind == "raise" and not r.logged
    g.update(70, 101)
    c = g.update(70, 102)
    assert c.kind == "clear" and not c.logged
    # After the cooldown it logs again.
    for _ in range(3):
        r = g.update(90, 2000)
    assert r.logged


def test_window_growth():
    w = Window(span=300)
    w.add(0, 100)
    w.add(100, 50)
    w.add(200, 300)
    assert w.growth() == 250
    w.add(600, 300)   # old points fall out
    assert w.growth() == 0


# ------------------------------------------------------------------ monitor


class FakeCollector:
    """Controlled readings; the tests change the attributes between ticks."""

    cpu_model = "Test CPU"
    in_container = True

    def __init__(self) -> None:
        self.busy = 10.0
        self.mem_used = 4 * GB
        self.total = 16 * GB
        self.swap_used = 0
        self.oom_kill = 0
        self.engine_rss = 300 << 20
        self.disk_pct = 40.0

    def cpu(self):
        return {"busy": self.busy, "user": self.busy * 0.7, "system": self.busy * 0.3, "iowait": 1.0, "steal": 0.0,
                "cores": [self.busy, self.busy], "count": 2, "btime": 1793400000, "procs_blocked": 0,
                "load1": 1.0, "load5": 1.0, "load15": 1.0, "runnable": 1, "threads": 100, "first": False}

    def memory(self):
        return {"total": self.total, "available": self.total - self.mem_used, "used": self.mem_used, "free": GB, "occupied": self.total-GB, "non_cache": self.total-3*GB,
                "cache": 2 * GB, "shmem": 0, "dirty": 0, "swap_total": 2 * GB, "swap_used": self.swap_used,
                "swap_cached": 0}

    def pressure(self):
        return {"memory": {"some": {"avg10": 0.0}, "full": {"avg10": 0.0}}, "cpu": {"some": {"avg10": 1.0}},
                "io": {"some": {"avg10": 0.5}}}

    def cgroup(self, now):
        return CgroupInfo(path="/", version=2, current=GB, max=None, working_set=GB // 2,
                          events={"oom_kill": self.oom_kill, "max": 0}), 5.0

    def disk_usage(self):
        return [{"label": "/home", "path": "/home", "total": 100 * GB, "used": int(self.disk_pct) * GB,
                 "free": (100 - int(self.disk_pct)) * GB, "pct": self.disk_pct}]

    def disk_io(self, now):
        return {"read": 1000.0, "write": 2000.0, "busy": 3.0}

    def network(self, now):
        return {"rx": 10.0, "tx": 20.0, "ifaces": ["eth0"], "rx_total": 0, "tx_total": 0}

    def processes(self, now, btime):
        me = ProcView(pid=100, comm="uvicorn", state="S", cmd="uvicorn app.main:app", rss=100 << 20,
                      rss_tree=0, cpu=1.0, cpu_tree=0, threads=10, nprocs=1, started=now - 50, zombies=0)
        eng = ProcView(pid=200, comm="claude", state="S", cmd="claude --print", rss=self.engine_rss,
                       rss_tree=self.engine_rss, cpu=3.0, cpu_tree=3.0, threads=5, nprocs=3, started=now - 10)
        return me, {200: eng}


class NoGpu:
    source = "none"
    error = None

    def read(self):
        return []

    def start(self):
        pass

    async def stop(self):
        pass


def _cfg(**over):
    base = {k: getattr(settings, k) for k in type(settings).model_fields if k.startswith("monitor_")}
    base.update(db_file=settings.db_file, uploads_root_path=settings.uploads_root_path, monitor_guard="off")
    base.update(over)
    return SimpleNamespace(**base)


def _monitor(db, clock, **over):
    mon = SystemMonitor(db, LogService(db), None, cfg=_cfg(**over), collector=FakeCollector(), gpu=NoGpu(),
                        clock=lambda: clock[0])
    return mon


ENGINE = [{"session_id": "s-eng", "pid": 200, "model": "claude-opus", "mode": "agent", "turn_active": False,
           "running_tasks": 5, "idle_s": 780, "account": "work", "cost_total_usd": 1.5}]


def _ticks(mon, clock, n, engines=ENGINE, step=2.0):
    snap = None
    for _ in range(n):
        clock[0] += step
        snap = mon._tick(clock[0], engines, [], False)
    return snap


def _codes(db):
    return [r["code"] for r in LogService(db).list(source="monitor", limit=500)["items"]][::-1]


def test_monitor_snapshot_and_events(db):
    clock = [1_800_000_000.0]
    mon = _monitor(db, clock)
    mon._on_start()
    snap = _ticks(mon, clock, 3)
    m = snap["m"]
    assert m["mem_used"] == 4 * GB and m["eng_n"] == 1 and m["eng_rss"] == 300 << 20 and m["cg_mem"] == GB // 2
    eng = next(p for p in snap["procs"] if p["kind"] == "engine")
    assert eng["session_id"] == "s-eng" and eng["tasks"] == 5 and eng["idle_s"] == 780 and eng["account"] == "work"
    assert snap["procs"][0]["kind"] == "backend" and snap["sampler"]["ticks"] == 3
    assert not snap["alerts"]

    col = mon.collector
    col.mem_used = int(14.5 * GB)            # 90.6 %
    snap = _ticks(mon, clock, 3)
    assert [a["key"] for a in snap["alerts"]] == ["mem"]
    assert _codes(db) == ["monitor.mem.raise"]
    _ticks(mon, clock, 20)                    # staying high: no repeat
    assert _codes(db) == ["monitor.mem.raise"]
    col.mem_used = int(15.5 * GB)            # 96.9 % -> escalate
    _ticks(mon, clock, 3)
    col.mem_used = 4 * GB
    _ticks(mon, clock, 20)
    assert _codes(db) == ["monitor.mem.raise", "monitor.mem.escalate", "monitor.mem.clear"]
    row = LogService(db).list(source="monitor", limit=1)["items"][0]
    assert row["level"] == "info" and row["detail"]["peak"] > 96

    # Engine over the RSS limit, CPU saturation for > 60 s, an OOM kill, a disk filling up.
    col.engine_rss = int(4.5 * GB)
    col.busy = 99.0
    col.oom_kill = 1
    col.disk_pct = 92.0
    _ticks(mon, clock, 35)
    codes = _codes(db)
    for c in ("monitor.engine.raise", "monitor.cpu.raise", "monitor.oom.kill", "monitor.disk.raise"):
        assert c in codes, c
    assert codes.count("monitor.oom.kill") == 1
    eng_row = next(r for r in LogService(db).list(source="monitor")["items"] if r["code"] == "monitor.engine.raise")
    assert eng_row["detail"]["session_id"] == "s-eng"
    # The engine goes away: its gauge is dropped silently.
    _ticks(mon, clock, 1, engines=[])
    assert not any(a["key"].startswith("engine:") for a in mon._alerts())


def test_monitor_history_ranges_and_hello(db):
    clock = [1_800_000_000.0]
    mon = _monitor(db, clock)
    mon._on_start()
    _ticks(mon, clock, 31 * 30, step=2.0)       # 31 minutes
    live = mon.series("15m")
    assert live["source"] == "live" and 440 <= len(live["t"]) <= 451 and "avg" in live["series"]["cpu"]
    hour = mon.series("1h")
    assert hour["source"] == "1m" and 30 <= len(hour["t"]) <= 33
    assert set(hour["series"]["mem_used"]) == {"min", "avg", "max"}
    assert hour["t"][-1] >= clock[0] - 120              # includes the in-progress minute
    assert mon.store.count(RES_1M) >= 30 and mon.store.count(RES_15M) >= 1
    week = mon.series("7d")
    assert week["source"] == "15m" and len(week["t"]) >= 1
    with pytest.raises(KeyError):
        mon.series("2y")
    hello = mon.hello()
    assert hello["now"]["m"]["cpu"] == 10 and len(hello["ring"]["t"]) > 400
    assert len(hello["cores"]) == 150 and "engine:s-eng" in hello["proc_hist"]
    assert "new_events" not in hello["now"]


def test_restart_detection(db):
    clock = [1_800_000_000.0]
    mon = _monitor(db, clock)
    mon._on_start()
    _ticks(mon, clock, 40)
    mon._on_stop()                           # clean shutdown
    clock[0] += 30
    mon2 = _monitor(db, clock)
    mon2._on_start()
    assert _codes(db)[-1] == "monitor.restart.clean"
    clock[0] += 100                          # killed: no _on_stop
    mon3 = _monitor(db, clock)
    mon3._on_start()
    row = LogService(db).list(source="monitor", limit=1)["items"][0]
    assert row["code"] == "monitor.restart.unclean" and row["level"] == "warning"
    assert row["detail"]["downtime_s"] >= 100


def test_monitor_snapshot_with_portable_collector(db, tmp_path, monkeypatch):
    """Windows/macOS collector: no run queue there, so the snapshot carries None instead of failing."""
    from app.services.sysmon import portable
    clock = [1_800_000_000.0]
    col = portable.Collector(disk_paths=[("data", str(tmp_path))])
    mon = SystemMonitor(db, LogService(db), None, cfg=_cfg(), collector=col, gpu=NoGpu(), clock=lambda: clock[0])
    mon._on_start()
    mon._tick(clock[0], [], [], True)
    snap = _ticks(mon, clock, 2, engines=[])
    assert snap is not None and mon.latest is snap
    assert snap["cpu"]["runnable"] is None and snap["cpu"]["blocked"] is None
    assert isinstance(snap["cpu"]["threads"], int) and snap["cpu"]["threads"] > 0
    assert snap["procs"][0]["kind"] == "backend" and snap["sampler"]["ticks"] == 2

    # An older portable reading without those keys at all still builds a snapshot.
    full = col.cpu
    monkeypatch.setattr(col, "cpu", lambda: {k: v for k, v in full().items()
                                             if k not in ("runnable", "threads", "procs_blocked", "btime")})
    snap = _ticks(mon, clock, 1, engines=[])
    assert snap["cpu"]["runnable"] is None and snap["cpu"]["threads"] is None and snap["cpu"]["btime"] is None


def test_portable_thread_count_is_cached(monkeypatch):
    from app.services.sysmon import portable
    calls, now = [], [100.0]
    monkeypatch.setattr(portable.sys, "platform", "darwin")
    monkeypatch.setattr(portable.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(portable, "_summed_threads", lambda: calls.append(1) or 321)
    col = portable.Collector()
    assert col.threads() == 321 and col.threads() == 321 and len(calls) == 1
    now[0] += portable.THREADS_TTL_S + 1
    assert col.threads() == 321 and len(calls) == 2
    # Windows asks the kernel first and only sums processes when that fails.
    monkeypatch.setattr(portable.sys, "platform", "win32")
    monkeypatch.setattr(portable, "_windows_threads", lambda: 4000)
    now[0] += portable.THREADS_TTL_S + 1
    assert col.threads() == 4000 and len(calls) == 2
    monkeypatch.setattr(portable, "_windows_threads", lambda: (_ for _ in ()).throw(OSError("no psapi")))
    now[0] += portable.THREADS_TTL_S + 1
    assert col.threads() == 321 and len(calls) == 3


# ------------------------------------------------------------------ API


def _login(client: TestClient) -> None:
    assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200


def test_api_shapes_and_ws():
    from app.main import app

    with TestClient(app) as client:
        assert client.get("/api/admin/system/now").status_code == 401
        _login(client)
        mon = app.state.system_monitor
        assert mon is not None
        deadline = time.time() + 10
        while mon.latest is None and time.time() < deadline:
            time.sleep(0.2)
        now = client.get("/api/admin/system/now").json()
        assert {"m", "cores", "procs", "gpus", "disks", "alerts", "sampler", "mem"} <= set(now)
        assert now["procs"][0]["kind"] == "backend" and now["procs"][0]["pid"] == os.getpid()
        r = client.get("/api/admin/system/metrics", params={"range": "1h"}).json()
        assert {"t", "series", "events", "step", "source", "thresholds"} <= set(r) and r["source"] == "1m"
        assert client.get("/api/admin/system/metrics", params={"range": "15m"}).json()["source"] == "live"
        assert client.get("/api/admin/system/metrics", params={"range": "1y"}).status_code == 422
        assert client.get("/api/admin/system").json()["monitor"]["ticks"] >= 1
        with client.websocket_connect("/ws/admin/system") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello" and hello["data"]["now"] is not None
            assert mon.subscribers == 1
            msg = ws.receive_json()
            assert msg["type"] in ("sample", "event")
        deadline = time.time() + 5
        while mon.subscribers and time.time() < deadline:
            time.sleep(0.05)
        assert mon.subscribers == 0

@pytest.mark.parametrize('total,free,available,cache',[(28,6,24,19),(16,1,6,5),(8,0,0,0)])
def test_host_memory_occupancy_includes_cache_without_adding_available_overlap(total,free,available,cache):
    s=memory_summary({'MemTotal':total*GB,'MemFree':free*GB,'MemAvailable':available*GB,'Cached':cache*GB})
    assert s['occupied']==(total-free)*GB
    assert s['non_cache']+s['cache']+s['free']==s['total']
    assert s['used']==(total-available)*GB # pressure/guard retains OS-available semantics
    assert s['available']==available*GB


def test_memory_missing_available_and_inconsistent_kernel_fixture_stays_bounded():
    s=memory_summary({'MemTotal':8*GB,'MemFree':2*GB,'Cached':3*GB,'SReclaimable':GB})
    assert s['available']==5*GB and s['occupied']==6*GB and s['non_cache']==2*GB
    s=memory_summary({'MemTotal':8*GB,'MemFree':99*GB,'MemAvailable':100*GB,'Cached':99*GB})
    assert s['free']==s['available']==s['total'] and s['occupied']==s['cache']==s['non_cache']==0
