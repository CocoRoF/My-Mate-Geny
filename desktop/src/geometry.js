// Window geometry of the Mate windows, as pure functions (no Electron): the
// avatar's edge resize, the quick card's remembered place and its growth.
// src/mate.js feeds them work areas from `screen`; test/geometry.test.js runs
// them without a display.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Overlap of rect b with work area a, in px (both axes ≥ slack). */
function overlaps(b, a, slack = 40) {
  const ix = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
  const iy = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
  return ix >= slack && iy >= slack;
}

/**
 * Geny's overlay:resize-by on an authoritative rect {x, y, w, h}: `edge` is
 * n/s/e/w or a corner ("se", "nw", …), dx/dy the pointer's movement. West /
 * north edges move the origin so the opposite edge stays put. The size stays
 * at least `min`, and the dragged edge stops at the work area's edge (it never
 * pushes the window off the display, nor shifts it when let go). Returns a new
 * rect.
 */
function resizeRect(r, edge, dx, dy, min, area) {
  const out = { ...r };
  if (!/^[nsew]{1,2}$/.test(String(edge))) return out;
  dx = clamp(Number(dx) || 0, -4000, 4000);
  dy = clamp(Number(dy) || 0, -4000, 4000);
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  if (edge.includes("e")) out.w = clamp(out.w + dx, min.width, Math.max(min.width, right - out.x));
  if (edge.includes("s")) out.h = clamp(out.h + dy, min.height, Math.max(min.height, bottom - out.y));
  if (edge.includes("w")) {
    const far = out.x + out.w; // the right edge stays
    const nw = clamp(out.w - dx, min.width, Math.max(min.width, far - area.x));
    out.x = far - nw;
    out.w = nw;
  }
  if (edge.includes("n")) {
    const far = out.y + out.h; // the bottom edge stays
    const nh = clamp(out.h - dy, min.height, Math.max(min.height, far - area.y));
    out.y = far - nh;
    out.h = nh;
  }
  return out;
}

/**
 * Where the quick card opens: the remembered top-left `saved` if a card there
 * would still be on one of `areas` (work areas of the live displays) — kept
 * inside the area it is on — else centred near the top of `fallback` (the
 * work area under the pointer).
 */
function quickPlacement(saved, w, h, areas, fallback) {
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const r = { x: Math.round(saved.x), y: Math.round(saved.y), width: w, height: h };
    let best = null;
    let most = 0;
    for (const a of areas) {
      if (!overlaps(r, a, 24)) continue;
      const area = (Math.min(r.x + w, a.x + a.width) - Math.max(r.x, a.x)) * (Math.min(r.y + h, a.y + a.height) - Math.max(r.y, a.y));
      if (area > most) [best, most] = [a, area];
    }
    if (best) {
      return {
        x: clamp(r.x, best.x, best.x + best.width - Math.min(w, best.width)),
        y: clamp(r.y, best.y, best.y + best.height - Math.min(h, best.height)),
        width: w,
        height: h,
      };
    }
  }
  const a = fallback;
  return { x: Math.round(a.x + (a.width - w) / 2), y: Math.round(a.y + a.height * 0.16), width: w, height: h };
}

/**
 * The quick card at a new content height: width fixed, the top edge fixed —
 * unless it would run off the bottom of its work area, then it moves up just
 * enough. The height stays in [minH, min(maxH, area height)].
 */
function quickGrow(b, h, w, area, minH, maxH) {
  const height = clamp(Math.round(Number(h)) || b.height, minH, Math.min(maxH, area.height));
  const y = Math.max(area.y, Math.min(b.y, area.y + area.height - height));
  return { x: b.x, y, width: w, height };
}

module.exports = { clamp, overlaps, resizeRect, quickPlacement, quickGrow };
