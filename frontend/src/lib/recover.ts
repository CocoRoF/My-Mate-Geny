/**
 * Never a blank page.
 *
 * A page that loaded build A keeps importing build A's code-split chunks (`/assets/<View>-<hash>.js`) as the user
 * opens views. Once the server serves build B those files may be gone: the dynamic import rejects ("Failed to fetch
 * dynamically imported module"), and React without an error boundary unmounts the whole root — a black window
 * (seen in the error log as `client.error … DownloadsView-….js`). The cure is a reload (the new index.html names the
 * new chunks); this module does it once, and the root error boundary shows a Reload screen if it happens again.
 */

const KEY = "hrh.recover.reloadAt";
/** a second chunk failure within this time after an automatic reload shows the error screen instead (no loops) */
const GUARD_MS = 30_000;

const CHUNK_RE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed|Outdated Optimize Dep/i;

/** Is this the "the code of this page is gone from the server" failure (a deploy happened since the page loaded)? */
export function isChunkError(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === "string" ? err : String((err as any)?.message ?? err);
  return CHUNK_RE.test(msg);
}

function lastReload(): number {
  try {
    return Number(sessionStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
}

/** May we reload automatically now? (not if we did within the last GUARD_MS: then the user decides) */
export function canAutoReload(now = Date.now()): boolean {
  return now - lastReload() > GUARD_MS;
}

/** Reload the page once for a chunk failure. false: already tried just now — show the retry screen instead. */
export function reloadOnce(reason = "chunk"): boolean {
  if (!canAutoReload()) return false;
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* private mode: still reload once (the in-memory flag below stops a loop within this page) */
  }
  if ((window as any).__hrhReloading) return true;
  (window as any).__hrhReloading = reason;
  window.location.reload();
  return true;
}

/** Hard reload from a button: the guard is cleared (the user asked for it). */
export function reloadNow(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  window.location.reload();
}

/** Vite's preload helper reports a chunk / CSS that failed to load: reload once (else let the error reach the boundary). */
export function installChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (ev) => {
    if (reloadOnce("preload")) ev.preventDefault();
  });
  // a lazy import outside React (a store, a renderer) that failed: same cure
  window.addEventListener("unhandledrejection", (ev) => {
    if (isChunkError(ev.reason)) reloadOnce("import");
  });
  // the inline boot screen (index.html) stops its "still loading" timer once the app is up
  (window as any).__hrhBooted = true;
  // up for a minute: the avatar window's quiet-retry backoff starts over next time
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem("hrh.recover.quiet");
    } catch {
      /* ignore */
    }
  }, 60_000);
}
