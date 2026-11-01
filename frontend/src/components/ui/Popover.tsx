import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "../../lib/back";
import { isTouchFirst } from "../../lib/device";

type Pos = { top: number; left?: number; right?: number; width?: number; maxHeight: number };

/**
 * A click-opened panel anchored under a trigger (the top bar's Folder / Git buttons).
 * Esc, a click / tap elsewhere and the back button close it; focus moves in on open (a `data-autofocus` field, else
 * the panel) and back to the trigger after Esc. Phones: the full width under the bar. Rendered in a portal (the bar uses backdrop-filter).
 */
export default function Popover({
  open,
  onClose,
  anchor,
  label,
  width = 380,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement>;
  label: string;
  width?: number;
  children: ReactNode;
  testId?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useBackHandler(open, () => closeRef.current());

  const place = () => {
    const a = anchor.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = Math.round(r.bottom + 6);
    const maxHeight = Math.max(200, vh - top - 10);
    if (vw < 640) return setPos({ top, left: 8, right: 8, maxHeight });
    const w = Math.min(width, vw - 16);
    // right edge under the trigger's right edge, kept on screen
    const right = Math.max(8, Math.min(vw - r.right, vw - w - 8));
    setPos({ top, right, width: w, maxHeight });
  };

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      closeRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.stopPropagation();
        closeRef.current();
        anchor.current?.focus({ preventScroll: true }); // keyboard users land back on the button
      }
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("touchstart", outside);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("touchstart", outside);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", place);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // focus in on open (the first field, else the panel), back to the trigger on close
  useEffect(() => {
    if (!open || !pos) return;
    const p = panel.current;
    if (!p || p.contains(document.activeElement)) return;
    // (not on touch screens: a focused field would pop the keyboard up over the panel)
    const first = (!isTouchFirst() && p.querySelector<HTMLElement>("[data-autofocus]")) || p;
    first.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!pos]);
  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-testid={testId}
      style={pos}
      className="fixed z-[70] flex flex-col overflow-hidden rounded-xl border border-border bg-surface-2 shadow-float outline-none animate-fade-in"
    >
      {children}
    </div>,
    document.body,
  );
}
