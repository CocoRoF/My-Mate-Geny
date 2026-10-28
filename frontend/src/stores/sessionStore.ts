import { create } from "zustand";
import type { Session } from "../types";
import {
  createSession,
  deleteSession,
  listSessions,
  type SessionInput,
} from "../api/sessions";

interface SessionState {
  sessions: Session[];
  activeId: string | null;
  load: () => Promise<void>;
  create: (body: SessionInput) => Promise<Session>;
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
  remove: async (id) => {
    await deleteSession(id);
    const { activeId } = get();
    await get().load();
    if (activeId === id) set({ activeId: null });
  },
  setActive: (id) => set({ activeId: id }),
}));
