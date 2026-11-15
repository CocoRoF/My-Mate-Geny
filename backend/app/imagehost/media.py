"""Image Studio's finishing steps on what the engine made — run as a script by the engine's own Python (numpy, Pillow
and PyAV come with ComfyUI's environment; the server process stays light). No app imports: ``python -I media.py <cmd>
<json>``, one JSON argument, one JSON line out (docs/local-image.md "Finishing").

    loop   the frames of a loop → its clip: colours brought back to the base picture's (the video model's decoder
           drifts a few levels darker), the base picture itself on the first and last frame with the frames next to
           them eased into it (the seam is exact), pasted back into the whole canvas when the model saw a crop of it
    nobg   a clip and its frames' masks → the subject on black (what a hosted video background remover returns)
    cut    a picture and its mask → the cut-out (RGBA)
    match  an edited picture → its colours fitted to the original's where the edit left it alone
    fake-* stand-ins for the engine (tests, no GPU): a draft, an edit, a mask, a loop's frames
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def _rgb(path: str | Path, size: tuple[int, int] | None = None) -> np.ndarray:
    im = Image.open(path).convert("RGB")
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32)


def _gray(path: str | Path, size: tuple[int, int]) -> np.ndarray:
    im = Image.open(path).convert("L")
    if im.size != size:
        im = im.resize(size, Image.BILINEAR)
    return np.asarray(im).astype(np.float32) / 255.0


def _save(arr: np.ndarray, path: Path, **kw) -> None:
    tmp = path.with_name(path.stem + ".part" + path.suffix)
    Image.fromarray(arr.clip(0, 255).round().astype(np.uint8)).save(tmp, **kw)
    os.replace(tmp, path)


# ── colour ──

def fit_colour(src: np.ndarray, ref: np.ndarray, weight: np.ndarray | None = None, *,
               slope: tuple[float, float] = (0.8, 1.25), offset: float = 40.0,
               spread: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """per channel ``ref ≈ a · src + b``, least squares over the pixels `weight` keeps (the 15% that differ most are
    left out: what changed is not a colour shift). A channel whose kept pixels span less than `spread` (std) can't
    tell a slope from noise — a flat background — so only its offset is fitted; a slope is held to `slope`, the
    offset to ±`offset`."""
    s, r = src.reshape(-1, 3), ref.reshape(-1, 3)
    keep = np.ones(len(s), bool) if weight is None else weight.reshape(-1) > 0.5
    d = np.abs(s - r).sum(1)
    if keep.sum() > 1000:
        keep &= d <= np.quantile(d[keep], 0.85)
    a, b = np.ones(3, np.float32), np.zeros(3, np.float32)
    for c in range(3):
        x, y = s[keep, c], r[keep, c]
        if len(x) < 100 or x.std() < spread:
            b[c] = float(np.clip((y - x).mean(), -offset, offset)) if len(x) else 0.0
            continue
        aa, bb = np.polyfit(x, y, 1)
        a[c] = float(np.clip(aa, *slope))
        if a[c] != aa:  # (held: the offset that goes with the held slope)
            bb = float((y - a[c] * x).mean())
        b[c] = float(np.clip(bb, -offset, offset))
    return a, b


def apply_colour(x: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return x * a + b


# ── video in / out (PyAV, else an ffmpeg program) ──

def _ffmpeg() -> str | None:
    exe = os.environ.get("AVATAR_FFMPEG") or shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # noqa: PLC0415

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


class Writer:
    """H.264 at a quality the next steps can't tell from lossless (CRF 12, 4:2:0 like the hosted models' clips)"""

    def __init__(self, path: Path, w: int, h: int, fps: float) -> None:
        self.path, self.w, self.h = path, w - w % 2, h - h % 2
        self.tmp = path.with_name(path.stem + ".part" + path.suffix)
        try:
            import av  # noqa: PLC0415

            self.av = av.open(str(self.tmp), "w")
            self.st = self.av.add_stream("libx264", rate=int(round(fps)))
            self.st.width, self.st.height, self.st.pix_fmt = self.w, self.h, "yuv420p"
            self.st.options = {"crf": "12", "preset": "veryfast"}  # (a working file: the avatar re-encodes it)
            self.st.codec_context.thread_count = 0
            self.proc = None
        except ImportError:
            exe = _ffmpeg()
            if not exe:
                raise RuntimeError("no video encoder: neither PyAV nor ffmpeg is available") from None
            self.av = None
            self.proc = subprocess.Popen(
                [exe, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{self.w}x{self.h}",
                 "-r", f"{fps:g}", "-i", "-", "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                 "-movflags", "+faststart", str(self.tmp)], stdin=subprocess.PIPE)

    def write(self, rgb: np.ndarray) -> None:
        f = rgb[: self.h, : self.w].clip(0, 255).round().astype(np.uint8)
        if self.av is not None:
            import av  # noqa: PLC0415

            for pkt in self.st.encode(av.VideoFrame.from_ndarray(np.ascontiguousarray(f), format="rgb24")):
                self.av.mux(pkt)
        else:
            assert self.proc and self.proc.stdin
            self.proc.stdin.write(f.tobytes())

    def close(self) -> None:
        if self.av is not None:
            for pkt in self.st.encode():
                self.av.mux(pkt)
            self.av.close()
        else:
            assert self.proc and self.proc.stdin
            self.proc.stdin.close()
            if self.proc.wait() != 0:
                raise RuntimeError("ffmpeg failed")
        os.replace(self.tmp, self.path)


def read_video(path: str | Path):
    """(frames as float32 RGB arrays, fps)"""
    try:
        import av  # noqa: PLC0415

        c = av.open(str(path))
        st = c.streams.video[0]
        fps = float(st.average_rate or st.guessed_rate or 24)
        out = [f.to_ndarray(format="rgb24").astype(np.float32) for f in c.decode(st)]
        c.close()
        return out, fps
    except ImportError:
        pass
    exe = _ffmpeg()
    if not exe:
        raise RuntimeError("no video decoder: neither PyAV nor ffmpeg is available")
    probe = subprocess.run([exe, "-i", str(path)], capture_output=True, text=True).stderr
    import re  # noqa: PLC0415

    m = re.search(r"(\d{2,5})x(\d{2,5})", probe.split("Video:", 1)[-1])
    fm = re.search(r"([\d.]+) fps", probe)
    w, h = int(m.group(1)), int(m.group(2))
    raw = subprocess.run([exe, "-loglevel", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    arr = np.frombuffer(raw[: n * w * h * 3], np.uint8).reshape(n, h, w, 3).astype(np.float32)
    return list(arr), float(fm.group(1)) if fm else 24.0


# ── the steps ──

def _resize(x: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    if (x.shape[1], x.shape[0]) == size:
        return x
    return np.asarray(Image.fromarray(x.clip(0, 255).round().astype(np.uint8)).resize(size, Image.LANCZOS)).astype(np.float32)


def cmd_loop(a: dict) -> dict:
    """frames (paths, in order) + base → the clip, at the base picture's size. `box`: where the frames sit in the base
    picture [x0, y0, x1, y1] (a crop the model saw at a higher resolution), else the whole picture. `ease`: frames
    eased into the base at each end — at the clip's own resolution, so the ends are the base picture itself, sharp."""
    frames = [Path(p) for p in a["frames"]]
    if len(frames) < 3:
        raise RuntimeError("too few frames")
    base = Image.open(a["base"]).convert("RGB")
    W, H = base.size
    x0, y0, x1, y1 = (int(v) for v in (a.get("box") or [0, 0, W, H]))
    bw, bh = x1 - x0, y1 - y0
    canvas = np.asarray(base).astype(np.float32)
    ref = canvas[y0:y1, x0:x1]                                    # the base where the frames go, full resolution
    fw, fh = Image.open(frames[0]).size
    small = _resize(ref, (fw, fh))                                 # … and at the model's resolution (the colour fit)
    a0, b0 = fit_colour(_rgb(frames[0]), small)
    a1, b1 = fit_colour(_rgb(frames[-1]), small)
    n, ease = len(frames), max(0, int(a.get("ease", 3)))
    whole = (x0, y0, x1, y1) == (0, 0, W, H)
    feather = None
    if not whole:  # (a crop goes back with a soft edge: the flat gray around her hides it)
        m = Image.new("L", (bw, bh), 0)
        k = max(4, int(min(bw, bh) * 0.04))
        ImageDraw.Draw(m).rectangle((k, k, bw - 1 - k, bh - 1 - k), fill=255)
        feather = np.asarray(m.filter(ImageFilter.GaussianBlur(k / 2))).astype(np.float32)[..., None] / 255.0
    wr = Writer(Path(a["out"]), W, H, float(a.get("fps", 24)))
    moved = []
    try:
        for i, f in enumerate(frames):
            t = i / (n - 1)
            w_end = 1.0 if i in (0, n - 1) else (1 - i / (ease + 1) if i <= ease else
                                                 1 - (n - 1 - i) / (ease + 1) if i >= n - 1 - ease else 0.0)
            if w_end >= 1.0:
                wr.write(canvas)
                moved.append(0.0)
                continue
            x = apply_colour(_rgb(f), a0 * (1 - t) + a1 * t, b0 * (1 - t) + b1 * t)
            moved.append(float(np.abs(x - small).mean()))
            y = _resize(x, (bw, bh)) * (1 - w_end) + ref * w_end
            if whole:
                wr.write(y)
            else:
                fr = canvas.copy()
                fr[y0:y1, x0:x1] = y * feather + ref * (1 - feather)
                wr.write(fr)
    finally:
        wr.close()
    if a.get("poster"):
        _save(canvas, Path(a["poster"]), quality=90)
    return {"frames": n, "size": [W, H], "model_size": [fw, fh], "box": [x0, y0, x1, y1],
            "colour": {"first": [a0.tolist(), b0.tolist()], "last": [a1.tolist(), b1.tolist()]},
            "most_moved": round(max(moved), 2), "seam": [round(moved[1], 2), round(moved[-2], 2)]}


def cmd_nobg(a: dict) -> dict:
    frames, fps = read_video(a["clip"])
    masks = [Path(p) for p in a["masks"]]
    if not frames:
        raise RuntimeError("the clip has no frames")
    h, w = frames[0].shape[:2]
    wr = Writer(Path(a["out"]), w, h, fps)
    try:
        for i, f in enumerate(frames):
            if masks:
                m = _gray(masks[min(i, len(masks) - 1)], (w, h))[..., None]
            elif a.get("auto_mask"):  # (the stand-in: whatever is not the flat background)
                bg = np.median(np.concatenate([f[:8].reshape(-1, 3), f[:, :8].reshape(-1, 3)]), axis=0)
                m = (np.sqrt(((f - bg) ** 2).sum(-1)) > 18).astype(np.float32)[..., None]
            else:
                m = 1.0
            wr.write(f * m)
    finally:
        wr.close()
    return {"frames": len(frames), "masks": len(masks), "size": [w, h], "fps": fps}


def cmd_cut(a: dict) -> dict:
    im = Image.open(a["image"]).convert("RGB")
    m = Image.open(a["mask"]).convert("L").resize(im.size, Image.BILINEAR)
    im.putalpha(m)
    out = Path(a["out"])
    tmp = out.with_name(out.stem + ".part.png")
    im.save(tmp)
    os.replace(tmp, out)
    arr = np.asarray(m)
    return {"size": list(im.size), "coverage": round(float((arr > 128).mean()), 4)}


#: summed |RGB difference| (0–765) under which a pixel of an edit counts as left alone — a decoder's colour drift
#: stays under it, a redrawn pixel doesn't
LEFT_ALONE = 48.0
#: less of the picture left alone than this: the edit redrew it (a new pose, a new style) and there is no drift to
#: measure — fitting it anyway pairs pixels that don't correspond and flattens the picture (slope 0.8, blacks +40)
MIN_LEFT_ALONE = 0.3


def cmd_match(a: dict) -> dict:
    """the edit's colours fitted to the original's where the edit left the picture alone (outside `exclude`, where
    the change was asked for, and only the pixels that still look the same), at the original's size; an edit that
    redrew the picture is kept as it came"""
    orig = Image.open(a["original"]).convert("RGB")
    ed = _rgb(a["image"], orig.size)
    o = np.asarray(orig).astype(np.float32)
    weight = np.ones(o.shape[:2], np.float32)
    ex = a.get("exclude")
    if ex:
        x0, y0, x1, y1 = (int(v) for v in ex)
        weight[max(0, y0):y1, max(0, x0):x1] = 0
    alone = (weight > 0.5) & (np.abs(ed - o).sum(2) <= LEFT_ALONE)
    share = round(float(alone.mean()), 3)
    if share < MIN_LEFT_ALONE:
        _save(ed, Path(a["out"]))
        return {"size": list(orig.size), "colour": None, "left_alone": share}
    # (a decoder's drift is small: a gentle slope at most, and only where the pixels left alone span enough tones)
    ca, cb = fit_colour(ed, o, alone.astype(np.float32), slope=(0.9, 1.1), offset=25.0, spread=35.0)
    _save(apply_colour(ed, ca, cb), Path(a["out"]))
    return {"size": list(orig.size), "colour": [ca.tolist(), cb.tolist()], "left_alone": share}


# ── stand-ins (tests) ──

def _label(img: Image.Image, text: str) -> None:
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, img.width, 28), fill=(20, 20, 24))
    d.text((8, 8), text[:80], fill=(240, 240, 240))


def cmd_fake_draft(a: dict) -> dict:
    w, h, seed = int(a["width"]), int(a["height"]), int(a.get("seed", 0))
    rng = np.random.default_rng(seed)
    img = Image.new("RGB", (w, h), (213, 212, 217))
    d = ImageDraw.Draw(img)
    c = tuple(int(v) for v in rng.integers(40, 200, 3))
    d.ellipse((w * 0.36, h * 0.12, w * 0.64, h * 0.38), fill=(238, 214, 196))
    d.rounded_rectangle((w * 0.26, h * 0.36, w * 0.74, h), radius=int(w * 0.08), fill=c)
    _label(img, a.get("prompt", ""))
    img.save(a["out"])
    return {"size": [w, h]}


def cmd_fake_edit(a: dict) -> dict:
    img = Image.open(a["image"]).convert("RGB")
    d = ImageDraw.Draw(img)
    w, h = img.size
    d.arc((w * 0.43, h * 0.27, w * 0.57, h * 0.33), 10, 170, fill=(150, 40, 60), width=max(2, w // 200))
    _label(img, a.get("prompt", ""))
    img.save(a["out"])
    return {"size": [w, h]}


def cmd_fake_mask(a: dict) -> dict:
    """a mask from the picture itself: whatever is not the flat background (its border's colour)"""
    o = _rgb(a["image"])
    bg = np.median(np.concatenate([o[:8].reshape(-1, 3), o[:, :8].reshape(-1, 3), o[:, -8:].reshape(-1, 3)]), axis=0)
    m = (np.sqrt(((o - bg) ** 2).sum(-1)) > 18).astype(np.float32) * 255
    _save(m, Path(a["out"]))
    return {"coverage": round(float((m > 128).mean()), 4)}


def cmd_fake_frames(a: dict) -> dict:
    base = Image.open(a["base"]).convert("RGB")
    w, h = int(a.get("width") or base.width), int(a.get("height") or base.height)
    base = base.resize((w, h), Image.LANCZOS)
    out = Path(a["dir"])
    out.mkdir(parents=True, exist_ok=True)
    n, files = int(a["frames"]), []
    for i in range(n):
        dy = int(round(np.sin(i / (n - 1) * np.pi) * h * 0.01))
        fr = Image.new("RGB", (w, h), base.getpixel((2, 2)))
        fr.paste(base, (0, -dy))
        p = out / f"frame_{i:05d}.png"
        fr.save(p)
        files.append(str(p))
    return {"files": files}


COMMANDS = {"loop": cmd_loop, "nobg": cmd_nobg, "cut": cmd_cut, "match": cmd_match, "fake-draft": cmd_fake_draft,
            "fake-edit": cmd_fake_edit, "fake-mask": cmd_fake_mask, "fake-frames": cmd_fake_frames}


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in COMMANDS:
        print(json.dumps({"error": f"usage: media.py <{'|'.join(COMMANDS)}> <json>"}))
        return 2
    try:
        res = COMMANDS[argv[1]](json.loads(argv[2]))
    except Exception as e:  # noqa: BLE001 - one line back to the server
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return 1
    print(json.dumps({"ok": True, **res}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
