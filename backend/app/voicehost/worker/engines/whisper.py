"""Whisper (transformers) for transcribing references and testing STT."""

from __future__ import annotations

from typing import Any

import numpy as np
import torch

from .base import Engine

_NAMES = {"ko": "korean", "en": "english", "zh": "chinese", "ja": "japanese", "de": "german", "es": "spanish",
          "fr": "french", "it": "italian", "ru": "russian", "pt": "portuguese", "vi": "vietnamese", "th": "thai",
          "id": "indonesian"}


class WhisperEngine(Engine):
    name = "whisper"
    sample_rate = 16000

    def load(self) -> None:
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

        # fp16 is Whisper's native inference precision; bf16 costs accuracy on some GPUs for no speed gain.
        # (fp32 on Metal: in fp16 there Whisper only repeats a token — "이!!!!…" — measured on Apple Silicon)
        self.dtype = torch.float16 if self.dev.is_cuda else torch.float32
        self.model = AutoModelForSpeechSeq2Seq.from_pretrained(
            str(self.model_dir), dtype=self.dtype, low_cpu_mem_usage=True, attn_implementation="sdpa"
        ).to(self.dev.device)
        self.model.eval()
        self.processor = AutoProcessor.from_pretrained(str(self.model_dir))

    def modules(self) -> list:
        return [self.model]

    @torch.inference_mode()
    def transcribe(self, path: str, language: str = "auto") -> dict[str, Any]:
        import soundfile as sf

        wav, sr = sf.read(path, dtype="float32", always_2d=True)
        wav = wav.mean(axis=1)
        if sr != 16000:
            import soxr

            wav = soxr.resample(wav, sr, 16000)
        out_text: list[str] = []
        detected = None
        # 30 s windows, Whisper's receptive field; references are almost always one window.
        step = 30 * 16000
        for start in range(0, max(1, len(wav)), step):
            chunk = wav[start:start + step]
            if len(chunk) < 1600:
                continue
            feats = self.processor(chunk, sampling_rate=16000, return_tensors="pt").input_features
            feats = feats.to(self.dev.device, dtype=self.dtype)
            kwargs: dict[str, Any] = {"task": "transcribe", "max_new_tokens": 440}
            if language and language != "auto":
                kwargs["language"] = _NAMES.get(language, language)
            elif detected is None:
                detected = self._detect(feats)
            ids = self.model.generate(feats, **kwargs)
            out_text.append(self.processor.batch_decode(ids, skip_special_tokens=True)[0].strip())
        return {"text": " ".join(t for t in out_text if t).strip(),
                "language": language if language not in ("", "auto") else (detected or "")}

    def _detect(self, feats) -> str | None:
        """Language of the first window. generate() no longer returns the language token, so ask Whisper directly."""
        try:
            lang_ids = self.model.detect_language(feats)
            tok = self.processor.tokenizer.convert_ids_to_tokens(int(lang_ids.reshape(-1)[0]))
            return tok[2:-2] if tok.startswith("<|") and tok.endswith("|>") else None
        except Exception:  # noqa: BLE001 - detection is a nicety; transcription must not fail on it
            return None

    def warmup(self) -> None:
        import os
        import tempfile

        import soundfile as sf

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "warmup.wav")
            sf.write(path, (np.random.randn(16000) * 0.01).astype(np.float32), 16000)
            self.transcribe(path, "en")
