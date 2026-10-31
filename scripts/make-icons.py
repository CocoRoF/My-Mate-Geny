#!/usr/bin/env python3
"""Regenerate every icon / logo the project ships from one master image.

    python3 scripts/make-icons.py [assets/geny-logo.png]

Writes: assets/ (master sizes), frontend/public/ (favicons, PWA icons, the
in-app logo), desktop/build/icon.png (electron-builder makes .ico/.icns from
it) and mobile/assets/ (sources for `npx @capacitor/assets generate --android`).
Needs Pillow. Forks: replace assets/geny-logo.png (square, transparent) and rerun.
"""

from __future__ import annotations

import base64
import io
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BG = (10, 12, 16, 255)  # the app's background (#0a0c10)


def load(path: Path) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    bbox = im.getbbox()  # trim transparent margins so small sizes use every pixel
    if bbox:
        im = im.crop(bbox)
    side = max(im.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    return sq


def fit(logo: Image.Image, size: int, scale: float = 1.0, bg: tuple | None = None) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), bg or (0, 0, 0, 0))
    inner = max(1, round(size * scale))
    canvas.alpha_composite(logo.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    return canvas


def mark(logo: Image.Image) -> Image.Image:
    """The face close-up for tiny favicons (16–48 px): the full logo with its
    lettering turns to mush at that size. Fractions of the trimmed square."""
    w = logo.width
    box = (round(w * 0.24), round(w * 0.13), round(w * 0.76), round(w * 0.65))
    return logo.crop(box)


def save(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, optimize=True)
    print(f"  {path.relative_to(ROOT)}  {im.size[0]}x{im.size[1]}")


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "assets" / "geny-logo.png"
    logo = load(src)
    a, pub = ROOT / "assets", ROOT / "frontend" / "public"
    # transparent icons (favicons, app logo, desktop icon)
    for size in (1024, 512, 192, 64):
        save(fit(logo, size), a / f"icon-{size}.png")
    save(fit(mark(logo), 32), a / "favicon-32.png")
    # platforms that fill transparency with black/white get the app background
    save(fit(logo, 180, 0.9, BG), a / "apple-touch-icon.png")
    # maskable / adaptive: logo inside the 80 % safe zone on the app background
    for size in (1024, 512):
        save(fit(logo, size, 0.72, BG), a / f"icon-maskable-{size}.png")

    for name in ("favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"):
        save(Image.open(a / name), pub / name)
    save(fit(logo, 256), pub / "logo.png")  # in-app brand mark (sidebar, login page)
    ico = fit(mark(logo), 256)
    ico.save(pub / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"  {(pub / 'favicon.ico').relative_to(ROOT)}  16/32/48 (face close-up)")
    # favicon.svg kept for old references: an SVG wrapping the 64 px PNG
    buf = io.BytesIO()
    fit(mark(logo), 64).save(buf, format="PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
           f'viewBox="0 0 64 64"><image width="64" height="64" href="data:image/png;base64,{b64}"/></svg>\n')
    for p in (pub / "favicon.svg", a / "icon.svg"):
        p.write_text(svg)
        print(f"  {p.relative_to(ROOT)}  (svg wrapper)")

    save(fit(logo, 1024), ROOT / "desktop" / "build" / "icon.png")

    m = ROOT / "mobile" / "assets"
    save(fit(logo, 1024, 0.86, BG), m / "icon-only.png")
    save(fit(logo, 1024, 0.62), m / "icon-foreground.png")  # adaptive icon: 66 % safe zone
    save(Image.new("RGBA", (1024, 1024), BG), m / "icon-background.png")
    for name in ("splash.png", "splash-dark.png"):
        save(fit(logo, 2732, 0.3, BG), m / name)


if __name__ == "__main__":
    main()
