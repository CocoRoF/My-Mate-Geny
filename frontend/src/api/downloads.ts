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
  /** this build's version (each platform is published the moment it is built: they differ for a while) */
  version?: string;
  /** the desktop app (local execution), a public repository: the file straight from GitHub — what a phone's QR code
   *  opens, since the phone can't reach this computer's own download address */
  public_url?: string;
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
  /** iOS is TestFlight: which build, and the public link a phone opens */
  ios?: { version: string; build?: string; testflight: string; updated_at?: string } | null;
}

/** the desktop app: a link a phone on the same Wi-Fi opens to get the Android app from this computer (half an hour) */
export const phoneLink = (name: string): Promise<{ url: string; until: number } | null> => {
  const native = typeof window !== "undefined" ? (window.hrhNative as any)?.updates : null;
  return native?.phoneLink ? native.phoneLink(name) : Promise.resolve(null);
};

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

/** the platform of the app this page runs in (its own builds on the Download page), or null in a browser */
export function nativePlatform(): Platform | null {
  const p = typeof window !== "undefined" ? window.hrhNative?.platform || "" : "";
  if (p === "android" || p === "ios") return p;
  return ({ "desktop-darwin": "macos", "desktop-win32": "windows", "desktop-linux": "linux" } as Record<string, Platform>)[p] || null;
}

/** A platform's newest build in a release: each platform is published the moment it is built, so its version is its own
 * (one Mac architecture's, given its arch). A server from before per-platform versions: the release's. */
export function versionFor(rel: AppRelease | null | undefined, platform: Platform | null, arch?: string): string | undefined {
  if (!rel || !platform) return rel?.version;
  if (platform === "ios") return rel.ios?.version || undefined;
  const mine = (rel.assets || []).filter((a) => a.platform === platform);
  const exact = platform === "macos" && arch ? mine.filter((a) => a.arch === arch) : mine;
  const list = exact.length ? exact : mine;
  const versions = list.map((a) => a.version || "").filter(Boolean);
  if (!versions.length) return list.length ? rel.version : undefined;
  return versions.sort((a, b) => compareVersions(b, a))[0];
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
