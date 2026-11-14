/**
 * A row that scrolls sideways (tabs, steps, chips that don't fit) — the one way every such row in the app scrolls: no
 * scrollbar, the mouse wheel scrolls it, a mouse drag pulls it (a press that doesn't move stays a click), a fade at an
 * edge that has more, and the selected child (aria-selected / data-active / aria-current) is scrolled into view when
 * `watch` changes. Touch scrolls it natively. It never moves up and down (a child a pixel taller — a tab's underline
 * over the row's border — made the wheel at an end nudge the whole row), and the wheel over a row that scrolls stays
 * with it at its ends too: nothing else jumps when it runs out. `drag={false}`: no pulling (a row whose children are
 * dragged themselves, the file tabs).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

const DRAG_PX = 5; // below this a press is still a click
const FADE = 28; // px
const SELECTED = '[aria-selected="true"], [data-active="true"], [aria-current]:not([aria-current="false"])';

export default function ScrollRow({
  children,
  className = "",
  watch,
  as: Tag = "div",
  drag: pull = true,
  ...rest
}: { children: ReactNode; className?: string; watch?: unknown; as?: "div" | "ol" | "ul"; drag?: boolean } & Omit<HTMLAttributes<HTMLElement>, "children" | "className">) {
  const ref = useRef<HTMLElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const shown = useRef(edges);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const left = el.scrollLeft > 1;
    const right = max > 1 && el.scrollLeft < max - 1;
    // (only a real change is an update: a setState per render — even one that keeps the same value — is scheduled
    // work, and with the parent rendering again it ran into React's nested-update limit)
    if (shown.current.left === left && shown.current.right === right) return;
    shown.current = { left, right };
    setEdges(shown.current);
  }, []);

  // (children come and go with a render: the fades follow)
  useLayoutEffect(measure);

  // the selected one in view (only this row moves: scrollIntoView would scroll the page too)
  useLayoutEffect(() => {
    const el = ref.current;
    const sel = el?.querySelector<HTMLElement>(SELECTED);
    if (!el || !sel || el.scrollWidth <= el.clientWidth) return measure();
    const b = el.getBoundingClientRect();
    const c = sel.getBoundingClientRect();
    if (c.left < b.left + FADE) el.scrollLeft -= b.left + FADE - c.left;
    else if (c.right > b.right - FADE) el.scrollLeft += c.right - (b.right - FADE);
    measure();
  }, [watch, measure]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    for (const c of el.children) ro?.observe(c);
    // the wheel: up / down scrolls the row (a sideways swipe is the trackpad's own). A row with nothing to scroll lets
    // it through to the page; one that scrolls keeps it, at its ends too (no page jumping under the pointer)
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * el.clientWidth : e.deltaY;
      const next = Math.max(0, Math.min(max, el.scrollLeft + d));
      if (Math.abs(next - el.scrollLeft) >= 0.5) el.scrollLeft = next;
    };
    // a mouse drag pulls the row; the click that ends a drag is swallowed
    let drag: { id: number; x: number; left: number; moved: boolean } | null = null;
    let swallow = false;
    const onDown = (e: PointerEvent) => {
      if (!pull || e.pointerType !== "mouse" || e.button !== 0 || el.scrollWidth <= el.clientWidth) return;
      drag = { id: e.pointerId, x: e.clientX, left: el.scrollLeft, moved: false };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < DRAG_PX) return;
        drag.moved = true;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* optional */
        }
        el.style.cursor = "grabbing";
      }
      el.scrollLeft = drag.left - dx;
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      if (!moved) return;
      el.style.cursor = "";
      swallow = true;
      setTimeout(() => (swallow = false), 0);
    };
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("scroll", measure, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClick, true);
    return () => {
      ro?.disconnect();
      el.removeEventListener("scroll", measure);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onClick, true);
    };
  }, [measure, pull]);

  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${edges.left ? "transparent" : "#000"} 0, #000 ${edges.left ? FADE : 0}px, #000 calc(100% - ${edges.right ? FADE : 0}px), ${edges.right ? "transparent" : "#000"} 100%)`
      : undefined;
  return (
    <Tag
      ref={(el: HTMLElement | null) => {
        ref.current = el;
      }}
      {...rest}
      className={`no-scrollbar flex overflow-x-auto overflow-y-hidden overscroll-x-contain ${className}`}
      style={{ ...rest.style, maskImage: mask, WebkitMaskImage: mask }}
      data-scroll-row=""
    >
      {children}
    </Tag>
  );
}
