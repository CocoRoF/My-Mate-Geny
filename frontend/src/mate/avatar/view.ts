/**
 * The user's pan / zoom of an avatar inside its box (Geny's Live2DCanvas view: drag pans, the wheel zooms around the
 * pointer, persisted under a view storage key, a reset). One transform for every body: a point q of the box is drawn
 * at `t + z·q` (t = x·width, y·height — fractions of the box). Video and photo bodies get it as a CSS transform
 * (origin 0 0); Live2D applies the same mapping inside its renderer (crisp at any zoom). The desktop overlay
 * (surfaces/MateSurfaces.tsx) and the console's Mate stage (MateStage.tsx) each keep their own, per mate.
 *
 * What is kept is not that transform but where she is against her fitted figure (KeptView). Kept as fractions of the
 * box, a zoom made on a wide stage, where she stands small in its middle, came back on a narrow one twice its width and
 * off to a side, her face cut by its edge. Against her figure another shape of box shows the same of her; she goes
 * wherever she is dragged — only never all the way out of the box (a sliver of her stays in sight, so she can't be lost);
 * and the console's stage fits her whole again when its shape changes a lot.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface AvatarViewT {
  /** pan, as a fraction of the box's width / height */
  x: number;
  y: number;
  /** zoom (1 = as fitted) */
  z: number;
}

export const VIEW_HOME: AvatarViewT = { x: 0, y: 0, z: 1 };
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 4;
// exponential, per wheel deltaY px: a mouse-wheel notch (100 px) ≈ 5.5 %, with Ctrl or Shift ≈ 2 % (the last bit);
// a trackpad pinch (Ctrl + small fractional deltas, as Chromium sends it) follows the fingers. (Geny's 0.0015 made a
// notch ≈ 14 %: too coarse to frame her face.)
export const NOTCH_SPEED = 0.00055;
export const FINE_SPEED = 0.0002;
const PINCH_SPEED = 0.01;
export const DRAG_PX = 4; // below this a press is still a tap
/** a pan or zoom goes anywhere, only never all the way out: this much of the box (or all of her middle, once it is
 *  smaller) stays her on each axis — enough to find her again, no limit to where she is put */
export const SLIVER = 0.06;
/** her middle: her fitted box without this much of it on each side — a picture's margins and a model's canvas around
 *  her are empty, and half of her box in a corner of the stage can be nothing of her */
export const MARGIN = 0.25;
/** a box this much wider or taller than the one a view was made on fits her whole again (the console's stage) */
export const REFIT_SHAPE = 1.3;

type WheelLike = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "shiftKey">;

/** a wheel event as a zoom: its delta in px (lines / pages converted) and the speed for it */
export function wheelZoom(e: WheelLike): { delta: number; speed: number } {
  // (Shift + wheel arrives sideways: Chromium turns it into deltaX on Windows / Linux, macOS does itself)
  let d = e.deltaY || (e.shiftKey ? e.deltaX : 0);
  if (e.deltaMode === 1) d *= 33;
  else if (e.deltaMode === 2) d *= 800;
  const pinch = e.ctrlKey && !e.shiftKey && Math.abs(d) < 20 && !Number.isInteger(d);
  return { delta: d, speed: pinch ? PINCH_SPEED : e.ctrlKey || e.shiftKey ? FINE_SPEED : NOTCH_SPEED };
}

export const isHome = (v: AvatarViewT) => v.z === 1 && v.x === 0 && v.y === 0;

/**
 * What a body fits in its box: the shape (width : height) of her picture, her framed box or her model, at what share
 * of the contained size (Live2D's scale), standing where up and down (1: on the bottom edge — pictures; 0.5: in the
 * middle — Live2D, LivLiv). The bodies say (MateAvatar `onFigure`).
 */
export interface FigureShape {
  aspect: number;
  scale?: number;
  anchorY?: number;
}

/**
 * How far past its box (px, each side) a body may be drawn: the console's stage fits her in its padded box but lets her
 * reach its very edges — the edges of the place behind her — rather than cutting her at the padding (MateStage).
 */
export interface Bleed {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** until the body says (a Live2D model still loading) */
export const FIGURE_GUESS: FigureShape = { aspect: 3 / 4 };

/** a rect, in fractions of the box */
export interface FitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const WHOLE: FitRect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Where her whole figure stands fitted in a `w` × `h` px box: contained (the smaller of the width and the height
 * scale), centred across, at its anchor up and down. → fractions of the box.
 */
export function fitRect(fig: FigureShape, w: number, h: number): FitRect {
  if (!(w > 0 && h > 0)) return WHOLE;
  const a = fig.aspect > 0 && Number.isFinite(fig.aspect) ? fig.aspect : FIGURE_GUESS.aspect;
  const k = fig.scale && fig.scale > 0 ? fig.scale : 1;
  const fh = Math.min(1, w / (h * a)) * k;
  const fw = (fh * h * a) / w;
  return { x: (1 - fw) / 2, y: (1 - fh) * (fig.anchorY ?? 1), w: fw, h: fh };
}

const zoomOf = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(z) ? z : 1));

/**
 * Never lose her: of her figure (`fit`: where it stands fitted), zoomed, a SLIVER of her middle stays inside the box on
 * each axis — nothing more is held back. (No figure: the whole box is her.)
 */
export function clampView(v: AvatarViewT, fit: FitRect = WHOLE): AvatarViewT {
  const z = zoomOf(v.z);
  const lim = (t: number, at: number, size: number) => {
    // her middle spans [t + z·mid, t + z·mid + span]
    const mid = at + MARGIN * size;
    const span = z * size * (1 - 2 * MARGIN);
    const keep = Math.min(SLIVER, span);
    const from = (Number.isFinite(t) ? t : 0) + z * mid;
    return Math.min(1 - keep, Math.max(keep - span, from)) - z * mid;
  };
  return { x: lim(v.x, fit.x, fit.w), y: lim(v.y, fit.y, fit.h), z };
}

/** zoom by a wheel delta around the pointer at (px, py) (fractions of the box): the point under it stays put */
export function zoomAt(v: AvatarViewT, deltaY: number, px: number, py: number, speed = NOTCH_SPEED, fit: FitRect = WHOLE): AvatarViewT {
  const z = zoomOf(v.z * Math.exp(-deltaY * speed));
  if (z === v.z) return v;
  const r = z / v.z;
  return clampView({ x: px - (px - v.x) * r, y: py - (py - v.y) * r, z }, fit);
}

/**
 * A view as kept: her zoom, and how far her figure is from where it stands fitted, in her own fitted size (ox 0.1: a
 * tenth of her width to the right) — the same of her in any shape of box. `shape`: the box's width : height when made.
 */
export interface KeptView {
  z: number;
  ox: number;
  oy: number;
  shape: number;
}

/** the view `v` of a box she is fitted in at `fit`, as kept */
export function toKept(v: AvatarViewT, fit: FitRect, shape: number): KeptView {
  return { z: v.z, ox: (v.x + (v.z - 1) * fit.x) / fit.w, oy: (v.y + (v.z - 1) * fit.y) / fit.h, shape };
}

/** a kept view, in a box she is fitted in at `fit` */
export function fromKept(k: KeptView, fit: FitRect): AvatarViewT {
  return { x: k.ox * fit.w - (k.z - 1) * fit.x, y: k.oy * fit.h - (k.z - 1) * fit.y, z: k.z };
}

/** is a box of shape `now` (width : height) far from the one of shape `was`: one to fit her again in */
export const shapeMoved = (was: number, now: number): boolean => !(was > 0 && now > 0) || Math.abs(Math.log(now / was)) > Math.log(REFIT_SHAPE);

const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** a view kept before there was a figure to keep it against: fractions of the box, its shape unknown */
type BoxView = AvatarViewT;

export const isKept = (v: KeptView | BoxView): v is KeptView => "shape" in v;

/** the view kept under `key` (null: fitted). An older box view comes back as one. */
export function readKept(key: string | null): KeptView | BoxView | null {
  if (!key) return null;
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    if (v && num(v.z) && num(v.ox) && num(v.oy) && num(v.shape)) return { z: v.z, ox: v.ox, oy: v.oy, shape: v.shape };
    if (v && num(v.z) && num(v.x) && num(v.y)) return { x: v.x, y: v.y, z: v.z };
  } catch {
    /* corrupt / unavailable */
  }
  return null;
}

function writeKept(key: string | null, v: KeptView | null) {
  if (!key) return;
  try {
    if (!v) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ z: +v.z.toFixed(4), ox: +v.ox.toFixed(4), oy: +v.oy.toFixed(4), shape: +v.shape.toFixed(4) }));
  } catch {
    /* private mode */
  }
}

/**
 * The view to draw: what is kept, in a `box` (px) she is fitted in as `figure` says, kept in reach. `refit`: a box of
 * quite another shape than the one it was made on — or an older box view, whose shape is unknown — shows her fitted.
 */
export function viewIn(kept: KeptView | BoxView | null, figure: FigureShape, box: { w: number; h: number } | null, refit: boolean): AvatarViewT {
  if (!kept || !box) return VIEW_HOME;
  if (refit && (!isKept(kept) || shapeMoved(kept.shape, box.w / box.h))) return VIEW_HOME;
  const fit = fitRect(figure, box.w, box.h);
  return clampView(isKept(kept) ? fromKept(kept, fit) : kept, fit);
}

/** the CSS transform for the video / photo bodies, on a layer that fills the box (transform-origin 0 0): translate %
 *  is of that layer, i.e. of the box */
export const viewTransform = (v: AvatarViewT) =>
  isHome(v) ? undefined : `translate(${(v.x * 100).toFixed(3)}%, ${(v.y * 100).toFixed(3)}%) scale(${v.z.toFixed(4)})`;

/**
 * Pan / zoom gestures on `ref`'s element while `enabled`: a left-button drag past DRAG_PX pans (the click that follows
 * is swallowed, so a drag is never also a tap), the wheel zooms around the pointer. Kept under `storageKey` (per mate)
 * against her fitted figure — `setFigure` takes what the body fits (MateAvatar `onFigure`); `reset()` goes back to the
 * fitted view. Other windows with the same key follow (the storage event). `touch: false` leaves a finger alone (a
 * phone's page scrolls, a tap pokes her); `doubleClickReset`: a double click goes back to the fitted view (the console's
 * stage); `refit`: a box whose shape changed a lot since the view was made shows her fitted — the view stays kept, for
 * a box like the one it was made on, until another one is made (the console's stage).
 */
export function useAvatarView(
  ref: React.RefObject<HTMLElement | null>,
  storageKey: string | null,
  enabled: boolean,
  { touch = true, doubleClickReset = false, refit = false }: { touch?: boolean; doubleClickReset?: boolean; refit?: boolean } = {},
) {
  const [kept, setKept] = useState<KeptView | BoxView | null>(() => readKept(storageKey));
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [figure, setFigureNow] = useState<FigureShape>(FIGURE_GUESS);
  const [dragging, setDragging] = useState(false);
  const setFigure = useCallback((f: FigureShape | null) => {
    const next = f && f.aspect > 0 && Number.isFinite(f.aspect) ? f : FIGURE_GUESS;
    setFigureNow((was) => (was.aspect === next.aspect && was.scale === next.scale && was.anchorY === next.anchorY ? was : next));
  }, []);

  const view = viewIn(kept, figure, box, refit);
  const fit = box ? fitRect(figure, box.w, box.h) : WHOLE;
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const shapeRef = useRef(1);
  shapeRef.current = box ? box.w / box.h : 1;
  const keptRef = useRef<KeptView | null>(null);

  useEffect(() => setKept(readKept(storageKey)), [storageKey]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === storageKey && setKept(readKept(storageKey));
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  // (an older box view, its shape unknown, is no use where she is fitted again: let go)
  useEffect(() => {
    if (!refit || !kept || isKept(kept)) return;
    writeKept(storageKey, null);
    setKept(null);
  }, [refit, kept, storageKey]);

  // the box's size: where she is fitted in it (before the first paint, so a kept view never shows in the wrong place)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const take = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setBox((b) => (b && b.w === w && b.h === h ? b : { w, h }));
    };
    take();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(take);
    ro.observe(el);
    return () => ro.disconnect();
    // (the element can come later: the overlay draws it once its mate is in, with her storage key)
  }, [ref, storageKey, enabled]);

  /** show `v` (kept in reach), as kept against her figure; written now when `save` */
  const put = useCallback(
    (v: AvatarViewT, save: boolean) => {
      const f = fitRef.current;
      const c = clampView(v, f);
      const k = isHome(c) ? null : toKept(c, f, shapeRef.current);
      viewRef.current = c;
      keptRef.current = k;
      setKept(k);
      if (save) writeKept(storageKey, k);
    },
    [storageKey],
  );
  const reset = useCallback(() => put(VIEW_HOME, true), [put]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let drag: { id: number; x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    let swallowClick = false;
    const frac = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      return { x: r.width ? (clientX - r.left) / r.width : 0.5, y: r.height ? (clientY - r.top) / r.height : 0.5, r };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = frac(e.clientX, e.clientY);
      const { delta, speed } = wheelZoom(e);
      const next = zoomAt(viewRef.current, delta, p.x, p.y, speed, fitRef.current);
      if (next === viewRef.current) return;
      put(next, false);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => writeKept(storageKey, keptRef.current), 250);
    };
    const onDouble = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("button, a, input, textarea, select, [data-no-pan]")) return;
      clearTimeout(saveTimer);
      put(VIEW_HOME, true);
    };
    const onDown = (e: PointerEvent) => {
      if (!touch && e.pointerType === "touch") return;
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, a, input, textarea, select, [data-no-pan]")) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
    };
    const onMove = (e: PointerEvent) => {
      const d = drag;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) <= DRAG_PX) return;
        d.moved = true;
        setDragging(true);
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* optional */
        }
      }
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      put({ x: d.vx + dx / r.width, y: d.vy + dy / r.height, z: viewRef.current.z }, false);
    };
    const onUp = (e: PointerEvent) => {
      const d = drag;
      if (!d || e.pointerId !== d.id) return;
      drag = null;
      if (!d.moved) return;
      e.stopPropagation(); // (the body never sees the end of a pan as a tap)
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
      setDragging(false);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      writeKept(storageKey, keptRef.current);
    };
    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return;
      e.stopPropagation();
      e.preventDefault();
    };
    // capture phase: a drag that started on the avatar must not reach the body as a press / tap
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointermove", onMove, true);
    el.addEventListener("pointerup", onUp, true);
    el.addEventListener("pointercancel", onUp, true);
    el.addEventListener("click", onClick, true);
    if (doubleClickReset) el.addEventListener("dblclick", onDouble);
    return () => {
      clearTimeout(saveTimer);
      el.removeEventListener("dblclick", onDouble);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointermove", onMove, true);
      el.removeEventListener("pointerup", onUp, true);
      el.removeEventListener("pointercancel", onUp, true);
      el.removeEventListener("click", onClick, true);
      setDragging(false);
    };
  }, [ref, enabled, storageKey, put, touch, doubleClickReset]);

  return { view, reset, dragging, setFigure };
}
