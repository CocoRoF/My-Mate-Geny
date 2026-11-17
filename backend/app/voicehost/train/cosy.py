"""CosyVoice3's part of a run (the cosy runtime, CosyVoice's own source at GENY_VOICE_COSYVOICE_SRC): its speech
tokens, mel and speaker embedding of her utterances, speaking for a measurement (zero-shot from her clip — it has no
voice of its own, so no "none"), and the loss of its LLM and its flow.

The LLM (how her words go): LoRA on its Qwen2 layers, the speech-token decoder and embedding trained in full, on
CosyVoice3LM's own sequence ([sos, instruction + text, task, speech] → the speech tokens and eos); half the samples
put after another of her utterances, as zero-shot inference puts a line after the clip's words and tokens (the clip's
tokens not learned). The flow (her timbre: mel from tokens, with the clip's embedding and mel): LoRA on its DiT's
attention and feed-forward, on its own conditional flow-matching loss (a random start of her mel as the prompt, as
upstream trains it). One adapter for both (engines/cosyvoice3.py: Learned). fp32 weights under bf16 autocast,
gradient checkpointing on the LLM; HiFT off the GPU while it trains.
"""

from __future__ import annotations

import random
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .recipe import Recipe, wav

TARGETS = (r"llm\.llm\.model\.model\.layers\.\d+\.(self_attn\.(q_proj|k_proj|v_proj|o_proj)|mlp\.(gate_proj|up_proj|down_proj))"
           r"|flow\.decoder\.estimator\.transformer_blocks\.\d+\.(attn\.(to_q|to_k|to_v|to_out\.0)|ff\.ff\.(0\.0|2))")
SAVE_FULL = ["llm_decoder", "speech_embedding"]
PROMPT_MAX = 200  # a prompt utterance at most this many speech tokens (8 s)
FLOW_FRAMES = 2000  # mel frames the flow learns from, a batch at most (2 a token; its DiT has no checkpointing)


class Cosy(Recipe):
    engine = "cosyvoice3"
    conditions = ("long", "short")
    epochs = 40  # (its decoder and embedding learn her lines by heart well before OmniVoice's 50)

    def load(self) -> None:
        from app.voicehost.worker.engines.cosyvoice3 import (END, PREFIX, Learned, _add_source_path, _stub_training_only,
                                                             _wants_frontend)

        _add_source_path()
        _stub_training_only()
        import logging

        from cosyvoice.cli.cosyvoice import CosyVoice3

        logging.getLogger().setLevel(logging.WARNING)
        self.PREFIX, self.END, self.wants_frontend = PREFIX, END, _wants_frontend
        self.cosy = CosyVoice3(self.job["model_dir"], load_trt=False, load_vllm=False, fp16=False)
        # (speaking for a measurement as the engine does: under fp16 autocast — only a switch, the weights stay fp32)
        self.cosy.model.fp16 = self.dev.type == "cuda"
        self.sr = int(self.cosy.sample_rate)
        self.fe = self.cosy.frontend
        self.lm = self.cosy.model.llm
        self.model = Learned(self.lm, self.cosy.model.flow)
        self.qwen = self.lm.llm.model.model  # (Qwen2Model: the layers LoRA goes on, in place)
        self.instr = self.fe.tokenizer.encode(f"{PREFIX}{END}", allowed_special="all")
        self.samples: list[tuple[list[int], torch.Tensor]] = []
        self.flow_data: list[tuple[torch.Tensor, torch.Tensor]] = []  # (her mel (2 frames a token), her embedding)
        self.rnd = random.Random(int(self.job.get("seed", 42)))
        import onnxruntime as ort

        so = ort.SessionOptions()  # (its own session: the frontend's runs on one thread)
        so.intra_op_num_threads = 8
        self.tok = ort.InferenceSession(str(Path(self.job["model_dir"]) / "speech_tokenizer_v3.onnx"), so,
                                        providers=["CPUExecutionProvider"])

    def _speech_tokens(self, path: str) -> torch.Tensor:
        import whisper

        x = torch.from_numpy(wav(path, 16000)[: 16000 * 30]).unsqueeze(0)
        feat = whisper.log_mel_spectrogram(x, n_mels=128)
        ins = self.tok.get_inputs()
        out = self.tok.run(None, {ins[0].name: feat.numpy(), ins[1].name: np.array([feat.shape[2]], dtype=np.int32)})[0]
        return torch.tensor(out.flatten().tolist(), dtype=torch.int32)

    def _text(self, text: str) -> list[int]:
        t = self.fe.text_normalize(text, split=False, text_frontend=self.wants_frontend(text, self.lang))
        return self.fe.tokenizer.encode(t if isinstance(t, str) else "".join(t), allowed_special="all")

    @torch.no_grad()
    def _mel(self, path: str) -> torch.Tensor:
        """24 kHz, padded to a whole token (960 samples) as upstream's training data is: (frames, 80)"""
        x = torch.from_numpy(wav(path, self.sr))
        x = torch.nn.functional.pad(x, (0, (-len(x)) % 960))
        return self.fe.feat_extractor(x.unsqueeze(0)).squeeze(0).transpose(0, 1).float().cpu()

    def tokens(self, kept: list[dict], progress) -> None:
        for i, g in enumerate(kept):
            if i % 10 == 0:
                progress(i)
            sp = self._speech_tokens(g["path"])
            mel = self._mel(g["path"])
            n = min(len(sp), mel.shape[0] // 2)
            emb = self.fe._extract_spk_embedding(g["path"]).reshape(-1).float().cpu()
            self.samples.append((self._text(g["text"]), sp))
            self.flow_data.append((mel[:2 * n].clone(), emb.clone()))
        progress(len(kept))
        del self.tok  # (its own copy of the tokenizer: ~1 GB of RAM no longer needed)
        self.prompts_ok = [i for i, (_, sp) in enumerate(self.samples) if len(sp) <= PROMPT_MAX]

    def prompt(self, ref: dict | None) -> Any:
        if ref is None:
            return None
        spk = f"train_{len(self.cosy.frontend.spk2info)}"
        text = f"{self.PREFIX}{self.END}{ref['text'].strip()}"
        self.cosy.add_zero_shot_spk(text, ref["path"], spk)
        return (spk, text)

    @torch.inference_mode()
    def speak(self, sentences: list[str], prompt: Any, check) -> list[np.ndarray]:
        spk, text = prompt
        out = []
        for s in sentences:
            check()
            gen = self.cosy.inference_zero_shot(s, text, "", zero_shot_spk_id=spk, stream=False,
                                                text_frontend=self.wants_frontend(s, self.lang))
            pieces = [o["tts_speech"].float().cpu().numpy().reshape(-1) for o in gen]
            out.append(np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32))
        return out

    def measuring(self, on: bool) -> None:
        self.cosy.model.hift.to(self.dev if on else "cpu")  # (the flow learns: it stays)

    def wrap(self, rank: int) -> list[torch.nn.Parameter]:
        from peft import LoraConfig, get_peft_model

        self.measuring(False)
        self.peft = get_peft_model(self.model, LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05, bias="none",
                                                          target_modules=TARGETS, modules_to_save=SAVE_FULL))
        self.lm.llm.model.config.use_cache = False
        self.lm.llm.model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        return [p for p in self.peft.parameters() if p.requires_grad]

    def lengths(self) -> list[int]:
        # (half of them carry a prompt utterance before them: counted at its average)
        extra = int(np.mean([len(self.samples[i][1]) + len(self.samples[i][0]) for i in self.prompts_ok]) / 2) \
            if self.prompts_ok else 0
        return [len(self.instr) + len(ids) + len(sp) + 2 + extra for ids, sp in self.samples]

    def loss(self, idx: list[int]) -> torch.Tensor:
        from torch.nn.utils.rnn import pad_sequence

        lm, dev = self.lm, self.dev
        se = lm.speech_embedding
        xs, ys = [], []
        for i in idx:
            ids, sp = self.samples[i]
            pre_ids: list[int] = []
            pre_sp = torch.zeros(0, dtype=torch.long)
            if self.prompts_ok and self.rnd.random() < 0.5:  # (after another of her utterances, as zero-shot is)
                j = self.rnd.choice(self.prompts_ok)
                if j != i:
                    pre_ids, pre_sp = self.samples[j][0], self.samples[j][1].long()
            tt = torch.tensor(self.instr + pre_ids + ids, device=dev)
            speech = torch.cat([pre_sp, sp.long()]).to(dev)
            sos = se(torch.tensor([lm.sos], device=dev))
            task = se(torch.tensor([lm.task_id], device=dev))
            xs.append(torch.cat([sos, self.qwen.embed_tokens(tt), task, se(speech)]))
            ys.append(torch.cat([torch.full((1 + len(tt) + len(pre_sp),), -1, device=dev), sp.long().to(dev),
                                 torch.tensor([lm.eos_token], device=dev)]))
        n = torch.tensor([len(x) for x in xs], device=dev)
        x = pad_sequence(xs, batch_first=True)
        y = pad_sequence(ys, batch_first=True, padding_value=-1)
        mask = torch.arange(x.shape[1], device=dev)[None] < n[:, None]
        with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=dev.type == "cuda"):
            h = self.qwen(inputs_embeds=x, attention_mask=mask, use_cache=False).last_hidden_state
            logits = lm.llm_decoder(h)
        l_llm = torch.nn.functional.cross_entropy(logits.float().flatten(0, 1), y.flatten(), ignore_index=-1)
        return l_llm + self._flow_loss(idx)

    def _flow_loss(self, idx: list[int]) -> torch.Tensor:
        """the flow's own loss (conditional flow matching, a random start of her mel as the prompt) on as many of the
        batch's utterances as fit"""
        from torch.nn.utils.rnn import pad_sequence

        pick, frames = [], 0
        for i in sorted(idx, key=lambda i: self.flow_data[i][0].shape[0]):
            n = self.flow_data[i][0].shape[0]
            if pick and frames + n > FLOW_FRAMES:
                break
            pick.append(i)
            frames += n
        dev = self.dev
        mels = [self.flow_data[i][0] for i in pick]
        toks = [self.samples[i][1][: m.shape[0] // 2].long() for i, m in zip(pick, mels)]
        batch = {"speech_token": pad_sequence(toks, batch_first=True).to(dev),
                 "speech_token_len": torch.tensor([len(t) for t in toks], dtype=torch.int32, device=dev),
                 "speech_feat": pad_sequence(mels, batch_first=True).to(dev),
                 "speech_feat_len": torch.tensor([m.shape[0] for m in mels], dtype=torch.int32, device=dev),
                 "embedding": torch.stack([self.flow_data[i][1] for i in pick]).to(dev)}
        with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=dev.type == "cuda"):
            return self.cosy.model.flow(batch, dev)["loss"].float()
