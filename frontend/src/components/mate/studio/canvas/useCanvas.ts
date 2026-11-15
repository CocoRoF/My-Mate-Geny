/**
 * The studio canvas's camera: the world (the graph) moves and scales inside the canvas, the dot paper with it.
 * The wheel zooms where the pointer is (ctrl+wheel = a trackpad pinch); a sideways swipe pans; one pointer drags from
 * anywhere (past 5 px it stops being a click); two pinch; arrows move, + / - zoom, 0 fits. It fits itself while the
 * user hasn't moved it (the chat folding, the window changing) and glides to what the agent works on — unless the
 * user touched it a moment ago.
 */
import { useCallback, useEffect, useRef, type RefObject } from "react";

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 1.6;
/** the fit never goes below this: the words stay readable, the rest is a drag away */
const FIT_MIN = 0.8;
const FIT_MIN_NARROW = 0.68;
/** at most this much room above the graph when it fits: it stands at the top, not in the middle */
const FIT_TOP = 12;
/** a user who just moved the canvas is not moved by the agent (ms) */
export const HANDS_OFF_MS = 6000;
const DOT = 22;

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export interface CanvasView {
  canvas: RefObject<HTMLDivElement>;
  world: RefObject<HTMLDivElement>;
  fit: () => void;
  zoomBy: (k: number) => void;
  /** bring a node into view (unless the user just moved the canvas) */
  focus: (key: string, force?: boolean) => void;
  /** the current scale (the lines are measured in world units) */
  scale: () => number;
}

export function useCanvas(): CanvasView {
  const canvas = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const cam = useRef({ x: 0, y: 0, z: 1 });
  const touched = useRef(0);
  const moved = useRef(false);

  const apply = useCallback(() => {
    const { x, y, z } = cam.current;
    if (world.current) world.current.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    const c = canvas.current;
    if (c) {
      c.style.backgroundSize = `${DOT * z}px ${DOT * z}px`;
      c.style.backgroundPosition = `${x}px ${y}px`;
      c.dataset.zoom = z.toFixed(2);
    }
  }, []);

  const glide = useCallback((on: boolean) => {
    world.current?.classList.toggle("is-gliding", on && !reduced());
  }, []);

  const fit = useCallback(() => {
    const c = canvas.current;
    const w = world.current;
    if (!c || !w || !w.offsetWidth) return;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    const least = cw < 760 ? FIT_MIN_NARROW : FIT_MIN;
    const z = Math.min(1, Math.max(least, Math.min(cw / w.offsetWidth, ch / w.offsetHeight)));
    const ww = w.offsetWidth * z;
    const wh = w.offsetHeight * z;
    cam.current = { x: ww <= cw ? (cw - ww) / 2 : 8, y: wh <= ch ? Math.min(FIT_TOP, (ch - wh) / 2) : 4, z };
    moved.current = false;
    apply();
  }, [apply]);

  const zoomAt = useCallback(
    (k: number, px: number, py: number) => {
      const { x, y, z } = cam.current;
      const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * k));
      cam.current = { x: px - ((px - x) * nz) / z, y: py - ((py - y) * nz) / z, z: nz };
      moved.current = true;
      touched.current = Date.now();
      apply();
    },
    [apply],
  );

  const focus = useCallback(
    (key: string, force = false) => {
      const c = canvas.current;
      const w = world.current;
      if (!c || !w || (!force && Date.now() - touched.current < HANDS_OFF_MS)) return;
      const el = w.querySelector<HTMLElement>(`[data-g="${CSS.escape(key)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      if (!force && r.left >= cr.left + 8 && r.right <= cr.right - 8 && r.top >= cr.top + 8 && r.bottom <= cr.bottom - 8) return;
      const { x, y, z } = cam.current;
      const wx = (r.left - cr.left - x) / z + r.width / z / 2;
      const wy = (r.top - cr.top - y) / z + r.height / z / 2;
      cam.current = { x: cr.width / 2 - wx * z, y: cr.height / 2 - wy * z, z };
      moved.current = true;
      glide(true);
      apply();
      window.setTimeout(() => glide(false), 520);
    },
    [apply, glide],
  );

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      if (!moved.current) fit();
    });
    ro.observe(c);
    if (world.current) ro.observe(world.current);

    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest("[data-scroll]")) return; // (a list inside a node scrolls itself)
      e.preventDefault();
      glide(false);
      const r = c.getBoundingClientRect();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) {
        cam.current.x -= e.deltaX;
        moved.current = true;
        touched.current = Date.now();
        apply();
        return;
      }
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      zoomAt(Math.exp(-px * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX - r.left, e.clientY - r.top);
    };
    c.addEventListener("wheel", wheel, { passive: false });

    const pts = new Map<number, { x: number; y: number }>();
    let dragging = false;
    let start = { x: 0, y: 0 };
    let pinch = 0;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest("input,textarea,select,video,[data-nodrag]")) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        start = { x: e.clientX, y: e.clientY };
        dragging = false;
      }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = c.getBoundingClientRect();
        if (pinch) zoomAt(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        pinch = d;
        dragging = true;
        return;
      }
      if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
      if (!dragging) {
        dragging = true;
        glide(false);
        try {
          c.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is gone */
        }
        c.classList.add("is-dragging");
      }
      cam.current.x += e.clientX - prev.x;
      cam.current.y += e.clientY - prev.y;
      moved.current = true;
      touched.current = Date.now();
      apply();
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (!pts.size) c.classList.remove("is-dragging");
    };
    // a drag that ends on a node is not a click on it
    const click = (e: MouseEvent) => {
      if (dragging) {
        e.preventDefault();
        e.stopPropagation();
        dragging = false;
      }
    };
    const key = (e: KeyboardEvent) => {
      if ((e.target as Element).closest("input,textarea,select")) return;
      const step = 80;
      const r = c.getBoundingClientRect();
      if (e.key === "ArrowLeft") cam.current.x += step;
      else if (e.key === "ArrowRight") cam.current.x -= step;
      else if (e.key === "ArrowUp") cam.current.y += step;
      else if (e.key === "ArrowDown") cam.current.y -= step;
      else if (e.key === "+" || e.key === "=") return zoomAt(1.15, r.width / 2, r.height / 2);
      else if (e.key === "-") return zoomAt(1 / 1.15, r.width / 2, r.height / 2);
      else if (e.key === "0") return fit();
      else return;
      e.preventDefault();
      moved.current = true;
      touched.current = Date.now();
      apply();
    };
    const focusin = (e: FocusEvent) => {
      const el = (e.target as Element).closest?.("[data-g]");
      if (!el || !(e.target as Element).matches(":focus-visible")) return;
      focus(el.getAttribute("data-g") || "", true);
    };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("click", click, true);
    c.addEventListener("keydown", key);
    c.addEventListener("focusin", focusin);
    return () => {
      ro.disconnect();
      c.removeEventListener("wheel", wheel);
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
      c.removeEventListener("click", click, true);
      c.removeEventListener("keydown", key);
      c.removeEventListener("focusin", focusin);
    };
  }, [apply, fit, focus, glide, zoomAt]);

  const zoomBy = useCallback(
    (k: number) => {
      const c = canvas.current;
      if (c) zoomAt(k, c.clientWidth / 2, c.clientHeight / 2);
    },
    [zoomAt],
  );
  const scale = useCallback(() => cam.current.z, []);
  return { canvas, world, fit, zoomBy, focus, scale };
}
