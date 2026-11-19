import { goBack } from "./lib/nav";
import { tr } from "./i18n";
import { NATIVE_VERSION_EVENT } from "./lib/nativeVersion";
import { setAppActive } from "./lib/appState";

/** a short notice at the bottom of the screen (no app UI needed) */
function toast(text: string) {
  const el = document.createElement("div");
  el.textContent = text;
  el.setAttribute("role", "status");
  el.style.cssText =
    "position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483647;" +
    "padding:9px 16px;border-radius:999px;background:rgb(var(--c-surface-3) / .95);border:1px solid rgb(var(--c-border-strong));" +
    "color:rgb(var(--c-content));font:13px Inter,system-ui,sans-serif;box-shadow:var(--shadow-float);transition:opacity .25s;pointer-events:none";
  document.body.appendChild(el);
  setTimeout(() => (el.style.opacity = "0"), 1700);
  setTimeout(() => el.remove(), 2000);
}

// The phone apps (Capacitor: Android, iOS) load this console remotely; their native bridge is
// injected as window.Capacitor. We talk to native plugins through the
// low-level bridge calls, so the web bundle needs no Capacitor packages.
// (The desktop shell injects window.hrhNative itself via its preload.)
export function installNativeBridge(): void {
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.() || window.hrhNative) return;
  const call = (plugin: string, method: string, options: Record<string, unknown> = {}) =>
    cap.nativePromise(plugin, method, options) as Promise<any>;

  // (iOS has the shell, notifications and the app's state; calls, the APK, Geny Net and the back button are Android's)
  const os = cap.getPlatform?.() === "ios" ? "ios" : "android";
  const bridge: NonNullable<Window["hrhNative"]> = {
    platform: os,
    version: "0.0.0",
    notify: (title: string, body: string) => {
      call("LocalNotifications", "schedule", {
        notifications: [{ id: Math.floor(Math.random() * 2_000_000_000), title, body }],
      }).catch(() => {});
    },
    openExternal: (url: string) => {
      window.open(url, "_system");
    },
  };
  window.hrhNative = bridge;
  document.documentElement.classList.add("native-app", `native-${os}`);

  // (it may answer after the first render: what shows the version listens — lib/nativeVersion.ts)
  call("App", "getInfo")
    .then((info) => {
      bridge.version = info?.version || bridge.version;
      window.dispatchEvent(new Event(NATIVE_VERSION_EVENT));
    })
    .catch(() => {});
  call("LocalNotifications", "requestPermissions").catch(() => {});

  // In front or away — another app, the app closed, the screen off (lib/appState.ts): away, the page goes quiet.
  try {
    cap.nativeCallback("App", "addListener", { eventName: "appStateChange" }, (s: { isActive?: boolean }) => setAppActive(!!s?.isActive));
  } catch {
    /* (an older app: the page's visibility stands in) */
  }

  // Back: close the top overlay, else the previous screen (lib/nav.ts); at the first screen a second press
  // within 2 s leaves — to the background, the session stays warm. (Android's button: iOS has none.)
  if (os !== "android") return;
  let armedAt = 0;
  cap.nativeCallback("App", "addListener", { eventName: "backButton" }, () => {
    if (goBack()) return;
    if (Date.now() - armedAt < 2000) {
      armedAt = 0;
      call("App", "minimizeApp").catch(() => {});
      return;
    }
    armedAt = Date.now();
    toast(tr("nav.pressBackAgain"));
  });
}
