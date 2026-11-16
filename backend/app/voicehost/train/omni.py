"""OmniVoice's part of a run (the omni runtime): its audio tokens, how it speaks for a measurement, and its loss.

LoRA on the LLM's projections only (the audio tokenizer, a submodule once loaded, has q_proj … of its own); the audio
embedding and heads trained in full. fp32 weights under bf16 autocast, gradient checkpointing; OmniVoice's own sample
processor and collator (the masked-token objective it was trained with). Measured: see run.py.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import torch

from .recipe import Recipe, wav

SR = 24_000
TARGETS = r"llm\.layers\.\d+\.(self_attn\.(q_proj|k_proj|v_proj|o_proj)|mlp\.(gate_proj|up_proj|down_proj))"
SAVE_FULL = ["audio_embeddings", "audio_heads"]
GEN = {"num_step": 32, "guidance_scale": 2.0, "t_shift": 0.1}


class Omni(Recipe):
    engine = "omnivoice"
    sr = SR

    def load(self) -> None:
        from omnivoice.models.omnivoice import OmniVoice
        from omnivoice.utils.lang_map import LANG_IDS

        self.model = OmniVoice.from_pretrained(self.job["model_dir"], dtype=torch.float32,
                                               attn_implementation="sdpa").to(self.dev)
        self.lang_id = self.lang if self.lang in LANG_IDS else "None"
        self.samples: list[dict] = []

    @torch.inference_mode()
    def _tokens(self, path: str) -> torch.Tensor:
        w = wav(path, SR)
        w = w / (np.abs(w).max() + 1e-7) * 0.9  # (as OmniVoice's own data reader does)
        x = self.model.feature_extractor(raw_audio=w, sampling_rate=SR, return_tensors="pt").to(self.dev)
        return self.model.audio_tokenizer.encode(x["input_values"]).audio_codes.squeeze(0).to(torch.int16).cpu()

    def tokens(self, kept: list[dict], progress) -> None:
        for i, g in enumerate(kept):
            if i % 20 == 0:
                progress(i)
            self.samples.append({"audio_tokens": self._tokens(g["path"]),
                                 "label": {"id": g["id"], "text": g["text"], "language_id": self.lang_id}})
        progress(len(kept))

    def prompt(self, ref: dict | None) -> Any:
        if ref is None:
            return None
        return self.model.create_voice_clone_prompt(ref_audio=ref["path"], ref_text=ref["text"])

    @torch.inference_mode()
    def speak(self, sentences: list[str], prompt: Any, check) -> list[np.ndarray]:
        out = []
        for j in range(0, len(sentences), 2):  # (two at a time: fp32 with guidance's doubled batch)
            check()
            part = sentences[j:j + 2]
            kw: dict[str, Any] = dict(GEN)
            if self.lang_id != "None":
                kw["language"] = [self.lang_id] * len(part)
            if prompt is not None:
                kw["voice_clone_prompt"] = [prompt] * len(part)
            out += [np.asarray(a, dtype=np.float32).reshape(-1) for a in self.model.generate(text=part, **kw)]
        return out

    def measuring(self, on: bool) -> None:
        self.model.audio_tokenizer.to(self.dev if on else "cpu")

    def wrap(self, rank: int) -> list[torch.nn.Parameter]:
        from omnivoice.data.collator import PaddingDataCollator
        from omnivoice.data.processor import OmniVoiceSampleProcessor
        from peft import LoraConfig, get_peft_model

        self.peft = get_peft_model(self.model, LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05, bias="none",
                                                          target_modules=TARGETS, modules_to_save=SAVE_FULL))
        self.model.llm.config.use_cache = False
        self.model.llm.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        self.proc = OmniVoiceSampleProcessor(text_tokenizer=self.model.text_tokenizer, num_channels=8, audio_mask_id=1024,
                                             prompt_ratio_range=(0.0, 0.3), mask_ratio_range=(0.0, 1.0),
                                             drop_cond_ratio=0.1, language_ratio=0.8, use_pinyin_ratio=0.0,
                                             instruct_ratio=0.0, only_instruct_ratio=0.0)
        self.batch_tokens = int(self.lim.get("batch_tokens", 4096))
        self.coll = PaddingDataCollator(self.proc, self.batch_tokens)
        return [p for p in self.peft.parameters() if p.requires_grad]

    def lengths(self) -> list[int]:
        return [s["audio_tokens"].shape[1] + 60 for s in self.samples]

    def loss(self, idx: list[int]) -> torch.Tensor:
        batch = {k: v.to(self.dev, non_blocking=True) for k, v in self.coll([self.proc(self.samples[i]) for i in idx]).items()}
        with torch.autocast(self.dev.type, dtype=torch.bfloat16, enabled=self.dev.type == "cuda"):
            return self.peft(**batch).loss
