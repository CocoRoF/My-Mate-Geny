import { create } from "zustand";
import { allTasks, listTasks } from "../api/sessions";
import type { PlanUsage, TaskInfo } from "../types";

// Background tasks (live from task.state messages + loaded per session) and
// the latest plan usage the engine reported.
interface TaskState {
  bySession: Record<string, TaskInfo[]>;
  all: TaskInfo[];
  usage: PlanUsage | null;
  loadSession: (sid: string) => Promise<void>;
  loadAll: () => Promise<void>;
  upsert: (sid: string, t: TaskInfo) => void;
  setUsage: (u: PlanUsage) => void;
}

const merge = (list: TaskInfo[], t: TaskInfo) => {
  const i = list.findIndex((x) => x.task_id === t.task_id);
  if (i < 0) return [t, ...list];
  const copy = list.slice();
  copy[i] = { ...copy[i], ...t };
  return copy;
};

export const useTaskStore = create<TaskState>((set) => ({
  bySession: {},
  all: [],
  usage: null,
  loadSession: async (sid) => {
    const tasks = await listTasks(sid);
    set((s) => ({ bySession: { ...s.bySession, [sid]: tasks } }));
  },
  loadAll: async () => set({ all: await allTasks() }),
  upsert: (sid, t) =>
    set((s) => ({
      bySession: { ...s.bySession, [sid]: merge(s.bySession[sid] || [], { ...t, session_id: sid }) },
      all: merge(s.all, { ...t, session_id: sid }),
    })),
  setUsage: (u) => set({ usage: u }),
}));

export const isRunning = (t?: TaskInfo | null) => !!t && (t.status === "running" || t.status === "pending");
