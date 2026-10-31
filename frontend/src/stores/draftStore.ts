import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
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

export const useDraftStore = create<DraftState>()(
  persist(
    (set) => ({
      drafts: {},
      queues: {},
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
          const keep = Object.entries(s.drafts).filter(([sid, d]) => liveIds.has(sid) && now - d.at < MAX_AGE_MS);
          if (keep.length === Object.keys(s.drafts).length) return s;
          return { drafts: Object.fromEntries(keep) };
        }),
    }),
    {
      name: KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ drafts: s.drafts }),
    },
  ),
);

// Another tab of this browser changed a draft: pick it up.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) useDraftStore.persist.rehydrate();
  });
}
