"""Local voice settings, from the app's settings (VOICE_* in the environment / backend/.env; docs/local-voice.md)."""

from __future__ import annotations

import importlib.util
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class VoiceSettings:
    home: Path
    # "real" spawns engine workers in their own environments; "fake" a synthetic engine (tests, no GPU); "off" disables
    engine_mode: str = "real"
    device: str = "cuda:0"
    # share of the GPU's memory our resident models may fill before the least recently used one goes
    vram_budget_fraction: float = 0.85
    # off the GPU this long after its last use (0 = keep it until another needs the room)
    idle_unload_seconds: float = 600.0
    # a parked model's process is stopped after this long (frees its host RAM and CUDA context); 0 = never
    parked_ttl_seconds: float = 1800.0
    # host RAM parked weights may take in total; beyond it an evicted model is stopped instead
    park_ram_gb: float = 6.0
    max_text_chars: int = 5000
    # Voice Studio's history: at most this many lines and this much audio (the oldest unstarred go first)
    history_max_entries: int = 2000
    history_max_gb: float = 5.0
    max_upload_mb: int = 50
    # longest reference kept after trimming (s): the engines clone best from 3–15 s
    max_reference_seconds: float = 30.0
    hf_endpoint: str = ""
    models_dir_override: str = ""
    runtimes_dir_override: str = ""
    # engine name → interpreter (development: an environment made by hand); missing → the installed runtime
    engine_python: dict[str, str] = field(default_factory=dict)

    @property
    def models_dir(self) -> Path:
        return Path(self.models_dir_override).expanduser() if self.models_dir_override else self.home / "models"

    @property
    def runtimes_dir(self) -> Path:
        return Path(self.runtimes_dir_override).expanduser() if self.runtimes_dir_override else self.home / "runtimes"

    @property
    def refs_dir(self) -> Path:
        return self.home / "references"

    @property
    def tmp_dir(self) -> Path:
        return self.home / "tmp"

    @property
    def runtimes_spec_dir(self) -> Path:
        return Path(__file__).resolve().parent / "runtimes"

    def ensure_dirs(self) -> None:
        for d in (self.home, self.models_dir, self.runtimes_dir, self.refs_dir, self.tmp_dir):
            d.mkdir(parents=True, exist_ok=True)

    def uv(self) -> list[str] | None:
        """uv: the one installed with the backend (the desktop app bundles it), else one on PATH."""
        if importlib.util.find_spec("uv") is not None:
            return [sys.executable, "-m", "uv"]
        found = shutil.which("uv")
        return [found] if found else None

    @property
    def python(self) -> str:
        """the interpreter engine environments are made from: the backend's own (the lock files are for CPython 3.12)"""
        return sys.executable

    @classmethod
    def from_app(cls) -> "VoiceSettings":
        from app.config import Settings, settings as s

        from . import system

        device, budget, park = s.voice_device, s.voice_vram_budget, s.voice_park_ram_gb
        if system.apple_silicon():
            # An Apple Silicon Mac (the desktop app's local mode): the engines run on its GPU through Metal, in the
            # memory everything else on the machine uses too — a smaller share by default, and no parking (moving
            # the weights "off the GPU" would keep them in the same memory).
            default = {k: f.default for k, f in Settings.model_fields.items()}
            if device == default["voice_device"]:
                device = "mps"
            if budget == default["voice_vram_budget"]:
                budget = 0.6
            if park == default["voice_park_ram_gb"]:
                park = 0.0
        return cls(
            home=Path(s.voice_home).expanduser() if s.voice_home else s.home_dir / "voice",
            engine_mode=s.voice_engine_mode,
            device=device,
            vram_budget_fraction=budget,
            idle_unload_seconds=s.voice_idle_unload_seconds,
            parked_ttl_seconds=s.voice_parked_ttl_seconds,
            park_ram_gb=park,
            hf_endpoint=s.voice_hf_endpoint,
            models_dir_override=s.voice_models_dir,
            runtimes_dir_override=s.voice_runtimes_dir,
        )
