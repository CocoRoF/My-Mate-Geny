"""Qwen3-TTS (12 Hz) Base models: zero-shot voice cloning."""

from __future__ import annotations

from typing import Any

import numpy as np
import torch

from .base import Engine, SynthRequest

_LANG = {
    "auto": "auto", "ko": "korean", "en": "english", "zh": "chinese", "ja": "japanese", "de": "german",
    "fr": "french", "ru": "russian", "pt": "portuguese", "es": "spanish", "it": "italian",
}


class Qwen3TTSEngine(Engine):
    name = "qwen3_tts"

    def load(self) -> None:
        from qwen_tts import Qwen3TTSModel

        kwargs: dict[str, Any] = {"device_map": self.dev.device, "dtype": self.dev.dtype}
        attn = self.options.get("attn_implementation")
        if attn:
            kwargs["attn_implementation"] = attn
        self.model = Qwen3TTSModel.from_pretrained(str(self.model_dir), **kwargs)
        self.model.model.eval()
        self.sample_rate = 24000
        self.fast = None
        if self.dev.is_cuda and self.options.get("fast_predictor", True):
            from .qwen_fast import install

            self.fast = install(self.model)

    def modules(self) -> list:
        # The codec (speech tokenizer) is a separate module held by a plain wrapper, not a registered submodule.
        mods = [self.model.model]
        st = getattr(self.model.model, "speech_tokenizer", None)
        if st is not None and getattr(st, "model", None) is not None:
            mods.append(st.model)
        return mods

    def on_park(self) -> None:
        super().on_park()
        if self.fast is not None:  # captured graphs point at the old weight addresses
            self.fast.reset()

    def _prompt(self, req: SynthRequest, x_vector_only: bool):
        ref = req.reference
        if ref is None:
            raise ValueError("Qwen3-TTS Base 모델은 레퍼런스 오디오가 필요합니다 (목소리 템플릿에 레퍼런스를 등록하세요)")
        if not x_vector_only and not ref.text.strip():
            raise ValueError("레퍼런스 전사가 비어 있습니다. 전사를 넣거나 '전사 없이 음색만' 을 켜세요")
        key = ref.key(x_vector_only)
        items = self.prompts.get(key)
        if items is None:
            items = self.model.create_voice_clone_prompt(
                ref_audio=ref.path, ref_text=ref.text or None, x_vector_only_mode=x_vector_only
            )
            self.prompts.put(key, items)
        return items

    @torch.inference_mode()
    def synthesize(self, req: SynthRequest) -> list[np.ndarray]:
        p = req.params
        items = self._prompt(req, bool(p.get("x_vector_only")))
        lang = _LANG.get(req.language or "auto", "auto")
        gen = {k: p[k] for k in ("temperature", "top_p", "top_k", "repetition_penalty") if k in p}
        if "max_new_tokens" in p:
            gen["max_new_tokens"] = int(p["max_new_tokens"])
        wavs, sr = self.model.generate_voice_clone(
            text=list(req.text),
            language=[lang] * len(req.text),
            voice_clone_prompt=items * len(req.text) if len(items) == 1 else items,
            **gen,
        )
        self.sample_rate = sr
        return [np.asarray(w, dtype=np.float32).reshape(-1) for w in wavs]

    def warmup(self) -> None:
        import os
        import tempfile

        import soundfile as sf

        # Half a second of low noise is enough to exercise the encoder, the talker and the codec decoder once.
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "warmup.wav")
            sf.write(path, (np.random.randn(12000) * 0.01).astype(np.float32), 24000)
            from .base import Reference

            self.synthesize(SynthRequest(text=["warm up"], language="en",
                                         reference=Reference(path, "warm up"),
                                         params={"max_new_tokens": 16}))
        self.prompts.clear()
