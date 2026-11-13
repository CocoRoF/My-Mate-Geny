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
  return (await ask(method, options)) !== null;
}

/** the plugin's answer, or null (no plugin, an app from before this method, a failure) */
async function ask<T = Record<string, unknown>>(method: string, options: Record<string, unknown> = {}): Promise<T | null> {
  const c = cap();
  if (!c || !nativeCalls()) return null;
  try {
    return ((await c.nativePromise("GenyCall", method, options)) ?? {}) as T;
  } catch {
    return null;
  }
}

/** the app's background link (GenyLinkService): her calls ring with the app closed, like a phone's */
export interface PhoneLink {
  /** the user lets it run with the app closed */
  background: boolean;
  /** signed in to a server it remembers, this page's device known */
  ready: boolean;
  running: boolean;
  state: "off" | "connecting" | "connected" | "offline" | "signed_out";
  /** she may call this phone (speaking first is on here), and who */
  calls: boolean;
  mate: string;
  /** what the phone still has to allow */
  notifications: boolean;
  fullScreen: boolean;
  batteryExempt: boolean;
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
  /** call mode: the route (loudspeaker or earpiece), the screen kept on; the app holds the microphone and shows the call */
  begin: (speaker: boolean, about?: { id: string; mate: string; name: string }) => call("begin", { speaker, ...about }),
  setSpeaker: (on: boolean) => call("setSpeaker", { on }),
  end: () => call("end"),
  /** her ringing as a call notification (shown while the app is in the background or the phone is locked) → shown:
   *  the phone rings, so the page doesn't */
  ring: async (id: string, mate: string, title: string, body: string): Promise<boolean> =>
    !!(await ask<{ shown?: boolean }>("ring", { id, mate, title, body }))?.shown,
  cancelRing: (id: string) => call("cancelRing", { id }),
  /** this page is `device`; her faces (data URLs by mate id) ring with her calls → the link's status (null: an app
   *  without the background link) */
  link: (device: string, faces: Record<string, string>) => ask<PhoneLink>("link", { device, faces }),
  linkStatus: () => ask<PhoneLink>("status"),
  setBackground: (on: boolean) => ask<PhoneLink>("setBackground", { on }),
  /** the phone's own page: battery (no optimisation) · fullscreen (calls over the lock screen) · notifications */
  openSettings: (what: "battery" | "fullscreen" | "notifications") => call("openSettings", { what }),
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
