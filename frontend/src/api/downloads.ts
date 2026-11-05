import { apiFetch } from "./client";

export interface AppAsset {
  id: number;
  name: string;
  size: number;
  url: string;
  platform: "windows" | "macos" | "linux" | "android";
  arch: string;
  kind: string;
  label: string;
  updated_at?: string;
}

export interface AppRelease {
  available: boolean;
  repository?: string;
  reason?: string;
  version?: string;
  commit?: string;
  commit_message?: string;
  built_at?: string;
  notes?: string;
  assets?: AppAsset[];
}

export const getDownloads = (refresh = false): Promise<AppRelease> => {
  const native=(typeof window!=="undefined" ? (window.hrhNative as any)?.updates : null);
  return native?.catalog ? native.catalog(refresh) : apiFetch<AppRelease>(`/api/downloads${refresh ? "?refresh=1" : ""}`);
};

export type Platform = "windows" | "macos" | "linux" | "android" | "ios" | "other";

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other";
}

/** -1 / 0 / 1 for dotted versions ("0.2.14" vs "0.2.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
