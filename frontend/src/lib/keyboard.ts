/**
 * The on-screen keyboard on phones and tablets.
 *
 * How the page learns about it differs:
 * - the Android app (adjustResize + Capacitor's SystemBars padding) and Chrome on Android (the viewport meta's
 *   `interactive-widget=resizes-content`) shrink the layout viewport: `innerHeight` and `100dvh` follow;
 * - other browsers (iOS Safari, older Chrome) leave the layout viewport alone and only shrink the visual viewport,
 *   so a `100dvh` page would sit half under the keyboard.
 *
 * Either way the visual viewport is what is visible. The keyboard counts as open when a text field has focus and
 * the visible height is well below the tallest height seen at this width (rotation / window resizes reset that).
 * While it is open:
 * - `<html data-keyboard="open">`;
 * - `--app-h` is the visible height when the layout viewport didn't shrink by itself (the app shell uses it
 *   instead of 100dvh), so the composer and the last message stay above the keyboard everywhere.
 */
import { useSyncExternalStore } from "react";

/** less than this (CSS px) is browser chrome (an address bar sliding away), not a keyboard */
const MIN_KEYBOARD = 120;

let open = false;
let tallest = 0;
let width = 0;
const listeners = new Set<() => void>();

function editableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
}

function update() {
  const vv = window.visualViewport;
  // pinch-zoomed: the visual viewport says nothing about a keyboard
  if (vv && vv.scale > 1.05) return;
  const visible = vv ? vv.height : window.innerHeight;
  if (window.innerWidth !== width) {
    width = window.innerWidth;
    tallest = 0;
  }
  tallest = Math.max(tallest, window.innerHeight, visible);
  const next = editableFocused() && tallest - visible > MIN_KEYBOARD;
  const root = document.documentElement;
  // the layout viewport stayed tall (iOS Safari…): size the app to what is visible
  if (next && window.innerHeight - visible > 40) {
    root.style.setProperty("--app-h", `${Math.round(visible)}px`);
    // (Safari scrolls the page to show the field; the shell now fits, so put it back)
    if (window.scrollY) window.scrollTo(0, 0);
  } else root.style.removeProperty("--app-h");
  if (next === open) return;
  open = next;
  if (open) root.dataset.keyboard = "open";
  else delete root.dataset.keyboard;
  listeners.forEach((l) => l());
}

let started = false;
function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  width = window.innerWidth;
  tallest = window.innerHeight;
  // focus moves before the viewport does (and the other way round on close): check on both, and once more after
  // the keyboard's animation for browsers that report the final size late
  const later = () => {
    update();
    setTimeout(update, 350);
  };
  window.visualViewport?.addEventListener("resize", update);
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", later);
  document.addEventListener("focusin", later);
  document.addEventListener("focusout", later);
  update();
}

/** true while the on-screen keyboard is up (see the top of this file) */
export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      start();
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => open,
    () => false,
  );
}

/** start watching right away (the app shell's `--app-h` must work before any component asks) */
export function watchKeyboard() {
  start();
}
