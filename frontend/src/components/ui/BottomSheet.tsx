import { useEffect, useRef, type MutableRefObject, type ReactNode, type RefObject } from "react";

/** How far (px, at most: a third of a small sheet will do) or how fast (px/ms) it has to be pulled to go; else it comes back */
const FAR = 110;
const FAST = 0.6;
const LEAVE_MS = 180;
/** A finger has to move this much (px) before it counts as a pull and not a tap */
const SLOP = 6;

/**
 * A sheet from the bottom of a phone's screen, with the handle it needs to go the way it looks like it goes: pull it
 * down (by the handle, or anywhere while it isn't scrolled) and it leaves; let go early and it comes back. A tap on the
 * backdrop closes it. The caller renders it in a portal.
 */
export default function BottomSheet({
  onClose,
  label,
  testId,
  panelRef,
  children,
}: {
  onClose: () => void;
  label?: string;
  testId?: string;
  panelRef?: RefObject<HTMLDivElement>;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = panel.current;
    const bg = scrim.current;
    if (!el || !bg) return;
    let armed = false;
    let pulling = false;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let lastAt = 0;
    let speed = 0;
    let leaving: ReturnType<typeof setTimeout> | undefined;

    const show = (y: number, animate: boolean) => {
      const transition = animate ? `${LEAVE_MS}ms ease-out` : "";
      el.style.transition = transition && `transform ${transition}`;
      bg.style.transition = transition && `opacity ${transition}`;
      el.style.transform = y ? `translateY(${y}px)` : "";
      bg.style.opacity = y ? String(Math.max(0, 1 - y / el.offsetHeight)) : "";
    };
    // (not a field, nor anything inside that is scrolled: the finger is about that)
    const free = (target: EventTarget | null) => {
      for (let n = target as HTMLElement | null; n && n !== el.parentElement; n = n.parentElement) {
        if (n.scrollTop > 0 || n.matches("input, textarea, select")) return false;
      }
      return true;
    };
    const begin = (x: number, y: number, target: EventTarget | null) => {
      armed = (target as HTMLElement | null)?.closest?.("[data-sheet-handle]") != null || free(target);
      pulling = false;
      startX = x;
      startY = lastY = y;
      lastAt = performance.now();
      speed = 0;
    };
    /** -> whether this move is the sheet's */
    const pull = (x: number, y: number) => {
      if (!armed) return false;
      if (!pulling) {
        const down = y - startY;
        if (Math.abs(down) < SLOP && Math.abs(x - startX) < SLOP) return false;
        if (down <= 0 || Math.abs(x - startX) > down) {
          armed = false;
          return false;
        }
        pulling = true;
        startY = y;
      }
      const at = performance.now();
      if (at > lastAt) speed = (y - lastY) / (at - lastAt);
      lastY = y;
      lastAt = at;
      show(Math.max(0, y - startY), false);
      return true;
    };
    const release = () => {
      if (!pulling) return;
      pulling = armed = false;
      if (lastY - startY > Math.min(FAR, el.offsetHeight * 0.3) || speed > FAST) {
        show(el.offsetHeight, true);
        leaving = setTimeout(() => closeRef.current(), LEAVE_MS);
      } else {
        show(0, true);
      }
    };

    const touchStart = (e: TouchEvent) => begin(e.touches[0].clientX, e.touches[0].clientY, e.target);
    const touchMove = (e: TouchEvent) => {
      if (pull(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) e.preventDefault();
    };
    // (a mouse has only the handle: a phone-sized desktop window has no finger)
    const mouseDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.("[data-sheet-handle]")) return;
      e.preventDefault();
      begin(e.clientX, e.clientY, e.target);
      const move = (m: MouseEvent) => void pull(m.clientX, m.clientY);
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        release();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchmove", touchMove, { passive: false });
    el.addEventListener("touchend", release);
    el.addEventListener("touchcancel", release);
    el.addEventListener("mousedown", mouseDown);
    return () => {
      clearTimeout(leaving);
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchmove", touchMove);
      el.removeEventListener("touchend", release);
      el.removeEventListener("touchcancel", release);
      el.removeEventListener("mousedown", mouseDown);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[70] flex items-end animate-fade-in" data-testid={testId}>
      <div ref={scrim} className="absolute inset-0 bg-scrim/45" onClick={onClose} data-testid="sheet-backdrop" />
      <div
        ref={(n) => {
          panel.current = n;
          if (panelRef) (panelRef as MutableRefObject<HTMLDivElement | null>).current = n;
        }}
        role="dialog"
        aria-label={label}
        className="no-scrollbar relative max-h-[80vh] w-full overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border bg-surface-2 pb-safe shadow-float"
      >
        <div data-sheet-handle className="sticky top-0 z-10 flex cursor-grab touch-none justify-center bg-surface-2 pb-2 pt-2.5" data-testid="sheet-handle">
          <div className="h-1 w-10 rounded-full bg-border-strong" />
        </div>
        {children}
      </div>
    </div>
  );
}
