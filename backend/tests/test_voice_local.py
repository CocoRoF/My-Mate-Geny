"""Local voice beyond a Linux server (docs/local-voice.md "Who can run it"): the desktop app's local mode on Windows
(an NVIDIA GPU) and on an Apple Silicon Mac (Metal), and what a desktop lacks — its own lock files per platform, MP3
without ffmpeg, the GPU's owners where the driver can't say what each process holds (Windows' WDDM mode, a Mac), and
the server's own values a setting goes back to. No GPU, no downloads: the engines on those platforms are exercised
for real by .github/workflows/voice-local.yml."""

from __future__ import annotations

import io
import re
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.voicehost import audio, gate as G, installer as I, system
from app.voicehost.service import VoiceHost
from app.voicehost.settings import VoiceSettings
from tests.test_voice_studio import vh, vs  # noqa: F401  (the fixtures)
from tests.test_voicehost import _gpu

GiB = 1 << 30


def _apple(total_gb: float = 16) -> system.Gpu:
    t = int(total_gb * GiB)
    return system.Gpu(0, "Apple M2 Pro", t, t // 2, t // 2, 0, "macOS 15.1", "", kind="apple")


# ---- who may run them ----

def test_windows_with_an_nvidia_gpu_and_apple_silicon_macs_may(monkeypatch):
    monkeypatch.setattr(system, "in_container", lambda: False)
    monkeypatch.setattr(system, "platform_key", lambda: "windows-x86_64")
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [_gpu()])
    assert G.check("real").code == "ok"
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [])
    assert G.check("real").code == "no_gpu"  # (a Windows PC without an NVIDIA GPU)

    monkeypatch.setattr(system, "platform_key", lambda: "macos-arm64")
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [_apple()])
    monkeypatch.setattr(system, "macos_version", lambda: (13, 6, 1))
    g = G.check("real")
    assert g.code == "old_os" and g.detail["os"] == "13.6.1" and g.to_dict()["requirements"]["macos"] == "14.0"
    monkeypatch.setattr(system, "macos_version", lambda: (15, 1))
    g = G.check("real")
    assert g.ok and g.gpu.kind == "apple" and "Metal" in g.message
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [_apple(total_gb=6)])
    assert G.check("real").code == "small_gpu"

    for plat in ("macos-x86_64", "windows-arm64", "linux-arm64"):
        monkeypatch.setattr(system, "platform_key", lambda p=plat: p)
        assert G.check("real").code == "platform", plat


def test_an_apple_silicon_mac_runs_on_metal_with_its_own_defaults(monkeypatch):
    from app.config import settings as app_settings

    monkeypatch.setattr(system, "apple_silicon", lambda: True)
    s = VoiceSettings.from_app()
    assert s.device == "mps" and s.vram_budget_fraction == 0.6 and s.park_ram_gb == 0.0
    # (what the admin set stays as it is)
    monkeypatch.setattr(app_settings, "voice_device", "cpu")
    monkeypatch.setattr(app_settings, "voice_vram_budget", 0.4)
    s = VoiceSettings.from_app()
    assert s.device == "cpu" and s.vram_budget_fraction == 0.4
    monkeypatch.setattr(system, "apple_silicon", lambda: False)
    monkeypatch.setattr(app_settings, "voice_device", "cuda:0")
    assert VoiceSettings.from_app().device == "cuda:0"


# ---- each platform's own engine environments ----

def _pins(path) -> dict[str, str]:
    return dict(line.split("==", 1) for line in path.read_text().splitlines() if line and not line.startswith("#"))


@pytest.mark.parametrize("rt", I.RUNTIMES, ids=lambda r: r.name)
def test_each_platform_has_its_own_lock_with_the_benchmarked_pins(rt, tmp_path, monkeypatch):
    inst = I.Installer(VoiceSettings(home=tmp_path), store=None)
    locks = {}
    for plat in ("linux-x86_64", "windows-x86_64", "macos-arm64"):
        monkeypatch.setattr(system, "platform_key", lambda p=plat: p)
        locks[plat] = inst.lock_path(rt)
    assert locks["linux-x86_64"].name == rt.lock
    assert locks["windows-x86_64"].name == rt.lock.replace(".txt", ".windows-x86_64.txt")
    assert locks["macos-arm64"].name == rt.lock.replace(".txt", ".macos-arm64.txt")
    linux, win, mac = (_pins(locks[p]) for p in ("linux-x86_64", "windows-x86_64", "macos-arm64"))
    for other in (win, mac):
        assert not any(re.match(r"nvidia-|triton$", k) for k in other)  # (Linux-only CUDA wheels)
        for k, v in other.items():  # the same versions as the environment benchmarked on Linux
            if k in linux:
                assert v == linux[k] or (k in ("torch", "torchaudio") and v == linux[k].split("+")[0]), k
        assert set(linux) - set(other) <= {k for k in linux if k.startswith("nvidia-") or k == "triton"}
    assert win["torch"].endswith("+cu128") and "colorama" in win  # (CUDA on Windows; click / tqdm need colorama there)
    assert "+" not in mac["torch"]  # (PyPI's torch: Metal)


async def test_the_install_uses_the_cuda_index_only_for_cuda_builds(tmp_path, monkeypatch):
    commands: list[list[str]] = []

    async def run(self, cmd, env, p, model_id):
        commands.append(cmd)
        if "venv" in cmd:
            Path(cmd[-1]).mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(I.Installer, "_run", run)
    s = VoiceSettings(home=tmp_path)
    s.ensure_dirs()
    monkeypatch.setattr(VoiceSettings, "uv", lambda self: ["uv"])
    inst = I.Installer(s, store=None)
    omni = next(r for r in I.RUNTIMES if r.name == "omni")
    for plat, cuda in (("windows-x86_64", True), ("macos-arm64", False), ("linux-x86_64", True)):
        monkeypatch.setattr(system, "platform_key", lambda p=plat: p)
        commands.clear()
        await inst._install_runtime(omni, I.Progress(), "omnivoice")
        pip = next(c for c in commands if "pip" in c)
        assert pip[pip.index("-r") + 1].endswith(inst.lock_path(omni).name)
        assert (I.TORCH_INDEX in pip) is cuda, plat
        assert "--no-deps" in pip


# ---- what a desktop lacks ----

def test_mp3_without_ffmpeg(tmp_path, monkeypatch):
    sr = 24000
    x = (0.3 * np.sin(2 * np.pi * 220 * np.arange(sr * 2) / sr)).astype(np.float32)
    path = tmp_path / "line.wav"
    sf.write(str(path), x, sr, subtype="PCM_16")
    monkeypatch.setattr(audio, "_ffmpeg", lambda: None)
    data = audio.encode(path, "mp3")
    back, back_sr = sf.read(io.BytesIO(data), dtype="float32")
    assert back_sr == sr and abs(len(back) / sr - 2.0) < 0.2 and np.abs(back).max() > 0.1
    assert audio.encode(path, "ogg") and audio.encode(path, "flac")


async def test_where_the_driver_cant_say_the_worker_measures(vh, monkeypatch):
    await vh.generate(model_id="omnivoice", text="warm up", mode="auto")
    r = next(iter(vh.engines.residents.values()))
    r.last_memory = {"allocated": 2 << 30, "reserved": 3 << 30}
    # Windows (WDDM): nvidia-smi lists the processes but not what each holds
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [system.Gpu(0, "RTX 4070", 12 << 30, 6 << 30, 6 << 30, 20,
                                                                        "581.57", "8.9")])
    monkeypatch.setattr(system, "telemetry", lambda: [])
    monkeypatch.setattr(system, "gpu_apps", lambda: [{"gpu": 0, "pid": r.worker.pid, "name": "python.exe", "used": None},
                                                     {"gpu": 0, "pid": 777, "name": "C:\\Games\\game.exe", "used": None}])
    u = vh.overview("ko")["gpus"][0]["usage"]
    assert u["ours"] == [{"model_id": "omnivoice", "name": "OmniVoice", "pid": r.worker.pid, "bytes": 3 << 30,
                          "measured": "worker"}]
    assert u["others"] == [{"pid": 777, "name": "C:\\Games\\game.exe", "bytes": None}] and u["unseen"] == 3 << 30
    # an Apple Silicon Mac: no per-process list at all
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [_apple()])
    monkeypatch.setattr(system, "gpu_apps", lambda: [])
    o = vh.overview("ko")
    assert o["gpus"][0]["kind"] == "apple" and o["gpus"][0]["usage"]["ours"][0]["bytes"] == 3 << 30
    assert vh._sample()[0]["ours"] == 3 << 30


async def test_a_setting_goes_back_to_the_servers_own_value(db, tmp_path):
    s = VoiceSettings(home=tmp_path / "voice", engine_mode="fake", vram_budget_fraction=0.6, park_ram_gb=0.0)
    s.ensure_dirs()
    h = VoiceHost(db, s)
    doc = h.put_settings({"vram_budget_fraction": 0.9, "park_ram_gb": 4})
    assert doc["values"]["vram_budget_fraction"] == 0.9 and doc["defaults"]["vram_budget_fraction"] == 0.6
    doc = h.put_settings({"vram_budget_fraction": None, "park_ram_gb": None})
    assert h.s.vram_budget_fraction == 0.6 and h.s.park_ram_gb == 0.0 and doc["defaults"]["park_ram_gb"] == 0.0
