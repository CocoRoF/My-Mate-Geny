/**
 * The square crop of a profile picture (components/ui/IconCropDialog.tsx — a mate's icon and the user's): where the
 * square starts in the picture and how big it is, in the picture's own pixels (any unit works as long as the picture's
 * size is given in it: MateThumb uses the rig's aspect). The dialog moves it with a drag, zooms it with the slider
 * (1 = the picture's whole short side) and draws it; MateThumb shows her default one, the face, with CSS.
 */

export interface Crop {
  x: number;
  y: number;
  size: number;
}

/** the most the slider zooms in */
export const MAX_ZOOM = 8;
/** a crop never gets smaller than this (a tiny picture: its short side) */
const MIN_SIZE = 16;
/** her face takes about half of the icon: the hair above it, the neck below */
const FACE_ROOM = 1.9;

const finite = (...xs: number[]) => xs.every((n) => Number.isFinite(n));

/** the crop moved and sized back inside the picture */
export function clampCrop(c: Crop, w: number, h: number): Crop {
  const short = Math.min(w, h);
  if (!finite(c.x, c.y, c.size, w, h) || short <= 0) return { x: 0, y: 0, size: Math.max(0, short) };
  const size = Math.min(short, Math.max(Math.min(MIN_SIZE, short), c.size));
  return { x: Math.min(w - size, Math.max(0, c.x)), y: Math.min(h - size, Math.max(0, c.y)), size };
}

/** the whole short side, in the middle (a picture the user picked) */
export function centreCrop(w: number, h: number): Crop {
  const size = Math.min(w, h);
  return clampCrop({ x: (w - size) / 2, y: (h - size) / 2, size }, w, h);
}

/** how far the slider goes for this picture */
export const maxZoom = (w: number, h: number): number => Math.max(1, Math.min(MAX_ZOOM, Math.min(w, h) / MIN_SIZE));

/** the slider's value for a crop: 1 = the whole short side */
export const zoomOf = (c: Crop, w: number, h: number): number => (c.size > 0 ? Math.min(w, h) / c.size : 1);

/** the crop at another zoom, the point at (fx, fy) of it (fractions; its middle by default) staying where it is */
export function zoomCrop(c: Crop, zoom: number, w: number, h: number, fx = 0.5, fy = 0.5): Crop {
  const z = Math.max(1, Math.min(maxZoom(w, h), Number.isFinite(zoom) ? zoom : 1));
  const size = Math.min(w, h) / z;
  const px = c.x + c.size * fx;
  const py = c.y + c.size * fy;
  return clampCrop({ x: px - size * fx, y: py - size * fy, size }, w, h);
}

/** a drag of (dx, dy) screen px over a crop shown `view` px wide: the picture follows the finger */
export function panCrop(c: Crop, dx: number, dy: number, view: number, w: number, h: number): Crop {
  const k = view > 0 ? c.size / view : 0;
  return clampCrop({ x: c.x - dx * k, y: c.y - dy * k, size: c.size }, w, h);
}

/**
 * Her face in her avatar's picture: where the rig's frame says it is (`face`: centre x, centre y, height — fractions of
 * the picture, avatar/framing.ts), else the top of the picture in the middle (where a figure's head is).
 */
export function faceCrop(w: number, h: number, face?: number[] | null): Crop {
  const short = Math.min(w, h);
  if (face && face.length === 3 && finite(...face) && face[2] > 0) {
    const size = Math.min(short, Math.max(short * 0.2, face[2] * h * FACE_ROOM));
    // (the face a little above the middle: room for the chin and the neck)
    return clampCrop({ x: face[0] * w - size / 2, y: face[1] * h - size * 0.45, size }, w, h);
  }
  const size = short * 0.6;
  return clampCrop({ x: (w - size) / 2, y: h * 0.02, size }, w, h);
}

/** the picture placed in a square box so that the box shows exactly the crop (CSS, in % of the box) */
export function cropBoxStyle(c: Crop, w: number, h: number): { width: string; height: string; left: string; top: string } {
  const pct = (v: number) => `${c.size > 0 ? +((v / c.size) * 100).toFixed(3) : 0}%`;
  return { width: pct(w), height: pct(h), left: pct(-c.x), top: pct(-c.y) };
}
