import { create } from "zustand";
import { getSessionGit, type GitStatus } from "../api/sessionGit";

/** Each chat's Git status for the top bar. Read on demand only — the chat opening, a turn ending, the popover
 * opening, after its own actions — never on a timer. */
interface SessionGitState {
  byId: Record<string, { status: GitStatus | null; loading: boolean; error?: string } | undefined>;
  refresh: (sid: string) => Promise<GitStatus | null>;
  set: (sid: string, status: GitStatus) => void;
}

const inflight = new Map<string, Promise<GitStatus | null>>();

export const useSessionGit = create<SessionGitState>((set) => ({
  byId: {},
  set: (sid, status) => set((s) => ({ byId: { ...s.byId, [sid]: { status, loading: false } } })),
  refresh: (sid) => {
    const running = inflight.get(sid);
    if (running) return running;
    set((s) => ({ byId: { ...s.byId, [sid]: { status: s.byId[sid]?.status ?? null, loading: true } } }));
    const p = getSessionGit(sid)
      .then((status) => {
        set((s) => ({ byId: { ...s.byId, [sid]: { status, loading: false } } }));
        return status;
      })
      .catch((e: any) => {
        set((s) => ({ byId: { ...s.byId, [sid]: { status: s.byId[sid]?.status ?? null, loading: false, error: String(e.message || e) } } }));
        return null;
      })
      .finally(() => inflight.delete(sid));
    inflight.set(sid, p);
    return p;
  },
}));
