"""A recording cut into utterances at its pauses (numpy only: tested without the engine's runtime).

Energy against the recording's own noise floor, in 20 ms frames: what is louder than the floor by a share of its
range is speech. Pauses of at least ``gap_s`` separate utterances; utterances shorter than ``min_s`` join their
neighbour across a short pause, longer than ``max_s`` are split at their quietest point. Each keeps a little of the
silence around it (``pad_s``): the model learns how she starts and ends a sentence.
"""

from __future__ import annotations

import numpy as np

FRAME_S = 0.02


def _frames_db(x: np.ndarray, sr: int) -> np.ndarray:
    n = int(sr * FRAME_S)
    k = len(x) // n
    if k == 0:
        return np.zeros(0, np.float32)
    f = x[: k * n].reshape(k, n).astype(np.float64)
    return (10 * np.log10(np.mean(f * f, axis=1) + 1e-12)).astype(np.float32)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) frame runs where mask is true"""
    out, start = [], None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(mask)))
    return out


def speech_segments(x: np.ndarray, sr: int, *, min_s: float = 1.5, max_s: float = 12.0, gap_s: float = 0.3,
                    join_gap_s: float = 0.8, pad_s: float = 0.12) -> list[tuple[int, int]]:
    """→ [(start, end)] in samples, each an utterance of min_s … max_s (shorter left out)"""
    db = _frames_db(x, sr)
    if len(db) == 0:
        return []
    floor, top = float(np.percentile(db, 10)), float(np.percentile(db, 97))
    if top - floor < 10:  # (no speech above the floor: silence, or a flat noise)
        return []
    voiced = db > max(floor + 0.3 * (top - floor), -55.0)
    gap, f_s = max(1, int(round(gap_s / FRAME_S))), FRAME_S
    # pauses shorter than gap_s are inside an utterance; voiced blips under 60 ms are not speech
    runs = [r for r in _runs(voiced) if r[1] - r[0] >= 3]
    merged: list[list[int]] = []
    for s, e in runs:
        if merged and s - merged[-1][1] < gap:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    # short utterances join a neighbour across a short pause, while the whole stays under max_s
    joined: list[list[int]] = []
    for s, e in merged:
        if joined:
            ps, pe = joined[-1]
            short = (pe - ps) * f_s < min_s or (e - s) * f_s < min_s
            if short and (s - pe) * f_s <= join_gap_s and (e - ps) * f_s <= max_s:
                joined[-1][1] = e
                continue
        joined.append([s, e])
    # long ones split at their quietest frame (away from the ends), until each fits
    out: list[tuple[int, int]] = []
    todo = [tuple(j) for j in joined]
    while todo:
        s, e = todo.pop(0)
        if (e - s) * f_s <= max_s:
            out.append((s, e))
            continue
        lo, hi = s + int(min_s / f_s), e - int(min_s / f_s)
        cut = lo + int(np.argmin(db[lo:hi])) if hi > lo else (s + e) // 2
        todo[:0] = [(s, cut), (cut, e)]
    pad = int(pad_s * sr)
    n = int(sr * FRAME_S)
    segs = []
    for s, e in out:
        if (e - s) * f_s < min_s:
            continue
        segs.append((max(0, s * n - pad), min(len(x), e * n + pad)))
    return segs


def steps_for(batches_per_epoch: float, *, epochs: int = 50, least: int = 200, most: int = 1500) -> int:
    """How long to train: about ``epochs`` passes over her data (measured: 5 and 26 minutes of one speaker peaked at
    40–50 passes, then slowly overfit), within least … most steps."""
    return int(max(least, min(most, round(epochs * max(1.0, batches_per_epoch)))))


def eval_every(steps: int, evaluations: int = 6) -> int:
    return max(25, steps // evaluations)
