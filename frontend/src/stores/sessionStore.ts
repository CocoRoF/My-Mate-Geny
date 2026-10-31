import { create } from "zustand";
import type { Session } from "../types";
import {
  createSession,
  deleteSession,
  listSessions,
  updateSession,
  type SessionInput,
  type SessionPatch,
} from "../api/sessions";

interface SessionState {
  sessions: Session[];
  activeId: string | null;
  load: () => Promise<void>;
  create: (body: SessionInput) => Promise<Session>;
  update: (id: string, patch: SessionPatch) => Promise<void>;
  /** Merge a server-side session snapshot (e.g. from history / live info). */
  patchLocal: (id: string, patch: Partial<Session>) => void;
  remove: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
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

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeId: null,
  load: async () => {
    const sessions = await listSessions();
    set({ sessions });
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
