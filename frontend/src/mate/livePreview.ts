/**
 * Live, unsaved settings previews shared by every window of this browser (BroadcastChannel): moving Settings → Voice
 * → Volume changes the voice playing in the desktop overlay / quick card / another tab at once, and switching a clip
 * on or off (or any other edit in Settings → Avatar) shows on every avatar at once. Clearing the preview (saved, or
 * the tab left / closed) puts each window back on the mate's saved value. Saved changes travel on their own
 * (stores/mateStore: server push + a same-browser announce).
 */
import { useSyncExternalStore } from "react";
import type { Avatar } from "./types";

type Msg =
  | { type: "volume"; mateId: string; volume: number | null }
  | { type: "avatar"; mateId: string; avatar: Avatar | null }
  /** unsaved display settings that show on the avatars (the emotion level, whether the idle look follows her mood) */
  | { type: "flags"; mateId: string; flags: PreviewFlags | null }
  /** a window that just opened asks for the previews running now */
  | { type: "hello" };

export interface PreviewFlags {
  /** prefs.emotion: 0 off · 1 subtle · 2 normal · 3 expressive */
  emotion?: number;
  /** relation.avatar_mood */
  avatarMood?: boolean;
}

const volumes = new Map<string, number>();
const flagsBy = new Map<string, PreviewFlags>();
const mineFlags = new Set<string>();
const avatars = new Map<string, Avatar>();
/** previews this page started (cleared for everyone when it goes away) */
const mine = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const channel: BroadcastChannel | null = (() => {
  try {
    return typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("hrh-mate-preview") : null;
  } catch {
    return null;
  }
})();

function apply(mateId: string, volume: number | null) {
  const cur = volumes.get(mateId);
  if (volume === null || !Number.isFinite(volume)) {
    if (cur === undefined) return;
    volumes.delete(mateId);
  } else {
    if (cur === volume) return;
    volumes.set(mateId, volume);
  }
  emit();
}

function applyAvatar(mateId: string, avatar: Avatar | null) {
  if (avatar === null) {
    if (!avatars.delete(mateId)) return;
  } else {
    if (JSON.stringify(avatars.get(mateId)) === JSON.stringify(avatar)) return;
    avatars.set(mateId, avatar);
  }
  emit();
}

function applyFlags(mateId: string, flags: PreviewFlags | null) {
  if (flags === null) {
    if (!flagsBy.delete(mateId)) return;
  } else {
    if (JSON.stringify(flagsBy.get(mateId)) === JSON.stringify(flags)) return;
    flagsBy.set(mateId, flags);
  }
  emit();
}

if (channel) {
  channel.onmessage = (e: MessageEvent) => {
    const d = e.data as Msg | null;
    if (d?.type === "volume" && typeof d.mateId === "string") apply(d.mateId, typeof d.volume === "number" ? d.volume : null);
    else if (d?.type === "avatar" && typeof d.mateId === "string") applyAvatar(d.mateId, d.avatar && typeof d.avatar === "object" ? d.avatar : null);
    else if (d?.type === "flags" && typeof d.mateId === "string") applyFlags(d.mateId, d.flags && typeof d.flags === "object" ? d.flags : null);
    else if (d?.type === "hello") {
      // tell the newcomer what this page is previewing
      for (const id of mine) if (volumes.has(id)) post({ type: "volume", mateId: id, volume: volumes.get(id)! });
      for (const id of mineAvatar) if (avatars.has(id)) post({ type: "avatar", mateId: id, avatar: avatars.get(id)! });
      for (const id of mineFlags) if (flagsBy.has(id)) post({ type: "flags", mateId: id, flags: flagsBy.get(id)! });
    }
  };
}

const post = (msg: Msg) => {
  try {
    channel?.postMessage(msg);
  } catch {
    /* closed */
  }
};

/** Preview a mate's volume (0..3) in every window of this browser; null ends the preview (back to the saved one). */
export function previewMateVolume(mateId: string, volume: number | null): void {
  if (volume === null) mine.delete(mateId);
  else mine.add(mateId);
  apply(mateId, volume);
  post({ type: "volume", mateId, volume });
}

/** previews this page started, per kind (mine = any of them) */
const mineAvatar = new Set<string>();

/**
 * Preview a mate's avatar settings (the unsaved Settings → Avatar draft: clips on/off, triggers, stills…) on every
 * avatar of this browser; null ends the preview (back to the saved avatar).
 */
export function previewMateAvatar(mateId: string, avatar: Avatar | null): void {
  if (avatar === null) mineAvatar.delete(mateId);
  else mineAvatar.add(mateId);
  applyAvatar(mateId, avatar);
  post({ type: "avatar", mateId, avatar });
}

/** Preview display settings (emotion level, avatar follows mood) in every window of this browser; null ends it. */
export function previewMateFlags(mateId: string, flags: PreviewFlags | null): void {
  if (flags === null) mineFlags.delete(mateId);
  else mineFlags.add(mateId);
  applyFlags(mateId, flags);
  post({ type: "flags", mateId, flags });
}

// the settings window closes mid-drag: nobody stays on its unsaved value
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const id of mine) post({ type: "volume", mateId: id, volume: null });
    for (const id of mineAvatar) post({ type: "avatar", mateId: id, avatar: null });
    for (const id of mineFlags) post({ type: "flags", mateId: id, flags: null });
    mine.clear();
    mineAvatar.clear();
    mineFlags.clear();
  });
  post({ type: "hello" });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** the volume being previewed for this mate right now (any window of this browser), or null */
export function usePreviewVolume(mateId: string | null): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (mateId ? volumes.get(mateId) ?? null : null),
    () => null,
  );
}

/**
 * The avatar to show for a mate: the Settings → Avatar draft being edited in any window of this browser, else the
 * saved one. Every stage / overlay / quick card avatar goes through this.
 */
export function useLiveAvatar(mate: { id: string; avatar: Avatar } | null | undefined): Avatar | null {
  const id = mate?.id ?? null;
  const preview = useSyncExternalStore(
    subscribe,
    () => (id ? avatars.get(id) ?? null : null),
    () => null,
  );
  return preview ?? mate?.avatar ?? null;
}

/** the display settings being previewed for this mate right now (any window of this browser), or null */
export function usePreviewFlags(mateId: string | null): PreviewFlags | null {
  return useSyncExternalStore(
    subscribe,
    () => (mateId ? flagsBy.get(mateId) ?? null : null),
    () => null,
  );
}
