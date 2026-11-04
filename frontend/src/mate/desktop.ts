/**
 * The desktop app's Mate bridge (`window.hrhNative.mate`, desktop/src/preload.js, docs/mate.md §7) and a hook for its
 * state. Absent in browsers and on Android: every helper here is a no-op there.
 */
import { useEffect, useState } from "react";

export interface DesktopMateState {
  visible: boolean;
  clickThrough: boolean;
  mateId: string | null;
  hotkey: string;
  hotkeyBound?: boolean;
  autostart: boolean;
  moveMode?: boolean;
  chatOpen?: boolean;
  chatOnTop?: boolean;
}

export type DesktopCommand = { type: string; [k: string]: unknown };

export interface MateBridge {
  showAvatar(mateId?: string): Promise<void>;
  hideAvatar(): Promise<void>;
  setClickThrough(on: boolean): Promise<void>;
  getState(): Promise<DesktopMateState>;
  moveBy(dx: number, dy: number): void;
  moveEnd(): void;
  setAvatarSize(w: number, h: number): void;
  setSize(w: number, h: number): void;
  /** move mode: resize the avatar window from an edge / corner ("n", "se", …) — desktop 0.4.1+ */
  resizeBy?(edge: string, dx: number, dy: number): void;
  resizeEnd?(): void;
  /** the quick card holds a draft: a click elsewhere leaves it open — desktop 0.4.1+ */
  setQuickPinned?(on: boolean): void;
  setMoveMode(on: boolean): Promise<void>;
  openQuick(): Promise<void>;
  closeQuick(): Promise<void>;
  screenHandled?(): Promise<void>;
  openChat(): Promise<void>;
  closeChat(): Promise<void>;
  setChatOnTop(on: boolean): Promise<void>;
  openConsole(url?: string): Promise<void>;
  setMate(mateId: string): Promise<void>;
  setHotkey(accel: string): Promise<boolean>;
  setAutostart(on: boolean): Promise<void>;
  /** The overlay reports its selected mate's saved reply-reading state to the local toolbar. */
  voiceState?(state: { mateId: string; enabled: boolean; available: boolean; busy: boolean } | null): void;
  onCommand(cb: (cmd: DesktopCommand) => void): () => void;
}

export const desktopMate = (): MateBridge | null => (typeof window !== "undefined" && window.hrhNative?.mate) || null;

/** which window this page is: the desktop says so; a browser page knows it from ?surface= */
export function currentSurface(): string {
  const native = typeof window !== "undefined" ? window.hrhNative?.surface : undefined;
  if (native) return native;
  const q = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("surface") : null;
  return q || "console";
}

/** the desktop Mate state, kept current by `state` commands (null outside the desktop app) */
export function useDesktopMate(onCommand?: (cmd: DesktopCommand) => void): DesktopMateState | null {
  const [state, setState] = useState<DesktopMateState | null>(null);
  useEffect(() => {
    const m = desktopMate();
    if (!m) return;
    let alive = true;
    m.getState()
      .then((s) => alive && setState(s))
      .catch(() => {});
    const off = m.onCommand((cmd) => {
      if (cmd.type === "state") {
        const { type: _t, ...rest } = cmd;
        setState(rest as unknown as DesktopMateState);
      }
      onCommand?.(cmd);
    });
    return () => {
      alive = false;
      off();
    };
    // (onCommand: the caller's latest is read through a ref by the callers that need it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

/**
 * Speech recognition in the page: Web Speech exists in Chrome/Edge/Safari but not in Electron nor the Android
 * WebView (the constructor may be there and fail with "network"/"not-allowed"), so it is offered only in a browser.
 */
export function webSpeechRecognition(): (new () => any) | null {
  if (typeof window === "undefined") return null;
  if (window.hrhNative) return null; // desktop app or Android shell
  if (/Electron|; wv\)/.test(navigator.userAgent)) return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}
