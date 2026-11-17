"""What a model brings to a run (run.py does the rest — her utterances, the measurements, the best checkpoint, going
on after leaving the GPU): its own tokens of her utterances, how it speaks a sentence with a reference (or none), LoRA
on its own layers, and its loss for a batch. One per engine: omni.py, qwen.py, cosy.py — each in its engine's runtime.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import numpy as np
import soundfile as sf
import soxr
import torch


def wav(path: str | Path, sr: int) -> np.ndarray:
    a, r = sf.read(str(path), dtype="float32", always_2d=True)
    a = a.mean(axis=1)
    return (soxr.resample(a, r, sr) if r != sr else a).astype(np.float32)


class Recipe:
    engine = ""
    sr = 24_000
    # the references it is measured with: her long clip, a short one, none (a model that can't speak without one
    # leaves "none" out)
    conditions: tuple[str, ...] = ("long", "short", "none")
    batch_tokens = 4096  # a batch's budget, in the units of lengths()
    epochs = 50  # passes over her data (between 200 and 1500 steps)

    def __init__(self, job: dict, dev: torch.device, lang: str, lim: dict) -> None:
        self.job, self.dev, self.lang, self.lim = job, dev, lang, lim
        self.model: Any = None
        self.peft: Any = None

    # -- the model's own --
    def load(self) -> None:
        raise NotImplementedError

    def tokens(self, kept: list[dict], progress: Callable[[int], None]) -> None:
        """her kept utterances (path, text) in the model's own terms, for loss()"""
        raise NotImplementedError

    def prompt(self, ref: dict | None) -> Any:
        """a reference (path, text, seconds) made ready to speak from; None: none"""
        raise NotImplementedError

    def speak(self, sentences: list[str], prompt: Any, check: Callable[[], None]) -> list[np.ndarray]:
        """the sentences at self.sr"""
        raise NotImplementedError

    def measuring(self, on: bool) -> None:
        """around a measurement: what only speaking needs on the GPU"""

    def wrap(self, rank: int) -> list[torch.nn.Parameter]:
        """LoRA on (self.peft) → what is trained"""
        raise NotImplementedError

    def lengths(self) -> list[int]:
        raise NotImplementedError

    def loss(self, idx: list[int]) -> torch.Tensor:
        raise NotImplementedError

    # -- the adapter (peft) --
    def training(self, on: bool) -> None:
        (self.peft or self.model).train(on)

    def lora_state(self) -> dict:
        from peft import get_peft_model_state_dict

        return get_peft_model_state_dict(self.peft)

    def load_lora_state(self, st: dict) -> None:
        from peft import set_peft_model_state_dict

        set_peft_model_state_dict(self.peft, st)

    def save(self, d: Path) -> None:
        self.peft.save_pretrained(str(d))

    def export(self, d: Path) -> None:
        """the best checkpoint → the adapter the engine loads: in bf16 (half the size; it is loaded in the model's own
        dtype anyway)"""
        from safetensors.torch import load_file, save_file

        f = d / "adapter_model.safetensors"
        t = load_file(str(f))
        save_file({k: (v.to(torch.bfloat16) if v.is_floating_point() else v) for k, v in t.items()}, str(f),
                  metadata={"format": "pt"})
        (d / "README.md").unlink(missing_ok=True)


def recipe_for(engine: str) -> type[Recipe]:
    if engine == "omnivoice":
        from .omni import Omni

        return Omni
    if engine == "qwen3_tts":
        from .qwen import Qwen

        return Qwen
    if engine == "cosyvoice3":
        from .cosy import Cosy

        return Cosy
    raise ValueError(f"no training for {engine}")
