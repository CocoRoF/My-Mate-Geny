"""VoxCPM2 (OpenBMB, 2B, 48 kHz): tokenizer-free TTS that clones a voice by continuing its clip — the clip's words and
sound, then the line ("ultimate" cloning: its timbre, pace and way of talking) — or from the clip alone, makes a
voice from a description, and speaks in a voice of its own; and a voice's own trained adapter (a LoRA on its LM and
its DiT, from app/voicehost/train), switched per line.

VoxCPM's LoRA is its own (not peft): the layers are made once, with one configuration (LORA, shared with the
trainer), and an adapter's weights are copied into them — none: the layers off. torch.compile (VoxCPM's ``optimize``)
needs a C compiler and Python's headers: off unless the model's load options turn it on.

Upstream builds the model in fp32 on the CPU and casts it after: ~9 GB of RAM, and its checkpoint read on top of that.
On a GPU it is built there in bf16 instead (``built_on``), and the RAM holds only the checkpoint while it is read; on
the CPU in bf16 (what it runs in there too), half of it. On a Mac's GPU (Metal) upstream keeps fp32 — bf16 drifts
there until the line is garbled —, built as upstream builds it.
"""

from __future__ import annotations

import contextlib
from typing import Any

import numpy as np
import torch

from .base import Adapters, Engine, SynthRequest

# every VoxCPM2 adapter's LoRA (train/vox.py makes them so): on the LM and the DiT, rank 16
LORA = {"enable_lm": True, "enable_dit": True, "enable_proj": False, "r": 16, "alpha": 32, "dropout": 0.0}
_GEN_KEYS = ("cfg_value", "inference_timesteps")


def lora_config():
    from voxcpm.model.voxcpm2 import LoRAConfig

    return LoRAConfig(**LORA)


@contextlib.contextmanager
def built_on(device: str):
    """VoxCPM2 made on the GPU in bf16 (what it speaks in there) rather than in fp32 on the CPU: the same numbers — its
    rotary tables are made in fp32 by name, its audio VAE is put in fp32 before its weights are copied in, the rest is
    its checkpoint's — at half the memory, none of it the machine's (the CPU: half the machine's)"""
    if not (device.startswith("cuda") or device == "cpu"):  # (Metal: fp32, as upstream has it)
        yield
        return
    was = torch.get_default_dtype()
    torch.set_default_dtype(torch.bfloat16)
    try:
        with torch.device(device):
            yield
    finally:
        torch.set_default_dtype(was)


class VoxCPMEngine(Engine):
    name = "voxcpm"

    def load(self) -> None:
        from voxcpm.core import VoxCPM

        dev = str(getattr(self.dev, "device", "cuda"))
        with built_on(dev):
            self.vox = VoxCPM(str(self.model_dir), zipenhancer_model_path=None, enable_denoiser=False,
                              optimize=bool(self.options.get("optimize", False)), device=dev, lora_config=lora_config())
        self.model = self.vox.tts_model
        self.model.eval()
        self.model.set_lora_enabled(False)
        self.sample_rate = int(self.model.sample_rate)
        self.adapter = ""  # (the adapter in the LoRA layers now: Adapters.name_of)

    def modules(self) -> list:
        return [self.model]

    def _use_adapter(self, path: str) -> None:
        if not path:
            self.model.set_lora_enabled(False)
            return
        name = Adapters.name_of(path)
        if name != self.adapter:
            from pathlib import Path

            loaded, skipped = self.model.load_lora_weights(str(Path(path) / "adapter_model.safetensors"))
            if skipped or not loaded:
                raise RuntimeError(f"this VoxCPM2 adapter doesn't fit ({len(skipped)} of its weights)")
            self.adapter = name
        self.model.set_lora_enabled(True)

    def _cache(self, req: SynthRequest, continue_clip: bool):
        """the clip encoded once (its sound, and its words to go on from): the same for every adapter"""
        ref = req.reference
        key = ref.key(continue_clip)
        cache = self.prompts.get(key)
        if cache is None:
            if continue_clip:
                cache = self.model.build_prompt_cache(prompt_text=ref.text.strip(), prompt_wav_path=ref.path,
                                                      reference_wav_path=ref.path)
            else:
                cache = self.model.build_prompt_cache(reference_wav_path=ref.path)
            self.prompts.put(key, cache)
        return cache

    @torch.inference_mode()
    def synthesize(self, req: SynthRequest) -> list[np.ndarray]:
        from voxcpm.model.utils import next_and_close

        self._use_adapter(req.adapter)
        p = req.params
        kw: dict[str, Any] = {"cfg_value": float(p.get("cfg_value", 2.0)),
                              "inference_timesteps": int(p.get("inference_timesteps", 10))}
        instruct = req.instruct.strip()
        cache = None
        if req.reference is not None:
            # (a description steers a clip's voice; without one the clip's own words are gone on from)
            cache = self._cache(req, continue_clip=bool(req.reference.text.strip()) and not instruct)
        outs: list[np.ndarray] = []
        for text in req.text:
            line = f"({instruct}){text}" if instruct else text
            wav, _, _ = next_and_close(self.model._generate_with_prompt_cache(
                target_text=" ".join(line.split()), prompt_cache=cache, min_len=2, max_len=4096, retry_badcase=True,
                retry_badcase_max_times=3, retry_badcase_ratio_threshold=6.0, streaming=False, **kw))
            outs.append(wav.squeeze(0).float().cpu().numpy().reshape(-1))
        return outs

    def warmup(self) -> None:
        self.synthesize(SynthRequest(text=["안녕하세요."], language="ko"))
