"""Does a take laugh? An AudioSet classifier (AST, MIT/ast-finetuned-audioset-10-10-0.4593: 527 sound classes) over
1.5 s windows — how the laughs a voice keeps are chosen (app/voicehost/sounds.py), and how the recipes were measured
(tools/nonverbal_bench.py). Loaded only while a voice's laughs are made, then let go."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

FAMILIES = {
    "laugh": ("Laughter", "Giggle", "Snicker", "Belly laugh", "Chuckle, chortle", "Baby laughter"),
    "sigh": ("Sigh", "Breathing"),
}
SR = 16000
WINDOW_S, HOP_S = 1.5, 0.25


class SoundCheck:
    def __init__(self, model_dir: str | Path, device: str = "cpu") -> None:
        import torch
        from transformers import ASTFeatureExtractor, ASTForAudioClassification

        self.torch = torch
        self.device = device
        self.fe = ASTFeatureExtractor.from_pretrained(str(model_dir))
        self.model = ASTForAudioClassification.from_pretrained(str(model_dir)).to(device).eval()
        labels = {v: int(k) for k, v in self.model.config.id2label.items()}
        self.idx = {k: [labels[n] for n in names if n in labels] for k, names in FAMILIES.items()}

    def score(self, wav: np.ndarray, sr: int, kind: str = "laugh", window: float = WINDOW_S,
              hop: float = HOP_S) -> dict[str, Any]:
        """→ {score: the most it sounds like `kind` in any window, start, end: that window (s)}"""
        torch = self.torch
        x = torch.from_numpy(np.asarray(wav, dtype=np.float32).reshape(-1))
        if sr != SR:
            import torchaudio

            x = torchaudio.functional.resample(x, sr, SR)
        y = x.numpy()
        n, h = int(window * SR), int(hop * SR)
        starts = list(range(0, max(1, len(y) - n + 1), h)) if len(y) > n else [0]
        probs = []
        with torch.inference_mode():
            for i in range(0, len(starts), 16):
                chunk = [y[s:s + n] for s in starts[i:i + 16]]
                feats = self.fe(chunk, sampling_rate=SR, return_tensors="pt").input_values.to(self.device)
                probs.append(torch.sigmoid(self.model(feats).logits)[:, self.idx[kind]].max(dim=1).values.float().cpu())
        p = torch.cat(probs).numpy()
        best = int(p.argmax())
        return {"score": float(p[best]), "start": starts[best] / SR, "end": min(len(y), starts[best] + n) / SR}

    def best_second(self, wav: np.ndarray, sr: int, kind: str = "laugh", length: float = 1.0) -> tuple[float, float]:
        """the `length` seconds of a take that sound most like `kind` (a giggle cut from a laugh) → (start, end) s"""
        r = self.score(wav, sr, kind, window=length, hop=0.125)
        return r["start"], r["end"]

    def close(self) -> None:
        del self.model
        if self.device.startswith("cuda"):
            self.torch.cuda.empty_cache()
