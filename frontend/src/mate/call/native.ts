/**
 * The phone around a call (docs/mate-calls.md "On Android"): the Android app's GenyCall plugin
 * (mobile/android/…/GenyCallPlugin.java) puts the phone in call mode (earpiece or loudspeaker, the screen kept on) and
 * shows her ringing as a call notification when the app is in the background (a full-screen one on a locked phone).
 * Elsewhere: the screen is kept on with the Wake Lock API where there is one, and "speaker off" only turns her down.
 * Every call here is best effort: nothing fails a call.
 */

type Cap = {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
  nativePromise: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<any>;
  nativeCallback: (plugin: string, method: string, options: Record<string, unknown>, cb: (data: any) => void) => unknown;
};

const cap = (): Cap | null => {
  const c = (typeof window !== "undefined" ? (window as unknown as { Capacitor?: Cap }).Capacitor : undefined) ?? null;
  return c?.isNativePlatform?.() ? c : null;
};

/** the page runs in the Android app */
export const onAndroid = () => typeof window !== "undefined" && window.hrhNative?.platform === "android";

/** the app has the call plugin (an app from before calls doesn't) */
export function nativeCalls(): boolean {
  const c = cap();
  return !!c && onAndroid() && (c.isPluginAvailable?.("GenyCall") ?? false);
}

async function call(method: string, options: Record<string, unknown> = {}): Promise<boolean> {
  const c = cap();
  if (!c || !nativeCalls()) return false;
  try {
    await c.nativePromise("GenyCall", method, options);
    return true;
  } catch {
    return false;
  }
}

let wake: { release: () => Promise<void> } | null = null;
let wakeWanted = false;
const onVisible = () => {
  if (wakeWanted && document.visibilityState === "visible" && !wake) void keepScreenOn(true);
};

/** keep the screen on (the Wake Lock API: the plugin does it in the app) */
export async function keepScreenOn(on: boolean): Promise<void> {
  wakeWanted = on;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisible);
    if (on) document.addEventListener("visibilitychange", onVisible);
  }
  if (!on) {
    const w = wake;
    wake = null;
    await w?.release().catch(() => {});
    return;
  }
  const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void>; addEventListener?: (e: string, f: () => void) => void }> } };
  if (wake || !nav.wakeLock) return;
  try {
    const w = await nav.wakeLock.request("screen");
    wake = w;
    w.addEventListener?.("release", () => {
      if (wake === w) wake = null;
    });
  } catch {
    /* not allowed now (hidden): tried again once visible */
  }
}

export const callNative = {
  /** call mode: the route (loudspeaker or earpiece), the screen kept on */
  begin: (speaker: boolean) => call("begin", { speaker }),
  setSpeaker: (on: boolean) => call("setSpeaker", { on }),
  end: () => call("end"),
  /** her ringing as a call notification (shown while the app is in the background) */
  ring: (id: string, title: string, body: string, accept: string, decline: string) =>
    call("ring", { id, title, body, accept, decline }),
  cancelRing: (id: string) => call("cancelRing", { id }),
  /** what was tapped on her call notification: open (the app came up) · accept · decline */
  onAction(cb: (a: { action: string; id: string }) => void): void {
    const c = cap();
    if (!c || !nativeCalls()) return;
    try {
      c.nativeCallback("GenyCall", "addListener", { eventName: "callAction" }, (d) => {
        if (d && typeof d.id === "string") cb({ action: String(d.action || "open"), id: d.id });
      });
    } catch {
      /* an older app */
    }
  },
};
