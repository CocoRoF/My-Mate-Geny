"""Qwen3-TTS (12 Hz Base, 0.6B / 1.7B)'s part of a run (the qwen runtime): its codes of her utterances, speaking for a
measurement, and the talker's loss.

Trained in the layouts the engine speaks in (Qwen3TTSForConditionalGeneration.generate, streaming text): after a
clip of her (in-context: the clip's words then the line's, the clip's codes, the line's words fed one a frame) — and
from her voice alone (the speaker embedding only, no clip: "none", with her mean embedding kept beside the adapter).
LoRA on the talker's layers only (the code predictor, which the engine runs as a CUDA graph, is left as it is: its
loss still teaches the talker). Loss: the first codebook and its end (CE) + 0.3 × the code predictor's CE on the
other 15 (a sample of frames). bf16 weights, gradient checkpointing. Not upstream's finetuning script (its loss
doesn't match generation: see docs/local-voice.md "Training a voice").
"""

from __future__ import annotations

import random
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from .recipe import Recipe, wav

SR = 24_000
TARGETS = r"talker\.model\.layers\.\d+\.(self_attn\.(q_proj|k_proj|v_proj|o_proj)|mlp\.(gate_proj|up_proj|down_proj))"
PROMPT_MAX = 100  # a clip before a line at most this many frames (8 s)
CP_FRAMES = 768   # frames whose other codebooks are learned, a batch at most
ICL_SHARE = 0.6   # samples after a clip of her; the rest from her voice alone
VOICE_FILE = "voice.safetensors"  # her mean speaker embedding, for speaking without a clip


class Qwen(Recipe):
    engine = "qwen3_tts"
    sr = SR
    batch_tokens = 2048

    def load(self) -> None:
        from qwen_tts import Qwen3TTSModel

        from app.voicehost.worker.engines.qwen3_tts import _LANG

        cuda = self.dev.type == "cuda"
        self.tts = Qwen3TTSModel.from_pretrained(self.job["model_dir"], device_map=str(self.dev),
                                                 dtype=torch.bfloat16 if cuda else torch.float32)
        self.m = self.model = self.tts.model
        self.m.eval()
        self.talker = self.m.talker
        self.cfg, self.tc = self.m.config, self.m.config.talker_config
        self.lang_name = _LANG.get(self.lang, "auto")
        self.lang_id = None if self.lang_name == "auto" else self.tc.codec_language_id.get(self.lang_name)
        self.fast = None
        if cuda:  # (the engine's own decoding: the code predictor as a CUDA graph)
            from app.voicehost.worker.engines.qwen_fast import install

            self.fast = install(self.tts)
        self.samples: list[dict] = []
        self.rnd = random.Random(int(self.job.get("seed", 42)))

    def _ids(self, text: str, ref: bool = False) -> torch.Tensor:
        t = self.tts._build_ref_text(text) if ref else self.tts._build_assistant_text(text)
        return self.tts._tokenize_texts([t])[0].cpu()

    @torch.no_grad()  # (not inference_mode: these are learned from, autograd must be able to keep them)
    def tokens(self, kept: list[dict], progress) -> None:
        for i, g in enumerate(kept):
            if i % 10 == 0:
                progress(i)
            w = wav(g["path"], SR)
            codes = self.m.speech_tokenizer.encode(w, sr=SR).audio_codes[0]
            spk = self.m.extract_speaker_embedding(audio=w, sr=SR)
            self.samples.append({"codes": codes.to(torch.int16).cpu().clone(), "spk": spk.float().cpu().clone(),
                                 "ids": self._ids(g["text"]), "ref_ids": self._ids(g["text"], ref=True)})
        progress(len(kept))
        x = torch.stack([s["spk"] for s in self.samples]).mean(0)
        self.xvec = x
        self.prompts_ok = [i for i, s in enumerate(self.samples) if s["codes"].shape[0] <= PROMPT_MAX]

    def prompt(self, ref: dict | None) -> Any:
        from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem

        if ref is None:  # (her voice alone: the mean of her utterances' embeddings)
            return VoiceClonePromptItem(ref_code=None, ref_spk_embedding=self.xvec.to(self.dev), x_vector_only_mode=True,
                                        icl_mode=False)
        return self.tts.create_voice_clone_prompt(ref_audio=ref["path"], ref_text=ref["text"])[0]

    @torch.inference_mode()
    def speak(self, sentences: list[str], prompt: Any, check) -> list[np.ndarray]:
        out: list[np.ndarray] = []
        for j in range(0, len(sentences), 3):
            check()
            part = sentences[j:j + 3]
            wavs, _ = self.tts.generate_voice_clone(text=part, language=[self.lang_name] * len(part),
                                                    voice_clone_prompt=[prompt] * len(part))
            out += [np.asarray(w, dtype=np.float32).reshape(-1) for w in wavs]
        return out

    def wrap(self, rank: int) -> list[torch.nn.Parameter]:
        from peft import LoraConfig, get_peft_model

        self.peft = get_peft_model(self.m, LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05, bias="none",
                                                      target_modules=TARGETS))
        self.talker.config.use_cache = False
        self.m.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        return [p for p in self.peft.parameters() if p.requires_grad]

    def training(self, on: bool) -> None:
        self.m.train(on)
        if self.fast is not None and on:
            self.fast.reset()  # (its graphs' memory back for training; made again at the next measurement)

    def lengths(self) -> list[int]:
        avg = int(np.mean([self.samples[i]["codes"].shape[0] + self.samples[i]["ref_ids"].shape[1]
                           for i in self.prompts_ok])) if self.prompts_ok else 0
        return [s["codes"].shape[0] + s["ids"].shape[1] + 12 + int(avg * ICL_SHARE) for s in self.samples]

    def save(self, d: Path) -> None:
        from safetensors.torch import save_file

        super().save(d)
        save_file({"spk": self.xvec.contiguous()}, str(d / VOICE_FILE))

    # -- the sequence, as generate() makes it --
    def _txt(self, ids: torch.Tensor) -> torch.Tensor:
        return self.talker.text_projection(self.talker.get_text_embeddings()(ids.to(self.dev)))

    def _frames(self, codes: torch.Tensor) -> torch.Tensor:
        """each frame's 16 codebooks' embeddings, summed (1, T, D)"""
        c = codes.long().to(self.dev)
        e = self.talker.get_input_embeddings()(c[:, 0])
        cp = self.talker.code_predictor.get_input_embeddings()
        for i in range(1, c.shape[1]):
            e = e + cp[i - 1](c[:, i])
        return e.unsqueeze(0)

    def _codec(self, ids: list[int]) -> torch.Tensor:
        return self.talker.get_input_embeddings()(torch.tensor([ids], device=self.dev))

    def _sequence(self, s: dict, p: dict | None) -> tuple[torch.Tensor, int]:
        """her utterance ``s`` (after the clip ``p``, or from her voice alone) → (inputs (1, L, D), the position that
        predicts its first frame)"""
        tc, cfg = self.tc, self.cfg
        bos_t, eos_t, pad_t = self._txt(torch.tensor([[cfg.tts_bos_token_id, cfg.tts_eos_token_id,
                                                       cfg.tts_pad_token_id]])).chunk(3, dim=1)
        pre = [tc.codec_nothink_id, tc.codec_think_bos_id, tc.codec_think_eos_id] if self.lang_id is None else \
            [tc.codec_think_id, tc.codec_think_bos_id, self.lang_id, tc.codec_think_eos_id]
        spk = (p["spk"] if p is not None else self.xvec).to(self.dev, pad_t.dtype).view(1, 1, -1)
        codec_in = torch.cat([self._codec(pre), spk, self._codec([tc.codec_pad_id, tc.codec_bos_id])], dim=1)
        ids = s["ids"]
        head = torch.cat([pad_t.expand(-1, codec_in.shape[1] - 2, -1), bos_t], dim=1) + codec_in[:, :-1]
        parts = [self._txt(ids[:, :3]), head]
        if p is not None:  # in-context, streaming (generate_icl_prompt)
            text = torch.cat([self._txt(torch.cat([p["ref_ids"][:, 3:-2], ids[:, 3:-5]], dim=-1)), eos_t], dim=1)
            codec = torch.cat([self._codec([tc.codec_bos_id]), self._frames(p["codes"])], dim=1)
            if text.shape[1] > codec.shape[1]:
                parts.append(text[:, :codec.shape[1]] + codec)
                trail = text[:, codec.shape[1]:]
            else:
                parts.append(torch.cat([text, pad_t.expand(-1, codec.shape[1] - text.shape[1], -1)], dim=1) + codec)
                trail = pad_t
        else:  # her voice alone: the line's first word with the codec's bos, the rest fed a frame at a time
            parts.append(self._txt(ids[:, 3:4]) + codec_in[:, -1:])
            trail = torch.cat([self._txt(ids[:, 4:-5]), eos_t], dim=1)
        start = sum(x.shape[1] for x in parts) - 1
        frames = self._frames(s["codes"])
        n = frames.shape[1]
        feed = trail[:, :n]
        if feed.shape[1] < n:
            feed = torch.cat([feed, pad_t.expand(-1, n - feed.shape[1], -1)], dim=1)
        parts.append(frames + feed)
        return torch.cat(parts, dim=1).squeeze(0), start

    def loss(self, idx: list[int]) -> torch.Tensor:
        dev, tc = self.dev, self.tc
        xs, labels, sels, codes = [], [], [], []
        with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=dev.type == "cuda"):
            for i in idx:
                s = self.samples[i]
                p = None
                if self.prompts_ok and self.rnd.random() < ICL_SHARE:
                    j = self.rnd.choice(self.prompts_ok)
                    p = self.samples[j] if j != i else None
                x, start = self._sequence(s, p)
                c = s["codes"].long().to(dev)
                n = c.shape[0]
                lab = torch.full((x.shape[0],), -100, dtype=torch.long, device=dev)
                lab[start:start + n] = c[:, 0]
                lab[start + n] = tc.codec_eos_token_id
                sel = torch.zeros(x.shape[0], dtype=torch.bool, device=dev)
                sel[start:start + n] = True
                xs.append(x)
                labels.append(lab)
                sels.append(sel)
                codes.append(c)
            from torch.nn.utils.rnn import pad_sequence

            L = torch.tensor([x.shape[0] for x in xs], device=dev)
            x = pad_sequence(xs, batch_first=True)
            lab = pad_sequence(labels, batch_first=True, padding_value=-100)
            sel = pad_sequence(sels, batch_first=True, padding_value=False)
            am = (torch.arange(x.shape[1], device=dev)[None] < L[:, None]).long()
            h = self.talker.model(inputs_embeds=x, attention_mask=am, use_cache=False).last_hidden_state
            l0 = F.cross_entropy(self.talker.codec_head(h).float().transpose(1, 2), lab, ignore_index=-100)
            # the other codebooks, from the hidden that predicted each frame's first (as the code predictor is run)
            C = torch.cat(codes)
            hs = h[sel]
            if hs.shape[0] > CP_FRAMES:
                keep = torch.randperm(hs.shape[0], device=dev)[:CP_FRAMES]
                hs, C = hs[keep], C[keep]
            cp = self.talker.code_predictor
            emb = cp.get_input_embeddings()
            cp_in = torch.cat([hs[:, None], self.talker.get_input_embeddings()(C[:, :1])]
                              + [emb[i - 1](C[:, i:i + 1]) for i in range(1, C.shape[1] - 1)], dim=1)
            lg = cp.forward_finetune(inputs_embeds=cp_in).logits
            l1 = F.cross_entropy(lg.float().transpose(1, 2), C[:, 1:])
        return l0 + 0.3 * l1
