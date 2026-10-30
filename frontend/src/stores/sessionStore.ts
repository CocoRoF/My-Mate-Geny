import { create } from "zustand";
import type { Session } from "../types";
import {
  createSession,
  deleteSession,
  listSessions,
  updateSession,
  type SessionInput,
} from "../api/sessions";

interface SessionState {
  sessions: Session[];
  activeId: string | null;
  load: () => Promise<void>;
  create: (body: SessionInput) => Promise<Session>;
  update: (id: string, patch: { provider?: string; model?: string; effort?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeId: null,
  load: async () => set({ sessions: await listSessions() }),
  create: async (body) => {
    const s = await createSession(body);
    await get().load();
    set({ activeId: s.id });
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
    if (activeId === id) set({ activeId: null });
  },
  setActive: (id) => set({ activeId: id }),
}));
