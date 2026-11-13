"""Avatar processing — the picture and video work between the Higgsfield jobs (docs/avatar-create.md §5).

A port of ailism-mate ``original_content/tools/mate.py`` (the pipeline that made 한채린), run by the
backend in its own venv (numpy, scipy, opencv, pillow; ffmpeg from the system or imageio-ffmpeg) under a memory cap,
one at a time. Every step streams video frame by frame (a 1440px clip is ~1 GB as one array).

    python -I pipeline.py <step> <project dir> [args]

Steps (files are relative to the project dir; ``pipeline.json`` there holds the settings):

    prep               masters/candidate.png → candidate.cutin.jpg (1600px, for the cut-out) + candidate.ref.jpg
                       (2048px, the stills' reference) + info.json
    home               + masters/candidate.cut.png (the remover's) → home.png (clean alpha, colour without the old
                       background: its edge measured from the picture, see edge_matte), place.json (where it sits on the canvas), home-gray.jpg (the clips' first and
                       last frame), face.json + face-mask.png (the region the stills may change)
    stills             stills/<n>.raw.png → stills/<n>.png (only the face region laid over the home picture)
    matte <id>         clips/<id>.mp4 + clips/<id>.nobg.mp4 → matte/<id>.alpha.mkv (lossless gray) + matte/<id>.json
                       (alpha recovered from the known flat gray: α = removed / original, colour = (orig − (1−α)·bg) / α;
                       gaps the remover covers opened again, see rematte)
    encode             all mattes → web/<id>.lg.mp4, web/<id>.sm.mp4 (stacked alpha: colour above, alpha below; each frame's
                       edge measured from the picture and the gray taken out of its colour, see edge_matte) +
                       web/box.json (one crop for every clip and still)
    check              → check.json: loop seam, first frame vs the base picture, background drift, alpha quality
    export <key>       → export/: rig.json, <still>.webp, <clip>.{lg,sm}.mp4, portrait.webp (an ailism-style pack)
    frame <pack>       measure where her face sits in a pack's stills and write it into its rig.json
    sheet <id> <out>   four frames of a clip side by side, cut out on a dark page once its matte exists (for a look)
    thumb <src> <dst> [px]
    selftest [assets]  the alpha recovery on a synthetic frame and, given the bundled mates' assets, on real art (tests)
    versions           what is installed

The last line on stdout is a JSON object: {"ok": true, …} or {"ok": false, "error": "…"}.
"""

from __future__ import annotations

import collections
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).resolve().parent
GRAY = (213, 212, 217)
CANVASES = {"9:16": (1080, 1920), "1:1": (1080, 1080)}
#: colour distance from the background gray where a pixel starts to count as the body, and where it surely is
KEY_FROM, KEY_TO = 45.0, 90.0
#: colour distance under which a pixel simply shows the background (video noise stays under ~5)
GAP_KEY = 9.0
#: under this the picture may still be the background: the gray behind fine hair picks up a tint of the hair
NEAR_KEY = 3 * GAP_KEY
#: pictures to judge a cut-out by stand on this: on the gray they were cut from, what is left of it can't be seen
REVIEW_PAGE = (22, 46, 72)
JOB_ASPECTS = {"1:1": 1.0, "3:4": 0.75, "4:3": 4 / 3, "2:3": 2 / 3, "3:2": 1.5, "9:16": 9 / 16, "16:9": 16 / 9}


def out(**kw) -> None:
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def progress(**kw) -> None:
    print(json.dumps({"progress": kw}, ensure_ascii=False), flush=True)


def ffmpeg() -> str:
    exe = os.environ.get("AVATAR_FFMPEG") or shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg  # noqa: PLC0415 - only when the system has no ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def cfg(p: Path) -> dict:
    try:
        return json.loads((p / "pipeline.json").read_text())
    except (OSError, ValueError):
        return {}


def atomic_save(img: Image.Image, path: Path, **kw) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".part" + path.suffix)
    img.save(tmp, **kw)
    os.replace(tmp, path)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    os.replace(tmp, path)


# ---------------------------------------------------------------- video io

def probe(path: Path) -> tuple[int, int, float]:
    """(width, height, fps) from ffmpeg's own description of the file (no ffprobe needed)."""
    r = subprocess.run([ffmpeg(), "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    m = None
    for line in r.stderr.splitlines():
        if "Video:" in line:
            m = line
            break
    if m is None:
        raise RuntimeError(f"{path.name}: no video stream")
    size = re.search(r"\b(\d{2,5})x(\d{2,5})\b", m)
    fps = re.search(r"([\d.]+) fps", m) or re.search(r"([\d.]+) tbr", m)
    if not size:
        raise RuntimeError(f"{path.name}: unknown size")
    return int(size.group(1)), int(size.group(2)), float(fps.group(1)) if fps else 24.0


def frames(path: Path, fmt: str = "rgb24", size: tuple[int, int] | None = None):
    """The frames one at a time (``size``: scaled to it)."""
    w, h, _ = probe(path)
    ch = {"rgb24": 3, "gray": 1}[fmt]
    args = [ffmpeg(), "-v", "error", "-i", str(path)]
    if size and size != (w, h):
        args += ["-vf", f"scale={size[0]}:{size[1]}:flags=area"]
        w, h = size
    p = subprocess.Popen([*args, "-pix_fmt", fmt, "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    assert p.stdout
    n = w * h * ch
    try:
        while True:
            buf = p.stdout.read(n)
            if len(buf) < n:
                break
            a = np.frombuffer(buf, np.uint8)
            yield a.reshape(h, w, 3) if ch == 3 else a.reshape(h, w)
    finally:
        p.stdout.close()
        p.kill()
        p.wait()


def writer(path: Path, w: int, h: int, fps: float, fmt: str, codec: list[str]) -> subprocess.Popen:
    path.parent.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen([ffmpeg(), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", fmt, "-s", f"{w}x{h}",
                             "-r", f"{fps:g}", "-i", "-", *codec, "-an", str(path)], stdin=subprocess.PIPE)


def close(p: subprocess.Popen, path: Path) -> None:
    assert p.stdin
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError(f"ffmpeg failed writing {path.name}")


# ---------------------------------------------------------------- alpha helpers (mate.py)

def clean_alpha(a: np.ndarray) -> np.ndarray:
    """Drops specks: parts not connected to the body and smaller than 0.3% of it."""
    lab, n = ndimage.label(a > 0.08)
    if n <= 1:
        return a
    sizes = ndimage.sum(np.ones_like(a), lab, index=np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool)
    keep[1:] = sizes >= max(sizes.max() * 0.003, 40)
    return np.where(keep[lab], a, 0.0)


def border_bg(orig: np.ndarray, k: int) -> np.ndarray:
    border = np.concatenate([orig[:k].reshape(-1, 3), orig[:, :k].reshape(-1, 3), orig[:, -k:].reshape(-1, 3)])
    return np.median(border, axis=0)


def flat_background(orig: np.ndarray, a: np.ndarray, bg: np.ndarray) -> bool:
    """Whether a picture stands on one flat colour, which is what telling the background by its colour rests on. Clips
    always do (they start from the known gray); a reference used as it is (``as_base``) may stand on a room."""
    away = cv2.erode((a < 0.02).astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)[::4, ::4]
    if away.mean() < 0.01:
        return False
    return float(np.percentile(np.abs(orig[::4, ::4][away] - bg).max(-1), 95)) <= 2 * GAP_KEY


def rematte(a: np.ndarray, orig: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """The remover's mask is a smooth hull over fine hair: gray seen between a loose strand and the head comes out as
    body (a white patch on a dark page) and a dark edge keeps a rim of gray. The background is one known flat colour, so
    the picture itself tells. A patch of that gray, or of that gray mixed with the dark next to it (a gap a few pixels
    wide never gets to the pure gray), is background when it is ringed by dark or open background and lies near the
    outline, opens to a hole or lies next to such a gap; light parts of the body can match the gray too (a headset's
    shading, a white band), but those are ringed by other light colours or, like the eyes, lie deep inside. From there on
    a few pixels of mix get the coverage the mix says. Colours that cannot be told from the gray (silver hair) keep the
    remover's answer, unless it doubts it (``doubted_gray``). Only on one flat background: elsewhere nothing changes."""
    if not flat_background(orig, a, bg):
        return a
    # (only around the body: most of a frame is empty, and a clip has over a hundred of them)
    rows, cols = np.flatnonzero((a > 0.04).any(1)), np.flatnonzero((a > 0.04).any(0))
    if not len(rows):
        return a
    y0, y1 = max(0, rows[0] - 40), rows[-1] + 41
    x0, x1 = max(0, cols[0] - 40), cols[-1] + 41
    out = a.copy()
    out[y0:y1, x0:x1] = close_body_holes(_rematte(a[y0:y1, x0:x1], orig[y0:y1, x0:x1], bg, a.shape[1], a.size),
                                         orig[y0:y1, x0:x1], bg)
    return out


def close_body_holes(a: np.ndarray, orig: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """A light part of the body can pass for the background (the highlight on her nose, in some frames of a clip), and
    the remover leaves a hole in the middle of her face. What shows through a real gap is the gray, or the gray mixed
    with the dark around it; so a hole whose picture is lighter than the gray, or has a colour of its own, is body. Unless
    dark hair rings it: there, a little lighter than the gray is the sharpening's overshoot."""
    solid = a > 0.5
    lab, n = ndimage.label(ndimage.binary_fill_holes(solid) & ~solid)
    if not n:
        return a
    off = orig - bg
    dark = orig.mean(-1) < 0.5 * bg.mean()
    body = np.zeros_like(solid)
    for i, (ys, xs) in enumerate(ndimage.find_objects(lab), 1):
        ys, xs = slice(max(0, ys.start - 3), ys.stop + 3), slice(max(0, xs.start - 3), xs.stop + 3)
        hole = lab[ys, xs] == i
        mid = np.median(off[ys, xs][hole], axis=0)
        level = float(mid.mean())
        if np.linalg.norm(mid) < NEAR_KEY or (level <= GAP_KEY and np.linalg.norm(mid - level) <= GAP_KEY):
            continue
        grown = cv2.dilate(hole.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
        if dark[ys, xs][grown & ~hole].mean() <= 0.25:
            body[ys, xs] |= grown
    return np.where(body, 1.0, a).astype(a.dtype)


def _rematte(a: np.ndarray, orig: np.ndarray, bg: np.ndarray, W: int, size: int) -> np.ndarray:
    r = max(3, W // 288)
    kernel = np.ones((3, 3), np.uint8)
    dark = cv2.erode(orig, np.ones((3 * r | 1, 3 * r | 1), np.uint8))  # per channel: the darkest colour near a pixel
    v = dark - bg
    vv = (v * v).sum(-1)
    cover = ((orig - bg) * v).sum(-1) / np.maximum(vv, 1.0)
    off = np.sqrt(((orig - bg - cover[..., None] * v) ** 2).sum(-1))
    dist = np.sqrt(((orig - bg) ** 2).sum(-1))
    # a little lighter than the gray is the sharpening's overshoot next to a dark edge
    mix = (vv > (1.5 * KEY_TO) ** 2) & (cover < 0.9) & (off < GAP_KEY) & ((cover > 0) | (dist < 4 * GAP_KEY))
    cover = np.clip(cover, 0, 1).astype(np.float32)
    hull = a > 0.5
    flat = dist < GAP_KEY
    light = hull & (flat | (mix & (cover < 0.25)))
    # the fragments of one gap (noise cuts it up) count as one, but not across an outline
    lab, n = ndimage.label(ndimage.binary_dilation(light, structure=kernel, iterations=2, mask=hull & (cover < 0.6)),
                           structure=kernel)
    gaps = np.zeros_like(hull)
    if n:
        ids = np.arange(1, n + 1)

        def around(m: np.ndarray) -> np.ndarray:
            return ndimage.sum(cv2.boxFilter(m.astype(np.float32), -1, (11, 11), normalize=False), lab, ids)

        total = np.maximum(around(~light), 1)
        hole = around(~hull) / total
        ringed = np.zeros(n + 1, bool)
        ringed[1:] = (hole + around(hull & (orig.mean(-1) < 0.5 * bg.mean())) / total >= 0.6) & (
            ndimage.sum(light, lab, ids) >= 6)
        inside = cv2.distanceTransform(ndimage.binary_fill_holes(hull).astype(np.uint8), cv2.DIST_L2, 3)
        keep = ringed.copy()
        keep[1:] &= (np.atleast_1d(ndimage.mean(inside, lab, ids)) <= max(12.0, 0.015 * W)) | (hole >= 0.05)
        keep[np.unique(lab[cv2.dilate(keep[lab].astype(np.uint8), np.ones((6 * r + 1, 6 * r + 1), np.uint8)) > 0])] = True
        keep &= ringed
        gaps = keep[lab] & light
    # from the background the mix only ever darkens: what turns light again lies behind an outline
    edge = gaps | (a < 0.04)
    for _ in range(r):
        step = cv2.dilate(edge.astype(np.uint8), kernel).astype(bool) & ~edge & mix
        step &= cover >= cv2.erode(np.where(edge, cover, 9.0).astype(np.float32), kernel) - 0.05
        if not step.any():
            break
        edge |= step
    a = np.where(edge, np.minimum(a, np.clip((cover - 0.03) / 0.57, 0, 1)), a)  # the half-dark tones of hair stay solid
    a[gaps & flat] = 0
    return doubted_gray(a, dist, size)


def doubted_gray(a: np.ndarray, dist: np.ndarray, size: int) -> np.ndarray:
    """Where the remover itself doubts and the picture says it is about the gray. That is what tells a tinted gap between
    pale hair from a pale part of the body the remover is sure of (a headset, a white band). A small patch it doubts for a
    good part goes as a whole; elsewhere each doubted pixel fades with how close it is to the gray. No hard thresholds:
    they show as jagged edges and flicker from frame to frame."""
    near = (dist < NEAR_KEY) & (a > 0.04)
    lab, n = ndimage.label(near, structure=np.ones((3, 3)))
    if n:
        ids = np.arange(1, n + 1)
        small = ndimage.sum(near, lab, ids) <= 0.004 * size
        keep = np.zeros(n + 1, bool)
        keep[1:] = small & (np.asarray(ndimage.mean(a, lab, ids)) < 0.65)  # (it mostly says "not her")
        patch = cv2.GaussianBlur(keep[lab].astype(np.float32), (0, 0), 1.5)
        a = a + np.clip(2 * patch, 0, 1) * (np.minimum(a, np.clip((dist - GAP_KEY) / (NEAR_KEY - GAP_KEY), 0, 1)) - a)
    doubt = np.clip((0.95 - a) / 0.15, 0, 1)
    return a * (1 - doubt * (1 - np.clip((dist - GAP_KEY) / (NEAR_KEY - GAP_KEY), 0, 1)))


def held_objects(a: np.ndarray, orig: np.ndarray, bg: np.ndarray, dist: np.ndarray, near: np.ndarray) -> np.ndarray:
    """What she holds, when the remover drops it whole: it keeps the person, and a book held up in front of her or a cup on
    its way out of the frame can go entirely, in some frames of a clip and not in others. On the flat gray, whatever is
    clearly not the gray and joined to her (``near``) through more of it is hers, however far it reaches. Its inside counts
    in full (a ramp from the gray would leave a book's light pages see-through); its outline is the edge steps' work. Only
    when the rest is the flat gray (what was dropped is no background to judge by) and it is smaller than she is: on a room
    the walls and the furniture would join her."""
    strong = dist > KEY_FROM
    lab, n = ndimage.label(strong, structure=np.ones((3, 3)))
    if not n:
        return a
    hers = np.zeros(n + 1, bool)
    hers[np.unique(lab[strong & near])] = True
    hers[0] = False
    far = hers[lab] & ~near
    if not far.any():
        return a
    out = np.where(far, 1.0, a).astype(a.dtype)
    if far.sum() > (a > 0.5).sum() or not flat_background(orig, out, bg):
        return a
    return out


def recover(orig: np.ndarray, masked: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """One frame's alpha (0..1) from the original on the flat gray and the remover's subject-on-black, and the
    background colour of this frame (the light may drift a little)."""
    bg = border_bg(orig, 24)
    so, sm = orig.sum(-1), masked.sum(-1)
    a = np.clip(sm / np.maximum(so, 1.0), 0, 1)
    dark = so < 60
    a[dark] = (sm[dark] > 12).astype(np.float32)
    a[a < 0.04] = 0
    a[a > 0.96] = 1
    # the background is one known flat gray: a pixel near the body that is clearly not that gray is the body, whatever
    # the remover says (its mask cracks along dark fold lines); colours close to the gray keep the remover's answer
    dist = np.sqrt(((orig - bg) ** 2).sum(-1))
    key = np.clip((dist - KEY_FROM) / (KEY_TO - KEY_FROM), 0, 1)
    near = ndimage.binary_dilation(a > 0.5, structure=np.ones((3, 3)), iterations=12)
    a = np.where(near, np.maximum(a, key), a)
    a = held_objects(a, orig, bg, dist, near)
    # solid inside the body — but holes that ARE the background (gray seen through a ponytail's loop) stay open
    solid = ndimage.binary_fill_holes(a > 0.5)
    a = np.where(solid & (a < 0.5) & (dist > KEY_FROM), np.maximum(a, 0.98), a)
    a = clean_alpha(rematte(a, orig, bg))
    a = cv2.GaussianBlur(a.astype(np.float32), (0, 0), 0.6)
    return a, bg


def colour(orig: np.ndarray, a: np.ndarray, bg: np.ndarray) -> np.ndarray:
    aa = a[..., None]
    return np.where(aa > 0.02, (orig - (1 - aa) * bg) / np.maximum(aa, 0.02), 0).clip(0, 255)


# ---------------------------------------------------------------- her edge

#: Her edge, measured from the picture (``edge_matte``). Pixels are a clip's of this width: ``scale`` stretches them for a
#: picture at another scale. EDGE_VERSION marks a cut-out whose edge is measured so (place.json "edge")
EDGE_CLIP, EDGE_VERSION = 1440, 1
#: up to EDGE_NOISE from the gray a pixel is the gray itself, video noise (under ~5) and the codec's colour blur at her edge;
#: her alpha grows in over EDGE_FADE more
EDGE_NOISE, EDGE_FADE = 6.0, 8.0
#: how far into her the gray is mixed with her at an edge (the line drawn round her and its anti-aliasing), and how far away her
#: own colour is looked for: a loose strand's pixels are all mixes, its colour is that of the outline a little further on
EDGE_MIX, EDGE_REACH = 3, 12
#: the gray between strands that the remover covered: a patch inside her matte (a patch bigger than this share of her and
#: wider than EDGE_REACH is a part of her in the gray's own colour: a gray hood); closed in by her, no further from her outline
#: than this many times EDGE_REACH
EDGE_GAP_AREA, EDGE_GAP_REACH = 0.004, 4
#: such a patch: its pixels closer to the gray than the first, at least the share (third) of them closer than the second (the
#: gray seen through a gap a few pixels wide takes on a tint of the strands round it: the codec keeps colour at half the
#: resolution); closed in by her, this share of what lies two to four pixels round it clearly not the gray (her lines)
EDGE_GAP_KEY, EDGE_GAP_DRAWN = (18.0, 9.0, 0.3), 0.25
#: a gap a few pixels wide between two of her lines (clearly not the gray: KEY_TO) gets no closer to the gray than this
EDGE_VALLEY = 24.0
#: a colour off the line from the gray through a pixel by no more than this (plus this share of its own distance from the gray)
#: is that pixel's colour, mixed with the gray in some other proportion
EDGE_LINE = (6.0, 0.1)
#: the noise of her colour where it is measured (plus this share of its distance from the gray)
EDGE_KNEE = (3.0, 0.03)
#: the sharpening's light line just outside her outline: no colour of its own, the gray's or lighter, no further from it than
#: this, within EDGE_HALO_NEAR pixels of something clearly not the gray
EDGE_HALO, EDGE_HALO_CHROMA, EDGE_HALO_NEAR = 40.0, 8.0, 2
#: past her, this many pixels take the colour of her nearest pixel (and black beyond: a flat field costs the codec nothing), so
#: the codec's colour blur and the browser's scaling find her colours there and not a dark rim
EDGE_FILL = 6


def _rings(near: int, far: int) -> np.ndarray:
    """Where around a pixel her colour is looked for: every pixel up to ``near`` away, then rings out to ``far``, two pixels
    apart along each (a ring a pixel further on is turned half a step, so a fine line crossing them is met)."""
    offs = {(dy, dx) for dy in range(-near, near + 1) for dx in range(-near, near + 1) if 0 < dy * dy + dx * dx <= near * near}
    for r in range(near + 1, far + 1):
        n = max(8, int(round(np.pi * r)))
        for k in range(n):
            t = 2 * np.pi * (k + 0.5 * (r % 2)) / n
            offs.add((int(round(r * np.sin(t))), int(round(r * np.cos(t)))))
    offs.discard((0, 0))
    return np.array(sorted(offs, key=lambda o: o[0] * o[0] + o[1] * o[1]), np.int32)


def _her_colour(v: np.ndarray, sure: np.ndarray, ys: np.ndarray, xs: np.ndarray, far_too: np.ndarray, near: int,
                far: int) -> tuple[np.ndarray, np.ndarray]:
    """For the pixels (ys, xs): her colour there, as an offset from the gray. A pixel at her edge is her colour mixed with the
    gray, so it lies on the line from the gray to her colour: of the pixels around it that are surely her (``sure``) and lie on
    that line, the one furthest out along it, among the nearest of them (the nearest one and what lies up to ``near`` pixels
    further: right behind an edge, her colour there, not a darker fold of it further on); for the pixels ``far_too``, among all
    up to ``far`` away (a loose strand's own pixels are all mixes: its colour is the line it is drawn in). The pixel's own colour
    counts if it is sure. → (that colour, whether there was one)."""
    H, W = sure.shape
    Wp = W + 2 * far
    vp = np.zeros((H + 2 * far, Wp, 3), np.float32)
    vp[far:far + H, far:far + W] = np.where(sure[..., None], v, 0.0)  # (only what is surely her can be chosen)
    flat = vp.reshape(-1, 3)
    n2 = (flat * flat).sum(-1)
    base = ((ys + far) * Wp + xs + far).astype(np.int64)
    vb = v[ys, xs]
    db = np.sqrt((vb * vb).sum(-1))
    u = (vb / np.maximum(db, 1e-3)[:, None]).astype(np.float32)
    own = sure[ys, xs] & (db > EDGE_NOISE)
    best = np.where(own, db, 0.0).astype(np.float32)
    pick = np.where(own, base, 0)
    first = np.where(own, 0.0, np.inf).astype(np.float32)
    a_tol, r_tol = EDGE_LINE
    # (the pixels still looking: one that is the gray itself has no colour to look for; one at her body's edge stops a few
    # pixels past the first it found)
    live = np.flatnonzero(db > EDGE_NOISE)
    lu, lb, lfar = u[live], base[live], far_too[live]
    radius = 0.0
    for dy, dx in _rings(near, far):
        r = float(np.hypot(dy, dx))
        if not len(live):
            break
        if r > radius + 0.99:
            radius = r
            keep = lfar | (first[live] + near >= r)
            if keep.mean() < 0.8:
                live, lu, lb, lfar = live[keep], lu[keep], lb[keep], lfar[keep]
        idx = lb + (int(dy) * Wp + int(dx))
        proj = np.einsum("ij,ij->i", flat[idx], lu)
        tol = a_tol + r_tol * proj
        on = (proj > EDGE_NOISE) & (n2[idx] - proj * proj <= tol * tol)
        fl = first[live]
        ok = on & (proj > best[live]) & (lfar | (r <= np.minimum(fl, r) + near))
        np.minimum(fl, np.where(on, r, np.inf), out=fl)
        first[live] = fl
        j = live[ok]
        best[j] = proj[ok]
        pick[j] = idx[ok]
    found = best > EDGE_NOISE
    return np.where(found[:, None], flat[pick], 0.0), found


def _valley(d: np.ndarray, reach: int, floor: float, wall: float) -> np.ndarray:
    """Pixels closer to the gray than ``floor`` with something at least ``wall`` from it within ``reach`` pixels on both
    sides of them, along two of the four lines through them (across, down, the diagonals): the gray in a channel between two
    lines, however mixed with them. (Where two lines meet in a corner only one line through it has them on both sides.)"""
    H, W = d.shape
    pad = np.pad(d, reach, mode="edge")
    walled = np.zeros(d.shape, np.uint8)
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        both = np.ones(d.shape, bool)
        for sign in (1, -1):
            side = np.zeros(d.shape, d.dtype)
            for k in range(1, reach + 1):
                oy, ox = reach + sign * k * dy, reach + sign * k * dx
                np.maximum(side, pad[oy:oy + H, ox:ox + W], out=side)
            both &= side >= wall
        walled += both
    return (walled >= 2) & (d < floor)


def _march(her: np.ndarray, d: np.ndarray, v: np.ndarray, gap_id: np.ndarray, opened: np.ndarray, start: np.ndarray,
           hers_gray: np.ndarray, mix: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """From ``start`` (outside her, and the gray opened in her) into her, a pixel at a time (four ways): into a patch of the gray
    (``gap_id`` > 0) whole, and then on into her for ``mix`` pixels as long as the picture keeps moving away from the gray and
    the same way (past a mix of hers, a pixel turning another way is another colour of hers, a light one the march came in
    through, not the gray). → (marched, the step that reached each pixel (0: start), the patches opened)."""
    H, W = her.shape
    n = H * W
    herf, df, gf, hgf = her.ravel(), d.ravel(), gap_id.ravel(), hers_gray.ravel()
    uf = (v / np.maximum(d, 1e-3)[..., None]).reshape(-1, 3).astype(np.float32)
    out = start.ravel().copy()
    order = np.where(out, 0, 0x7FFF).astype(np.int16)
    depth = np.where(out, 0, 0x7FFF).astype(np.int16)  # steps of mix since the gray
    way = np.zeros(n, bool)  # marched pixels of hers with a colour clear enough to tell its way
    # (each patch's pixels, to open it whole)
    gp = np.flatnonzero(gf)
    gp = gp[np.argsort(gf[gp], kind="stable")]
    bounds = np.searchsorted(gf[gp], np.arange(len(opened) + 1))
    xs = np.arange(n) % W

    def around(p: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
        """For each of the four ways: (index into ``p``, that pixel's neighbour), inside the picture."""
        x = xs[p]
        res = []
        for sel, off in ((x > 0, -1), (x < W - 1, 1), (p >= W, -W), (p < n - W, W)):
            i = np.flatnonzero(sel)
            res.append((i, p[i] + off))
        return res

    front = np.flatnonzero((start & (_step4((her & ~start).astype(np.uint8), np.maximum) > 0)).ravel())
    for k in range(1, 0x7FFF):
        cand = np.unique(np.concatenate([q for _, q in around(front)]))
        cand = cand[herf[cand] & ~out[cand]]
        if not len(cand):
            break
        ids = np.unique(gf[cand])
        ids = ids[(ids > 0) & ~opened[ids]]
        opened[ids] = True
        g = np.concatenate([gp[bounds[i]:bounds[i + 1]] for i in ids]) if len(ids) else np.zeros(0, np.int64)
        c = cand[(gf[cand] == 0) & ~hgf[cand]]
        last = np.full(len(c), -1.0, np.float32)
        low = np.full(len(c), 0x7FFF, np.int32)
        same = np.zeros(len(c), bool)
        for i, q in around(c):
            hit = out[q]
            j, q = i[hit], q[hit]
            np.maximum.at(last, j, df[q])
            np.minimum.at(low, j, depth[q])
            same[j] |= ~way[q] | ((uf[c[j]] * uf[q]).sum(-1) >= 0.8)
        dc = df[c]
        m = c[(low < mix) & (dc >= last - (EDGE_NOISE + 0.1 * last)) & same]
        mdepth = (low + 1)[(low < mix) & (dc >= last - (EDGE_NOISE + 0.1 * last)) & same]
        g = g[~out[g]]
        if not len(g) and not len(m):
            break
        out[g] = True
        out[m] = True
        order[g] = k
        order[m] = k
        depth[g] = 0
        depth[m] = mdepth
        # (a way is told by a clear colour; not by the sharpening's light line, which turns the other way from a dark outline)
        vm = uf[m] * df[m][:, None]
        way[m[(df[m] >= EDGE_NOISE + EDGE_FADE) & ~((vm.min(-1) >= -4) & (np.ptp(vm, -1) < EDGE_HALO_CHROMA))]] = True
        front = np.concatenate([g, m])
    return out.reshape(H, W), order.reshape(H, W), opened


def _step4(m: np.ndarray, op) -> np.ndarray:
    """``op`` (np.maximum / np.minimum) of each pixel and its four neighbours."""
    r = m.copy()
    op(r[1:], m[:-1], out=r[1:])
    op(r[:-1], m[1:], out=r[:-1])
    op(r[:, 1:], m[:, :-1], out=r[:, 1:])
    op(r[:, :-1], m[:, 1:], out=r[:, :-1])
    return r


def edge_matte(o: np.ndarray, a0: np.ndarray, bg: np.ndarray, scale: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """Her alpha and her colour, from the picture on the known flat gray (``o``) and her matte (``a0``: what is her, 0..1).

    The matte says where she is; at her edge the picture says how much. An edge pixel is her colour mixed with the gray,
    C = α·F + (1 − α)·B, and on the gray the mix is all there is to see; on a dark page a pixel called all her while it still
    holds gray is a light rim round her (her hair's strands, her arms). So, from the outside in, through the gray her matte
    covers (between strands: patches of it, and channels between two of her lines too narrow to ever show it unmixed) and then
    a few pixels on, as long as the picture keeps moving away from the gray and the same way (past her outline it comes back
    towards it: that is her inside, and the matte's word stands there), and over all of what is thinner than two edges (a
    strand), each pixel's alpha is measured: how far its colour lies from the gray along the line to her colour there
    (``_her_colour``), the gray's noise faded out. Her colour is then the mix undone, F = (C − (1 − α)·B) / α, and where little
    of her is left her colour from nearby. The sharpening's light line outside a strong outline is none of her. Past her, her
    colours carried out a few pixels (``EDGE_FILL``).

    Whatever the page: on the gray she looks exactly as she was made; on a dark or a light one no gray shows at her edge, a
    fine strand stays a strand (its mix measured, no threshold to break it into dots), her inside stays solid, light clothes
    included (only her outermost pixels are ever measured, and a colour like the gray's in a big wide patch is hers).
    ``scale``: the picture's pixels per pixel of an EDGE_CLIP-wide clip. → (alpha 0..1, colour 0..255), float32."""
    H, W = a0.shape
    alpha = np.zeros((H, W), np.float32)
    rgb = np.zeros((H, W, 3), np.float32)
    seen = a0 > 0.02
    if not seen.any():
        return alpha, rgb
    mix = max(2, int(round(EDGE_MIX * scale)))
    reach = max(mix + 2, int(round(EDGE_REACH * scale)))
    fill = max(2, int(round(EDGE_FILL * scale)))
    # (only around her: most of a frame is empty)
    rows, cols = np.flatnonzero(seen.any(1)), np.flatnonzero(seen.any(0))
    pad = reach + fill + 2
    y0, y1 = max(0, rows[0] - pad), min(H, rows[-1] + pad + 1)
    x0, x1 = max(0, cols[0] - pad), min(W, cols[-1] + pad + 1)
    al, col = _edge_matte(o[y0:y1, x0:x1].astype(np.float32), a0[y0:y1, x0:x1].astype(np.float32),
                          np.asarray(bg, np.float32), mix, reach, fill)
    alpha[y0:y1, x0:x1] = al
    rgb[y0:y1, x0:x1] = col
    return alpha, rgb


def _dist(mask: np.ndarray) -> np.ndarray:
    """For each pixel of ``mask``, how far the nearest pixel outside it is (0 outside)."""
    return cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 5)


def _grow(mask: np.ndarray, px: int) -> np.ndarray:
    return cv2.dilate(mask.astype(np.uint8), np.ones((2 * px + 1, 2 * px + 1), np.uint8)).astype(bool)


def _edge_matte(o: np.ndarray, a0: np.ndarray, bg: np.ndarray, mix: int, reach: int, fill: int) -> tuple[np.ndarray, np.ndarray]:
    her = a0 >= 0.5
    v = o - bg
    d = np.sqrt((v * v).sum(-1))
    if not her.any():
        return np.zeros_like(a0), np.zeros_like(o)
    depth_in = _dist(her)
    gap_reach = EDGE_GAP_REACH * reach
    # the gray inside her matte, in patches no bigger than a gap and of the gray's very colour: opened whole once reached from
    # outside her; or, closed in by her, when it lies near her outline and is a sliver or her lines run round it (the gray
    # seen between two strands, where they cross). A gray part of her keeps her matte: too big, or set deep in her (an eye's
    # light), or a round patch in her light colours (on a badge)
    gray = her & (d < EDGE_GAP_KEY[0])
    lab, n = ndimage.label(gray, structure=np.ones((3, 3)))
    gap = np.zeros(n + 1, bool)
    seed = np.zeros(n + 1, bool)
    big = np.zeros(n + 1, bool)
    if n:
        ids = np.arange(1, n + 1)
        lg = lab[gray]  # (the patches' own pixels only: the rest of the picture has nothing to say)
        size = np.bincount(lg, minlength=n + 1)[1:].astype(np.float64)
        thick = np.asarray(ndimage.maximum(_dist(gray)[gray], lg, ids))
        # (a long thin band of it is no part of her however long: the gray the remover's hull keeps all along her outline)
        big[1:] = (size > EDGE_GAP_AREA * her.sum()) & (thick > reach / 2)
        # (a line of it a pixel or two wide is no gap the gray shows through: where two colours of hers meet, a light one and a
        # dark one, the mix can pass for the gray; a gap that narrow between two of her lines is a valley, below)
        gap[1:] = ~big[1:] & (thick >= 1.5) & (
            np.bincount(lg, d[gray] <= EDGE_GAP_KEY[1], minlength=n + 1)[1:] >= EDGE_GAP_KEY[2] * size)
        near = np.asarray(ndimage.minimum(depth_in[gray], lg, ids)) <= gap_reach
        sliver = size >= 2.5 * np.pi * thick ** 2
        if n < 0xFFFF:
            gl = np.where(gap[lab], lab, 0).astype(np.uint16)
            ring = np.where(_grow(gray, 1), 0, cv2.dilate(gl, np.ones((9, 9), np.uint8)))
            with np.errstate(invalid="ignore", divide="ignore"):
                drawn = np.nan_to_num(np.asarray(ndimage.mean(d >= KEY_FROM, ring, ids))) >= EDGE_GAP_DRAWN
        else:
            drawn = np.zeros(n, bool)
        seed[1:] = gap[1:] & near & (sliver | drawn)
    gap_id = np.where(gap[lab], lab, 0)
    hers_gray = big[lab] & gray  # (a part of her in the gray's colour: never measured)
    # a gap only a few pixels wide never shows the gray itself: what lies between two of her lines and comes close to the gray
    # there, near her outline, is the gray mixed with the strands beside it
    valley = her & ~hers_gray & (depth_in <= gap_reach) & _valley(d, 2 * mix, EDGE_VALLEY, KEY_TO)
    # the march from the outside in
    opened = seed.copy()
    out, order, opened = _march(her, d, v, gap_id, opened, ~her | (opened[gap_id] & (gap_id > 0)) | valley, hers_gray, mix)
    gapped = (opened[gap_id] & (gap_id > 0)) | valley
    # (what is thinner than two edges has no inside: a loose strand is her line, the gray and a little of her colour, mixed)
    # (thin: nothing around it lies deeper in her than an edge reaches; a corner of her is no strand)
    disk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * mix + 1, 2 * mix + 1))
    thin = her & (cv2.dilate(depth_in, disk) <= mix + 0.5) & ~hers_gray
    inner = her & ~out & ~thin
    measure = ((out | thin) & her) | (~her & ((_dist(~her) <= mix + 0.5) | _grow(a0 > 0.02, 1)))
    # (her colour is one that can be told from the gray: a pixel next to her edge whose own tint says next to nothing can't take
    # a near-gray pixel of her for her colour and so pass for all her)
    sure = (inner & (d >= EDGE_NOISE + EDGE_FADE)) | (d >= KEY_TO)
    ys, xs = np.nonzero(measure)
    # (at the edge of her body her colour right behind it; for a strand, or what lies past her matte, the line it is drawn in)
    hc, found = _her_colour(v, sure, ys, xs, (thin | ~her)[ys, xs], mix, reach)
    vb, db = v[ys, xs], d[ys, xs]
    fn = np.sqrt((hc * hc).sum(-1))
    share = (vb * hc).sum(-1) / np.maximum(fn * fn, 1e-3)
    # (her colour is the furthest of a few noisy pixels, a little further than she really is: within the noise of it a pixel is
    # all her, and it reaches that over twice the noise. Below that the share is the alpha)
    knee = (EDGE_KNEE[0] + EDGE_KNEE[1] * fn) / np.maximum(fn, 1e-3)
    lo = np.clip(1 - 2 * knee, 0, 1)
    share = np.where(share > lo, lo + (share - lo) * 2, share)
    fade = np.clip((db - EDGE_NOISE) / EDGE_FADE, 0, 1)
    am = np.where(found, np.clip(share, 0, 1) * fade,
                  np.clip((db - EDGE_NOISE) / (KEY_TO - EDGE_NOISE), 0, 1)).astype(np.float32)
    strong = _grow(d >= KEY_TO, EDGE_HALO_NEAR)
    # (unless she has that colour herself nearby: silver hair, a white collar beside a dark line)
    halo = (vb.min(-1) >= -4) & (vb.max(-1) - vb.min(-1) < EDGE_HALO_CHROMA) & (db < EDGE_HALO) & strong[ys, xs] & ~found
    am[halo] = 0.0
    # (the gray opened between strands is all gray: what tint it has is the codec's colour blur from the strands round it)
    am[gapped[ys, xs]] = 0.0
    alpha = np.zeros(a0.shape, np.float32)
    alpha[inner] = 1.0
    # (a part of her in the gray's own colour keeps the remover's edge)
    keep = hers_gray & (depth_in <= mix)
    alpha[keep] = np.clip(a0[keep], 0, 1)
    alpha[ys, xs] = am
    # (past the line drawn round her she is all her: her line against a lighter colour of hers looks much like it against the
    # gray, so a pixel the march reached from a pixel that is all her, mostly her itself, is all her too)
    for k in range(1, int(order[out & her].max(initial=0)) + 1):
        at = (order == k) & (alpha >= 0.5) & ~gapped
        if at.any():
            alpha[at] = np.maximum(alpha[at], _step4(np.where(order < k, alpha, 0.0).astype(np.float32), np.maximum)[at])
    am = alpha[ys, xs]
    rgb = o.copy()
    # her colour: the mix undone, and where little of her is left the colour of her found nearby
    undone = bg + vb / np.maximum(am, 1e-3)[:, None]
    near_c = np.where(found[:, None], bg + hc, bg + vb / np.maximum(am, 0.15)[:, None])
    w = np.clip((am - 0.15) / 0.35, 0, 1)[:, None]
    rgb[ys, xs] = (w * undone + (1 - w) * near_c).clip(0, 255)
    # past her, her colours carried out (an average of her nearest pixels, weighted by how near)
    solid = (alpha >= 0.5).astype(np.float32)
    sigma = fill / 2.0
    den = cv2.GaussianBlur(solid, (0, 0), sigma)
    num = cv2.GaussianBlur(rgb * solid[..., None], (0, 0), sigma)
    carried = num / np.maximum(den, 1e-6)[..., None]
    empty = alpha < 0.02
    rgb = np.where(empty[..., None], np.where((den > 1e-3)[..., None], carried, 0.0), rgb)
    return alpha, rgb.astype(np.float32)


def clean_cutout(im: Image.Image, scale: float = 1.0) -> Image.Image:
    """A cut-out made before its edge was measured (``edge_matte``), measured now: put back on the known gray it was cut from,
    its alpha standing for her matte."""
    px = np.asarray(im.convert("RGBA")).astype(np.float32)
    a, rgb = edge_matte(on_gray(px), px[..., 3] / 255.0, np.array(GRAY, np.float32), scale)
    return Image.fromarray(np.dstack([rgb, a * 255.0]).clip(0, 255).round().astype(np.uint8), "RGBA")


def edge_extend(rgba: np.ndarray, fill: int = EDGE_FILL) -> np.ndarray:
    """A picture with alpha (uint8) whose empty pixels near her take her nearest colour (scaled or compressed, her edge then
    mixes only with her own colours)."""
    a = rgba[..., 3]
    solid = a >= 128
    if not solid.any() or solid.all():
        return rgba
    dist, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
    out_ = rgba.copy()
    empty = a == 0
    out_[..., :3] = np.where(empty[..., None], np.where((dist <= fill)[..., None], rgba[iy, ix, :3], 0), rgba[..., :3])
    return out_


def shrink(rgb: np.ndarray, a: np.ndarray, size: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Colour and alpha scaled down to ``size`` (w, h) as one picture: the colour weighted by its alpha (else an edge pixel takes
    the colour of what lies under the empty pixels beside it), and where nothing of her is left her colour carried out."""
    if (rgb.shape[1], rgb.shape[0]) == tuple(size):
        return rgb, a
    sa = cv2.resize(a, size, interpolation=cv2.INTER_AREA)
    sp = cv2.resize(rgb * a[..., None], size, interpolation=cv2.INTER_AREA)
    carried = cv2.resize(rgb, size, interpolation=cv2.INTER_AREA)
    return np.where(sa[..., None] > 1e-3, sp / np.maximum(sa, 1e-3)[..., None], carried).clip(0, 255), sa


#: steady in time: each frame's alpha and colour are averaged with the frames around it (this many each way), as far as the
#: picture there is the same picture (a moving arm keeps its own frame): the matte's per-frame noise and the source's compression
#: shimmer stop crawling along her edges
STEADY_RADIUS, STEADY_SIGMA = 3, 7.0
#: a hole of her matte that is her or what she holds (fill_object_holes): at least this far from the gray and no more than this
#: much darker than it; or this large with its colour's channels this far apart (the gray's are about 5)
OBJECT_HOLE_KEY, OBJECT_HOLE_DARKER = 20.0, 10.0
OBJECT_HOLE_COLOURED_MIN, OBJECT_HOLE_CHROMA = 30, 40.0
#: the codec's quality for a set's clips: the alpha half shares it, and noise there is her edge crawling
CRF = {"lg": "18", "sm": "20"}


def steady(window: list[tuple[np.ndarray, np.ndarray]], mid: int) -> tuple[np.ndarray, np.ndarray]:
    """``window``: (picture on the gray, alpha) of a few frames around ``mid``. -> that frame's picture and alpha, steadied."""
    o0, a0 = window[mid]
    num_o, num_a, den = o0.copy(), a0.copy(), np.ones(a0.shape, np.float32)
    for k, (o, a) in enumerate(window):
        if k == mid:
            continue
        d = cv2.blur(np.abs(o - o0).mean(-1), (5, 5))
        wgt = np.exp(-(d / STEADY_SIGMA) ** 2).astype(np.float32)
        num_o += o * wgt[..., None]
        num_a += a * wgt
        den += wgt
    return num_o / den[..., None], num_a / den


#: and once her edge is measured: edge_matte decides frame by frame whether a little patch of the gray between her strands is the
#: gray or her, and that decision can turn over and stay turned for a second or two while nothing there moves (a pixel jumping
#: between clear and solid: her edge sparkles). A pixel whose picture holds still keeps one alpha: over each stretch of frames in
#: which its picture doesn't change from one frame to the next (mean change, 5x5, under STEADY_EDGE_STILL) nor drift from where
#: the stretch began (STEADY_EDGE_DRIFT), it takes the middle of what those frames said. Where she moves, a new stretch begins
STEADY_EDGE_STILL, STEADY_EDGE_DRIFT = 6.0, 10.0


def settle_still(pics: np.ndarray, alphas: np.ndarray) -> np.ndarray:
    """``pics`` (T, H, W, 3) uint8: a clip's pictures; ``alphas`` (T, H, W) uint8: its measured alpha. -> the alpha, every pixel
    one value over each stretch in which its picture holds still (only pixels whose alpha changes at all are looked at)."""
    T = len(alphas)
    band = (alphas.max(0).astype(np.int16) - alphas.min(0)) > 12
    if T < 2 or not band.any():
        return alphas
    ys, xs = np.nonzero(band)
    runs = np.zeros((T, len(ys)), np.int32)
    ref = pics[0].astype(np.float32)
    prev = ref.copy()
    cur = np.zeros(len(ys), np.int32)
    for t in range(1, T):
        o = pics[t].astype(np.float32)
        new = (cv2.blur(np.abs(o - prev).mean(-1), (5, 5)) >= STEADY_EDGE_STILL) | \
              (cv2.blur(np.abs(o - ref).mean(-1), (5, 5)) >= STEADY_EDGE_DRIFT)
        ref[new] = o[new]
        prev = o
        cur += new[ys, xs]
        runs[t] = cur
    vals = alphas[:, ys, xs]
    group = (np.arange(len(ys), dtype=np.int64)[None, :] * (int(runs.max()) + 1) + runs).ravel()
    order = np.lexsort((vals.ravel(), group))
    g_sorted = group[order]
    starts = np.flatnonzero(np.r_[True, g_sorted[1:] != g_sorted[:-1]])
    ends = np.r_[starts[1:], len(order)]
    med = vals.ravel()[order][(starts + ends - 1) // 2]  # (each stretch's middle value)
    out_vals = np.empty(len(order), np.uint8)
    out_vals[order] = np.repeat(med, ends - starts)
    out = alphas.copy()
    out[:, ys, xs] = out_vals.reshape(T, len(ys))
    return out


def fill_object_holes(a: np.ndarray, orig: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Holes inside her that are her, or something she holds: the remover keeps the person and can drop a flat object, or a light
    part of her over it (her fingers on a cup, a book's pages, a white rim). Such a hole is about as light as the gray or lighter,
    and yet not the gray itself; or it has a clear colour of its own. A hole that is the gray (between her fingers, her arm and her
    side) stays open, and so does one darker than the gray: the gray between strands of her hair, mixed with them, even where the
    sharpening's light line in it makes it pass as light on the medians (dark hair rings it). The bottom of the frame closes a hole
    like her body does: she is cut off there."""
    solid = a > 0.5
    # (she is cut off at the bottom of the frame: what her body and that edge close in is inside her too, a cup on its way out)
    closed = ndimage.binary_fill_holes(np.vstack([solid, np.ones((1, solid.shape[1]), bool)]))[:-1]
    lab, n = ndimage.label(closed & ~solid)
    if not n:
        return a
    dist = np.sqrt(((orig - bg) ** 2).sum(-1))
    lum, bg_lum = orig.mean(-1), float(bg.mean())
    chroma = orig.max(-1) - orig.min(-1)
    out = a.copy()
    H, W = a.shape
    for i, box in enumerate(ndimage.find_objects(lab), 1):
        sl = (slice(max(0, box[0].start - 3), min(H, box[0].stop + 3)), slice(max(0, box[1].start - 3), min(W, box[1].stop + 3)))
        hole = lab[sl] == i
        size = int(hole.sum())
        lum_h, dist_h = lum[sl][hole], dist[sl][hole]
        light = float(np.median(lum_h)) >= bg_lum - OBJECT_HOLE_DARKER and float(np.median(dist_h)) >= OBJECT_HOLE_KEY
        if light and float(((lum_h >= bg_lum - OBJECT_HOLE_DARKER) & (dist_h >= OBJECT_HOLE_KEY)).mean()) < 0.5:
            # (it passes only on the two medians taken apart, most of its pixels failing one test or the other: a gap between
            # strands of her hair does, its light line about as light as the gray and its gray mixed with the strands far from it,
            # and so do a book's page lines, darker than the gray between white paper. Dark hair rings the gap; paper the lines)
            ring = ndimage.binary_dilation(hole, iterations=2) & ~hole
            light = float((lum[sl][ring] < 0.5 * bg_lum).mean()) <= 0.25
        coloured = size >= OBJECT_HOLE_COLOURED_MIN and float(np.median(chroma[sl][hole])) >= OBJECT_HOLE_CHROMA
        if light or coloured:
            g = ndimage.binary_dilation(hole, iterations=1)
            out[sl][g] = np.maximum(out[sl][g], 1.0)
    return out


THUMB_HEIGHT = 240


def clip_thumb(src: Path, dst: Path, height: int = THUMB_HEIGHT) -> bool:
    """A small still of a stacked clip (its middle frame, alpha applied) for the clip library: the browser then never
    downloads and decodes every clip just to show a card. -> whether there is one."""
    w, h2, fps = probe(src)
    h = h2 // 2
    if not w or not h:
        return False
    out = subprocess.run([ffmpeg(), "-v", "error", "-ss", "2.4", "-i", str(src), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True)
    if len(out.stdout) < w * h2 * 3:
        out = subprocess.run([ffmpeg(), "-v", "error", "-i", str(src), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    if len(out.stdout) < w * h2 * 3:
        return False
    fr = np.frombuffer(out.stdout[: w * h2 * 3], np.uint8).reshape(h2, w, 3)
    a = np.clip((fr[h:, :, 0].astype(np.float32) / 255.0 - 0.03) / 0.94, 0, 1)
    im = Image.fromarray(np.dstack([fr[:h], (a * 255).round().astype(np.uint8)]), "RGBA")
    im.thumbnail((10_000, height), Image.LANCZOS)
    im.save(dst, quality=82, method=6)
    return True


def on_gray(rgba: np.ndarray) -> np.ndarray:
    """A picture with alpha as it looks on the known gray."""
    al = rgba[..., 3:4] / 255.0
    return rgba[..., :3] * al + np.array(GRAY, np.float32) * (1 - al)


# ---------------------------------------------------------------- pictures

def thumb(src: Path, dst: Path, px: int = 512) -> None:
    im = Image.open(src)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        flat = Image.new("RGBA", im.size, REVIEW_PAGE + (255,))
        flat.alpha_composite(im)
        im = flat
    im = im.convert("RGB")
    im.thumbnail((px, px), Image.LANCZOS)
    atomic_save(im, dst, quality=85)


def flatten(src: Path, dst: Path) -> None:
    """A picture with a transparent background on the known gray, at full size (a reference for the image model)."""
    im = Image.open(src).convert("RGBA")
    flat = Image.new("RGBA", im.size, GRAY + (255,))
    flat.alpha_composite(im)
    atomic_save(flat.convert("RGB"), dst, quality=93)


def nearest_aspect(w: int, h: int) -> str:
    r = w / h
    return min(JOB_ASPECTS, key=lambda k: abs(np.log(JOB_ASPECTS[k] / r)))


def cmd_prep(p: Path) -> dict:
    m = p / "masters"
    src = Image.open(m / "candidate.png").convert("RGB")
    im = src.copy()
    im.thumbnail((1600, 1600), Image.LANCZOS)
    atomic_save(im, m / "candidate.cutin.jpg", quality=95)  # big PNGs have stalled the remover's upload
    im = src.copy()
    im.thumbnail((2048, 2048), Image.LANCZOS)
    atomic_save(im, m / "candidate.ref.jpg", quality=95)
    info = {"size": list(src.size), "job_aspect": nearest_aspect(*src.size)}
    write_json(m / "info.json", info)
    return info


def find_face(home: Image.Image) -> tuple[list[int], str]:
    """The face box in home-picture pixels: the anime face detector (lbpcascade_animeface, nagadomi, MIT), else
    OpenCV's frontal face detector, else an estimate from the figure's outline (the top of the body)."""
    W, H = home.size
    flat = Image.new("RGBA", home.size, (200, 200, 200, 255))
    flat.alpha_composite(home)
    gray = cv2.equalizeHist(cv2.cvtColor(np.asarray(flat.convert("RGB")), cv2.COLOR_RGB2GRAY))
    haar = getattr(getattr(cv2, "data", None), "haarcascades", "")
    for name, path in (("anime", HERE / "lbpcascade_animeface.xml"),
                       ("frontal", Path(haar or "/nonexistent") / "haarcascade_frontalface_default.xml")):
        if not path.is_file():
            continue
        casc = cv2.CascadeClassifier(str(path))
        faces = casc.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=4, minSize=(W // 15, W // 15))
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
            return [int(x), int(y), int(w), int(h)], name
    return _outline_box(home), "estimate"


def _outline_box(home: Image.Image) -> list[int]:
    """A face box estimated from the figure's outline (the top of the body)."""
    W, H = home.size
    a = np.asarray(home)[..., 3] > 25
    ys, xs = np.nonzero(a)
    if not len(ys):
        return [W // 3, H // 8, W // 3, W // 3]
    top, bottom = ys.min(), ys.max()
    band = a[top:top + max(1, (bottom - top) // 4)]
    cols = np.nonzero(band.any(axis=0))[0]
    cx = (cols.min() + cols.max()) / 2 if len(cols) else W / 2
    size = max(40, int((cols.max() - cols.min()) * 0.55)) if len(cols) else W // 4
    return [int(cx - size / 2), int(top + size * 0.35), size, size]


def measure_frame(stills: list[Image.Image], home: str) -> dict:
    """Where her face sits in a set, in fractions of the picture, so that every set of a mate can stand in the same place at
    the same size (frontend mate/avatar/framing.ts). One picture can fool the detector (a chest taken for a face), so it is
    the median over her stills, of the boxes in the upper half of her figure. ``home``: the picture it was measured for."""
    faces, tops = [], []
    for im in stills:
        ys = np.nonzero((np.asarray(im)[..., 3] > 25).any(axis=1))[0]
        if not len(ys):
            continue
        W, H = im.size
        tops.append(float(ys[0]) / H)
        box, how = find_face(im)
        middle = box[1] + box[3] / 2
        if how != "estimate" and middle <= ys[0] + (ys[-1] - ys[0]) * 0.5:
            faces.append(((box[0] + box[2] / 2) / W, middle / H, box[3] / H))
    outline = [0.5, 0.3, 0.3]
    if stills:
        W, H = stills[0].size
        x, y, w, h = _outline_box(stills[0])
        outline = [(x + w / 2) / W, (y + h / 2) / H, h / H]
    face, how = ([float(np.median([f[i] for f in faces])) for i in range(3)], "face") if faces else (outline, "outline")
    # (the outline too: a set from before, measured only that way, can still be compared with this one)
    return {"face": [round(v, 4) for v in face], "outline": [round(v, 4) for v in outline],
            "top": round(float(np.median(tops)) if tops else 0.0, 4), "how": how, "for": home}


def _frame_stills(folder: Path, names: list[str]) -> list[Image.Image]:
    """The stills that show her as she is (a blink or a mouth frame is only the same picture again)."""
    return [Image.open(folder / n).convert("RGBA") for n in names if not Path(n).stem.startswith(("blink", "mouth"))]


def face_mask(home: Image.Image, box: list[int]) -> np.ndarray:
    """Solid over both eyes, soft only in a thin outer band that falls on hair (mate.py)."""
    W, H = home.size
    x, y, w, h = box
    cx, cy = x + w / 2, y + h * 0.56
    rx, ry = w * 0.50, h * 0.46
    yy, xx = np.mgrid[0:H, 0:W]
    dist = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    m = np.clip((1.0 - dist) / 0.14, 0.0, 1.0).astype(np.float32)
    return m * m * (3 - 2 * m)


def cmd_home(p: Path) -> dict:
    m = p / "masters"
    c = cfg(p)
    src = Image.open(m / "candidate.png").convert("RGB")
    rgba = Image.open(m / "candidate.cut.png").convert("RGBA")
    a = clean_alpha(np.asarray(rgba)[..., 3].astype(np.float32) / 255.0)
    if (a > 0.1).sum() < 100:
        raise RuntimeError("the cut-out is empty: the background remover found no character")
    orig = np.asarray(src.resize(rgba.size, Image.LANCZOS), np.float32)
    bg = np.median(np.concatenate([orig[:16].reshape(-1, 3), orig[:, :16].reshape(-1, 3),
                                   orig[:, -16:].reshape(-1, 3)]), axis=0)
    # the canvas: the figure fills 86% of the height (or 92% of the width), bottom-aligned, centred on its bbox
    ys, xs = np.nonzero(a > 0.1)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    aspect = c.get("aspect", "1:1")
    W, H = CANVASES[aspect]
    s = min(0.92 * W / (x1 - x0 + 1), 0.86 * H / (y1 - y0 + 1))
    a = clean_alpha(rematte(a, orig, bg))
    # her edge measured from the picture, at this picture's own scale (a clip shows her at s · EDGE_CLIP / W of it)
    a, fg = edge_matte(orig, a, bg, scale=W / (s * EDGE_CLIP))
    home = Image.fromarray(np.dstack([fg, a * 255]).clip(0, 255).round().astype(np.uint8), "RGBA")
    atomic_save(home, m / "home.png")
    w, h = round(home.width * s), round(home.height * s)
    ox = round(W / 2 - ((x0 + x1) / 2) * s)
    oy = round(H - (y1 + 1) * s)
    # ("edge": the cut-out's edge is measured already; a set made before that has it measured when it is exported)
    write_json(m / "place.json", {"aspect": aspect, "canvas": [W, H], "scale": s, "x": ox, "y": oy, "edge": EDGE_VERSION})
    canvas = Image.new("RGBA", (W, H), GRAY + (255,))
    canvas.alpha_composite(home.resize((w, h), Image.LANCZOS), (ox, oy))
    atomic_save(canvas.convert("RGB"), m / "home-gray.jpg", quality=95)
    box, method = find_face(home)
    mask = face_mask(home, box)
    atomic_save(Image.fromarray((mask * 255).astype(np.uint8)), m / "face-mask.png")
    write_json(m / "face.json", {"box": box, "method": method})
    thumb(m / "home.png", p / "thumbs" / "home.jpg")
    # the region the expressions may change, outlined on the base picture (for the user's approval)
    view = np.asarray(Image.open(m / "home.png").convert("RGBA")).astype(np.float32)
    flat = view[..., :3] * (view[..., 3:] / 255.0) + np.array(REVIEW_PAGE, np.float32) * (1 - view[..., 3:] / 255.0)
    ring = (mask > 0.04) & (mask < 0.5)
    flat[ring] = flat[ring] * 0.3 + np.array([255, 80, 120], np.float32) * 0.7
    im = Image.fromarray(flat.clip(0, 255).astype(np.uint8))
    im.thumbnail((512, 512), Image.LANCZOS)
    atomic_save(im, p / "thumbs" / "face.jpg", quality=85)
    return {"place": {"aspect": aspect, "scale": s, "x": ox, "y": oy}, "face": {"box": box, "method": method},
            "size": list(home.size)}


def cmd_stills(p: Path) -> dict:
    m = p / "masters"
    mask = np.asarray(Image.open(m / "face-mask.png")).astype(np.float32)[..., None] / 255.0
    home = np.asarray(Image.open(m / "home.png")).astype(np.float32)
    al = home[..., 3] / 255.0
    done = []
    for raw in sorted((p / "stills").glob("*.raw.png")):
        name = raw.name[: -len(".raw.png")]
        v = np.asarray(Image.open(raw).convert("RGB").resize((home.shape[1], home.shape[0]), Image.LANCZOS),
                       np.float32)
        # (where the face's region reaches her edge, its picture's gray is taken out the way the home picture's was)
        v = np.where((al > 0.02)[..., None], colour(v, al, border_bg(v, 16)), home[..., :3])
        rgb = home[..., :3] * (1 - mask) + v * mask
        img = Image.fromarray(np.dstack([rgb, home[..., 3]]).clip(0, 255).astype(np.uint8), "RGBA")
        atomic_save(img, p / "stills" / f"{name}.png")
        thumb(p / "stills" / f"{name}.png", p / "thumbs" / f"still-{name}.jpg")
        done.append(name)
    return {"stills": done}


# ---------------------------------------------------------------- clips

def cmd_matte(p: Path, cid: str) -> dict:
    src = p / "clips" / f"{cid}.mp4"
    nobg = p / "clips" / f"{cid}.nobg.mp4"
    w, h, fps = probe(src)
    dst = p / "matte" / f"{cid}.alpha.mkv"
    tmp = dst.with_name(f"{cid}.alpha.part.mkv")
    wr = writer(tmp, w, h, fps, "gray", ["-c:v", "ffv1", "-level", "3"])
    assert wr.stdin
    bgs, n = [], 0
    hit = np.zeros((h, w), bool)
    for o, mk in zip(frames(src), frames(nobg, size=(w, h))):
        a, bg = recover(o.astype(np.float32), mk.astype(np.float32))
        a8 = (a * 255).round().astype(np.uint8)
        hit |= a8 > 10
        wr.stdin.write(a8.tobytes())
        bgs.append([round(float(x), 2) for x in bg])
        n += 1
        if n % 24 == 0:
            progress(step="matte", clip=cid, frame=n)
    close(wr, tmp)
    if n == 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"{cid}: no frames could be read")
    os.replace(tmp, dst)
    ys, xs = np.nonzero(hit)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else [0, 0, w - 1, h - 1]
    write_json(p / "matte" / f"{cid}.json", {"frames": n, "fps": fps, "size": [w, h], "bbox": bbox, "bg": bgs})
    return {"clip": cid, "frames": n, "size": [w, h], "bbox": bbox}


def mattes(p: Path) -> list[tuple[str, dict]]:
    out_ = []
    for f in sorted((p / "matte").glob("*.json")):
        if f.name.endswith(".part.json") or not (p / "matte" / f"{f.stem}.alpha.mkv").exists():
            continue
        out_.append((f.stem, json.loads(f.read_text())))
    return out_


def crop_box(ms: list[tuple[str, dict]]) -> tuple[int, int, int, int, int]:
    """One box for every clip (and the stills): the union of where the body ever is, plus a margin, even sizes.
    The body is cut by the bottom edge, so the box runs to it. → (x, y, w, h, clip width)"""
    W, H = ms[0][1]["size"]
    x0 = min(m["bbox"][0] for _, m in ms)
    y0 = min(m["bbox"][1] for _, m in ms)
    x1 = max(m["bbox"][2] for _, m in ms)
    pad = round(0.03 * W)
    x0, y0, x1, y1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), H
    return int(x0), int(y0), int((x1 - x0) // 2 * 2), int((y1 - y0) // 2 * 2), int(W)


def cmd_encode(p: Path, only: list[str] | None = None) -> dict:
    c = cfg(p)
    sizes = c.get("sizes") or {"lg": 1080, "sm": 540}
    ms = mattes(p)
    if not ms:
        raise RuntimeError("no mattes to encode")
    if len({tuple(m["size"]) for _, m in ms}) > 1:
        raise RuntimeError("the clips have different sizes")
    x, y, w, h, cw = crop_box(ms)
    web = p / "web"
    done = []
    for cid, meta in ms:
        if only and cid not in only:
            continue
        fps = float(meta["fps"])
        procs = {}
        for tag, height in sizes.items():
            hh = min(height, h) // 2 * 2
            ww = round(w * hh / h) // 2 * 2
            mp4 = web / f"{cid}.{tag}.part.mp4"
            procs[tag] = (writer(mp4, ww, hh * 2, fps, "rgb24",
                                 ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", CRF.get(tag, "20"), "-tune", "animation",
                                  "-preset", "slow", "-movflags", "+faststart"]), (ww, hh), mp4)
        bgs = meta["bg"]
        scale = cw / EDGE_CLIP

        def write(rgb: np.ndarray, a: np.ndarray) -> None:
            for proc, (ww, hh), _ in procs.values():
                col, al = shrink(rgb, a, (ww, hh))
                col8 = col.clip(0, 255).round().astype(np.uint8)
                alpha = np.repeat((al * 255.0).clip(0, 255).round().astype(np.uint8)[..., None], 3, axis=-1)
                assert proc.stdin
                proc.stdin.write(np.ascontiguousarray(np.concatenate([col8, alpha], axis=0)).tobytes())

        # (her edge measured in each steadied frame; the whole clip kept, 8-bit, to be settled where it holds still: settle_still)
        pics: list[np.ndarray] = []
        measured: list[np.ndarray] = []
        colours: list[np.ndarray] = []

        def emit(i: int, o: np.ndarray, a: np.ndarray) -> None:
            bg = np.array(bgs[min(i, len(bgs) - 1)], np.float32)
            a, rgb = edge_matte(o, a, bg, scale)
            pics.append(o.round().clip(0, 255).astype(np.uint8))
            measured.append((a * 255.0).round().clip(0, 255).astype(np.uint8))
            colours.append(rgb.round().clip(0, 255).astype(np.uint8))

        # (a few frames ahead in memory: each frame is steadied with the ones around it, then made as before)
        r = STEADY_RADIUS
        buf: collections.deque[tuple[int, np.ndarray, np.ndarray]] = collections.deque()
        nxt = 0

        def flush(end: bool = False) -> None:
            nonlocal nxt
            while buf and nxt <= buf[-1][0] and (end or buf[-1][0] >= nxt + r):
                near = [(k, o, al) for k, o, al in buf if abs(k - nxt) <= r]
                mid = [k for k, _, _ in near].index(nxt)
                emit(nxt, *steady([(o, al) for _, o, al in near], mid))
                nxt += 1
                while buf and buf[0][0] < nxt - r:
                    buf.popleft()

        for i, (o, a8) in enumerate(zip(frames(p / "clips" / f"{cid}.mp4"), frames(p / "matte" / f"{cid}.alpha.mkv", "gray"))):
            o = o[y:y + h, x:x + w].astype(np.float32)
            bg = np.array(bgs[min(i, len(bgs) - 1)], np.float32)
            a = fill_object_holes(a8[y:y + h, x:x + w].astype(np.float32) / 255.0, o, bg)
            buf.append((i, o, a))
            flush()
        flush(end=True)
        settled = settle_still(np.stack(pics), np.stack(measured))
        del pics, measured
        for k, rgb in enumerate(colours):
            write(rgb.astype(np.float32), settled[k].astype(np.float32) / 255.0)
        for tag, (proc, _, mp4) in procs.items():
            close(proc, mp4)
            os.replace(mp4, web / f"{cid}.{tag}.mp4")
        done.append(cid)
        progress(step="encode", clip=cid)
    write_json(web / "box.json", {"box": [x, y, w, h], "clip_width": cw, "sizes": sizes})
    return {"encoded": done, "box": [x, y, w, h]}


def cmd_check(p: Path) -> dict:
    home = np.asarray(Image.open(p / "masters" / "home-gray.jpg").convert("RGB"), np.float32)
    res = {}
    for cid in [c["id"] for c in cfg(p).get("clips") or []]:
        path = p / "clips" / f"{cid}.mp4"
        if not path.exists():
            res[cid] = {"ok": False, "missing": True}
            continue
        first = last = None
        corners_sum, corners_n, n = np.zeros(3), 0, 0
        for fr in frames(path):
            f = fr.astype(np.float32)
            if first is None:
                first = f
            last = f
            cs = np.concatenate([f[:16, :16].reshape(-1, 3), f[:16, -16:].reshape(-1, 3)])
            corners_sum += cs.sum(0)
            corners_n += len(cs)
            n += 1
        if first is None:
            res[cid] = {"ok": False, "missing": True}
            continue
        h0 = cv2.resize(home, (first.shape[1], first.shape[0]), interpolation=cv2.INTER_AREA)
        seam = float(np.abs(first - last).mean())
        start = float(np.abs(first - h0).mean())
        drift = float(np.abs(corners_sum / max(corners_n, 1) - np.array(GRAY)).mean())
        r = {"frames": n, "seam": round(seam, 2), "start": round(start, 2), "drift": round(drift, 2)}
        mj = p / "matte" / f"{cid}.json"
        if mj.exists():
            meta = json.loads(mj.read_text())
            mid = meta["frames"] // 2
            for i, a8 in enumerate(frames(p / "matte" / f"{cid}.alpha.mkv", "gray")):
                if i == mid:
                    a = a8.astype(np.float32) / 255.0
                    body = ndimage.binary_fill_holes(a > 0.5)
                    area = max(int(body.sum()), 1)
                    r["soft"] = round(float(((a > 0.1) & (a < 0.9)).sum()) / area, 4)
                    lab, k = ndimage.label(a > 0.08)
                    r["pieces"] = int(k)
                    break
        r["ok"] = seam < 3 and start < 4 and drift < 10 and r.get("soft", 0) < 0.12
        res[cid] = r
    out_ = {"clips": res, "passed": all(v.get("ok") for v in res.values()),
            "redo": [k for k, v in res.items() if not v.get("ok")]}
    write_json(p / "check.json", out_)
    return out_


# ---------------------------------------------------------------- export

def portrait(home: Image.Image, box: list[int]) -> Image.Image:
    """Head and shoulders from the home picture (its edge measured: ``edge_matte``), 3:4 (768×1024), on a soft two-tone of
    the character's own colours."""
    px = np.asarray(home).astype(np.float32)
    fx, fy, fw, fh = box
    top = max(0, round(fy - fh * 0.8))
    ch = max(8, min(round(fw * 3.0 * 4 / 3), home.height - top))
    cw = round(ch * 3 / 4)
    left = round(fx + fw / 2 - cw / 2)
    body = px[..., 3] > 128
    mean = px[..., :3][body].mean(0) if body.any() else np.array([120.0, 120.0, 130.0])
    top_c, bottom_c = mean * 0.35, np.clip(mean * 0.35 + 90, 0, 255)
    ramp = np.linspace(0, 1, ch)[:, None, None]
    bg = (top_c * (1 - ramp) + bottom_c * ramp).repeat(cw, axis=1).astype(np.uint8)
    canvas = Image.fromarray(bg, "RGB").convert("RGBA")
    canvas.alpha_composite(home.crop((left, top, left + cw, top + ch)))
    return canvas.convert("RGB").resize((768, 1024), Image.LANCZOS)


def cmd_export(p: Path, key: str) -> dict:
    c = cfg(p)
    m = p / "masters"
    dest = p / "export"
    tmp = p / "export.part"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    box = json.loads((p / "web" / "box.json").read_text())
    x, y, w, h = box["box"]
    pl = json.loads((m / "place.json").read_text())
    s, ox, oy, canvas_size = pl["scale"], pl["x"], pl["y"], tuple(pl["canvas"])
    k = canvas_size[0] / float(box["clip_width"])
    # (a cut-out made before its edge was measured is measured now, at its own scale: see cmd_home)
    measured = bool(pl.get("edge"))
    own_scale = canvas_size[0] / (s * EDGE_CLIP)

    def cutout(src: Path) -> Image.Image:
        im = Image.open(src).convert("RGBA")
        return im if measured else clean_cutout(im, own_scale)

    stills = {}
    for name in ["neutral", *[st for st in c.get("stills") or []]]:
        src = m / "home.png" if name == "neutral" else p / "stills" / f"{name}.png"
        if not src.exists():
            continue
        im = cutout(src)
        # (Pillow scales a picture with alpha weighted by it: no colour of what lies under the empty pixels creeps in)
        canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
        canvas.alpha_composite(im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS), (ox, oy))
        crop = canvas.crop((round(x * k), round(y * k), round((x + w) * k), round((y + h) * k)))
        crop.thumbnail((10_000, box["sizes"]["lg"]), Image.LANCZOS)
        crop = Image.fromarray(edge_extend(np.asarray(crop), max(2, round(EDGE_FILL * crop.width / w))), "RGBA")
        crop.save(tmp / f"{name}.webp", quality=90, method=6, exact=True)
        stills[name] = f"asset:{key}/{name}.webp"
    clips = []
    for cl in c.get("clips") or []:
        lg = p / "web" / f"{cl['id']}.lg.mp4"
        if not lg.exists() or cl.get("disabled"):
            continue
        for tag in ("lg", "sm"):
            shutil.copy2(p / "web" / f"{cl['id']}.{tag}.mp4", tmp / f"{cl['id']}.{tag}.mp4")
        clip = {"id": cl["id"], "kind": cl["kind"], "src": f"asset:{key}/{cl['id']}.lg.mp4",
                "small": f"asset:{key}/{cl['id']}.sm.mp4"}
        if clip_thumb(tmp / f"{cl['id']}.lg.mp4", tmp / f"{cl['id']}.thumb.webp"):
            clip["thumb"] = f"asset:{key}/{cl['id']}.thumb.webp"
        if cl.get("emotion"):
            clip["emotion"] = cl["emotion"]
        if cl.get("loop"):
            clip["loop"] = True
        clips.append(clip)
    if not clips:
        raise RuntimeError("no encoded clips to export")
    emotions: dict[str, list[str]] = {}
    for cl in clips:
        if cl.get("emotion"):
            emotions.setdefault(cl["emotion"], []).append(cl["id"])
    home = cutout(m / "home.png")
    face = json.loads((m / "face.json").read_text())
    portrait(home, face["box"]).save(tmp / "portrait.webp", quality=90, method=6)
    names = [Path(v).name for v in stills.values()]
    rig = {"version": 1, "aspect": [w, h], "anchor": [0.5, 1.0], "home": stills.get("neutral"), "stills": stills,
           "clips": clips, "emotions": emotions, "packing": "stacked-alpha", "portrait": f"asset:{key}/portrait.webp",
           "frame": measure_frame(_frame_stills(tmp, names), Path(stills.get("neutral") or "neutral.webp").name)}
    (tmp / "rig.json").write_text(json.dumps(rig, ensure_ascii=False, indent=2) + "\n")
    shutil.rmtree(dest, ignore_errors=True)
    os.replace(tmp, dest)
    return {"export": str(dest), "stills": len(stills), "clips": len(clips), "aspect": [w, h]}


def cmd_frame(pack: Path) -> dict:
    """Measure a pack that was made before sets carried their ``frame`` (the bundled mates' are kept in their rig.json)."""
    path = pack / "rig.json"
    rig = json.loads(path.read_text())
    home = Path(str(rig.get("home") or "neutral.webp")).name
    names = [Path(str(v)).name for v in (rig.get("stills") or {}).values()]
    rig["frame"] = measure_frame(_frame_stills(pack, [n for n in names if (pack / n).is_file()]), home)
    path.write_text(json.dumps(rig, ensure_ascii=False, indent=2) + "\n")
    return {"frame": rig["frame"]}


def cmd_sheet(p: Path, cid: str, dst: str) -> dict:
    path = p / "clips" / f"{cid}.mp4"
    w, h, _ = probe(path)
    size = (360, 360 * h // w // 2 * 2)
    allf = list(frames(path, size=size))
    picks = [int(i) for i in np.linspace(0, len(allf) - 1, 6)[1:-1]]
    shown = [allf[i] for i in picks]
    alpha, meta = p / "matte" / f"{cid}.alpha.mkv", p / "matte" / f"{cid}.json"
    if alpha.exists() and meta.exists():  # (cut out already: how it will look, with whatever is left of the gray)
        bgs = json.loads(meta.read_text())["bg"]
        a8 = list(frames(alpha, "gray", size=size))
        page = np.array(REVIEW_PAGE, np.float32)
        shown = []
        for i in picks:
            o = allf[i].astype(np.float32)
            a, rgb = edge_matte(o, a8[min(i, len(a8) - 1)].astype(np.float32) / 255.0,
                                np.array(bgs[min(i, len(bgs) - 1)], np.float32), size[0] / EDGE_CLIP)
            shown.append((rgb * a[..., None] + page * (1 - a[..., None])).clip(0, 255).astype(np.uint8))
    sheet = Image.fromarray(np.concatenate(shown, axis=1))
    atomic_save(sheet, Path(dst), quality=85)
    return {"sheet": dst, "frames": len(allf)}


# ---------------------------------------------------------------- tests

def cmd_selftest(assets: str | None = None) -> dict:
    """Alpha recovery on a synthetic frame with a known gray background: a dark disk (cloth, with a darker fold
    line) and a light one (silver hair) with soft edges, composited over the gray; the 'remover' result is the same
    figure on black. The recovered alpha and colour are compared with the truth."""
    rng = np.random.default_rng(7)
    H = W = 240
    yy, xx = np.mgrid[0:H, 0:W]
    a_true = np.zeros((H, W), np.float32)
    fg = np.zeros((H, W, 3), np.float32)
    for (cy, cx, r, col) in ((150, 90, 55, (40, 32, 70)), (110, 165, 40, (225, 222, 230))):
        d = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
        a = np.clip((r - d) / 4.0, 0, 1)
        fg = fg * (1 - a[..., None]) + np.array(col, np.float32) * a[..., None]
        a_true = np.maximum(a_true, a)
    fold = (np.abs(xx - 90) < 2) & (np.abs(yy - 150) < 40)
    fg[fold] = (12, 10, 20)
    bg = np.array(GRAY, np.float32)
    orig = (fg * a_true[..., None] + bg * (1 - a_true[..., None]) + rng.normal(0, 0.8, (H, W, 3))).clip(0, 255)
    masked = (fg * a_true[..., None] + rng.normal(0, 0.8, (H, W, 3))).clip(0, 255)
    masked[fold] *= 0.2  # the remover's mask cracks along a dark fold line
    a, bg_est = recover(orig, masked)
    rgb = colour(orig, a, bg_est)
    inside, outside = a_true > 0.99, a_true < 0.01
    edge = ~inside & ~outside
    col_err = float(np.abs(rgb - fg)[inside & (a > 0.5)].mean())
    return {
        "bg": [round(float(v), 2) for v in bg_est],
        "alpha_inside_min": round(float(a[inside].min()), 4),
        "alpha_inside_mean": round(float(a[inside].mean()), 4),
        "alpha_shipped_inside_min": round(float(edge_matte(orig, a, bg_est)[0][inside].min()), 4),
        "alpha_outside_max": round(float(a[outside].max()), 4),
        "alpha_edge_mae": round(float(np.abs(a - a_true)[edge].mean()), 4),
        "fold_alpha_min": round(float(a[fold].min()), 4),
        "colour_mae": round(col_err, 3),
        **selftest_gaps(rng),
        **selftest_holes(rng),
        **selftest_page(),
        **(selftest_art(Path(assets)) if assets else {}),
    }


def selftest_art(assets: Path) -> dict:
    """Real art on the gray, from a remover that covers the gaps and from one that doubts a wide band around her: what is
    solid stays, what is empty opens. The same picture before a wall instead of one flat colour changes nothing."""
    art = {}
    wall_changed = 0
    for f in sorted(assets.glob("*/neutral.webp")):
        px = np.asarray(Image.open(f).convert("RGBA"), np.float32)
        at = px[..., 3] / 255.0
        bg = np.array(GRAY, np.float32)
        orig = on_gray(px)
        solid = (at > 0.5).astype(np.uint8)
        hull = cv2.GaussianBlur(cv2.dilate(solid, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19))).astype(np.float32), (0, 0), 3)
        doubting = cv2.GaussianBlur(cv2.dilate(solid, np.ones((5, 5), np.uint8)).astype(np.float32), (0, 0), 12)
        empty = (at < 0.05) & (hull > 0.5)
        art[f.parent.name] = {"lost": round(100 * float((rematte(doubting, orig, bg)[at > 0.95] < 0.5).mean()), 2),
                              "opened": round(100 * float((rematte(hull, orig, bg)[empty] < 0.5).mean()), 1)}
        shade = np.linspace(-45, 45, at.shape[1], dtype=np.float32)[None, :, None]  # (light falling along a wall)
        wall = shade + np.array((205, 185, 160), np.float32)
        before = (px[..., :3] * at[..., None] + wall * (1 - at[..., None])).astype(np.float32)
        wall_bg = np.median(before[:16].reshape(-1, 3), axis=0)
        wall_changed += int(np.count_nonzero(rematte(hull, before, wall_bg) != hull))
    return {"art": art, "wall_changed": wall_changed}


def selftest_page() -> dict:
    """What is left of the gray must show in the pictures a cut-out is judged by."""
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "a.png", Path(tmp) / "a.jpg"
        Image.new("RGBA", (40, 40), (0, 0, 0, 0)).save(src)
        thumb(src, dst)
        return {"thumb_page": [int(v) for v in np.asarray(Image.open(dst).convert("RGB"))[20, 20]]}


def selftest_gaps(rng: np.random.Generator) -> dict:
    """Dark hair with a loose strand beside it, and the remover's hull over the gray between them; the gap must open
    and the strand stay. So must two places of the gray's very colour that are body: inside a light badge at the edge
    of the hair, and deep inside it (an eye)."""
    H = W = 240
    yy, xx = np.mgrid[0:H, 0:W]
    d = np.sqrt((yy - 120.0) ** 2 + (xx - 120.0) ** 2)
    arc = np.abs(np.arctan2(yy - 120.0, 120.0 - xx)) < 0.6  # the left side
    bg = np.array(GRAY, np.float32)
    fg = np.full((H, W, 3), (25, 22, 30), np.float32)
    a_true = ((d < 80) | ((d >= 86) & (d < 89) & arc)).astype(np.float32)
    badge = np.sqrt((yy - 195.0) ** 2 + (xx - 120.0) ** 2)
    fg[badge < 18] = (235, 235, 240)
    a_true[badge < 18] = 1
    light = badge < 5
    deep = d < 6
    fg[light | deep] = bg
    soft = cv2.GaussianBlur(a_true, (0, 0), 1.0)
    orig = (cv2.GaussianBlur(fg * a_true[..., None], (0, 0), 1.0) + bg * (1 - soft[..., None])
            + rng.normal(0, 0.8, (H, W, 3))).clip(0, 255).astype(np.float32)
    hull = (d < 82) | ((d < 92) & arc) | (badge < 20)
    a, bg_est = recover(orig, (orig * hull[..., None]).astype(np.float32))
    shown, _ = edge_matte(orig, a, bg_est)
    a = shown  # (what ships)
    side = np.abs(np.arctan2(yy - 120.0, 120.0 - xx)) < 0.5
    return {
        "strand_shown_mean": round(float(shown[(d > 86.5) & (d < 88.5) & side].mean()), 4),
        "gap_alpha_max": round(float(a[(d >= 82) & (d < 84) & side].max()), 4),
        "strand_alpha_mean": round(float(a[(d > 86.5) & (d < 88.5) & side].mean()), 4),
        "light_patch_alpha_min": round(float(a[light].min()), 4),
        "deep_patch_alpha_min": round(float(a[deep].min()), 4),
    }


def selftest_holes(rng: np.random.Generator) -> dict:
    """A face with the remover's mask cut open in four places: on the highlight of her nose and on a shadow with a colour of
    its own (both body), where the gray really shows between two fingers, and in dark hair where the gray overshoots a
    little lighter (both gaps)."""
    H = W = 240
    yy, xx = np.mgrid[0:H, 0:W]
    bg = np.array(GRAY, np.float32)
    orig = np.full((H, W, 3), bg, np.float32)
    figure = (yy - 120.0) ** 2 + (xx - 120.0) ** 2 < 100.0 ** 2
    orig[figure] = (238, 214, 210)  # skin
    hair = figure & (yy < 80)
    orig[hair] = (25, 22, 30)

    def spot(y: int, x: int) -> np.ndarray:
        return (yy - y) ** 2 + (xx - x) ** 2 < 6 ** 2

    nose, shadow, fingers, gap = spot(120, 120), spot(160, 90), spot(160, 150), spot(50, 120)
    orig[nose] = (247, 229, 228)
    orig[shadow] = (205, 170, 168)
    orig[fingers] = bg
    orig[gap] = bg + 22
    orig = (orig + rng.normal(0, 0.8, (H, W, 3))).clip(0, 255).astype(np.float32)
    hull = figure & ~(nose | shadow | fingers | gap)
    a, _ = recover(orig, (orig * hull[..., None]).astype(np.float32))
    return {
        "nose_alpha_min": round(float(a[nose].min()), 4),
        "shadow_alpha_min": round(float(a[shadow].min()), 4),
        "fingers_alpha_max": round(float(a[fingers].max()), 4),
        "hair_gap_alpha_max": round(float(a[gap].max()), 4),
    }


def cmd_versions() -> dict:
    import scipy  # noqa: PLC0415
    import PIL  # noqa: PLC0415

    exe = ffmpeg()
    r = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True)
    return {"numpy": np.__version__, "opencv": cv2.__version__, "scipy": scipy.__version__,
            "pillow": PIL.__version__, "ffmpeg": exe, "x264": "libx264" in r.stdout, "ffv1": " ffv1 " in r.stdout}


def main(argv: list[str]) -> int:
    if not argv:
        out(ok=False, error="usage: pipeline.py <step> <project dir> [args]")
        return 2
    step, rest = argv[0], argv[1:]
    try:
        if step == "selftest":
            res = cmd_selftest(rest[0] if rest else None)
        elif step == "versions":
            res = cmd_versions()
        elif step == "thumb":
            thumb(Path(rest[0]), Path(rest[1]), int(rest[2]) if len(rest) > 2 else 512)
            res = {}
        elif step == "flatten":
            flatten(Path(rest[0]), Path(rest[1]))
            res = {}
        else:
            p = Path(rest[0]).resolve()
            fn = {"prep": cmd_prep, "home": cmd_home, "stills": cmd_stills, "check": cmd_check, "frame": cmd_frame}.get(step)
            if fn is not None:
                res = fn(p)
            elif step == "matte":
                res = cmd_matte(p, rest[1])
            elif step == "encode":
                res = cmd_encode(p, rest[1].split(",") if len(rest) > 1 and rest[1] else None)
            elif step == "export":
                res = cmd_export(p, rest[1] if len(rest) > 1 else "avatar")
            elif step == "sheet":
                res = cmd_sheet(p, rest[1], rest[2])
            else:
                out(ok=False, error=f"unknown step {step}")
                return 2
    except Exception as exc:  # noqa: BLE001 - reported to the backend as the step's error
        out(ok=False, error=f"{type(exc).__name__}: {exc}"[:600])
        return 1
    out(ok=True, **(res or {}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
