import { runBack } from "./lib/back";

// Android shell (Capacitor) loads this console remotely; its native bridge is
// injected as window.Capacitor. We talk to native plugins through the
// low-level bridge calls, so the web bundle needs no Capacitor packages.
// (The desktop shell injects window.hrhNative itself via its preload.)
export function installNativeBridge(): void {
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.() || window.hrhNative) return;
  const call = (plugin: string, method: string, options: Record<string, unknown> = {}) =>
    cap.nativePromise(plugin, method, options) as Promise<any>;

  const bridge: NonNullable<Window["hrhNative"]> = {
    platform: "android",
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
  document.documentElement.classList.add("native-android");

  call("App", "getInfo").then((info) => (bridge.version = info?.version || bridge.version)).catch(() => {});
  call("LocalNotifications", "requestPermissions").catch(() => {});

  // Back: close the top overlay; at the root, send the app to the background
  // instead of closing it (keeps the session warm).
  cap.nativeCallback("App", "addListener", { eventName: "backButton" }, () => {
    if (runBack()) return;
    call("App", "minimizeApp").catch(() => {});
  });
}
