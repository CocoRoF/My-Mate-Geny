# System monitoring (Admin → System)

Live and historical CPU, memory, swap, pressure, disk, network, GPU and
per-process usage of the machine running Geny, plus alerts in the admin log.
No extra dependency: everything is read from `/proc`, `/sys` and the cgroup
filesystem (no psutil); GPUs via a long-lived `nvidia-smi` stream or amdgpu
sysfs.

```
backend/app/services/sysmon/
  procfs.py   parsers (/proc/stat, meminfo, loadavg, pressure, diskstats, net/dev,
              <pid>/stat, cgroup v2 + v1) and the Collector (rates, process trees)
  gpu.py      NvidiaStream (nvidia-smi --query-gpu … -l 2) · amdgpu sysfs
  store.py    Ring (live) · Agg (min/sum/max/n) · MetricsStore (SQLite) · bucketize
  events.py   Gauge (hysteresis state machine) · Window
  monitor.py  SystemMonitor: the sampler task, alerts, live fan-out, history API
backend/app/ws/system.py              WebSocket /ws/admin/system
backend/app/routers/admin.py          GET /api/admin/system/now · /system/metrics
frontend/src/components/admin/SystemPanel.tsx + admin/system/*   the UI
```

## What is sampled (every 2 s)

| Area | Source | Notes |
|---|---|---|
| CPU | `/proc/stat`, `/proc/loadavg` | total and per core; user (+nice), system (+irq/softirq), iowait, steal. "CPU %" = user + system + steal (iowait is idle time waiting on disk, shown separately). |
| Memory | `/proc/meminfo` | used = total − MemAvailable; cache = buffers + cached + SReclaimable − shmem; swap used. |
| Pressure | `/proc/pressure/{cpu,memory,io}` | PSI avg10 (share of time tasks stalled). Memory "full" is what memguard watches. |
| Container | own cgroup (`/proc/self/cgroup` → `/sys/fs/cgroup/…`) | working set (current − inactive_file), limit (nearest ancestor with `memory.max`), peak, `memory.events` (OOM kills), CPU usage. cgroup v1 fallback. |
| Disk | `statvfs` of `/home`, the data dir, uploads (+ `MONITOR_DISK_PATHS`), `/proc/diskstats` | IO = sum over whole physical disks (no partitions / loop / dm); busy = max io_ticks share. |
| Network | `/proc/net/dev` | all interfaces except lo / veth / docker bridges. |
| Processes | `/proc/<pid>/task/*/children`, `/proc/<pid>/stat` | the backend and each direct child **with its whole subtree** (an engine + its shells, MCP servers, tools): RSS, CPU % of one core, process count, uptime. Engines are matched to their chat (title, model, account, working / idle, background tasks) via `EngineManager.describe()`; one-shot CLI turns (Codex) are paired with active runs. Zombie children are counted. |
| GPU | `nvidia-smi … -l 2` (one process, streamed) / `/sys/class/drm/card*/device` | util, memory, temperature, power per GPU. "No GPU detected" otherwise. |

What a Docker container sees (the deployed backend): `/proc/stat`, `meminfo`,
`loadavg`, `diskstats`, `pressure` are **host-wide**; `/proc/net/dev` is the
container's own network namespace (i.e. all of Geny's traffic); the cgroup is
the container's. Host processes outside the container are not visible — the
process table shows Geny's own tree. Run directly on the host, the cgroup is
the service/session scope and its limit is found on an ancestor (e.g. a user
slice).

**Cost.** One tick reads ~20 small kernel files plus `stat` of the backend's
descendants: measured **~3 ms CPU per tick ≈ 0.15 % of one core** (shown live
in the *Monitor* card: `sampler.avg_cpu_ms`, `cpu_pct`). Cross-check from
outside: two otherwise idle backends over 100 s — monitor on 0.31 %, off
0.13 % of a core, i.e. +0.18 %. JSON encoding for live viewers happens once
per tick regardless of the number of viewers, and only while at least one is
connected. Command lines are read once per process; zombies are only counted.

## Storage

* **Ring buffer** — the last `MONITOR_RING_MINUTES` (30) at full resolution
  in memory (`(ts, keys, values)` tuples sharing one keys tuple: ~1 MB).
* **SQLite** — table `sys_metrics(res, ts, n, data)`: 1-minute aggregates kept
  `MONITOR_KEEP_1M_DAYS` (7), 15-minute aggregates kept `MONITOR_KEEP_15M_DAYS`
  (90). `data` is zlib-compressed JSON `{"metric": [min, avg, max]}` (a bare
  number when constant), values rounded to 4 significant digits. Rows are
  pruned at start and hourly. A bucket written twice (restart mid-minute) is
  merged, not replaced; the 15-minute bucket is resumed from 1-minute rows
  after a restart. Size: ~0.6 KB per row incl. index → ≈ 12 MB at full
  retention (18,720 rows). A plain rowid table on purpose: ~1 KB rows in a
  WITHOUT ROWID b-tree spill into overflow pages (measured 7× larger).
  Range queries: 1h 15 ms, 24h 0.2 s, 30d 0.3 s (bucketing ~3k rows).
* `sys_monitor_state` holds the last heartbeat (restart detection).

Range → source: `15m`/`30m` live ring (2 s) · `1h`/`6h` 1-min rows · `24h`
1-min rebucketed to 5 min · `7d` 15-min → 30 min · `30d` → 2 h · `90d` → 6 h.
The in-progress bucket is included so charts reach "now".

## API

All behind the normal login (cookie or `?token=` for sockets).

* `GET /api/admin/system/now` — the latest snapshot: `m` (flat metrics),
  `cores`, `cpu`, `mem`, `cgroup`, `pressure`, `disks`, `io`, `net`, `gpus`,
  `procs`, `zombies`, `runs`, `engines`, `alerts` (active alert states),
  `guard`, `sampler`, `host`. 503 while warming up / when disabled.
* `GET /api/admin/system/metrics?range=15m|30m|1h|6h|24h|7d|30d|90d` —
  columnar: `t[]` (epoch s, bucket start) and `series[metric] = {avg, min?, max?}`
  (nulls where a metric was absent), plus `step`, `source`, `from`, `to`,
  `events` (monitor log rows in range) and `thresholds`.
* `WS /ws/admin/system` — `hello` (snapshot + last 15 min of the ring +
  per-core and per-process histories + recent events + thresholds), then a
  `sample` every tick and an `event` whenever an alert fires/clears. Client may
  send `{"type":"ping"}`. Nothing is sent when nobody is connected.
* `GET /api/admin/system` additionally reports `monitor` (sampler stats).

Flat metric keys: `cpu cpu_user cpu_system cpu_iowait cpu_steal load1 load5
load15 mem_used mem_avail mem_cache mem_total swap_used swap_total psi_cpu
psi_mem psi_mem_full psi_io cg_mem cg_limit cg_cpu disk_read disk_write
disk_busy disk_pct net_rx net_tx be_rss be_cpu tree_rss eng_n eng_rss eng_cpu`
and per GPU `g{i}_util g{i}_mem g{i}_memt g{i}_temp g{i}_pwr`.

## Alerts → admin log

Written with `source = "monitor"`, `code = monitor.<rule>.<transition>`
(`raise` → warning/error, `escalate` → error, `clear` → info with peak and
duration). Details carry the values, thresholds and the top processes.

Each gauge is a small state machine (`events.Gauge`): a level is entered
after `sustain` consecutive samples (~6 s) at or above its line and left only
after ~30 s below `line − margin`, so a value hovering around a threshold
logs once. A gauge that trips again within 10 minutes of clearing changes
state silently.

| Rule | Default | Setting |
|---|---|---|
| host memory used | warn 85 %, critical 95 % | `MONITOR_MEM_WARN_PCT`, `MONITOR_MEM_CRIT_PCT` |
| memguard line | available within 1 GB of / below `avail_min` | `MONITOR_GUARD*` |
| container cgroup | same %, of its limit (if any) | |
| memory pressure | PSI full avg10 ≥ 5 % (critical ×4) | `MONITOR_PSI_FULL_WARN` |
| swap used | ≥ 80 % | `MONITOR_SWAP_WARN_PCT` |
| swap growth | +256 MB within 5 min (30 min cooldown) | `MONITOR_SWAP_GROWTH_MB` |
| disk full | warn 90 %, critical 97 % per watched mount | `MONITOR_DISK_WARN_PCT`, `…_CRIT_PCT` |
| engine RSS | one engine tree ≥ 2 GB (critical ×2) | `MONITOR_ENGINE_RSS_GB` |
| CPU saturated | ≥ 95 % for 60 s | `MONITOR_CPU_SAT_PCT`, `MONITOR_CPU_SAT_S` |
| GPU temperature | ≥ 85 °C (critical +7) | `MONITOR_GPU_TEMP_C` |
| GPU memory | ≥ 95 % | |
| zombie children | ≥ 50 | `MONITOR_ZOMBIE_WARN` |
| OOM kill | any new `oom_kill` in the cgroup's `memory.events` | — |
| cgroup limit hit | new `max` events (10 min cooldown) | — |
| backend restart | clean (info) / unclean = no clean shutdown recorded (warning) / host rebooted (warning) | — |

## Host memory guard (optional)

Some hosts run a user-space memory guard: per-command cgroups plus a daemon
(**memguard**) that SIGTERMs the fastest-growing big process when machine-wide
available memory drops below a floor (default 1.5 GB, 600 MB hard) or PSI
memory "full" exceeds 40 %, usually together with a memory ceiling for the
user slice. The monitor detects such a guard (`/usr/local/sbin/memguard` or
`~/server-hardening/memguard.py`) and:

* draws memguard's line on the memory chart (total − its floor) and its PSI
  line on the pressure chart;
* alerts when available memory comes within 1 GB of that line;
* shows the *Memory protection* card (container working set / limit / OOM
  kills, headroom above memguard's line, the user-slice ceiling).

A backend running in Docker (system slice) is not under a user-slice ceiling
and cannot read it from inside the container; set `MONITOR_USER_CEILING`
(e.g. `22G`) to show it anyway. memguard's own kills are only visible on the
host (`journalctl -u memguard`). Settings: `MONITOR_GUARD=auto|on|off`,
`MONITOR_GUARD_AVAIL`, `MONITOR_GUARD_AVAIL_HARD`, `MONITOR_GUARD_PSI_FULL`.
Without a guard none of this appears.

## UI

Admin → System (only while that tab is visible; the socket closes when the
browser tab is hidden and reopens with a fresh `hello`):

* toolbar: range (Live · 1 h · 6 h · 24 h · 7 d · 30 d), Pause (freezes the
  view; samples queue and apply on resume), live status;
* active alerts banner; KPI tiles (CPU, memory, swap, disk, network, GPU) with
  15-minute sparklines and status (icon + label);
* charts with a shared crosshair and tooltips, min–max bands on history
  ranges, event markers: CPU (stacked user / system / iowait) with a per-core
  heat map (last 5 min), memory (used / cache / container / swap, memguard and
  limit lines), Geny processes (backend / engines / other children), network
  and disk IO (in/read above, out/write below), pressure, one card per GPU;
  live charts scroll smoothly (one DOM update per sample + a CSS transition;
  off with `prefers-reduced-motion`);
* process table (engines link to their chat; "idle 13m · 5 tasks" /
  "working"), system events timeline, running turns, memory protection,
  monitor cost, and the runtime / providers / data / storage cards.

Colors: categorical slots blue / orange / aqua / yellow, validated for the dark
surface (adjacent CVD ΔE ≥ 8.4, ≥ 3:1 contrast); status colors are reserved
for status and always paired with an icon and a label.

Set `MONITOR_ENABLED=false` to turn it all off (the endpoints answer 503).

## Server RAM versus Geny usage

The default RAM headline is host physical occupancy (`MemTotal - MemFree`), including cache. The chart stacks
`mem_non_cache` and `mem_cache` to that exact occupancy; it does not add cache to `total - MemAvailable`, which
would overlap. `mem_free` is unused RAM; `mem_avail` is the kernel estimate for new applications including
reclaimable cache. Both are labelled separately. Pressure alerts and memguard continue using OS availability.
Historical buckets before these new occupancy metrics have a gap rather than fabricated occupancy.

Geny is shown separately within that host total: container `memory.current` (including its cache) and process
RSS sum (may count shared pages more than once), not added together. `cg_current` is stored alongside the
existing `cg_mem` working-set series. Kernel reference: https://docs.kernel.org/filesystems/proc.html#meminfo .
