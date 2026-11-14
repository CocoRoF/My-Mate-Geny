"""GPU discovery and memory bookkeeping inside an engine worker.

Runs in the engine's own environment (torch is available here, never in the server process). The worker picks the
device and dtype from what the GPU can do instead of trusting a config: bf16 on Ampere and newer, fp16 on Volta/Turing,
fp32 on CPU or anything older.
"""

from __future__ import annotations

import gc
import os
import time
from dataclasses import dataclass
from typing import Any

import torch


@dataclass
class Device:
    device: str  # "cuda:0" | "cpu"
    dtype: torch.dtype
    name: str
    capability: tuple[int, int] | None
    total_bytes: int

    @property
    def is_cuda(self) -> bool:
        return self.device.startswith("cuda")

    def describe(self) -> dict[str, Any]:
        return {
            "device": self.device,
            "dtype": str(self.dtype).replace("torch.", ""),
            "name": self.name,
            "capability": list(self.capability) if self.capability else None,
            "total_bytes": self.total_bytes,
        }


def pick_device(requested: str = "cuda:0", dtype: str = "auto") -> Device:
    if requested.startswith("cuda") and torch.cuda.is_available():
        idx = int(requested.split(":", 1)[1]) if ":" in requested else 0
        idx = min(idx, torch.cuda.device_count() - 1)
        torch.cuda.set_device(idx)
        props = torch.cuda.get_device_properties(idx)
        cap = (props.major, props.minor)
        if dtype == "auto":
            dt = torch.bfloat16 if cap >= (8, 0) else torch.float16 if cap >= (7, 0) else torch.float32
        else:
            dt = getattr(torch, dtype)
        # TF32 matmuls are free speed on Ampere+ and do not change fp16/bf16 paths.
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        return Device(f"cuda:{idx}", dt, props.name, cap, props.total_memory)
    threads = int(os.environ.get("GENY_VOICE_CPU_THREADS", "0")) or max(1, (os.cpu_count() or 2) - 1)
    torch.set_num_threads(threads)
    return Device("cpu", torch.float32 if dtype == "auto" else getattr(torch, dtype), "CPU", None, 0)


def memory(dev: Device) -> dict[str, Any]:
    if not dev.is_cuda:
        return {"allocated": 0, "reserved": 0, "peak_allocated": 0, "peak_reserved": 0}
    return {
        "allocated": torch.cuda.memory_allocated(),
        "reserved": torch.cuda.memory_reserved(),
        "peak_allocated": torch.cuda.max_memory_allocated(),
        "peak_reserved": torch.cuda.max_memory_reserved(),
    }


def device_free(dev: Device) -> dict[str, int]:
    if not dev.is_cuda:
        return {}
    free, total = torch.cuda.mem_get_info()
    return {"free": free, "total": total}


def release_cache(dev: Device) -> None:
    gc.collect()
    if dev.is_cuda:
        torch.cuda.synchronize()
        torch.cuda.empty_cache()


def reset_peak(dev: Device) -> None:
    if dev.is_cuda:
        torch.cuda.reset_peak_memory_stats()


def sync(dev: Device) -> None:
    if dev.is_cuda:
        torch.cuda.synchronize()


def seed_everything(seed: int) -> None:
    import random

    import numpy as np

    random.seed(seed)
    np.random.seed(seed % (2**32))
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


class Parker:
    """Moves a model's tensors between the GPU and host memory.

    Parking keeps the process (its imported libraries and CUDA context) alive while giving the GPU memory back;
    resuming is then a host-to-device copy instead of a cold start (process + imports + disk read + init). Plain
    pageable memory on purpose: measured on the RTX 5070 host, resume runs at ~11.7 GB/s pageable vs 12.6 GB/s
    pinned, park at 2.9 vs 12.7 GB/s, and large page-locked allocations there fail ("invalid argument" at >= 1 GiB)
    and cannot be swapped -- a parked model must never be able to wedge the machine.
    """

    def __init__(self) -> None:
        self.parked = False

    @staticmethod
    def _tensors(modules: list[torch.nn.Module]):
        seen: set[int] = set()
        for m in modules:
            for t in list(m.parameters()) + list(m.buffers()):
                if id(t) not in seen:
                    seen.add(id(t))
                    yield t

    def park(self, modules: list[torch.nn.Module]) -> float:
        t0 = time.perf_counter()
        for t in self._tensors(modules):
            if t.device.type == "cuda":
                t.data = t.data.to("cpu")
        torch.cuda.synchronize()
        self.parked = True
        return time.perf_counter() - t0

    def resume(self, modules: list[torch.nn.Module], device: str) -> float:
        t0 = time.perf_counter()
        for t in self._tensors(modules):
            if t.device.type == "cpu":
                t.data = t.data.to(device, non_blocking=True)
        torch.cuda.synchronize()
        self.parked = False
        return time.perf_counter() - t0
