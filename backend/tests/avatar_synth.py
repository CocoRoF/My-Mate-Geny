"""Synthetic inputs for the avatar pipeline test (run with the processing venv's python): a figure on the known gray
background as a candidate, its cut-out, a still, a short looping clip and the remover's subject-on-black version.

    python -I avatar_synth.py <project dir>
"""
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

GRAY = (213, 212, 217)


def figure(w: int, h: int, t: float = 0.0, smile: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """(colour, alpha 0..1) of a simple waist-up figure, swaying by ``t`` (0..1 → one loop)."""
    col = np.zeros((h, w, 3), np.uint8)
    a = np.zeros((h, w), np.uint8)
    dx = int(round(math.sin(t * 2 * math.pi) * w * 0.01))
    cx = w // 2 + dx
    body = np.array([[cx - w * 0.28, h], [cx - w * 0.16, h * 0.55], [cx + w * 0.16, h * 0.55], [cx + w * 0.28, h]],
                    np.int32)
    cv2.fillPoly(col, [body], (40, 34, 70))
    cv2.fillPoly(a, [body], 255)
    head = (cx, int(h * 0.38))
    r = int(w * 0.14)
    cv2.circle(col, head, r, (236, 205, 190), -1)
    cv2.circle(a, head, r, 255, -1)
    for ex in (-0.05, 0.05):
        cv2.ellipse(col, (cx + int(w * ex), int(h * 0.37)), (int(w * 0.015), int(w * 0.022)), 0, 0, 360, (30, 30, 40),
                    -1)
    if smile:
        cv2.ellipse(col, (cx, int(h * 0.43)), (int(w * 0.04), int(w * 0.02)), 0, 0, 180, (150, 40, 60), 3)
    a = cv2.GaussianBlur(a, (0, 0), 1.2)
    return col.astype(np.float32), a.astype(np.float32) / 255.0


def over(col: np.ndarray, a: np.ndarray, bg) -> np.ndarray:
    return (col * a[..., None] + np.array(bg, np.float32) * (1 - a[..., None])).clip(0, 255).astype(np.uint8)


def ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def video(path: Path, frames: list[np.ndarray], fps: int = 24) -> None:
    h, w = frames[0].shape[:2]
    p = subprocess.Popen([ffmpeg(), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r",
                          str(fps), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", str(path)],
                         stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    assert p.wait() == 0


def main(p: Path) -> None:
    w, h = 600, 800
    col, a = figure(w, h)
    Image.fromarray(over(col, a, (225, 225, 230))).save(p / "masters" / "candidate.png")
    Image.fromarray(np.dstack([col, a * 255]).clip(0, 255).astype(np.uint8), "RGBA").save(
        p / "masters" / "candidate.cut.png")
    scol, sa = figure(w, h, smile=True)
    Image.fromarray(over(scol, sa, (225, 225, 230))).save(p / "stills" / "smile.raw.png")
    n, s = 48, 360
    orig, masked = [], []
    for i in range(n):
        c, al = figure(s, s, i / (n - 1))
        orig.append(over(c, al, GRAY))
        masked.append(over(c, al, (0, 0, 0)))
    video(p / "clips" / "idle_a.mp4", orig)
    video(p / "clips" / "idle_a.nobg.mp4", masked)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
    os._exit(0)
