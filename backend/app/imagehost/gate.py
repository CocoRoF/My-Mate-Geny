"""Can this machine run the image engine? (docs/local-image.md "Who can run it")

The engine's environment is torch 2.14 (runtimes/comfy[.<platform>].txt). On Linux and Windows (x86-64) it is built
for CUDA 13.0 — the only build of that torch with Blackwell (RTX 50) kernels: an NVIDIA GPU of compute capability 7.5
or newer (Turing … Blackwell: the wheels carry sm_75 – sm_120), a driver that speaks CUDA 13.0 (580 or newer) and room
for the smallest recipe (8 GB: a draft model at its measured 6.1 GB peak, with headroom). On an Apple Silicon Mac it
runs on the GPU through Metal, in the machine's unified memory. Anything short of that is refused up front: the models
list still shows what could be had, the install buttons say why not.
"""

from __future__ import annotations

import sys

from app.voicehost import system
from app.voicehost.gate import MIN_MACOS, PLATFORMS, PYTHON, Gate, device_index

MIN_DRIVER = 580              # CUDA 13.0
MIN_CAPABILITY = (7, 5)       # sm_75 … sm_120
MIN_VRAM = 8 * system.GiB     # a draft model at its peak (6.1 GB measured) with headroom
MIN_UNIFIED = 16 * system.GiB  # an Apple Silicon Mac: the model and the system share it


class ImageGate(Gate):
    def to_dict(self) -> dict:
        d = super().to_dict()
        d["requirements"] = {"driver": MIN_DRIVER, "capability": ".".join(map(str, MIN_CAPABILITY)), "vram": MIN_VRAM,
                             "unified": MIN_UNIFIED, "platforms": list(PLATFORMS),
                             "python": ".".join(map(str, PYTHON)), "macos": ".".join(map(str, MIN_MACOS))}
        return d


def check(engine_mode: str = "real", device: str = "cuda:0") -> ImageGate:
    g = _check(engine_mode, device)
    return ImageGate(g.ok, g.code, g.message, g.gpu, g.detail)


def _check(engine_mode: str, device: str) -> Gate:
    if engine_mode == "off":
        return Gate(False, "off", "Local image models are switched off on this server (IMAGE_ENGINE_MODE=off).")
    if engine_mode == "fake":
        return Gate(True, "fake", "A stand-in engine (tests): no GPU is used.")
    plat = system.platform_key()
    if plat not in PLATFORMS:
        return Gate(False, "platform", f"Local image models can't be installed on {plat} yet "
                                       f"(supported: {', '.join(PLATFORMS)}).", detail={"platform": plat})
    if plat == "macos-arm64":
        have = system.macos_version()
        if have < MIN_MACOS:
            v = ".".join(map(str, have))
            return Gate(False, "old_os", f"macOS {v} is too old for the image engine: it needs macOS "
                                         f"{'.'.join(map(str, MIN_MACOS))} or newer.", detail={"os": v})
        gpu = (system.gpus(max_age=0.0) or [system.apple_gpu()])[0]
        if gpu.total < MIN_UNIFIED:
            return Gate(False, "small_gpu", f"{gpu.name} has {gpu.total / system.GiB:.0f} GB of memory; local image "
                                            f"models need at least {MIN_UNIFIED / system.GiB:.0f} GB.", gpu)
        return _python(gpu) or Gate(True, "ok", f"{gpu.name} · Metal · {gpu.total / system.GiB:.0f} GB unified memory",
                                    gpu)
    gs = system.gpus(max_age=0.0)
    if not gs:
        if system.in_container() and not system.nvidia_devices():
            return Gate(False, "gpu_not_passed", "No NVIDIA GPU is visible in this container: the host has none, or "
                                                 "it wasn't given to the container (deploy/docker-compose.gpu.yml).",
                        detail={"container": True})
        return Gate(False, "no_gpu", "This machine has no NVIDIA GPU (or its driver isn't installed): local image "
                                     "models need one.", detail={"error": system.smi_error()})
    idx = device_index(device)
    gpu = next((g for g in gs if g.index == idx), gs[0])
    if gpu.driver_major and gpu.driver_major < MIN_DRIVER:
        return Gate(False, "old_driver", f"The NVIDIA driver {gpu.driver} is too old for the image engine: CUDA 13.0 "
                                         f"needs {MIN_DRIVER} or newer.", gpu)
    cap = gpu.capability_tuple
    if cap is not None and cap < MIN_CAPABILITY:
        return Gate(False, "old_gpu", f"{gpu.name} (compute capability {gpu.capability}) is older than the image "
                                      "engine supports (7.5, Turing, or newer).", gpu)
    if gpu.total < MIN_VRAM:
        return Gate(False, "small_gpu", f"{gpu.name} has {gpu.total / system.GiB:.1f} GB of memory; local image "
                                        f"models need at least {MIN_VRAM / system.GiB:.0f} GB.", gpu)
    return _python(gpu) or Gate(True, "ok", f"{gpu.name} · {gpu.total / system.GiB:.1f} GB · driver {gpu.driver}", gpu)


def _python(gpu: system.Gpu) -> Gate | None:
    if sys.version_info[:2] != PYTHON:
        have, need = f"{sys.version_info[0]}.{sys.version_info[1]}", ".".join(map(str, PYTHON))
        return Gate(False, "python", f"This server runs Python {have}; the image engine's environment is made from it "
                                     f"and needs Python {need}.", gpu, detail={"python": have, "need": need})
    return None
