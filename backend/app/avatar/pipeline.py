"""Avatar processing — the picture and video work between the Higgsfield jobs (docs/avatar-create.md §5).

A port of ailism-mate ``original_content/tools/mate.py`` (the pipeline that made 한채린), run by the
backend in its own venv (numpy, scipy, opencv, pillow; ffmpeg from the system or imageio-ffmpeg) under a memory cap,
one at a time. Every step streams video frame by frame (a 1440px clip is ~1 GB as one array).

    python -I pipeline.py <step> <project dir> [args]

Steps (files are relative to the project dir; ``pipeline.json`` there holds the settings):

    prep               masters/candidate.png → candidate.cutin.jpg (1600px, for the cut-out) + candidate.ref.jpg
                       (2048px, the stills' reference) + info.json
    home               + masters/candidate.cut.png (the remover's) → home.png (clean alpha, colour without the old
                       background), place.json (where it sits on the canvas), home-gray.jpg (the clips' first and
                       last frame), face.json + face-mask.png (the region the stills may change)
    stills             stills/<n>.raw.png → stills/<n>.png (only the face region laid over the home picture)
    matte <id>         clips/<id>.mp4 + clips/<id>.nobg.mp4 → matte/<id>.alpha.mkv (lossless gray) + matte/<id>.json
                       (alpha recovered from the known flat gray: α = removed / original, colour = (orig − (1−α)·bg) / α;
                       gaps the remover covers opened again, see rematte)
    encode             all mattes → web/<id>.lg.mp4, web/<id>.sm.mp4 (stacked alpha: colour above, alpha below) +
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


def near_dark(orig: np.ndarray, bg: np.ndarray, px: int) -> np.ndarray:
    """Where something as dark as hair lies within ``px`` pixels."""
    size = 2 * px + 1
    return cv2.erode(orig.mean(-1).astype(np.float32), np.ones((size, size), np.uint8)) < 0.5 * bg.mean()


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
    # solid inside the body — but holes that ARE the background (gray seen through a ponytail's loop) stay open
    solid = ndimage.binary_fill_holes(a > 0.5)
    a = np.where(solid & (a < 0.5) & (dist > KEY_FROM), np.maximum(a, 0.98), a)
    a = clean_alpha(rematte(a, orig, bg))
    a = cv2.GaussianBlur(a.astype(np.float32), (0, 0), 0.6)
    return a, bg


def colour(orig: np.ndarray, a: np.ndarray, bg: np.ndarray) -> np.ndarray:
    aa = a[..., None]
    return np.where(aa > 0.02, (orig - (1 - aa) * bg) / np.maximum(aa, 0.02), 0).clip(0, 255)


def solidify(rgb: np.ndarray, a: np.ndarray, orig: np.ndarray, bg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Full opacity well inside the body (dark cloth gives a noisy ratio matte): small holes closed, pixels two
    steps inside get alpha 1 and their original colour back. Gaps that show the background gray between dark strands
    stay open, and so do their edges."""
    body = ndimage.binary_closing(a > 0.5, structure=np.ones((3, 3)), iterations=2)
    body &= ~((a < 0.5) & (np.sqrt(((orig - bg) ** 2).sum(-1)) < KEY_FROM) & near_dark(orig, bg, 4))
    inner = ndimage.binary_erosion(body, structure=np.ones((3, 3)), iterations=2) & (a < 1.0)
    if inner.any():
        rgb = rgb.copy()
        a = a.copy()
        rgb[inner] = orig[inner]
        a[inner] = 1.0
    return rgb, a


#: from here a pixel is her for certain: what is less is an edge, coloured from her nearest certain pixel; this far past
#: her (pixels of the clip) it is coloured too, so the codec's colour blur and the browser's scaling find her colours there
DEFRINGE_SOLID, DEFRINGE_BAND = 0.95, 6


def defringe(rgb: np.ndarray, a: np.ndarray, solid: float = DEFRINGE_SOLID, band: int = DEFRINGE_BAND) -> np.ndarray:
    """The edge in her own colours. A half-transparent edge pixel still holds some of the gray she was cut from, and on a
    dark page that reads as a light rim around her (her arms, her hair): every pixel short of ``solid``, up to ``band``
    pixels out, takes the colour of the nearest one that is certainly her (her outline, mostly). Beyond that it is black,
    as before (a flat field costs the codec nothing). Alpha stays as it is."""
    s = a >= solid
    if not s.any() or s.all():
        return rgb
    dist, (iy, ix) = ndimage.distance_transform_edt(~s, return_indices=True)
    out = np.where(s[..., None], rgb, rgb[iy, ix])
    return np.where(((dist > band) & (a < 0.02))[..., None], 0, out).astype(rgb.dtype)


def defringe_image(im: Image.Image) -> Image.Image:
    """A still with alpha, its edge in her own colours (``defringe``)."""
    px = np.asarray(im.convert("RGBA"))
    rgb = defringe(px[..., :3], px[..., 3].astype(np.float32) / 255.0)
    return Image.fromarray(np.dstack([rgb, px[..., 3]]).astype(np.uint8), "RGBA")


def choke(a: np.ndarray, seen: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """The edge about a pixel in: the old gray in the outermost pixels reads as a light rim on a dark page, the
    remover's faint wisps as smoke. Solid parts stay, and so does what clearly isn't the gray (``seen``: the picture on it):
    a fine strand or an outline is no rim, and eaten away it breaks into dashes."""
    was = a
    a = np.where(a < 1.0, a ** 1.4, a).astype(np.float32)
    inner = cv2.erode(a, np.ones((3, 3), np.uint8))
    out = np.minimum(a, cv2.GaussianBlur(inner, (0, 0), 0.8))
    clear = np.clip((np.sqrt(((seen - bg) ** 2).sum(-1)) - KEY_FROM) / (KEY_TO - KEY_FROM), 0, 1) * np.clip((was - 0.1) / 0.3, 0, 1)
    return (out + clear * (was - out)).astype(np.float32)


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
    a = clean_alpha(rematte(a, orig, bg))
    fg = colour(orig, a, bg)
    home = Image.fromarray(np.dstack([fg, a * 255]).astype(np.uint8), "RGBA")
    atomic_save(home, m / "home.png")
    aspect = c.get("aspect", "1:1")
    W, H = CANVASES[aspect]
    s = min(0.92 * W / (x1 - x0 + 1), 0.86 * H / (y1 - y0 + 1))
    w, h = round(home.width * s), round(home.height * s)
    ox = round(W / 2 - ((x0 + x1) / 2) * s)
    oy = round(H - (y1 + 1) * s)
    write_json(m / "place.json", {"aspect": aspect, "canvas": [W, H], "scale": s, "x": ox, "y": oy})
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
    done = []
    for raw in sorted((p / "stills").glob("*.raw.png")):
        name = raw.name[: -len(".raw.png")]
        v = np.asarray(Image.open(raw).convert("RGB").resize((home.shape[1], home.shape[0]), Image.LANCZOS),
                       np.float32)
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
                                 ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "21" if tag == "lg" else "23",
                                  "-preset", "slow", "-movflags", "+faststart"]), (ww, hh), mp4)
        bgs = meta["bg"]
        for i, (o, a8) in enumerate(zip(frames(p / "clips" / f"{cid}.mp4"),
                                        frames(p / "matte" / f"{cid}.alpha.mkv", "gray"))):
            o = o[y:y + h, x:x + w].astype(np.float32)
            a = a8[y:y + h, x:x + w].astype(np.float32) / 255.0
            bg = np.array(bgs[min(i, len(bgs) - 1)], np.float32)
            rgb = colour(o, a, bg)
            rgb, a = solidify(rgb, a, o, bg)
            a = choke(a, o, bg)
            rgb = defringe(rgb, a)
            crop = np.dstack([rgb, a * 255.0]).clip(0, 255).round().astype(np.uint8)
            for proc, (ww, hh), _ in procs.values():
                small = cv2.resize(crop, (ww, hh), interpolation=cv2.INTER_AREA)
                alpha = np.repeat(small[..., 3:4], 3, axis=-1)
                assert proc.stdin
                proc.stdin.write(np.ascontiguousarray(np.concatenate([small[..., :3], alpha], axis=0)).tobytes())
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
    """Head and shoulders from the home picture, 3:4 (768×1024), on a soft two-tone of the character's own colours."""
    px = np.asarray(home).astype(np.float32)
    px[..., 3] = choke(px[..., 3] / 255.0, on_gray(px), np.array(GRAY, np.float32)) * 255.0
    home = Image.fromarray(px.clip(0, 255).astype(np.uint8), "RGBA")
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
    stills = {}
    for name in ["neutral", *[st for st in c.get("stills") or []]]:
        src = m / "home.png" if name == "neutral" else p / "stills" / f"{name}.png"
        if not src.exists():
            continue
        im = Image.open(src).convert("RGBA")
        px = np.asarray(im).astype(np.float32)
        px[..., 3] = choke(px[..., 3] / 255.0, on_gray(px), np.array(GRAY, np.float32)) * 255.0
        im = Image.fromarray(px.clip(0, 255).astype(np.uint8), "RGBA")
        canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
        canvas.alpha_composite(im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS), (ox, oy))
        crop = canvas.crop((round(x * k), round(y * k), round((x + w) * k), round((y + h) * k)))
        crop.thumbnail((10_000, box["sizes"]["lg"]), Image.LANCZOS)
        crop = defringe_image(crop)
        crop.save(tmp / f"{name}.webp", quality=90, method=6)
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
    home = Image.open(m / "home.png").convert("RGBA")
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
            a = a8[min(i, len(a8) - 1)].astype(np.float32) / 255.0
            o = allf[i].astype(np.float32)
            rgb = colour(o, a, np.array(bgs[min(i, len(bgs) - 1)], np.float32))
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
        "alpha_shipped_inside_min": round(float(solidify(rgb, a, orig, bg_est)[1][inside].min()), 4),
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
    _, a = solidify(colour(orig, a, bg_est), a, orig, bg_est)
    side = np.abs(np.arctan2(yy - 120.0, 120.0 - xx)) < 0.5
    shown = choke(a, orig, bg_est)
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
