import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "../../lib/back";
import { usePhone } from "../../lib/device";

type Pos = {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

/**
 * A small info popover: opens on hover with a mouse, on tap with touch.
 * Clicking (desktop) pins it open until the next click / outside click / Esc.
 * Rendered in a portal, above or below the trigger — wherever there's room. On a phone, a sheet from the bottom: the
 * panels are wider than what is left beside a trigger in the middle of a bar.
 */
export default function HoverPopover({
  trigger,
  children,
  onOpen,
  align = "end",
  triggerClassName = "",
  panelClassName = "",
  label,
  triggerStyle,
}: {
  trigger: ReactNode;
  children: ReactNode | (() => ReactNode);
  onOpen?: () => void;
  align?: "start" | "end";
  triggerClassName?: string;
  panelClassName?: string;
  label?: string; // accessible name of the trigger
  triggerStyle?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const sheet = usePhone();

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
    const p: Pos = {
      maxHeight: Math.max(48, (above ? r.top : vh - r.bottom) - 14),
    };
    if (above) p.bottom = vh - r.top + 6;
    else p.top = r.bottom + 6;
    if (align === "end") p.right = Math.max(8, vw - r.right);
    else p.left = Math.max(8, Math.min(r.left, vw - 288)); // start-aligned panels are <= 280px wide
    setPos(p);
  };
  useLayoutEffect(() => {
    if (open && !sheet) place();
    else setPos(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, align, sheet]);
  // (its width is only known now: hanging from a trigger near the left edge, it would run off the screen)
  useLayoutEffect(() => {
    if (!panel.current || pos?.right === undefined) return;
    if (panel.current.getBoundingClientRect().left < 8) setPos({ ...pos, right: undefined, left: 8 });
  }, [pos]);

  useEffect(() => {
    if (!open || sheet) return; // (a sheet: its own backdrop closes it, and a tap there must not reach what is below)
    const outside = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || btn.current?.contains(t)) return;
      close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        btn.current?.focus();
        close();
      }
    };
    const moved = (e: Event) => {
      if (
        panel.current &&
        e.target instanceof Node &&
        panel.current.contains(e.target)
      )
        return;
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
  }, [open, sheet]);

  useEffect(() => {
    if (!open || !sheet) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet]);

  const blur = (e: React.FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && (btn.current?.contains(next) || panel.current?.contains(next))) return;
    close();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-hover-popover
        className={triggerClassName}
        style={triggerStyle}
        onFocus={sheet ? undefined : show}
        onBlur={sheet ? undefined : blur}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            show();
            setPinned(true);
            requestAnimationFrame(() =>
              panel.current?.querySelector<HTMLElement>("button,a")?.focus(),
            );
          }
        }}
        onPointerEnter={(e) => e.pointerType === "mouse" && !sheet && show()}
        onPointerLeave={(e) => e.pointerType === "mouse" && !sheet && hideSoon()}
        onClick={() => {
          if (open && pinned) return close();
          show();
          setPinned(true);
        }}
      >
        {trigger}
      </button>
      {open &&
        sheet &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-end bg-scrim/45 animate-fade-in"
            onClick={(e) => e.target === e.currentTarget && close()}
            data-testid="popover-sheet"
          >
            <div
              ref={panel}
              role="dialog"
              aria-label={label}
              className="max-h-[80vh] w-full overflow-y-auto rounded-t-2xl border-t border-border bg-surface-2 pb-safe pt-1.5 shadow-float"
            >
              <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-border-strong" />
              {/* (the panels are sized for the popover) */}
              <div className="[&>*]:!w-full [&>*]:!max-w-none">{typeof children === "function" ? children() : children}</div>
            </div>
          </div>,
          document.body,
        )}
      {open &&
        !sheet &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            onBlur={blur}
            aria-label={label}
            style={pos}
            onPointerEnter={(e) =>
              e.pointerType === "mouse" && clearTimeout(timer.current)
            }
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
