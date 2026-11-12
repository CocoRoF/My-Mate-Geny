/**
 * The user's pan / zoom of an avatar inside its box (Geny's Live2DCanvas view: drag pans, the wheel zooms around the
 * pointer, persisted under a view storage key, a reset). One transform for every body: a point q of the box is drawn
 * at `t + z·q` (t = x·width, y·height — fractions of the box, so a resized window keeps the framing). Video and photo
 * bodies get it as a CSS transform (origin 0 0); Live2D applies the same mapping inside its renderer (crisp at any
 * zoom). The desktop overlay (surfaces/MateSurfaces.tsx) and the console's Mate stage (MateStage.tsx) each keep their
 * own, per mate.
 */
import { useCallback, useEffect, useRef, useState } from "react";

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

/** keep at least a quarter of the zoomed avatar inside the box (it can never be panned out of reach) */
export function clampView(v: AvatarViewT): AvatarViewT {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(v.z) ? v.z : 1));
  const lim = (t: number) => {
    // the content spans [t, t + z] (fractions); require overlap with [0, 1] of ≥ min(z, 1) / 4
    const keep = Math.min(z, 1) / 4;
    return Math.min(1 - keep, Math.max(keep - z, Number.isFinite(t) ? t : 0));
  };
  return { x: lim(v.x), y: lim(v.y), z };
}

/** zoom by a wheel delta around the pointer at (px, py) (fractions of the box): the point under it stays put */
export function zoomAt(v: AvatarViewT, deltaY: number, px: number, py: number, speed = NOTCH_SPEED): AvatarViewT {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * Math.exp(-deltaY * speed)));
  if (z === v.z) return v;
  const r = z / v.z;
  return clampView({ x: px - (px - v.x) * r, y: py - (py - v.y) * r, z });
}

export function readView(key: string | null): AvatarViewT {
  if (!key) return VIEW_HOME;
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    if (v && typeof v.x === "number" && typeof v.y === "number" && typeof v.z === "number") return clampView(v);
  } catch {
    /* corrupt / unavailable */
  }
  return VIEW_HOME;
}

function writeView(key: string | null, v: AvatarViewT) {
  if (!key) return;
  try {
    if (isHome(v)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) }));
  } catch {
    /* private mode */
  }
}

/** the CSS transform for the video / photo bodies, on a layer that fills the box (transform-origin 0 0): translate %
 *  is of that layer, i.e. of the box */
export const viewTransform = (v: AvatarViewT) =>
  isHome(v) ? undefined : `translate(${(v.x * 100).toFixed(3)}%, ${(v.y * 100).toFixed(3)}%) scale(${v.z.toFixed(4)})`;

/**
 * Pan / zoom gestures on `ref`'s element while `enabled`: a left-button drag past DRAG_PX pans (the click that follows
 * is swallowed, so a drag is never also a tap), the wheel zooms around the pointer. Persisted under `storageKey` (per
 * mate); `reset()` goes back to the fitted view. Other windows with the same key follow (the storage event).
 * `touch: false` leaves a finger alone (a phone's page scrolls, a tap pokes her); `doubleClickReset`: a double click
 * goes back to the fitted view (the console's stage).
 */
export function useAvatarView(
  ref: React.RefObject<HTMLElement | null>,
  storageKey: string | null,
  enabled: boolean,
  { touch = true, doubleClickReset = false }: { touch?: boolean; doubleClickReset?: boolean } = {},
) {
  const [view, setView] = useState<AvatarViewT>(() => readView(storageKey));
  const viewRef = useRef(view);
  viewRef.current = view;
  const [dragging, setDragging] = useState(false);

  useEffect(() => setView(readView(storageKey)), [storageKey]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === storageKey && setView(readView(storageKey));
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  const put = useCallback(
    (v: AvatarViewT, save: boolean) => {
      viewRef.current = v;
      setView(v);
      if (save) writeView(storageKey, v);
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
      const next = zoomAt(viewRef.current, delta, p.x, p.y, speed);
      if (next === viewRef.current) return;
      put(next, false);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => writeView(storageKey, viewRef.current), 250);
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
      put(clampView({ x: d.vx + dx / r.width, y: d.vy + dy / r.height, z: viewRef.current.z }), false);
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
      writeView(storageKey, viewRef.current);
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

  return { view, reset, dragging };
}
