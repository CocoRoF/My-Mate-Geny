"""GPU readings without extra dependencies.

* **NVIDIA** — one long-lived ``nvidia-smi --query-gpu=… -l <interval>``
  process streams a CSV line per GPU per interval; we keep the latest line per
  index. Far cheaper than spawning nvidia-smi every tick (each spawn costs
  ~50-100 ms of CPU). Restarted with a backoff if it exits.
* **AMD** (amdgpu) — plain sysfs: ``gpu_busy_percent``, ``mem_info_vram_*``
  and the hwmon ``temp1_input`` / ``power1_*`` of ``/sys/class/drm/card*``.

Either source yields the same dict per GPU::

    {"index", "name", "vendor", "util", "mem_used", "mem_total", "temp", "power", "power_limit"}

(values may be ``None`` when the device does not report them).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
import time
from typing import Any

from app.services.sysmon.procfs import read_int, read_text

log = logging.getLogger(__name__)

NVIDIA_FIELDS = (
    "index", "name", "utilization.gpu", "memory.used", "memory.total",
    "temperature.gpu", "power.draw", "power.limit",
)


def _num(raw: str) -> float | None:
    raw = raw.strip()
    if not raw or raw.startswith("[") or raw.upper() in ("N/A", "NA"):
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def parse_nvidia_csv_line(line: str) -> dict[str, Any] | None:
    """One ``--format=csv,noheader,nounits`` line in :data:`NVIDIA_FIELDS` order."""
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < len(NVIDIA_FIELDS):
        return None
    idx = _num(parts[0])
    if idx is None:
        return None
    mem_used, mem_total = _num(parts[3]), _num(parts[4])
    return {
        "index": int(idx),
        "name": parts[1],
        "vendor": "nvidia",
        "util": _num(parts[2]),
        "mem_used": int(mem_used * 1024 * 1024) if mem_used is not None else None,   # MiB
        "mem_total": int(mem_total * 1024 * 1024) if mem_total is not None else None,
        "temp": _num(parts[5]),
        "power": _num(parts[6]),
        "power_limit": _num(parts[7]),
    }


class NvidiaStream:
    """Background ``nvidia-smi -l`` reader. ``latest()`` never blocks."""

    def __init__(self, binary: str, interval_s: float) -> None:
        self.binary = binary
        self.interval = max(1, int(round(interval_s)))
        self._gpus: dict[int, tuple[float, dict[str, Any]]] = {}
        self._task: asyncio.Task | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self.error: str | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        if self._proc is not None and self._proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self._proc.kill()

    def latest(self) -> list[dict[str, Any]]:
        now = time.monotonic()
        stale = 5 * self.interval + 5
        return [g for _, (t, g) in sorted(self._gpus.items()) if now - t < stale]

    async def _run(self) -> None:
        backoff = 5.0
        while True:
            try:
                self._proc = await asyncio.create_subprocess_exec(
                    self.binary, f"--query-gpu={','.join(NVIDIA_FIELDS)}",
                    "--format=csv,noheader,nounits", "-l", str(self.interval),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                    stdin=asyncio.subprocess.DEVNULL,
                )
                assert self._proc.stdout is not None
                async for raw in self._proc.stdout:
                    g = parse_nvidia_csv_line(raw.decode(errors="replace"))
                    if g is not None:
                        self._gpus[g["index"]] = (time.monotonic(), g)
                        self.error, backoff = None, 5.0
                await self._proc.wait()
                self.error = f"nvidia-smi exited ({self._proc.returncode})"
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.error = f"nvidia-smi: {exc}"
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 300.0)


def amd_cards(sys: str = "/sys") -> list[str]:
    """``/sys/class/drm/cardN/device`` dirs driven by amdgpu."""
    base = f"{sys}/class/drm"
    try:
        names = sorted(n for n in os.listdir(base) if n.startswith("card") and n[4:].isdigit())
    except OSError:
        return []
    out = []
    for n in names:
        dev = f"{base}/{n}/device"
        if "DRIVER=amdgpu" in (read_text(f"{dev}/uevent") or "") and os.path.exists(f"{dev}/gpu_busy_percent"):
            out.append(dev)
    return out


def read_amd(dev: str, index: int, name: str) -> dict[str, Any]:
    hwmon = None
    with contextlib.suppress(OSError):
        hw = sorted(os.listdir(f"{dev}/hwmon"))
        hwmon = f"{dev}/hwmon/{hw[0]}" if hw else None
    temp = power = power_limit = None
    if hwmon:
        t = read_int(f"{hwmon}/temp1_input")
        temp = t / 1000 if t is not None else None
        p = read_int(f"{hwmon}/power1_average")
        if p is None:
            p = read_int(f"{hwmon}/power1_input")
        power = p / 1e6 if p is not None else None
        cap = read_int(f"{hwmon}/power1_cap")
        power_limit = cap / 1e6 if cap else None
    return {
        "index": index,
        "name": name,
        "vendor": "amd",
        "util": _float(read_int(f"{dev}/gpu_busy_percent")),
        "mem_used": read_int(f"{dev}/mem_info_vram_used"),
        "mem_total": read_int(f"{dev}/mem_info_vram_total"),
        "temp": temp,
        "power": power,
        "power_limit": power_limit,
    }


def _float(v: int | None) -> float | None:
    return float(v) if v is not None else None


def amd_name(dev: str, cpu_model: str) -> str:
    product = (read_text(f"{dev}/product_name") or "").strip()
    if product:
        return product
    pci = ""
    for line in (read_text(f"{dev}/uevent") or "").splitlines():
        if line.startswith("PCI_ID="):
            pci = line[7:]
    total = read_int(f"{dev}/mem_info_vram_total") or 0
    if "Radeon" in cpu_model and total <= 4 << 30:
        # An APU: "AMD Ryzen 9 6900HX with Radeon Graphics" -> integrated graphics.
        return "AMD Radeon Graphics (integrated)"
    return f"AMD GPU {pci}".strip()


class GpuReader:
    """Picks the available source once; ``read()`` is cheap and non-blocking."""

    def __init__(self, *, mode: str, interval_s: float, sys: str = "/sys", cpu_model: str = "") -> None:
        self.mode = (mode or "auto").lower()
        self.sys = sys
        self.nvidia: NvidiaStream | None = None
        self.amd: list[tuple[str, str]] = []
        self.source = "none"
        if self.mode == "off":
            self.source = "off"
            return
        binary = shutil.which("nvidia-smi")
        if binary and self.mode in ("auto", "nvidia"):
            self.nvidia = NvidiaStream(binary, interval_s)
            self.source = "nvidia"
        if self.mode in ("auto", "amd"):
            self.amd = [(d, amd_name(d, cpu_model)) for d in amd_cards(sys)]
            if self.amd and self.source == "none":
                self.source = "amd"
            elif self.amd:
                self.source = "nvidia+amd"

    def start(self) -> None:
        if self.nvidia is not None:
            self.nvidia.start()

    async def stop(self) -> None:
        if self.nvidia is not None:
            await self.nvidia.stop()

    def read(self) -> list[dict[str, Any]]:
        gpus: list[dict[str, Any]] = []
        if self.nvidia is not None:
            gpus.extend(self.nvidia.latest())
        base = len(gpus)
        for i, (dev, name) in enumerate(self.amd):
            with contextlib.suppress(Exception):
                gpus.append(read_amd(dev, base + i, name))
        for i, g in enumerate(gpus):
            g["index"] = i
        return gpus

    @property
    def error(self) -> str | None:
        return self.nvidia.error if self.nvidia is not None else None
