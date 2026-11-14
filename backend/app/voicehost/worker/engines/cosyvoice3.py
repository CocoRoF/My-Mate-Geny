"""Fun-CosyVoice3 0.5B: zero-shot cloning, cross-lingual cloning and instruct control.

CosyVoice is not a pip package: its runtime install fetches a pinned archive of its source (and of its Matcha-TTS
submodule) next to the environment, at GENY_VOICE_COSYVOICE_SRC (app/voicehost/installer.py).
"""

from __future__ import annotations

import hashlib
import os
import sys
import numpy as np
import torch

from .base import Engine, SynthRequest

PREFIX = "You are a helpful assistant."
END = "<|endofprompt|>"


def _add_source_path() -> None:
    src = os.environ.get("GENY_VOICE_COSYVOICE_SRC", "")
    if not src:
        raise RuntimeError("CosyVoice source is not installed (GENY_VOICE_COSYVOICE_SRC)")
    for p in (src, os.path.join(src, "third_party", "Matcha-TTS")):
        if p not in sys.path:
            sys.path.insert(0, p)


def _stub_training_only() -> None:
    """cosyvoice3.yaml names functions from the training data pipeline, whose module imports pyworld (a C extension
    that often fails to build). Inference never calls them, so an empty module is enough."""
    import types

    for name in ("pyworld",):
        try:
            __import__(name)
        except ImportError:
            sys.modules[name] = types.ModuleType(name)
    # wetext fetches its normaliser grammars from modelscope.cn on every load (currently 403, ~2 s wasted, and a
    # network dependency for an offline studio). Without it CosyVoice still splits and spells out English numbers;
    # Korean and other languages skip its frontend anyway (see _wants_frontend).
    if os.environ.get("GENY_VOICE_COSYVOICE_WETEXT", "0") != "1":
        sys.modules["wetext"] = None  # type: ignore[assignment]  # makes "from wetext import ..." raise ImportError


def _wants_frontend(text: str, language: str) -> bool:
    """CosyVoice's text frontend normalises Chinese, and English for everything else: it would spell Korean numbers
    out in English. Use it only where it helps."""
    if language in ("zh", "en"):
        return True
    if language not in ("", "auto"):
        return False
    return all(ord(c) < 0x3000 or 0x4E00 <= ord(c) <= 0x9FFF for c in text)


class CosyVoice3Engine(Engine):
    name = "cosyvoice3"

    def load(self) -> None:
        _add_source_path()
        _stub_training_only()
        import logging

        from cosyvoice.cli.cosyvoice import CosyVoice3

        logging.getLogger().setLevel(logging.WARNING)
        # CosyVoice runs its LLM and flow under torch.autocast(fp16) when asked; bf16 is not wired in upstream.
        fp16 = bool(self.options.get("fp16", self.dev.is_cuda))
        self.cosy = CosyVoice3(str(self.model_dir), load_trt=False, load_vllm=False, fp16=fp16)
        self.sample_rate = int(self.cosy.sample_rate)
        # Cached speakers live in the frontend's spk2info; drop them there when the cache lets one go.
        self.prompts.on_evict = lambda spk: self.cosy.frontend.spk2info.pop(spk, None)

    def modules(self) -> list:
        m = self.cosy.model
        return [m.llm, m.flow, m.hift]

    def _spk(self, req: SynthRequest, mode: str) -> str:
        """Encode the reference once (speech tokens, mel features, speaker embedding) and keep it by id."""
        ref = req.reference
        key = ref.key(mode)
        spk = self.prompts.get(key)
        if spk is None:
            spk = "as_" + hashlib.sha1(repr(key).encode()).hexdigest()[:16]
            prompt_text = f"{PREFIX}{END}{ref.text.strip()}" if mode == "zero_shot" else ""
            self.cosy.add_zero_shot_spk(prompt_text, ref.path, spk)
            self.prompts.put(key, spk)
        return spk

    @torch.inference_mode()
    def synthesize(self, req: SynthRequest) -> list[np.ndarray]:
        if req.reference is None:
            raise ValueError("CosyVoice3 는 레퍼런스 오디오가 필요합니다 (목소리 템플릿에 레퍼런스를 등록하세요)")
        p = req.params
        speed = float(p.get("speed", 1.0))
        mode = p.get("mode", "zero_shot")
        if mode == "zero_shot" and not req.reference.text.strip():
            mode = "cross_lingual"
        instruct = req.instruct.strip()
        outs: list[np.ndarray] = []
        for text in req.text:
            fe = _wants_frontend(text, req.language)
            if instruct:
                spk = self._spk(req, "cross_lingual")
                gen = self.cosy.inference_instruct2(text, f"{PREFIX} {instruct}{END}", "", zero_shot_spk_id=spk,
                                                    stream=False, speed=speed, text_frontend=fe)
            elif mode == "cross_lingual":
                spk = self._spk(req, "cross_lingual")
                gen = self.cosy.inference_cross_lingual(f"{PREFIX}{END}{text}", "", zero_shot_spk_id=spk,
                                                        stream=False, speed=speed, text_frontend=fe)
            else:
                spk = self._spk(req, "zero_shot")
                gen = self.cosy.inference_zero_shot(text, f"{PREFIX}{END}{req.reference.text.strip()}", "",
                                                    zero_shot_spk_id=spk, stream=False, speed=speed, text_frontend=fe)
            pieces = [o["tts_speech"].float().cpu().numpy().reshape(-1) for o in gen]
            outs.append(np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32))
        return outs

    def warmup(self) -> None:
        import os
        import tempfile

        import soundfile as sf

        from .base import Reference

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "warmup.wav")
            t = np.arange(24000) / 24000
            sf.write(path, (0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 24000)
            self.synthesize(SynthRequest(text=["Hello."], language="en", reference=Reference(path, "Hello.")))
        self.prompts.clear()
