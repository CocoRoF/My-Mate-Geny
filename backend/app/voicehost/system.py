"""What this machine has: NVIDIA GPUs (nvidia-smi — no CUDA in the server process), what each process holds on them,
or an Apple Silicon GPU (Metal: the machine's unified memory), host memory and disk, and whether we run in a container
that was given the GPU. On Windows every probe runs without a console window (the desktop app's local backend has none).
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

MiB = 1 << 20
GiB = 1 << 30


@dataclass
class Gpu:
    index: int
    name: str
    total: int
    used: int
    free: int
    util: int
    driver: str
    capability: str  # "8.6"; "" when the driver can't say
    kind: str = "nvidia"  # nvidia | apple (Metal on Apple Silicon: total = the machine's unified memory)

    def to_dict(self) -> dict:
        return {"index": self.index, "name": self.name, "total": self.total, "used": self.used, "free": self.free,
                "util": self.util, "driver": self.driver, "capability": self.capability, "kind": self.kind}

    @property
    def driver_major(self) -> int:
        try:
            return int(self.driver.split(".", 1)[0])
        except ValueError:
            return 0

    @property
    def capability_tuple(self) -> tuple[int, int] | None:
        try:
            a, b = self.capability.split(".", 1)
            return int(a), int(b)
        except ValueError:
            return None


_cache: tuple[float, list[Gpu]] = (0.0, [])
_smi_error = ""


def _run(args: list[str], timeout: float = 10) -> subprocess.CompletedProcess:
    """a probe's output (no console window on Windows: a windowless parent would flash one per call)"""
    from app.portability import subprocess_flags

    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, **subprocess_flags())


def apple_silicon() -> bool:
    return sys.platform == "darwin" and platform.machine().lower() in ("arm64", "aarch64")


def macos_version() -> tuple[int, ...]:
    try:
        return tuple(int(x) for x in platform.mac_ver()[0].split(".") if x.isdigit()) or (0,)
    except ValueError:
        return (0,)


def _sysctl(name: str) -> str:
    try:
        return _run(["/usr/sbin/sysctl", "-n", name], timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def apple_gpu() -> Gpu:
    """Apple Silicon's GPU: Metal, sharing the machine's memory (what the engines may take is the machine's RAM)"""
    m = host_memory()
    chip = _sysctl("machdep.cpu.brand_string") or "Apple Silicon"
    return Gpu(0, chip, m["total"], m["used"], m["available"], 0, "macOS " + ".".join(map(str, macos_version())), "",
               kind="apple")


def smi() -> str | None:
    found = shutil.which("nvidia-smi")
    if found:
        return found
    if os.name == "nt":  # (the driver puts it here, not always on PATH)
        for c in (r"C:\Windows\System32\nvidia-smi.exe", r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe"):
            if os.path.isfile(c):
                return c
    return None


def _num(v: str) -> int:
    try:
        return int(float(v))
    except ValueError:
        return 0


def gpus(max_age: float = 1.0) -> list[Gpu]:
    """Current GPUs and their memory. Cached for a second: the UI polls, nvidia-smi takes ~50 ms."""
    global _cache, _smi_error
    if time.monotonic() - _cache[0] < max_age:
        return _cache[1]
    exe = smi()
    out: list[Gpu] = []
    _smi_error = ""
    if exe is None and apple_silicon():
        out = [apple_gpu()]
    elif exe:
        base = "index,name,memory.total,memory.used,memory.free,utilization.gpu,driver_version"
        for fields in (base + ",compute_cap", base):  # (compute_cap: drivers from 2022 on)
            try:
                p = _run([exe, f"--query-gpu={fields}", "--format=csv,noheader,nounits"])
            except (OSError, subprocess.SubprocessError) as e:
                _smi_error = str(e)
                break
            if p.returncode != 0:
                _smi_error = (p.stderr or p.stdout).strip()[:300]
                continue
            for line in p.stdout.strip().splitlines():
                f = [x.strip() for x in line.split(",")]
                if len(f) < 7:
                    continue
                out.append(Gpu(_num(f[0]), f[1], _num(f[2]) * MiB, _num(f[3]) * MiB, _num(f[4]) * MiB, _num(f[5]),
                               f[6], f[7] if len(f) > 7 and f[7] not in ("[N/A]", "N/A") else ""))
            break
    _cache = (time.monotonic(), out)
    return out


def smi_error() -> str:
    return _smi_error


def invalidate() -> None:
    global _cache
    _cache = (0.0, [])


def gpu_processes() -> dict[int, int]:
    """pid → bytes it holds on the GPUs (CUDA processes only; empty without nvidia-smi or in some containers)."""
    exe = smi()
    if not exe:
        return {}
    try:
        p = _run([exe, "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"])
    except (OSError, subprocess.SubprocessError):
        return {}
    out: dict[int, int] = {}
    for line in p.stdout.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) >= 2 and f[0].isdigit() and _opt(f[1]) is not None:  # ("[N/A]": Windows' WDDM mode)
            out[int(f[0])] = out.get(int(f[0]), 0) + _num(f[1]) * MiB
    return out


def _opt(v: str) -> float | None:
    try:
        return float(v)
    except ValueError:
        return None  # ("[N/A]": a laptop's power, a passive card's fan)


def telemetry() -> list[dict]:
    """What each GPU is doing right now (Voice Studio's overview): load, memory load, temperature, power, clock, fan,
    performance state. Fields the card doesn't report are None."""
    exe = smi()
    if not exe:
        return []
    q = "index,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.sm,clocks.max.sm,fan.speed,pstate"
    try:
        p = _run([exe, f"--query-gpu={q}", "--format=csv,noheader,nounits"])
    except (OSError, subprocess.SubprocessError):
        return []
    out = []
    for line in p.stdout.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 10 or not f[0].isdigit():
            continue
        out.append({"index": int(f[0]), "util": _opt(f[1]), "mem_util": _opt(f[2]), "temperature": _opt(f[3]),
                    "power": _opt(f[4]), "power_limit": _opt(f[5]), "clock": _opt(f[6]), "clock_max": _opt(f[7]),
                    "fan": _opt(f[8]), "pstate": f[9]})
    return out


def gpu_apps() -> list[dict]:
    """The CUDA processes the driver shows here: pid (in this container's namespace), executable, GPU memory (None where
    the driver won't say: Windows' WDDM mode). Other containers' and the host's own processes may be missing (and
    graphics-only ones, Xorg, never appear)."""
    exe = smi()
    if not exe:
        return []
    try:
        p = _run([exe, "--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"])
        u = _run([exe, "--query-gpu=index,uuid", "--format=csv,noheader"])
    except (OSError, subprocess.SubprocessError):
        return []
    index_of = {}
    for line in u.stdout.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) == 2 and f[0].isdigit():
            index_of[f[1]] = int(f[0])
    out = []
    for line in p.stdout.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) >= 4 and f[1].isdigit():
            used = _opt(f[3])
            out.append({"gpu": index_of.get(f[0], 0), "pid": int(f[1]), "name": f[2],
                        "used": int(used * MiB) if used is not None else None})
    return out


def _read(path: str) -> str:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


def host_memory() -> dict:
    """Memory this process can use: the container's cgroup limit when there is one, else the machine's."""
    if not sys.platform.startswith("linux"):
        try:
            import psutil

            vm = psutil.virtual_memory()
            return {"total": int(vm.total), "used": int(vm.total - vm.available), "available": int(vm.available),
                    "limited": False}
        except Exception:  # noqa: BLE001
            return {"total": 0, "used": 0, "available": 0, "limited": False}
    info = {}
    for line in _read("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        if v.strip().endswith("kB"):
            info[k] = int(v.split()[0]) * 1024
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", 0)
    limit = _read("/sys/fs/cgroup/memory.max")
    cur = _read("/sys/fs/cgroup/memory.current")
    if limit and limit != "max" and limit.isdigit():
        lim = int(limit)
        used = int(cur) if cur.isdigit() else 0
        # Page cache counts in memory.current; the kernel reclaims it before OOM, so subtract what is file cache.
        stat = {}
        for line in _read("/sys/fs/cgroup/memory.stat").splitlines():
            k, _, v = line.partition(" ")
            if v.isdigit():
                stat[k] = int(v)
        used_real = max(0, used - stat.get("inactive_file", 0) - stat.get("active_file", 0))
        return {"total": min(lim, total) if total else lim, "used": used_real,
                "available": max(0, min(lim - used_real, avail or lim)), "limited": True}
    return {"total": total, "used": total - avail, "available": avail, "limited": False}


def disk(path: Path) -> dict:
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    try:
        u = shutil.disk_usage(p)
        return {"path": str(path), "total": u.total, "free": u.free}
    except OSError:
        return {"path": str(path), "total": 0, "free": 0}


def cpu() -> dict:
    name = ""
    for line in _read("/proc/cpuinfo").splitlines():
        if line.startswith("model name"):
            name = line.split(":", 1)[1].strip()
            break
    if not name and sys.platform == "darwin":
        name = _sysctl("machdep.cpu.brand_string")
    if not name and os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                name = str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).strip()
        except OSError:
            pass
    return {"name": name or platform.processor() or platform.machine(), "count": os.cpu_count() or 1}


def in_container() -> bool:
    if os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv"):
        return True
    cg = _read("/proc/1/cgroup")
    return any(k in cg for k in ("docker", "containerd", "kubepods", "libpod"))


def nvidia_devices() -> bool:
    """the NVIDIA device nodes are here (a container was given the GPU)"""
    return os.path.exists("/dev/nvidiactl") or any(Path("/dev").glob("nvidia[0-9]*"))


def platform_key() -> str:
    """linux-x86_64 · windows-x86_64 · macos-arm64 … (which engine environments can be installed here)"""
    osname = {"linux": "linux", "win32": "windows", "darwin": "macos"}.get(sys.platform, sys.platform)
    machine = platform.machine().lower()
    machine = {"amd64": "x86_64", "x64": "x86_64", "aarch64": "arm64"}.get(machine, machine)
    return f"{osname}-{machine}"
