import { create } from "zustand";
import { allTasks, taskPage, type TaskPage } from "../api/sessions";
import type { TaskInfo } from "../types";

interface TaskPaging {
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  ids: string[];
  start: string | null;
  expanded: boolean;
}
interface TaskState {
  bySession: Record<string, TaskInfo[]>;
  paging: Record<string, TaskPaging>;
  all: TaskInfo[];
  loadSession: (sid: string, reset?: boolean) => Promise<void>;
  loadMore: (sid: string) => Promise<void>;
  loadAll: () => Promise<void>;
  upsert: (sid: string, t: TaskInfo) => void;
}
const emptyPage = (): TaskPaging => ({ cursor: null, hasMore: false, loading: false, error: null, ids: [], start: null, expanded: false });
const pending = new Map<string, Promise<void>>();
const generations = new Map<string, number>();
const merge = (list: TaskInfo[], t: TaskInfo) => {
  const i = list.findIndex((x) => x.task_id === t.task_id);
  if (i < 0) return [t, ...list];
  if (list[i].updated_at && t.updated_at && list[i].updated_at! > t.updated_at) return list;
  const copy = list.slice();
  copy[i] = { ...copy[i], ...t };
  return copy;
};
const combine = (previous: TaskInfo[], rows: TaskInfo[]) => rows.reduce(merge, previous);
const snapshot = (previous: TaskInfo[], result: TaskPage) => {
  const runningIds = new Set(result.running.map(t => t.task_id));
  // A reconnect must clear old running badges absent from the authoritative snapshot.
  // Preserve a socket update newer than the snapshot, and fetch an old finished row only on demand.
  return combine(previous.filter(t => !isRunning(t) || runningIds.has(t.task_id) || !!(t.updated_at && result.as_of && t.updated_at > result.as_of)), [...result.tasks, ...result.running]);
};

export const useTaskStore = create<TaskState>((set, get) => ({
  bySession: {}, paging: {}, all: [],
  loadSession: (sid, reset = false) => {
    if (pending.has(sid) && (!reset || !get().paging[sid]?.expanded)) return pending.get(sid)!;
    const generation = (generations.get(sid) || 0) + 1;
    generations.set(sid, generation);
    set(s => ({ paging: { ...s.paging, [sid]: { ...(s.paging[sid] || emptyPage()), ...(reset ? { ids: [], expanded: false } : {}), loading: true, error: null } } }));
    const initialIds = new Set(get().paging[sid]?.ids);
    const request = (async () => {
      try {
        const result = await taskPage(sid);
        if (generations.get(sid) !== generation) return;
        set(s => {
          const p = s.paging[sid], keep = p.expanded;
          return {
            bySession: { ...s.bySession, [sid]: snapshot(s.bySession[sid] || [], result) },
            paging: { ...s.paging, [sid]: {
              cursor: keep ? p.cursor : result.page.cursor, hasMore: keep ? p.hasMore : result.page.has_more,
              loading: false, error: null, expanded: keep, start: keep ? p.start : result.page.start,
              ids: [...new Set([...(keep ? p.ids : []), ...result.tasks.map(t => t.task_id), ...p.ids.filter(id => !initialIds.has(id))])],
            } },
          };
        });
      } catch (e) {
        if (generations.get(sid) === generation) set(s => ({ paging: { ...s.paging, [sid]: { ...s.paging[sid], loading: false, error: String(e) } } }));
      } finally {
        if (generations.get(sid) === generation) pending.delete(sid);
      }
    })();
    pending.set(sid, request);
    return request;
  },
  loadMore: async sid => {
    const p = get().paging[sid];
    if (!p || p.loading || !p.cursor) return;
    const generation = generations.get(sid);
    set(s => ({ paging: { ...s.paging, [sid]: { ...p, loading: true, error: null } } }));
    try {
      const result = await taskPage(sid, p.cursor);
      if (generations.get(sid) !== generation) return;
      set(s => ({
        bySession: { ...s.bySession, [sid]: snapshot(s.bySession[sid] || [], result) },
        paging: { ...s.paging, [sid]: { cursor: result.page.cursor, hasMore: result.page.has_more, loading: false,
          error: null, expanded: true, start: result.page.start, ids: [...new Set([...s.paging[sid].ids, ...result.tasks.map(t => t.task_id)])] } },
      }));
    } catch (e) {
      if (generations.get(sid) === generation) set(s => ({ paging: { ...s.paging, [sid]: { ...s.paging[sid], loading: false, error: String(e) } } }));
    }
  },
  loadAll: async () => set({ all: await allTasks() }),
  upsert: (sid, t) => set(s => {
    const task = { ...t, session_id: sid }, p = s.paging[sid];
    const recent = !p?.start || (t.started_at ?? Date.parse(t.updated_at || "") / 1000) >= Date.parse(p.start) / 1000;
    return {
      bySession: { ...s.bySession, [sid]: merge(s.bySession[sid] || [], task) }, all: merge(s.all, task),
      ...(p && recent && !isRunning(task) ? { paging: { ...s.paging, [sid]: { ...p, ids: [...new Set([...p.ids, t.task_id])] } } } : {}),
    };
  }),
}));
export const isRunning = (t?: TaskInfo | null) => !!t && (t.status === "running" || t.status === "pending");
export function visibleTasks(tasks: TaskInfo[], ids: string[]): TaskInfo[] {
  const selected = new Set(ids);
  return tasks.filter(t => isRunning(t) || selected.has(t.task_id)).sort((a, b) => (b.started_at || 0) - (a.started_at || 0) || b.task_id.localeCompare(a.task_id));
}
