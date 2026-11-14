"""OmniVoice (k2-fsa): non-autoregressive diffusion-LM TTS with cloning, voice design and auto voice."""

from __future__ import annotations

from typing import Any

import numpy as np
import torch

from .base import Engine, SynthRequest

_GEN_KEYS = ("num_step", "guidance_scale", "t_shift", "denoise", "position_temperature", "class_temperature",
             "layer_penalty_factor", "audio_chunk_duration", "audio_chunk_threshold")


class OmniVoiceEngine(Engine):
    name = "omnivoice"

    def load(self) -> None:
        from omnivoice import OmniVoice

        # bf16 keeps the diffusion steps stable where fp16 can overflow; the worker picks bf16 on Ampere+.
        self.model = OmniVoice.from_pretrained(str(self.model_dir), device_map=self.dev.device, dtype=self.dev.dtype)
        self.model.eval()
        self.sample_rate = int(getattr(self.model, "sampling_rate", 24000))

    def modules(self) -> list:
        return [self.model]  # the audio tokenizer is a registered submodule

    def _prompt(self, req: SynthRequest):
        ref = req.reference
        key = ref.key()
        prompt = self.prompts.get(key)
        if prompt is None:
            prompt = self.model.create_voice_clone_prompt(ref_audio=ref.path, ref_text=ref.text or None)
            self.prompts.put(key, prompt)
        return prompt

    @torch.inference_mode()
    def synthesize(self, req: SynthRequest) -> list[np.ndarray]:
        p = req.params
        n = len(req.text)
        kwargs: dict[str, Any] = {k: p[k] for k in _GEN_KEYS if k in p}
        lang = None if (req.language or "auto") == "auto" else req.language
        if lang:
            kwargs["language"] = [lang] * n
        if req.reference is not None:
            if not req.reference.text.strip():
                raise ValueError("OmniVoice 복제에는 레퍼런스 전사가 필요합니다 (자동 전사를 쓰세요)")
            kwargs["voice_clone_prompt"] = [self._prompt(req)] * n
        if req.instruct.strip():
            kwargs["instruct"] = [req.instruct.strip()] * n
        if p.get("duration"):
            kwargs["duration"] = [float(p["duration"])] * n
        elif p.get("speed") and abs(float(p["speed"]) - 1.0) > 1e-3:
            kwargs["speed"] = [float(p["speed"])] * n
        audios = self.model.generate(text=list(req.text), **kwargs)
        return [np.asarray(a, dtype=np.float32).reshape(-1) for a in audios]

    def warmup(self) -> None:
        self.synthesize(SynthRequest(text=["warm up"], language="en", params={"num_step": 4}))
