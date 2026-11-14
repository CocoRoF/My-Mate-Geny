"""A fast replacement for Qwen3-TTS's per-frame code predictor.

Upstream calls Hugging Face ``generate()`` on the 5-layer code predictor for every 80 ms audio frame to produce the 15
residual codebook tokens. ``generate()`` rebuilds logits processors, stopping criteria, a dynamic cache and masks on
every call; on an RTX 5070 that costs ~40 ms per frame, three quarters of all synthesis time, while the math itself
is well under a millisecond per token.

The shape of that work never changes: a 2-position prefill followed by 14 single-token steps, always at the same
positions. So the whole 15-token loop -- embedding, projection, the transformer, the heads and the sampling
(temperature, top-k, top-p via Gumbel-max) -- is captured once per batch size as a CUDA graph and replayed with one
launch per frame.

The KV cache is a preallocated buffer that hands attention an exact-length view at each step (the steps are unrolled
in the capture, so every length is a fixed Python int). A padded static cache with a mask would pick a different
bf16 attention kernel and drift from upstream's tokens; with exact views, greedy decoding reproduces upstream token
for token (tools/check_qwen_fast.py) and sampled decoding draws from the same distribution.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import torch


def _sample(logits: torch.Tensor, temp: torch.Tensor, top_k: int, top_p: float, do_sample: bool) -> torch.Tensor:
    logits = logits.float()
    if not do_sample:
        return logits.argmax(-1)
    logits = logits / temp
    if 0 < top_k < logits.shape[-1]:
        vals, idx = logits.topk(top_k, dim=-1)  # sorted, largest first
    else:
        vals, idx = logits.sort(dim=-1, descending=True)
    if top_p < 1.0:
        probs = vals.softmax(-1)
        drop = probs.cumsum(-1) - probs > top_p  # keep the smallest prefix whose mass reaches top_p (>= 1 token)
        vals = vals.masked_fill(drop, float("-inf"))
    # Gumbel-max: argmax(logits + Gumbel noise) is a sample from softmax(logits); unlike multinomial it needs no
    # host synchronisation, so it can live inside a CUDA graph.
    u = torch.rand_like(vals).clamp_(1e-20, 1.0)
    choice = (vals - torch.log(-torch.log(u))).argmax(-1, keepdim=True)
    return idx.gather(-1, choice).squeeze(-1)


class _ExactCacheImpl:
    """KV buffers per layer; ``offset`` (a Python int set before each call) says where this call's keys go."""

    def __init__(self, length: int) -> None:
        try:
            super().__init__(layers=[])
        except TypeError:
            pass
        self.length = length
        self.offset = 0
        self.k: dict[int, torch.Tensor] = {}
        self.v: dict[int, torch.Tensor] = {}

    def update(self, key_states, value_states, layer_idx, cache_kwargs=None):
        if layer_idx not in self.k:
            b, h, _, d = key_states.shape
            self.k[layer_idx] = key_states.new_zeros(b, h, self.length, d)
            self.v[layer_idx] = value_states.new_zeros(b, h, self.length, d)
        n = key_states.shape[2]
        end = self.offset + n
        self.k[layer_idx][:, :, self.offset:end] = key_states
        self.v[layer_idx][:, :, self.offset:end] = value_states
        return self.k[layer_idx][:, :, :end], self.v[layer_idx][:, :, :end]

    def get_seq_length(self, layer_idx: int = 0) -> int:
        return self.offset

    def get_mask_sizes(self, cache_position, layer_idx: int = 0):
        return self.offset + cache_position.shape[0], 0

    @property
    def is_compileable(self) -> bool:
        return False


_cache_cls = None


def _exact_cache(length: int):
    """The model insists on a transformers ``Cache``; subclass it at first use (worker env only)."""
    global _cache_cls
    if _cache_cls is None:
        from transformers.cache_utils import Cache

        _cache_cls = type("ExactCache", (_ExactCacheImpl, Cache), {})
    return _cache_cls(length)


class FastCodePredictor:
    def __init__(self, cp: torch.nn.Module, use_graphs: bool = True) -> None:
        self.cp = cp
        self.n = cp.config.num_code_groups - 1
        self.use_graphs = use_graphs
        self.device = next(cp.parameters()).device
        self.dtype = next(cp.parameters()).dtype
        self.pos = torch.arange(self.n + 1, device=self.device)
        self._graphs: dict[tuple, Any] = {}
        self._caches: dict[int, Any] = {}
        # No masks: prefill runs causal (q=2, kv=2) and each step attends to exactly the keys written so far.
        self._masks = {"full_attention": None}
        self.disabled_reason = ""

    def _cache(self, batch: int):
        c = self._caches.get(batch)
        if c is None:
            c = _exact_cache(self.n + 1)
            self._caches[batch] = c
        return c

    def _loop(self, emb: torch.Tensor, cache, temp: torch.Tensor, top_k: int, top_p: float, do_sample: bool):
        cp = self.cp
        model = cp.model
        x = cp.small_to_mtp_projection(emb)
        pos = self.pos[:2]
        cache.offset = 0
        h = model(inputs_embeds=x, attention_mask=self._masks, past_key_values=cache, cache_position=pos,
                  position_ids=pos.unsqueeze(0), use_cache=True).last_hidden_state
        tok = _sample(cp.lm_head[0](h[:, -1]), temp, top_k, top_p, do_sample)
        toks = [tok]
        for s in range(1, self.n):
            e = model.codec_embedding[s - 1](tok.unsqueeze(-1))
            x = cp.small_to_mtp_projection(e)
            pos = self.pos[s + 1:s + 2]
            cache.offset = s + 1
            h = model(inputs_embeds=x, attention_mask=self._masks, past_key_values=cache, cache_position=pos,
                      position_ids=pos.unsqueeze(0), use_cache=True).last_hidden_state
            tok = _sample(cp.lm_head[s](h[:, -1]), temp, top_k, top_p, do_sample)
            toks.append(tok)
        return torch.stack(toks, dim=-1)

    def _graph(self, batch: int, hidden: int, top_k: int, top_p: float, do_sample: bool):
        key = (batch, top_k, round(top_p, 4), do_sample)
        g = self._graphs.get(key)
        if g is not None:
            return g
        cache = self._cache(batch)
        static_emb = torch.zeros(batch, 2, hidden, device=self.device, dtype=self.dtype)
        static_temp = torch.ones(1, device=self.device)
        stream = torch.cuda.Stream()
        stream.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(stream):  # warm up outside the graph: lazy cache allocation, cuBLAS handles
            for _ in range(2):
                self._loop(static_emb, cache, static_temp, top_k, top_p, do_sample)
        torch.cuda.current_stream().wait_stream(stream)
        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph):
            static_out = self._loop(static_emb, cache, static_temp, top_k, top_p, do_sample)
        g = SimpleNamespace(graph=graph, emb=static_emb, temp=static_temp, out=static_out)
        self._graphs[key] = g
        return g

    def reset(self) -> None:
        self._graphs.clear()
        self._caches.clear()

    @torch.inference_mode()
    def generate(self, inputs_embeds: torch.Tensor, max_new_tokens: int | None = None, do_sample: bool = True,
                 top_p: float = 1.0, top_k: int = 50, temperature: float = 1.0, **_: Any):
        batch, steps, hidden = inputs_embeds.shape
        top_k = int(top_k or 0)
        top_p = float(1.0 if top_p is None else top_p)
        temperature = float(temperature or 1.0)
        do_sample = bool(do_sample)
        if steps != 2 or (max_new_tokens not in (None, self.n)):
            raise RuntimeError("unexpected code predictor call shape")
        if self.use_graphs and self.device.type == "cuda" and not self.disabled_reason:
            try:
                g = self._graph(batch, hidden, top_k, top_p, do_sample)
                g.emb.copy_(inputs_embeds)
                g.temp.fill_(temperature)
                g.graph.replay()
                return SimpleNamespace(sequences=g.out.clone())
            except Exception as e:  # noqa: BLE001 - fall back to the eager loop, still far cheaper than generate()
                self.disabled_reason = f"{type(e).__name__}: {e}"
                self._graphs.clear()
                torch.cuda.synchronize()
        temp = torch.full((1,), temperature, device=self.device)
        cache = self._cache(batch)
        seq = self._loop(inputs_embeds.to(self.dtype), cache, temp, top_k, top_p, do_sample)
        return SimpleNamespace(sequences=seq)


def install(qwen_model) -> FastCodePredictor:
    """Route the talker's per-frame ``code_predictor.generate`` through the fast path."""
    cp = qwen_model.model.talker.code_predictor
    fast = FastCodePredictor(cp)
    cp.generate = fast.generate
    return fast
