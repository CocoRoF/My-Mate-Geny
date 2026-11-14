"""Split long text into speakable segments.

Autoregressive engines drift (speed, timbre, repeated words) on long inputs and their memory grows with length;
sentence-sized segments keep quality and VRAM flat, and engines that batch (Qwen3-TTS) generate them in parallel.
"""

from __future__ import annotations

import re

_SENT_END = re.compile(r"(?<=[.!?。！？…])\s+|(?<=[.!?。！？…][\"'”’)\]])\s+|\n+")
_SOFT = re.compile(r"(?<=[,，、;；:])\s+")


def split(text: str, max_chars: int = 180, min_chars: int = 30) -> list[str]:
    text = re.sub(r"[ \t]+", " ", text.strip())
    if not text:
        return []
    raw = [s.strip() for s in _SENT_END.split(text) if s and s.strip()]
    pieces: list[str] = []
    for s in raw:
        if len(s) <= max_chars:
            pieces.append(s)
            continue
        # Too long for one breath: break at commas, then at spaces.
        buf = ""
        for part in _SOFT.split(s):
            if len(part) > max_chars:
                words, part_buf = part.split(" "), ""
                for w in words:
                    if part_buf and len(part_buf) + 1 + len(w) > max_chars:
                        pieces.append(part_buf)
                        part_buf = w
                    else:
                        part_buf = f"{part_buf} {w}".strip()
                part = part_buf
            if buf and len(buf) + 1 + len(part) > max_chars:
                pieces.append(buf)
                buf = part
            else:
                buf = f"{buf} {part}".strip()
        if buf:
            pieces.append(buf)
    # Merge very short pieces into their neighbour: one-word segments sound clipped.
    merged: list[str] = []
    for p in pieces:
        if merged and (len(p) < min_chars or len(merged[-1]) < min_chars) and len(merged[-1]) + 1 + len(p) <= max_chars:
            merged[-1] = f"{merged[-1]} {p}"
        else:
            merged.append(p)
    return merged
