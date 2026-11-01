/**
 * Downloads with progress (Download page).
 *
 * - Desktop app: the app's own updater (`hrhNative.updates`, desktop/src/updater.js) — state in the app, a reloaded
 *   page reads it again.
 * - Android app: the system DownloadManager through the app's GenyServer plugin (downloadApk / downloadStatus /
 *   installApk) — the download id is kept in localStorage, so a reloaded page shows it again; older apps without
 *   those methods fall back to the plain link (the app's DownloadListener).
 * - Browser: fetch the file as a stream (same origin: /api/downloads/asset/…), show bytes / speed / time left, then
 *   save it; without stream support (or on any error before the first byte) the plain link.
 */
import { useEffect, useRef, useState } from "react";

export interface Progress {
  status: "idle" | "downloading" | "done" | "error" | "cancelled";
  transferred: number;
  total: number;
  bytesPerSecond: number;
  eta: number | null;
  error?: string;
}

const IDLE: Progress = { status: "idle", transferred: 0, total: 0, bytesPerSecond: 0, eta: null };

/** speed over the last few seconds */
function meter() {
  let samples: { t: number; b: number }[] = [];
  return (bytes: number) => {
    const t = performance.now();
    samples = [...samples.filter((s) => t - s.t < 3000), { t, b: bytes }];
    const f = samples[0];
    return t > f.t ? ((bytes - f.b) * 1000) / (t - f.t) : 0;
  };
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** browser: one file with progress */
export function useBrowserDownload() {
  const [p, setP] = useState<Progress>(IDLE);
  const [name, setName] = useState("");
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  const start = async (url: string, fileName: string, size: number) => {
    if (typeof ReadableStream === "undefined" || !("body" in Response.prototype)) {
      window.location.href = url; // no streams: the browser's own download
      return;
    }
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setName(fileName);
    setP({ ...IDLE, status: "downloading", total: size });
    let got = 0;
    try {
      const r = await fetch(url, { signal: c.signal, credentials: "same-origin" });
      if (!r.ok || !r.body) throw new Error(r.status === 404 ? "This build was replaced by a newer one — refresh the page." : `HTTP ${r.status}`);
      const total = Number(r.headers.get("content-length")) || size || 0;
      const reader = r.body.getReader();
      const chunks: Uint8Array[] = [];
      const speed = meter();
      let last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        const now = performance.now();
        if (now - last > 150) {
          last = now;
          const bps = speed(got);
          setP({ status: "downloading", transferred: got, total, bytesPerSecond: bps, eta: bps > 0 && total ? (total - got) / bps : null });
        }
      }
      save(new Blob(chunks as BlobPart[], { type: r.headers.get("content-type") || "application/octet-stream" }), fileName);
      setP({ status: "done", transferred: got, total: got, bytesPerSecond: 0, eta: 0 });
    } catch (e: any) {
      if (c.signal.aborted) setP({ ...IDLE, status: "cancelled" });
      else if (!got) window.location.href = url; // nothing came: let the browser try it the plain way
      else setP((x) => ({ ...x, status: "error", error: String(e?.message || e) }));
    }
  };
  const cancel = () => ctrl.current?.abort();
  const reset = () => setP(IDLE);
  return { progress: p, name, start, cancel, reset };
}

// ── Android: DownloadManager through the GenyServer plugin ──

const ANDROID_KEY = "hrh.apkDownload";
const cap = () => (window as any).Capacitor;
const plugin = (method: string, options: Record<string, unknown> = {}) => cap().nativePromise("GenyServer", method, options) as Promise<any>;
export const isAndroidApp = () => !!cap()?.isNativePlatform?.() && cap()?.getPlatform?.() === "android";

export function useAndroidDownload() {
  const [p, setP] = useState<Progress>(IDLE);
  const [id, setId] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(ANDROID_KEY)) || null;
    } catch {
      return null;
    }
  });
  const speed = useRef(meter());

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const poll = async () => {
      try {
        const s = await plugin("downloadStatus", { id });
        if (!alive) return;
        const bps = speed.current(s.transferred || 0);
        const total = s.total || 0;
        if (s.status === "done") setP({ status: "done", transferred: total, total, bytesPerSecond: 0, eta: 0 });
        else if (s.status === "failed" || s.status === "gone") {
          setP({ ...IDLE, status: s.status === "gone" ? "idle" : "error", error: s.reason || "The download failed." });
          if (s.status === "gone") forget();
        } else setP({ status: "downloading", transferred: s.transferred || 0, total, bytesPerSecond: bps, eta: bps > 0 && total ? (total - s.transferred) / bps : null });
      } catch {
        if (alive) forget();
      }
    };
    void poll();
    const t = setInterval(poll, 500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const forget = () => {
    try {
      localStorage.removeItem(ANDROID_KEY);
    } catch {
      /* ignore */
    }
    setId(null);
  };

  /** false: this app version has no such method — use the plain link */
  const start = async (url: string, name: string): Promise<boolean> => {
    try {
      const abs = new URL(url, window.location.href).href;
      const r = await plugin("downloadApk", { url: abs, name });
      try {
        localStorage.setItem(ANDROID_KEY, String(r.id));
      } catch {
        /* ignore */
      }
      speed.current = meter();
      setP({ ...IDLE, status: "downloading" });
      setId(r.id);
      return true;
    } catch {
      return false;
    }
  };
  const install = () => (id ? plugin("installApk", { id }).catch((e: any) => setP((x) => ({ ...x, status: "error", error: String(e?.message || e) }))) : undefined);
  const cancel = async () => {
    if (id) await plugin("cancelDownload", { id }).catch(() => {});
    forget();
    setP({ ...IDLE, status: "cancelled" });
  };
  return { progress: p, active: !!id, start, install, cancel, reset: () => (forget(), setP(IDLE)) };
}

export function fmtSpeed(bps: number): string {
  if (!bps) return "";
  const mb = bps / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}

export function fmtEta(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "";
  if (s < 1) return "almost done";
  if (s < 60) return `${Math.ceil(s)} s left`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${Math.round(s % 60)} s left` : `${Math.floor(m / 60)} h ${m % 60} min left`;
}
