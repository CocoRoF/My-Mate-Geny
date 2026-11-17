"""VoxCPM2's part of a run (the vox runtime: voxcpm without its own training stack): her utterances as text ids and 16 kHz
audio, speaking for a measurement (going on from her clip and its words; none: its own voice — or, trained, hers), and
its own loss.

VoxCPM's LoRA (not peft: engines/voxcpm.py LORA, the same layers the engine loads an adapter into) on the LM and the
DiT; VoxCPM2's own objective (the diffusion loss on the audio latents and the stop loss) from its own packer — half
the samples with another of her utterances as the reference (its tokens kept apart, not learned), as a clip is used
when she speaks. The frozen weights in bf16 (as it speaks), the LoRA in fp32 under bf16 autocast; the audio VAE in
fp32, as upstream keeps it; each transformer layer recomputed in the backward pass (gradient checkpointing).
"""

from __future__ import annotations

import importlib.util
import random
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .recipe import Recipe, wav

PROMPT_MAX_S = 8.0  # a reference utterance at most this long


def _packers():
    """voxcpm.training's packer, without voxcpm.training (its __init__ wants the datasets stack, not installed)"""
    import voxcpm

    p = Path(voxcpm.__file__).parent / "training" / "packers.py"
    spec = importlib.util.spec_from_file_location("voxcpm_training_packers", p)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _checkpointed(layer: torch.nn.Module) -> None:
    forward = layer.forward

    def run(*args, **kwargs):
        if layer.training and torch.is_grad_enabled():
            from torch.utils.checkpoint import checkpoint

            return checkpoint(forward, *args, use_reentrant=False, **kwargs)
        return forward(*args, **kwargs)

    layer.forward = run


class Vox(Recipe):
    engine = "voxcpm"
    sr = 48_000
    batch_tokens = 1024  # (VoxCPM2's LM runs at 6.25 patches a second: a few hundred positions an utterance)
    epochs = 40

    def load(self) -> None:
        from voxcpm.model.voxcpm2 import VoxCPM2Model

        from app.voicehost.worker.engines.voxcpm import built_on, lora_config

        with built_on(str(self.dev)):  # (on a GPU: made there in bf16 — upstream's fp32 on the CPU is ~9 GB of RAM)
            m = VoxCPM2Model.from_local(self.job["model_dir"], optimize=False, training=True,
                                        lora_config=lora_config(), device=str(self.dev))
        bf16 = torch.bfloat16 if self.dev.type == "cuda" else torch.float32
        for name, p in m.named_parameters():  # (the frozen weights as it speaks; the LoRA's own kept in fp32)
            if "audio_vae" in name:
                continue
            p.data = p.data.float() if "lora_" in name else p.data.to(bf16)
        self.model = m.to(self.dev)
        self.model.audio_vae.to(torch.float32)
        self.model.set_lora_enabled(True)
        self.model.eval()
        self.sr = int(self.model.sample_rate)
        self.vae_sr = int(self.model.audio_vae.sample_rate)
        self.tok = self.model.text_tokenizer
        self.samples: list[dict] = []
        self.rnd = random.Random(int(self.job.get("seed", 42)))
        self.progress = 0.0
        cfg = self.model.config
        self.packer = _packers().AudioFeatureProcessingPacker(dataset_cnt=1, max_len=cfg.max_length,
                                                              patch_size=cfg.patch_size, feat_dim=cfg.feat_dim,
                                                              audio_vae=self.model.audio_vae)
        self.hop = int(self.model.audio_vae.hop_length) * int(cfg.patch_size)  # (16 kHz samples a position)

    def tokens(self, kept: list[dict], progress) -> None:
        for i, g in enumerate(kept):
            if i % 20 == 0:
                progress(i)
            self.samples.append({"ids": list(self.tok(g["text"])), "wav": wav(g["path"], self.vae_sr)})
        progress(len(kept))
        self.refs_ok = [i for i, s in enumerate(self.samples) if len(s["wav"]) <= PROMPT_MAX_S * self.vae_sr]

    def prompt(self, ref: dict | None) -> Any:
        if ref is None:
            return None
        return self.model.build_prompt_cache(prompt_text=ref["text"].strip(), prompt_wav_path=ref["path"],
                                             reference_wav_path=ref["path"])

    @torch.inference_mode()
    def speak(self, sentences: list[str], prompt: Any, check) -> list[np.ndarray]:
        from voxcpm.model.utils import next_and_close

        out = []
        for s in sentences:
            check()
            with torch.autocast(self.dev.type, dtype=torch.bfloat16, enabled=self.dev.type == "cuda"):
                w, _, _ = next_and_close(self.model._generate_with_prompt_cache(
                    target_text=s, prompt_cache=prompt, min_len=2, max_len=4096, inference_timesteps=10, cfg_value=2.0,
                    retry_badcase=True, retry_badcase_max_times=3, retry_badcase_ratio_threshold=6.0, streaming=False))
            out.append(w.squeeze(0).float().cpu().numpy().reshape(-1))
        return out

    def wrap(self, rank: int) -> list[torch.nn.Parameter]:
        self.peft = self.model  # (its own LoRA, made at load: rank as engines/voxcpm.py LORA)
        # each transformer layer (the LMs' and the DiT's) recomputed in the backward pass while it learns: upstream has
        # no gradient checkpointing, and a batch's activations alone outgrow a 12 GB GPU
        for m in self.model.modules():
            if type(m).__name__ == "MiniCPMDecoderLayer":
                _checkpointed(m)
        return [p for n, p in self.model.named_parameters() if "lora_" in n and p.requires_grad]

    def training(self, on: bool) -> None:
        self.model.train(on)
        self.model.audio_vae.eval()

    def lengths(self) -> list[int]:
        ref = int(np.mean([len(self.samples[i]["wav"]) for i in self.refs_ok]) / self.hop / 2) if self.refs_ok else 0
        return [len(s["ids"]) + len(s["wav"]) // self.hop + 4 + ref for s in self.samples]

    def loss(self, idx: list[int]) -> torch.Tensor:
        def pad(xs: list[torch.Tensor], value: float) -> torch.Tensor:
            n = max(x.shape[0] for x in xs)
            return torch.stack([torch.nn.functional.pad(x, (0, n - x.shape[0]), value=value) for x in xs])

        dev = self.dev
        texts = [torch.tensor(self.samples[i]["ids"], dtype=torch.int32) for i in idx]
        audios = [torch.from_numpy(self.samples[i]["wav"]) for i in idx]
        refs = []
        for i in idx:  # (half with another of her utterances as the reference, as a clip is used)
            j = self.rnd.choice(self.refs_ok) if self.refs_ok and self.rnd.random() < 0.5 else i
            refs.append(torch.from_numpy(self.samples[j]["wav"]) if j != i else torch.tensor([-100.0]))
        packed = self.packer(audio_tokens=pad(audios, -100.0).to(dev), text_tokens=pad(texts, -100).to(dev),
                             task_ids=torch.ones(len(idx), dtype=torch.int32, device=dev),
                             dataset_ids=torch.zeros(len(idx), dtype=torch.int32, device=dev),
                             is_prompts=[False] * len(idx), ref_audio_tokens=pad(refs, -100.0).to(dev))
        with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=dev.type == "cuda"):
            out = self.model(packed["text_tokens"], packed["text_mask"], packed["audio_feats"], packed["audio_mask"],
                             packed["loss_mask"], packed["position_ids"], packed["labels"], progress=self.progress)
        return sum(v.float() for k, v in out.items() if k.startswith("loss/"))

    # -- its own LoRA (not peft) --
    def lora_state(self) -> dict:
        return self.model.get_lora_state_dict()

    def load_lora_state(self, st: dict) -> None:
        params = dict(self.model.named_parameters())
        for k, v in st.items():
            params[k].data.copy_(v.to(params[k].device))

    def save(self, d: Path) -> None:
        import json

        from safetensors.torch import save_file

        from app.voicehost.worker.engines.voxcpm import LORA

        d.mkdir(parents=True, exist_ok=True)
        save_file({k: v.contiguous() for k, v in self.model.get_lora_state_dict().items()},
                  str(d / "adapter_model.safetensors"), metadata={"format": "pt"})
        (d / "adapter_config.json").write_text(json.dumps({"peft_type": "VOXCPM_LORA", **LORA}))
