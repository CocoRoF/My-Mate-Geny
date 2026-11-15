"""Image Studio's settings, from the app's settings (IMAGE_* in the environment / backend/.env; docs/local-image.md)."""

from __future__ import annotations

import importlib.util
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ImageSettings:
    home: Path
    # "real" runs ComfyUI; "fake" a stand-in that makes plain pictures and clips (tests, no GPU); "off" disables
    engine_mode: str = "real"
    device: str = "cuda:0"
    # the engine is stopped after this long without a job: its VRAM goes back to the voice models
    idle_stop_seconds: float = 120.0
    hf_endpoint: str = ""
    models_dir_override: str = ""
    # the GPU memory the engine leaves free for the voice models (GB); -1: automatic — what a call holds plus the
    # default speech model, so the mates still speak while a picture or a clip is made (docs/local-image.md)
    voice_room_gb: float = -1.0
    # ComfyUI's memory flags besides its reserve (measured on a 12 GB card: docs/local-image.md "Measured")
    comfy_flags: tuple[str, ...] = ("--disable-pinned-memory",)

    @property
    def models_dir(self) -> Path:
        return Path(self.models_dir_override).expanduser() if self.models_dir_override else self.home / "models"

    @property
    def runtime_dir(self) -> Path:
        """the engine: ComfyUI's source and its Python environment"""
        return self.home / "engine"

    @property
    def work_dir(self) -> Path:
        """ComfyUI's input and output folders (temporary: results move to the history)"""
        return self.home / "work"

    @property
    def history_dir(self) -> Path:
        return self.home / "history"

    @property
    def tmp_dir(self) -> Path:
        return self.home / "tmp"

    def uv(self) -> list[str] | None:
        """uv: the one installed with the backend (the desktop app bundles it), else one on PATH"""
        if importlib.util.find_spec("uv") is not None:
            return [sys.executable, "-m", "uv"]
        found = shutil.which("uv")
        return [found] if found else None

    @property
    def python(self) -> str:
        """the interpreter the engine's environment is made from: the backend's own (the lock file is for 3.12)"""
        return sys.executable

    def ensure_dirs(self) -> None:
        for d in (self.home, self.models_dir, self.runtime_dir, self.work_dir, self.history_dir, self.tmp_dir):
            d.mkdir(parents=True, exist_ok=True)

    @classmethod
    def from_app(cls) -> "ImageSettings":
        from app.config import settings as s

        return cls(
            home=Path(s.image_home).expanduser() if s.image_home else s.home_dir / "image",
            engine_mode=s.image_engine_mode,
            device=s.image_device,
            idle_stop_seconds=s.image_idle_stop_seconds,
            hf_endpoint=s.image_hf_endpoint,
            models_dir_override=s.image_models_dir,
        )
