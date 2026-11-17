/**
 * The picture editor's model (components/attachments/ImageEditor.tsx): a picture turned a quarter at a time, cut to a
 * rectangle, and drawn on — pen, highlighter, mosaic, a box, an arrow, words. Nothing is baked in until the end: the
 * edit is a small state (`EditState`) kept with an undo history, and the picture is drawn from it — on screen while
 * editing, and once at full size when done (`exportEdit`).
 *
 * Every coordinate is in the turned picture's own pixels ("turned space": `turnedSize` wide and high), so a mark stays
 * where it was drawn whatever is cut away; turning the picture turns the crop and the marks with it. Pure but for the
 * drawing at the end (test/image-edit.test.ts).
 */

export type Turn = 0 | 90 | 180 | 270;
export type Pt = [number, number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type StrokeKind = "pen" | "highlighter" | "mosaic";
export type ShapeKind = "rect" | "arrow";

export type StrokeMark = { kind: StrokeKind; color: string; size: number; points: Pt[] };
export type ShapeMark = { kind: ShapeKind; color: string; size: number; from: Pt; to: Pt };
export type TextMark = { kind: "text"; color: string; size: number; at: Pt; text: string };
export type Mark = StrokeMark | ShapeMark | TextMark;

export const isStroke = (m: Mark): m is StrokeMark => m.kind === "pen" || m.kind === "highlighter" || m.kind === "mosaic";
export const isShape = (m: Mark): m is ShapeMark => m.kind === "rect" || m.kind === "arrow";

export interface EditState {
  turn: Turn;
  crop: Rect;
  marks: Mark[];
}

/** the longest side a finished picture is drawn at (a phone's camera picture fits; memory stays sane) */
export const MAX_SIDE = 4096;
/** the smallest crop, in the picture's pixels */
export const MIN_CROP = 16;

export function turnedSize(w: number, h: number, turn: Turn): [number, number] {
  return turn === 90 || turn === 270 ? [h, w] : [w, h];
}

export function initialEdit(w: number, h: number): EditState {
  return { turn: 0, crop: { x: 0, y: 0, w, h }, marks: [] };
}

/** anything changed (a picture handed back as it was isn't uploaded again) */
export function edited(s: EditState, w: number, h: number): boolean {
  const [W, H] = turnedSize(w, h, s.turn);
  const full = s.crop.x <= 0.5 && s.crop.y <= 0.5 && Math.abs(s.crop.w - W) <= 0.5 && Math.abs(s.crop.h - H) <= 0.5;
  return s.turn !== 0 || !full || s.marks.length > 0;
}

// ── turning ──

/** a point of the turned picture (`H` high) after a quarter turn clockwise */
const cw = ([x, y]: Pt, H: number): Pt => [H - y, x];

function turnMark(m: Mark, H: number): Mark {
  if (isStroke(m)) return { ...m, points: m.points.map((p) => cw(p, H)) };
  if (isShape(m)) return { ...m, from: cw(m.from, H), to: cw(m.to, H) };
  return { ...m, at: cw(m.at, H) };
}

/** a quarter turn clockwise: the crop and every mark go with the picture */
export function turnClockwise(s: EditState, w: number, h: number): EditState {
  const [, H] = turnedSize(w, h, s.turn);
  const c = s.crop;
  return {
    turn: ((s.turn + 90) % 360) as Turn,
    crop: { x: H - (c.y + c.h), y: c.x, w: c.h, h: c.w },
    marks: s.marks.map((m) => turnMark(m, H)),
  };
}

// ── cutting ──

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** the crop's handle under `p` (corners first, then edges, then inside: move), `tol` in the picture's pixels */
export function handleAt(c: Rect, [x, y]: Pt, tol: number): Handle | null {
  const nearL = Math.abs(x - c.x) <= tol;
  const nearR = Math.abs(x - (c.x + c.w)) <= tol;
  const nearT = Math.abs(y - c.y) <= tol;
  const nearB = Math.abs(y - (c.y + c.h)) <= tol;
  const inX = x >= c.x - tol && x <= c.x + c.w + tol;
  const inY = y >= c.y - tol && y <= c.y + c.h + tol;
  if (nearT && nearL) return "nw";
  if (nearT && nearR) return "ne";
  if (nearB && nearL) return "sw";
  if (nearB && nearR) return "se";
  if (nearT && inX) return "n";
  if (nearB && inX) return "s";
  if (nearL && inY) return "w";
  if (nearR && inY) return "e";
  if (x > c.x && x < c.x + c.w && y > c.y && y < c.y + c.h) return "move";
  return null;
}

/**
 * The crop dragged by `handle` by (dx, dy) from where it was (`start`), inside the picture (`W` × `H`), at least
 * MIN_CROP, and — with a `ratio` (width / height) — keeping it: the opposite corner or edge stays put.
 */
export function dragCrop(start: Rect, handle: Handle, dx: number, dy: number, W: number, H: number, ratio: number | null = null): Rect {
  if (handle === "move") {
    return { ...start, x: clamp(start.x + dx, 0, W - start.w), y: clamp(start.y + dy, 0, H - start.h) };
  }
  let l = start.x;
  let t = start.y;
  let r = start.x + start.w;
  let b = start.y + start.h;
  if (handle.includes("w")) l = clamp(l + dx, 0, r - MIN_CROP);
  if (handle.includes("e")) r = clamp(r + dx, l + MIN_CROP, W);
  if (handle.includes("n")) t = clamp(t + dy, 0, b - MIN_CROP);
  if (handle.includes("s")) b = clamp(b + dy, t + MIN_CROP, H);
  if (!ratio) return { x: l, y: t, w: r - l, h: b - t };
  // the ratio kept: the side that moved most leads; the far corner (or the middle of the far edge) stays where it was
  let w = r - l;
  let h = b - t;
  const horiz = handle === "e" || handle === "w";
  const vert = handle === "n" || handle === "s";
  if (horiz || (!vert && Math.abs(dx) >= Math.abs(dy) * ratio)) h = w / ratio;
  else w = h * ratio;
  // the room there is, from the anchor
  const ax = handle.includes("w") ? start.x + start.w : handle.includes("e") ? start.x : start.x + start.w / 2;
  const ay = handle.includes("n") ? start.y + start.h : handle.includes("s") ? start.y : start.y + start.h / 2;
  const roomW = handle.includes("w") ? ax : handle.includes("e") ? W - ax : 2 * Math.min(ax, W - ax);
  const roomH = handle.includes("n") ? ay : handle.includes("s") ? H - ay : 2 * Math.min(ay, H - ay);
  const k = Math.min(1, roomW / w, roomH / h);
  w *= k;
  h *= k;
  if (w < MIN_CROP || h < MIN_CROP) {
    const g = Math.max(MIN_CROP / w, MIN_CROP / h);
    w *= g;
    h *= g;
  }
  const x = handle.includes("w") ? ax - w : handle.includes("e") ? ax : ax - w / 2;
  const y = handle.includes("n") ? ay - h : handle.includes("s") ? ay : ay - h / 2;
  return { x: clamp(x, 0, W - w), y: clamp(y, 0, H - h), w, h };
}

/** the largest crop of `ratio` (none: the whole picture) about the middle of the one there was */
export function cropToRatio(c: Rect, ratio: number | null, W: number, H: number): Rect {
  if (!ratio) return { x: 0, y: 0, w: W, h: H };
  let w = W;
  let h = W / ratio;
  if (h > H) {
    h = H;
    w = H * ratio;
  }
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  return { x: clamp(cx - w / 2, 0, W - w), y: clamp(cy - h / 2, 0, H - h), w, h };
}

// ── marks ──

function segDist([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** the box a text mark takes (its size is the letters' height; ~0.6 of it a letter wide) */
export function textBox(m: TextMark): Rect {
  const w = Math.max(1, [...m.text].reduce((n, ch) => n + (/[ᄀ-￿]/.test(ch) ? 1 : 0.6), 0)) * m.size;
  return { x: m.at[0], y: m.at[1] - m.size, w, h: m.size * 1.25 };
}

/** the mark is under `p` (within `tol` of its line, inside its words) */
export function markHit(m: Mark, p: Pt, tol: number): boolean {
  const r = m.size / 2 + tol;
  if (m.kind === "text") {
    const b = textBox(m);
    return p[0] >= b.x - tol && p[0] <= b.x + b.w + tol && p[1] >= b.y - tol && p[1] <= b.y + b.h + tol;
  }
  if (!isStroke(m)) {
    if (m.kind === "arrow") return segDist(p, m.from, m.to) <= r;
    const [x1, y1] = m.from;
    const [x2, y2] = m.to;
    const c: Pt[] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    return c.some((a, i) => segDist(p, a, c[(i + 1) % 4]) <= r);
  }
  const pts = m.points;
  if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) <= r;
  for (let i = 1; i < pts.length; i++) if (segDist(p, pts[i - 1], pts[i]) <= r) return true;
  return false;
}

/** the marks the eraser's path (`radius` wide) went over, gone */
export function erase(marks: Mark[], path: Pt[], radius: number): Mark[] {
  return marks.filter((m) => !path.some((p) => markHit(m, p, radius)));
}

/** the topmost text mark under `p` (to move it), or -1 */
export function textAt(marks: Mark[], p: Pt, tol: number): number {
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i].kind === "text" && markHit(marks[i], p, tol)) return i;
  return -1;
}

/** a stroke's points thinned: one closer than `min` to the last kept is dropped (a finger's jitter, fewer points) */
export function addPoint(points: Pt[], p: Pt, min: number): Pt[] {
  const last = points[points.length - 1];
  if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < min) return points;
  return [...points, p];
}

// ── drawing ──

type Ctx = CanvasRenderingContext2D;

/** the picture into `ctx`, already in turned space */
export function drawPicture(ctx: Ctx, img: CanvasImageSource, w: number, h: number, turn: Turn): void {
  ctx.save();
  if (turn === 90) {
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  } else if (turn === 180) {
    ctx.translate(w, h);
    ctx.rotate(Math.PI);
  } else if (turn === 270) {
    ctx.translate(0, w);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(img, 0, 0, w, h);
  ctx.restore();
}

function path(ctx: Ctx, pts: Pt[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
}

/** the font of a text mark */
export const textFont = (size: number) => `700 ${Math.round(size)}px system-ui, -apple-system, "Segoe UI", "Noto Sans KR", sans-serif`;

/** one mark (not mosaic: `drawMosaic`) */
export function drawMark(ctx: Ctx, m: Mark): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = m.size;
  if (isStroke(m)) {
    if (m.kind === "highlighter") {
      ctx.globalAlpha = 0.38;
      ctx.lineCap = "square";
    }
    path(ctx, m.points);
    ctx.stroke();
  } else if (m.kind === "rect") {
    const [x1, y1] = m.from;
    const [x2, y2] = m.to;
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  } else if (m.kind === "arrow") {
    const [x1, y1] = m.from;
    const [x2, y2] = m.to;
    const a = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(m.size * 3.2, 10);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2 - Math.cos(a) * head * 0.6, y2 - Math.sin(a) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(a - 0.45), y2 - head * Math.sin(a - 0.45));
    ctx.lineTo(x2 - head * Math.cos(a + 0.45), y2 - head * Math.sin(a + 0.45));
    ctx.closePath();
    ctx.fill();
  } else if (m.kind === "text") {
    ctx.font = textFont(m.size);
    ctx.textBaseline = "alphabetic";
    // (a thin outline in the other tone: readable on any picture)
    ctx.lineWidth = Math.max(1, m.size / 7);
    ctx.strokeStyle = isLight(m.color) ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.7)";
    ctx.strokeText(m.text, m.at[0], m.at[1]);
    ctx.fillText(m.text, m.at[0], m.at[1]);
  }
  ctx.restore();
}

export function isLight(color: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
}

/** the mosaic marks: the picture in big squares where they went, over `region` (what is drawn: the screen's part, the
 *  crop) at `scale` device pixels per picture pixel (`pixels`: the turned picture, squared — `squared`) */
export function drawMosaic(ctx: Ctx, marks: Mark[], pixels: HTMLCanvasElement, W: number, H: number, region: Rect, scale: number): void {
  const strokes = marks.filter((m): m is StrokeMark => m.kind === "mosaic");
  if (!strokes.length || region.w <= 0 || region.h <= 0) return;
  const mask = document.createElement("canvas");
  mask.width = Math.max(1, Math.round(region.w * scale));
  mask.height = Math.max(1, Math.round(region.h * scale));
  const m = mask.getContext("2d");
  if (!m) return;
  m.scale(scale, scale);
  m.translate(-region.x, -region.y);
  m.lineJoin = "round";
  m.lineCap = "round";
  m.strokeStyle = "#fff";
  for (const s of strokes) {
    m.lineWidth = s.size;
    path(m, s.points);
    m.stroke();
  }
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.globalCompositeOperation = "source-in";
  m.imageSmoothingEnabled = false;
  const kx = pixels.width / W;
  const ky = pixels.height / H;
  m.drawImage(pixels, region.x * kx, region.y * ky, region.w * kx, region.h * ky, 0, 0, mask.width, mask.height);
  ctx.drawImage(mask, region.x, region.y, region.w, region.h);
}

/** the turned picture in squares of `block` pixels (for the mosaic) */
export function squared(img: CanvasImageSource, w: number, h: number, turn: Turn, block: number): HTMLCanvasElement {
  const [W, H] = turnedSize(w, h, turn);
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(W / block));
  small.height = Math.max(1, Math.round(H / block));
  const s = small.getContext("2d")!;
  s.scale(small.width / W, small.height / H);
  drawPicture(s, img, w, h, turn);
  return small;
}

/** the block of a mosaic, in the picture's pixels: about 1/40 of its longer side */
export const mosaicBlock = (W: number, H: number) => Math.max(6, Math.round(Math.max(W, H) / 40));

/** the whole edit drawn into `ctx` (in turned space; the caller's transform places it), `region` of it at `scale` */
export function drawEdit(ctx: Ctx, img: CanvasImageSource, w: number, h: number, s: EditState, pixels: HTMLCanvasElement | null, region: Rect, scale: number): void {
  const [W, H] = turnedSize(w, h, s.turn);
  drawPicture(ctx, img, w, h, s.turn);
  if (pixels) drawMosaic(ctx, s.marks, pixels, W, H, region, scale);
  for (const m of s.marks) if (m.kind !== "mosaic") drawMark(ctx, m);
}

/** the type a finished picture is saved as: PNG / WebP / GIF stay lossless (PNG), the rest JPEG */
export function outputType(mime: string): "image/png" | "image/jpeg" {
  return /png|webp|gif|bmp/i.test(mime) ? "image/png" : "image/jpeg";
}

/** "photo.heic" → "photo-edited.jpg" */
export function editedName(name: string, type: string): string {
  const ext = type === "image/png" ? "png" : "jpg";
  const base = (name || "image").replace(/\.[^./\\]+$/, "").replace(/-edited$/, "");
  return `${base}-edited.${ext}`;
}

/** the finished picture: the crop at full size (at most MAX_SIDE), as a file */
export async function exportEdit(img: CanvasImageSource, w: number, h: number, s: EditState, name: string, mime: string): Promise<File> {
  const c = s.crop;
  const k = Math.min(1, MAX_SIDE / Math.max(c.w, c.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(c.w * k));
  canvas.height = Math.max(1, Math.round(c.h * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  const type = outputType(mime);
  if (type === "image/jpeg") {
    ctx.fillStyle = "#fff"; // (JPEG has no transparency: white behind, not black)
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.scale(k, k);
  ctx.translate(-c.x, -c.y);
  const [W, H] = turnedSize(w, h, s.turn);
  const pixels = s.marks.some((m) => m.kind === "mosaic") ? squared(img, w, h, s.turn, mosaicBlock(W, H)) : null;
  drawEdit(ctx, img, w, h, s, pixels, c, k);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, type, 0.92));
  if (!blob) throw new Error("canvas");
  return new File([blob], editedName(name, type), { type, lastModified: Date.now() });
}
