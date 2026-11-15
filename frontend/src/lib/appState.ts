/**
 * Whether the app is in front. In the Android app the activity's own state counts (Capacitor's appStateChange, heard in
 * native.ts): another app in front, the app closed and the screen turned off all mean away — even where the WebView
 * would still call its page visible. Elsewhere: the page's visibility.
 *
 * On the phone, away means quiet (docs/mate-calls.md "On Android"): a reply being read aloud stops and none starts, and
 * nothing else keeps running for the page — except a call, which goes on with the screen off.
 */
import { useSyncExternalStore } from "react";

let active = true;
const listeners = new Set<() => void>();

/** the Android app (the page inside it) */
export const onPhone = (): boolean => typeof window !== "undefined" && window.hrhNative?.platform === "android";

/** in front: the app's activity (the phone) and the page itself */
export function appActive(): boolean {
  return active && (typeof document === "undefined" || document.visibilityState === "visible");
}

/** the phone app's activity came to the front / went away (native.ts) */
export function setAppActive(on: boolean): void {
  if (on === active) return;
  active = on;
  listeners.forEach((l) => l());
}

export function onAppActive(cb: () => void): () => void {
  listeners.add(cb);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", cb);
  return () => {
    listeners.delete(cb);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", cb);
  };
}

export function useAppActive(): boolean {
  return useSyncExternalStore(onAppActive, appActive, () => true);
}
