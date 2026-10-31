"""System monitoring: /proc + cgroup sampler, history store, alerts.

* :mod:`.procfs`  — pure parsers for /proc, cgroup v2/v1 and sysfs files, and
  the :class:`~.procfs.Collector` that turns them into one sample every tick.
* :mod:`.gpu`     — NVIDIA (a long-lived ``nvidia-smi -l``) and AMD (sysfs).
* :mod:`.store`   — the in-memory ring buffer (live views) and the SQLite
  history (1-min / 15-min min/avg/max aggregates, pruned automatically).
* :mod:`.events`  — threshold rules with hysteresis -> the admin log.
* :mod:`.monitor` — :class:`~.monitor.SystemMonitor`, the asyncio task that
  ties it together and fans samples out to live WebSocket subscribers.

No third-party dependency (no psutil): everything is read from kernel files.
See docs/monitoring.md.
"""

from app.services.sysmon.monitor import SystemMonitor

__all__ = ["SystemMonitor"]
