import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Attachment } from "../types";

/**
 * What the user wrote but hasn't sent, per chat: the text and the files
 * already uploaded for it. Kept across chat switches, other views, reloads
 * and app restarts (localStorage), and shared live between this browser's
 * tabs. Queued messages (waiting for the running turn) are kept per chat
 * too, in memory.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: Attachment[];
}

interface Draft {
  text: string;
  attachments: Attachment[]; // uploaded (server-side) files — they survive a reload
  at: number;
}

interface DraftState {
  drafts: Record<string, Draft>;
  queues: Record<string, QueuedMessage[]>; // not persisted
  /** conversations that aren't in the chat list (mates): prune keeps their drafts */
  pinned: Record<string, true>;
  pin: (sid: string) => void;
  setText: (sid: string, text: string) => void;
  setAttachments: (sid: string, attachments: Attachment[]) => void;
  setQueue: (sid: string, queue: QueuedMessage[]) => void;
  /** Forget chats that no longer exist (and drafts untouched for a month). */
  prune: (liveIds: Set<string>) => void;
}

const KEY = "hrh_drafts";
const MAX_AGE_MS = 30 * 86400_000;

function put(drafts: Record<string, Draft>, sid: string, patch: Partial<Draft>): Record<string, Draft> {
  const next: Draft = { ...(drafts[sid] ?? { text: "", attachments: [], at: 0 }), ...patch, at: Date.now() };
  const out = { ...drafts };
  if (next.text || next.attachments.length) out[sid] = next;
  else delete out[sid];
  return out;
}

const sameIds = (a: Attachment[], b: Attachment[]) => a.length === b.length && a.every((x, i) => x.id === b[i].id);

/** localStorage, written at most every 300 ms (and at once when the page is hidden or left): every keystroke wrote
 *  every chat's draft, and every other window of this browser read them all back */
export const WRITE_DELAY_MS = 300;
let pending: [string, string] | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
export function flushDrafts() {
  clearTimeout(timer);
  if (!pending) return;
  const [k, v] = pending;
  pending = null;
  try {
    localStorage.setItem(k, v);
  } catch {
    /* full / private mode: this page only */
  }
}
const lazyStorage: StateStorage = {
  getItem: (k) => (pending && pending[0] === k ? pending[1] : localStorage.getItem(k)),
  setItem: (k, v) => {
    pending = [k, v];
    clearTimeout(timer);
    timer = setTimeout(flushDrafts, WRITE_DELAY_MS);
  },
  removeItem: (k) => {
    if (pending?.[0] === k) pending = null;
    localStorage.removeItem(k);
  },
};
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDrafts);
  document.addEventListener("visibilitychange", () => document.hidden && flushDrafts());
}

export const useDraftStore = create<DraftState>()(
  persist(
    (set) => ({
      drafts: {},
      queues: {},
      pinned: {},
      pin: (sid) => set((s) => (s.pinned[sid] ? s : { pinned: { ...s.pinned, [sid]: true } })),
      setText: (sid, text) =>
        set((s) => ((s.drafts[sid]?.text ?? "") === text ? s : { drafts: put(s.drafts, sid, { text }) })),
      setAttachments: (sid, attachments) =>
        set((s) => (sameIds(s.drafts[sid]?.attachments ?? [], attachments) ? s : { drafts: put(s.drafts, sid, { attachments }) })),
      setQueue: (sid, queue) =>
        set((s) => {
          const queues = { ...s.queues };
          if (queue.length) queues[sid] = queue;
          else delete queues[sid];
          return { queues };
        }),
      prune: (liveIds) =>
        set((s) => {
          const now = Date.now();
          // (a mate's conversation isn't in the chat list: pinned; "mate:<id>" = older mate drafts)
          const keep = Object.entries(s.drafts).filter(
            ([sid, d]) => (liveIds.has(sid) || s.pinned[sid] || sid.startsWith("mate:")) && now - d.at < MAX_AGE_MS,
          );
          if (keep.length === Object.keys(s.drafts).length) return s;
          return { drafts: Object.fromEntries(keep) };
        }),
    }),
    {
      name: KEY,
      version: 1,
      storage: createJSONStorage(() => lazyStorage),
      partialize: (s) => ({ drafts: s.drafts, pinned: s.pinned }),
    },
  ),
);

// Another tab of this browser changed a draft: pick it up.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) useDraftStore.persist.rehydrate();
  });
}
