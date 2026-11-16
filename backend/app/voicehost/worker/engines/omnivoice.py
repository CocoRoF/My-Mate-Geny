"""OmniVoice (k2-fsa): non-autoregressive diffusion-LM TTS with cloning, voice design and auto voice — and a voice's
own trained adapter (a LoRA from app/voicehost/train), switched per line: loaded the first time, kept (the last few),
off for a voice without one."""

from __future__ import annotations

import hashlib
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .base import Engine, SynthRequest

_GEN_KEYS = ("num_step", "guidance_scale", "t_shift", "denoise", "position_temperature", "class_temperature",
             "layer_penalty_factor", "audio_chunk_duration", "audio_chunk_threshold")


KEEP_ADAPTERS = 4  # (≈ 55 MB each on the GPU)


def _adapter_name(path: str) -> str:
    """a name for peft: the adapter's directory and when its weights were written (a new training is a new name)"""
    p = Path(path) / "adapter_model.safetensors"
    stamp = p.stat().st_mtime_ns if p.exists() else 0
    return "v" + hashlib.sha1(f"{path}:{stamp}".encode()).hexdigest()[:12]


class OmniVoiceEngine(Engine):
    name = "omnivoice"
    peft: Any = None

    def load(self) -> None:
        from omnivoice import OmniVoice

        # bf16 keeps the diffusion steps stable where fp16 can overflow; the worker picks bf16 on Ampere+.
        self.model = OmniVoice.from_pretrained(str(self.model_dir), device_map=self.dev.device, dtype=self.dev.dtype)
        self.model.eval()
        self.sample_rate = int(getattr(self.model, "sampling_rate", 24000))

    def modules(self) -> list:
        return [self.model]  # the audio tokenizer is a registered submodule (an adapter's layers are inside it too)

    def _use_adapter(self, path: str) -> None:
        """the voice's adapter on, or none: the model as it came"""
        if not path:
            if self.peft is not None:
                self.peft.base_model.disable_adapter_layers()
            return
        from peft import PeftModel

        name = _adapter_name(path)
        if self.peft is None:
            self._adapters: OrderedDict[str, str] = OrderedDict()
            self.peft = PeftModel.from_pretrained(self.model, path, adapter_name=name, is_trainable=False,
                                                  autocast_adapter_dtype=False)
        elif name not in self.peft.peft_config:
            self.peft.load_adapter(path, adapter_name=name, is_trainable=False, autocast_adapter_dtype=False)
        self._adapters[name] = path
        self._adapters.move_to_end(name)
        while len(self._adapters) > KEEP_ADAPTERS:
            old, _ = self._adapters.popitem(last=False)
            if old != name:
                self.peft.delete_adapter(old)
        self.peft.set_adapter(name)
        self.peft.base_model.enable_adapter_layers()
        self.model.eval()

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
        self._use_adapter(req.adapter)
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
