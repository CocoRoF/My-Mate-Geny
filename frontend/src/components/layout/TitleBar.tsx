/**
 * The desktop app's own title bar (no system frame — lib/nativeWindow.ts, desktop/src/chrome.js): the background
 * moves the window (double-click maximizes / restores: the OS does it for a drag area), the buttons minimize,
 * maximize-restore and close. macOS keeps its traffic lights: room is left for them, no buttons are drawn.
 * Rendered only inside the desktop app — browsers and phones never see any of this.
 */
import type { ReactNode } from "react";
import { DRAG, NO_DRAG, nativeWindow, useWindowState, type WindowBridge } from "../../lib/nativeWindow";

const Glyph = {
  min: <path d="M0 5.5h10" />,
  max: <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />,
  restore: (
    <>
      <rect x="0.5" y="2.5" width="7" height="7" rx="1.25" />
      <path d="M2.5 2.5V2a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 9.5 2v4A1.5 1.5 0 0 1 8 7.5h-.5" />
    </>
  ),
  close: <path d="M0.75 0.75l8.5 8.5M9.25 0.75l-8.5 8.5" />,
};

function G({ children }: { children: ReactNode }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden>
      {children}
    </svg>
  );
}

/** minimize · maximize/restore · close — Windows / Linux (macOS: the traffic lights) */
export function WindowControls({ w, height = 36, className = "" }: { w: WindowBridge; height?: number; className?: string }) {
  const st = useWindowState();
  if (w.chrome === "mac") return null;
  const big = st.maximized || st.fullscreen;
  const base = "grid w-[46px] place-items-center text-content-dim transition-colors duration-100 focus-visible:outline-none focus-visible:bg-surface-3";
  return (
    <div className={`flex shrink-0 self-stretch ${className}`} style={NO_DRAG} data-testid="window-controls">
      <button className={`${base} hover:bg-surface-3 hover:text-content`} style={{ height }} onClick={() => w.minimize()} title="Minimize" aria-label="Minimize" data-testid="window-min">
        <G>{Glyph.min}</G>
      </button>
      <button
        className={`${base} hover:bg-surface-3 hover:text-content`}
        style={{ height }}
        onClick={() => w.toggleMaximize()}
        title={big ? "Restore" : "Maximize"}
        aria-label={big ? "Restore" : "Maximize"}
        data-testid="window-max"
        data-maximized={big ? "true" : "false"}
      >
        <G>{big ? Glyph.restore : Glyph.max}</G>
      </button>
      <button className={`${base} hover:bg-[#e5484d] hover:text-white`} style={{ height }} onClick={() => w.close()} title="Close" aria-label="Close" data-testid="window-close">
        <G>{Glyph.close}</G>
      </button>
    </div>
  );
}

/** The console window's slim title bar: brand · what is open · window buttons. */
export default function TitleBar({ context }: { context?: string }) {
  const w = nativeWindow();
  const st = useWindowState();
  if (!w) return null;
  const mac = w.chrome === "mac";
  return (
    <header
      className={`relative z-[100] flex h-9 shrink-0 select-none items-center border-b border-border/70 bg-surface/95 backdrop-blur-xl transition-colors ${
        st.focused ? "text-content-dim" : "text-content-faint"
      }`}
      style={DRAG}
      data-testid="title-bar"
      data-region="drag"
    >
      <div className={`flex min-w-0 flex-1 items-center gap-2 ${mac ? "pl-[78px]" : "pl-3"}`}>
        <img src="/logo.png" alt="" width={16} height={16} className={`h-4 w-4 shrink-0 transition-opacity ${st.focused ? "" : "opacity-60"}`} draggable={false} />
        <span className="shrink-0 text-[12px] font-medium tracking-tight">My Mate Geny</span>
        {context && (
          <>
            <span className="h-3 w-px shrink-0 bg-border-strong" />
            <span className="min-w-0 truncate text-[12px] text-content-faint" data-testid="title-bar-context">
              {context}
            </span>
          </>
        )}
      </div>
      <WindowControls w={w} height={35} />
    </header>
  );
}
