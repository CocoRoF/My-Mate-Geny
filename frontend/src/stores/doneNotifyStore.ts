/**
 * “끝나면 알려 줘” for a chat (backend app/services/done_notify.py, docs/mate-calls.md "Alarms"): armed, its mate phones
 * them when the chat's turn ends. Armed by the chat's agent (they asked in words) or the bell by the message box; the
 * server says where it stands on the chat's stream (`session.notify`, hooks/useChatSocket.ts).
 */
import { create } from "zustand";
import { apiFetch } from "../api/client";

export interface DoneNotifyState {
  armed: boolean;
  mate_id: string;
  mate_name: string;
  /** a mate can call them (otherwise the bell isn't offered) */
  available: boolean;
}

interface Store {
  by: Record<string, DoneNotifyState>;
  load: (sid: string) => Promise<void>;
  set: (sid: string, state: DoneNotifyState) => void;
  toggle: (sid: string) => Promise<void>;
}

export const useDoneNotifyStore = create<Store>((set, get) => ({
  by: {},
  load: async (sid) => {
    try {
      const st = await apiFetch<DoneNotifyState>(`/api/sessions/${encodeURIComponent(sid)}/notify-done`);
      get().set(sid, st);
    } catch {
      /* an older server: no bell */
    }
  },
  set: (sid, state) => set((s) => ({ by: { ...s.by, [sid]: state } })),
  toggle: async (sid) => {
    const now = get().by[sid];
    try {
      const st = await apiFetch<DoneNotifyState>(`/api/sessions/${encodeURIComponent(sid)}/notify-done`, {
        method: now?.armed ? "DELETE" : "POST",
        body: now?.armed ? undefined : JSON.stringify({}),
      });
      get().set(sid, st);
    } catch {
      void get().load(sid);
    }
  },
}));
