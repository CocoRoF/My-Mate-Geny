"""A synthetic engine for tests and GPU-less development: tones whose length follows the text."""

from __future__ import annotations

from typing import Any

import numpy as np

from .base import Engine, SynthRequest


class FakeEngine(Engine):
    name = "fake"

    def load(self) -> None:
        self.loaded = True

    def synthesize(self, req: SynthRequest) -> list[np.ndarray]:
        if req.reference is None and not req.instruct and self.options.get("needs_reference"):
            raise ValueError("레퍼런스 오디오가 필요합니다")
        speed = float(req.params.get("speed", 1.0))
        out = []
        for text in req.text:
            n = int(self.sample_rate * max(0.3, 0.06 * len(text)) / speed)
            t = np.arange(n) / self.sample_rate
            f0 = 180 + (sum(map(ord, text)) % 80)
            out.append((0.2 * np.sin(2 * np.pi * f0 * t)).astype(np.float32))
        return out

    def transcribe(self, path: str, language: str = "auto") -> dict[str, Any]:
        import soundfile as sf

        info = sf.info(path)
        return {"text": f"가짜 전사 {info.duration:.1f}초", "language": language if language != "auto" else "ko"}
