"""Can this machine serve local voice models? (docs/local-voice.md "Who can run it")

The engines' environments are torch 2.8 (app/voicehost/runtimes/*.txt, one set per platform). On Linux and Windows
(x86-64) it is built for CUDA 12.8: an NVIDIA GPU of compute capability 7.0 or newer (Volta … Blackwell: the wheels
carry sm_70 – sm_120), a driver that speaks CUDA 12.8 (570 or newer) and room for at least the smallest model. On an
Apple Silicon Mac the engines run on its GPU through Metal (MPS), in the machine's unified memory: macOS 14 or newer
and enough of that memory. Anything short of that is refused up front — the models list still shows what could be
had, the install and load buttons say why not — instead of failing halfway through a 4 GB download or with a CUDA
error on the first sentence. The same holds for a server and for the desktop app's local mode (this machine's own
GPU).
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any

from . import system

MIN_DRIVER = 570              # CUDA 12.8
MIN_CAPABILITY = (7, 0)       # sm_70 … sm_120
MIN_VRAM = 4 * system.GiB     # the smallest useful set (Whisper + OmniVoice) with headroom
MIN_MACOS = (14, 0)           # MPS with bf16, and the onnxruntime the engines pin
MIN_UNIFIED = 8 * system.GiB  # an Apple Silicon Mac: the models share the machine's memory with everything else
# where the engines' locked environments can be installed (runtimes/<name>.<platform>.txt; Linux: <name>.txt)
PLATFORMS = ("linux-x86_64", "windows-x86_64", "macos-arm64")
# the engines' environments are made from the server's own interpreter, and the lock files are for CPython 3.12
PYTHON = (3, 12)
SERVER_PACKAGES = ("numpy", "soundfile", "soxr", "huggingface_hub")


@dataclass
class Gate:
    ok: bool
    code: str  # ok | fake | off | platform | old_os | python | packages | no_gpu | gpu_not_passed | old_driver | old_gpu | small_gpu
    message: str
    gpu: system.Gpu | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "code": self.code, "message": self.message,
                "gpu": self.gpu.to_dict() if self.gpu else None, "detail": self.detail,
                "requirements": {"driver": MIN_DRIVER, "capability": ".".join(map(str, MIN_CAPABILITY)),
                                 "vram": MIN_VRAM, "platforms": list(PLATFORMS),
                                 "python": ".".join(map(str, PYTHON)), "macos": ".".join(map(str, MIN_MACOS)),
                                 "unified": MIN_UNIFIED}}


def _missing_packages() -> list[str]:
    import importlib.util

    return [p for p in SERVER_PACKAGES if importlib.util.find_spec(p) is None]


def device_index(device: str) -> int:
    try:
        return int(device.split(":", 1)[1]) if device.startswith("cuda:") else 0
    except ValueError:
        return 0


def check(engine_mode: str = "real", device: str = "cuda:0") -> Gate:
    if engine_mode == "off":
        return Gate(False, "off", "Local voice models are switched off on this server (VOICE_ENGINE_MODE=off).")
    if engine_mode == "fake":
        missing = _missing_packages()
        if missing:
            return Gate(False, "packages", "This server is missing packages local voice needs: " + ", ".join(missing),
                        detail={"missing": missing})
        return Gate(True, "fake", "A stand-in engine (tests): no GPU is used.")
    plat = system.platform_key()
    if plat not in PLATFORMS:
        return Gate(False, "platform", f"Local voice models can't be installed on {plat} yet "
                                       f"(supported: {', '.join(PLATFORMS)}).", detail={"platform": plat})
    if plat == "macos-arm64":
        have = system.macos_version()
        if have < MIN_MACOS:
            v = ".".join(map(str, have))
            return Gate(False, "old_os", f"macOS {v} is too old for the engines: they need macOS "
                                         f"{'.'.join(map(str, MIN_MACOS))} or newer.", detail={"os": v})
        gpu = (system.gpus(max_age=0.0) or [system.apple_gpu()])[0]
        if gpu.total < MIN_UNIFIED:
            return Gate(False, "small_gpu", f"{gpu.name} has {gpu.total / system.GiB:.0f} GB of memory; local voice "
                                            f"models need at least {MIN_UNIFIED / system.GiB:.0f} GB.", gpu,
                        detail={"min": MIN_UNIFIED})
        return _server_side(gpu) or Gate(True, "ok", f"{gpu.name} · Metal · {gpu.total / system.GiB:.0f} GB unified "
                                                     f"memory · {gpu.driver}", gpu)
    gs = system.gpus(max_age=0.0)
    if not gs:
        if system.in_container() and not system.nvidia_devices():
            return Gate(False, "gpu_not_passed", "No NVIDIA GPU is visible in this container: the host has none, or "
                                                 "it wasn't given to the container (install the NVIDIA Container "
                                                 "Toolkit; compose: deploy.resources.reservations.devices, driver "
                                                 "nvidia — deploy/docker-compose.gpu.yml).",
                        detail={"container": True})
        return Gate(False, "no_gpu", "This machine has no NVIDIA GPU (or its driver isn't installed): local voice "
                                     "models need one.", detail={"nvidia_smi": bool(system.smi()),
                                                                 "error": system.smi_error()})
    idx = device_index(device)
    gpu = next((g for g in gs if g.index == idx), gs[0])
    if gpu.driver_major and gpu.driver_major < MIN_DRIVER:
        return Gate(False, "old_driver", f"The NVIDIA driver {gpu.driver} is too old: CUDA 12.8 needs {MIN_DRIVER} or "
                                         "newer.", gpu)
    cap = gpu.capability_tuple
    if cap is not None and cap < MIN_CAPABILITY:
        return Gate(False, "old_gpu", f"{gpu.name} (compute capability {gpu.capability}) is older than the engines "
                                      f"support (7.0, Volta, or newer).", gpu)
    if gpu.total < MIN_VRAM:
        return Gate(False, "small_gpu", f"{gpu.name} has {gpu.total / system.GiB:.1f} GB of memory; local voice "
                                        f"models need at least {MIN_VRAM / system.GiB:.0f} GB.", gpu)
    return _server_side(gpu) or Gate(True, "ok", f"{gpu.name} · {gpu.total / system.GiB:.1f} GB · driver {gpu.driver}",
                                     gpu)


def _server_side(gpu: system.Gpu) -> Gate | None:
    """what the backend itself needs (last: on a machine without a GPU, that is the reason — not the Python or a
    package it would need afterwards)"""
    if sys.version_info[:2] != PYTHON:
        have, need = f"{sys.version_info[0]}.{sys.version_info[1]}", ".".join(map(str, PYTHON))
        return Gate(False, "python", f"This server runs Python {have}; the engines' environments are made from it and "
                                     f"need Python {need} (the Docker image and the desktop app have it).", gpu,
                    detail={"python": have, "need": need})
    missing = _missing_packages()
    if missing:
        return Gate(False, "packages", "This server is missing packages local voice needs: " + ", ".join(missing),
                    gpu, detail={"missing": missing})
    return None
