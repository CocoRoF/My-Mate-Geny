/**
 * Live, unsaved settings previews shared by every window of this browser (BroadcastChannel): moving Settings → Voice
 * → Volume changes the voice playing in the desktop overlay / quick card / another tab at once, and clearing the
 * preview (saved, or the tab left / closed) puts each window back on the mate's saved value. Saved changes travel
 * on their own (stores/mateStore: server push + a same-browser announce).
 */
import { useSyncExternalStore } from "react";

type Msg = { type: "volume"; mateId: string; volume: number | null };

const volumes = new Map<string, number>();
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

if (channel) {
  channel.onmessage = (e: MessageEvent) => {
    const d = e.data as Msg | null;
    if (d?.type === "volume" && typeof d.mateId === "string") apply(d.mateId, typeof d.volume === "number" ? d.volume : null);
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

// the settings window closes mid-drag: nobody stays on its unsaved value
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const id of mine) post({ type: "volume", mateId: id, volume: null });
    mine.clear();
  });
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
