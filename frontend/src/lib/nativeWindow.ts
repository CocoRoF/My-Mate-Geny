/**
 * The desktop app's window chrome bridge (`window.hrhNative.window`, desktop/src/chrome.js + preload.js): present
 * only in the console and the mate chat window of a desktop app that draws no system title bar there. Then the page
 * draws its own title bar (components/layout/TitleBar.tsx) and says so with <html data-hrh-chrome> — until it does,
 * the desktop app shows a plain fallback bar. Browsers, phones and older desktop apps: absent, nothing changes.
 */
import { useEffect, useState } from "react";

export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
}

export interface WindowBridge {
  /** "custom": draw minimize / maximize / close; "mac": the traffic lights are there (leave room on the left) */
  chrome: "custom" | "mac";
  kind?: string;
  platform?: string;
  initial?: WindowState;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  getState(): Promise<WindowState | null>;
  onState(cb: (s: WindowState) => void): () => void;
}

export const nativeWindow = (): WindowBridge | null => (typeof window !== "undefined" && window.hrhNative?.window) || null;

/** The page draws the title bar: the desktop app's fallback bar goes away. */
export function claimWindowChrome(): boolean {
  const w = nativeWindow();
  if (!w) return false;
  document.documentElement.dataset.hrhChrome = w.chrome;
  if (w.kind) document.documentElement.dataset.hrhWindow = w.kind; // (its bar's height: index.css --window-chrome-height)
  return true;
}

export function useWindowState(): WindowState {
  const w = nativeWindow();
  const [s, setS] = useState<WindowState>(() => w?.initial ?? { maximized: false, fullscreen: false, focused: true });
  useEffect(() => {
    if (!w) return;
    let alive = true;
    w.getState()
      .then((x) => alive && x && setS(x))
      .catch(() => {});
    const off = w.onState((x) => setS(x));
    return () => {
      alive = false;
      off();
    };
  }, [w]);
  return s;
}

/** -webkit-app-region: the area that moves the window (double-click maximizes — the OS does it) and what does not */
export const DRAG = { WebkitAppRegion: "drag" } as React.CSSProperties;
export const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
