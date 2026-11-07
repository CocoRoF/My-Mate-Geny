import { create } from "zustand";
import type { Session } from "../types";
import {
  copySession,
  createSession,
  deleteSession,
  listSessionsVersioned,
  updateSession,
  type SessionInput,
  type SessionPatch,
} from "../api/sessions";
import { useDraftStore } from "./draftStore";

interface SessionState {
  sessions: Session[];
  activeId: string | null;
  /** Server version of `sessions` (X-Sessions-Version); null before the first load. */
  version: number | null;
  /** Fetch the list. Calls made while one is in flight share one follow-up
   *  fetch, so a burst of changes costs at most two requests. */
  load: () => Promise<void>;
  create: (body: SessionInput) => Promise<Session>;
  update: (id: string, patch: SessionPatch) => Promise<void>;
  /** Merge a server-side session snapshot (e.g. from history / live info). */
  patchLocal: (id: string, patch: Partial<Session>) => void;
  remove: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  /** A second chat that works exactly like this one; the open chat stays open. */
  copy: (id: string) => Promise<Session>;
}

const LAST_KEY = "hrh_last_session";
const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
  } catch {
    /* ignore */
  }
};

let opened = false; // first load picks a chat once; later loads keep the user's choice
let inflight: Promise<void> | null = null;
let again = false;

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeId: null,
  version: null,
  load: () => {
    if (inflight) {
      again = true; // something changed mid-fetch: one more fetch after this one
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          again = false;
          await fetchList(set, get);
        } while (again);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
  create: async (body) => {
    const s = await createSession(body);
    await get().load();
    set({ activeId: s.id });
    remember(s.id);
    return s;
  },
  update: async (id, patch) => {
    const updated = await updateSession(id, patch);
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...updated } : x)) }));
  },
  copy: async (id) => {
    const s = await copySession(id);
    await get().load();
    return s;
  },
  remove: async (id) => {
    await deleteSession(id);
    const { activeId } = get();
    await get().load();
    // deleting the open chat moves to the next most recent; none left → New chat
    if (activeId === id) set({ activeId: get().sessions[0]?.id ?? null });
  },
  patchLocal: (id, patch) =>
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
  setActive: (id) => {
    remember(id);
    set({ activeId: id });
  },
}));

type StoreSet = (partial: Partial<SessionState>) => void;

async function fetchList(set: StoreSet, get: () => SessionState) {
  const { sessions, version } = await listSessionsVersioned();
  set({ sessions, version });
  useDraftStore.getState().prune(new Set(sessions.map((x) => x.id))); // unsent drafts of deleted chats
  // The app opens on a chat, not on "New chat": the last one opened here,
  // else the most recent (the list is newest first). Only an empty history
  // (or the New chat button) shows the new-chat screen.
  if (!opened) {
    opened = true;
    if (!get().activeId && sessions.length) {
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_KEY);
      } catch {
        /* ignore */
      }
      set({ activeId: sessions.find((x) => x.id === last)?.id ?? sessions[0].id });
    }
  }
  // The open chat was deleted on another device: move to the most recent.
  const { activeId } = get();
  if (opened && activeId && !sessions.some((x) => x.id === activeId)) set({ activeId: sessions[0]?.id ?? null });
}
