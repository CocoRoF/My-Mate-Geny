/**
 * Live2D Cubism Core loader. The core is not bundled (Live2D licence, docs/mate.md §2): the backend installs it on
 * request and serves it at `/api/mates/live2d/core.js`. Tiny on purpose — no pixi here, so the main bundle stays
 * light; the Live2D body itself is a lazy chunk.
 */

let coreUrl = "/api/mates/live2d/core.js";

/** where the Cubism Core script is loaded from (the lab points it at a local copy) */
export function setLive2DCoreUrl(url: string): void {
  coreUrl = url;
}

export function getLive2DCoreUrl(): string {
  return coreUrl;
}

const loading = new Map<string, Promise<boolean>>();

const hasCore = () => typeof window !== "undefined" && !!(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore;

/** load the core once; resolves false when it is not installed (404) or broken. A failure is retried next time. */
export function loadCubismCore(url = coreUrl): Promise<boolean> {
  if (hasCore()) return Promise.resolve(true);
  const known = loading.get(url);
  if (known) return known;
  const p = new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.dataset.live2dCore = "1";
    script.onload = () => resolve(hasCore());
    script.onerror = () => {
      script.remove();
      resolve(false);
    };
    document.head.appendChild(script);
  }).then((ok) => {
    if (!ok) loading.delete(url);
    return ok;
  });
  loading.set(url, p);
  return p;
}
