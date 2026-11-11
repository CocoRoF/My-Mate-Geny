/**
 * Live2D Cubism Core: where it loads from, loading it once, and telling every Live2D body that it was just installed.
 *
 * The core is not bundled (Live2D licence, docs/mate.md §2): the backend installs it on request
 * (`POST /api/mates/live2d/core/install`, NDJSON progress) and serves it at `/api/mates/live2d/core.js`. Tiny on
 * purpose — no pixi here, so the main bundle stays light; the Live2D body itself is a lazy chunk.
 *
 * After an install, the settings UI calls `markLive2DCoreInstalled()`: every Live2D body showing "runtime not
 * installed" (in this tab, and in other tabs/windows of the app via a BroadcastChannel) loads right away, no reload.
 * `openLive2DSettings()` opens Settings → 메이트 (where the install lives).
 */
import { useEffect, useState } from "react";
import { openAppSettings } from "../lib/openAppSettings";

/** window event: the Cubism Core was installed (detail: { at }) */
export const LIVE2D_CORE_INSTALLED_EVENT = "hrh:live2d-core-installed";

const CHANNEL = "hrh-live2d-core";

let coreUrl = "/api/mates/live2d/core.js";
/** bumps with every install this page heard of (the next load asks for a fresh copy) */
let installs = 0;

/** where the Cubism Core script is loaded from (the lab points it at a local copy) */
export function setLive2DCoreUrl(url: string): void {
  coreUrl = url;
}

export function getLive2DCoreUrl(): string {
  return coreUrl;
}

/** how many installs this page has heard of (a hook dependency: changes when the core was just installed) */
export function live2dCoreInstalls(): number {
  return installs;
}

const hasCore = () => typeof window !== "undefined" && !!(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore;

const loading = new Map<string, Promise<boolean>>();

/** load the core once; resolves false when it is not installed (404) or broken. A failure is retried next time. */
export function loadCubismCore(url = coreUrl): Promise<boolean> {
  if (hasCore()) return Promise.resolve(true);
  // after an install, never reuse a "not installed" answer the browser may still hold for the plain URL
  const src = installs ? `${url}${url.includes("?") ? "&" : "?"}i=${installs}` : url;
  const known = loading.get(src);
  if (known) return known;
  const p = new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.live2dCore = "1";
    script.onload = () => resolve(hasCore());
    script.onerror = () => {
      script.remove();
      resolve(false);
    };
    document.head.appendChild(script);
  }).then((ok) => {
    if (!ok) loading.delete(src);
    return ok;
  });
  loading.set(src, p);
  return p;
}

// every "installed" event counts, whoever dispatched it (markLive2DCoreInstalled, another module, a test); registered at
// import, i.e. before any body's listener, so a body retrying on the event already asks for a fresh copy
if (typeof window !== "undefined") window.addEventListener(LIVE2D_CORE_INSTALLED_EVENT, () => (installs += 1));

let lastHeard = 0;
function heard(): void {
  // the same install announced twice in a row (two modules, two windows) is one retry
  if (Date.now() - lastHeard < 400) return;
  lastHeard = Date.now();
  window.dispatchEvent(new CustomEvent(LIVE2D_CORE_INSTALLED_EVENT, { detail: { at: lastHeard } }));
}

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) => {
      if (e.data === "installed") heard();
    };
  } catch {
    channel = null;
  }
  return channel;
}
if (typeof window !== "undefined") getChannel();

/** the Cubism Core was just installed: every Live2D body waiting for it (here and in the app's other windows) loads */
export function markLive2DCoreInstalled(): void {
  heard();
  try {
    getChannel()?.postMessage("installed");
  } catch {
    /* other windows reload on their own */
  }
}

/** a number that changes whenever the core was just installed (use as an effect dependency to retry) */
export function useLive2DCoreInstalls(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((v) => v + 1);
    window.addEventListener(LIVE2D_CORE_INSTALLED_EVENT, on);
    return () => window.removeEventListener(LIVE2D_CORE_INSTALLED_EVENT, on);
  }, []);
  return n;
}

/** open Settings → 메이트, where the runtime is installed (a body's "runtime not installed" state) */
export function openLive2DSettings(): void {
  openAppSettings("mate");
}
