import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "../../lib/back";

type Pos = { left?: number; right?: number; top?: number; bottom?: number; maxHeight: number };

/**
 * A small info popover: opens on hover with a mouse, on tap with touch.
 * Clicking (desktop) pins it open until the next click / outside click / Esc.
 * Rendered in a portal, above or below the trigger — wherever there's room.
 */
export default function HoverPopover({
  trigger,
  children,
  onOpen,
  align = "end",
  triggerClassName = "",
  panelClassName = "",
  label,
}: {
  trigger: ReactNode;
  children: ReactNode | (() => ReactNode);
  onOpen?: () => void;
  align?: "start" | "end";
  triggerClassName?: string;
  panelClassName?: string;
  label?: string; // accessible name of the trigger
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const close = () => {
    clearTimeout(timer.current);
    setOpen(false);
    setPinned(false);
  };
  const show = () => {
    clearTimeout(timer.current);
    if (!open) {
      setOpen(true);
      onOpen?.();
    }
  };
  const hideSoon = () => {
    clearTimeout(timer.current);
    if (!pinned) timer.current = setTimeout(() => setOpen(false), 180);
  };
  useBackHandler(open, close);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Anchor to the trigger; re-anchored on scroll/resize (the chat keeps
  // scrolling while a turn streams), closed once the trigger leaves the screen.
  const place = () => {
    if (!btn.current) return setPos(null);
    const r = btn.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh) return close();
    const above = r.top > vh - r.bottom;
    const p: Pos = { maxHeight: Math.max(160, (above ? r.top : vh - r.bottom) - 14) };
    if (above) p.bottom = vh - r.top + 6;
    else p.top = r.bottom + 6;
    if (align === "end") p.right = Math.max(8, vw - r.right);
    else p.left = Math.max(8, Math.min(r.left, vw - 288)); // start-aligned panels are <= 280px wide
    setPos(p);
  };
  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || btn.current?.contains(t)) return;
      close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    const moved = (e: Event) => {
      if (panel.current && e.target instanceof Node && panel.current.contains(e.target)) return;
      place();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("touchstart", outside);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("touchstart", outside);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-expanded={open}
        className={triggerClassName}
        onPointerEnter={(e) => e.pointerType === "mouse" && show()}
        onPointerLeave={(e) => e.pointerType === "mouse" && hideSoon()}
        onClick={() => {
          if (open && pinned) return close();
          show();
          setPinned(true);
        }}
      >
        {trigger}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            style={pos}
            onPointerEnter={(e) => e.pointerType === "mouse" && clearTimeout(timer.current)}
            onPointerLeave={(e) => e.pointerType === "mouse" && hideSoon()}
            className={`fixed z-[70] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-border bg-surface-2 shadow-float animate-fade-in ${panelClassName}`}
          >
            {typeof children === "function" ? children() : children}
          </div>,
          document.body,
        )}
    </>
  );
}
