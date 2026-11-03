import { apiFetch, apiResponse } from "./client";
import type { AccountRef, ChatMessage, Compaction, ContextInfo, PlanUsage, ProviderEvent, Session, TaskInfo } from "../types";

export type SessionPatch = {
  provider?: string;
  model?: string;
  effort?: string;
  mode?: "agent" | "plan";
  extra_dirs?: string[];
  folders?: { path: string; connection_id: string | null }[]; // every additional folder, with its host
  title?: string;
  auto_compact_window?: number; // tokens; 0 = CLI default; -1 = back to the global default
  account_id?: string; // run on this account from the next turn
  higgsfield?: { enabled?: boolean; max_credits?: number | null }; // this chat's Higgsfield
};

export const listSessions = () => apiFetch<Session[]>("/api/sessions");

/** The list plus its server version (see /ws/sessions): a feed message with a
 *  newer version means this list is stale. */
export async function listSessionsVersioned(): Promise<{ sessions: Session[]; version: number | null }> {
  const res = await apiResponse("/api/sessions");
  const v = Number(res.headers.get("X-Sessions-Version"));
  return { sessions: (await res.json()) as Session[], version: Number.isFinite(v) && v > 0 ? v : null };
}

export interface SessionInput {
  provider: string;
  model: string;
  effort?: string;
  connection_id: string | null;
  workspace_path: string;
  title: string;
  mode?: "agent" | "plan";
  extra_dirs?: string[];
}

export const createSession = (body: SessionInput) =>
  apiFetch<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) });

export const updateSession = (id: string, patch: SessionPatch) =>
  apiFetch<Session>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export const stopTurn = (id: string) => apiFetch(`/api/sessions/${id}/stop`, { method: "POST" });

export const resetContext = (id: string) =>
  apiFetch(`/api/sessions/${id}/reset-context`, { method: "POST" });

export const deleteSession = (id: string) =>
  apiFetch(`/api/sessions/${id}`, { method: "DELETE" });

export interface History {
  session_id: string;
  session: Session;
  running: boolean;
  messages: ChatMessage[];
  events: ProviderEvent[];
  account?: AccountRef | null; // which account this chat runs on (None before the first turn)
  live_usage?: PlanUsage | null; // what this chat's engine last reported
}

export const getHistory = (id: string) => apiFetch<History>(`/api/history/${id}`);

// ---- paged history (backend/app/services/history_page.py) ----

/** Where a slice of the history sits: turns start at a user message or an
 * auto turn; `cursor` is the slice's start (null = the beginning). */
export interface HistoryPageInfo {
  cursor: string | null;
  until: string | null;
  has_more: boolean;
  turns: number;
  last_eid?: number; // newest pages: the highest event id (attach after it)
}

export interface ChangedFile {
  path: string;
  ops: number;
  created: boolean;
  failed: boolean;
}

/** What precedes a page's cursor — the parts of the chat not loaded yet. */
export interface HistoryBefore {
  cost_usd: number;
  costed_turns: number;
  usage: Record<string, number>;
  changes: { git: boolean; files: ChangedFile[] };
  todos: unknown; // the latest TodoWrite input before the cursor
}

export interface HistorySummary {
  cost_usd: number;
  costed_turns: number;
  usage: Record<string, number>;
  context: ContextInfo | null;
  last_compaction: Compaction | null;
  /** running background work launched before the cursor: its call + steps */
  pinned: ProviderEvent[];
}

export interface HistoryPage extends History {
  page: HistoryPageInfo;
  before: HistoryBefore;
  summary?: HistorySummary; // newest / since pages
}

/** An older page: the slice + what precedes it. */
export type OlderPage = Pick<HistoryPage, "session_id" | "messages" | "events" | "page" | "before">;

/** `lite`: ask for the slimmer page (big tool payloads as previews with
 * `event.lazy`, deltas merged; backend services/history_lite.py). A backend
 * that doesn't know it sends the full page — the store handles both. */
export const getHistoryPage = (id: string, q: { turns?: number; since?: string }, lite = false) => {
  const p = new URLSearchParams();
  if (q.turns) p.set("turns", String(q.turns));
  if (q.since !== undefined) p.set("since", q.since);
  if (lite) p.set("lite", "1");
  return apiFetch<HistoryPage>(`/api/history/${id}?${p}`);
};

export const getOlderPage = (id: string, before: string, turns: number, lite = false) =>
  apiFetch<OlderPage>(
    `/api/history/${id}?${new URLSearchParams({ turns: String(turns), before, ...(lite ? { lite: "1" } : {}) })}`,
  );

/** The stored events `eids` of a chat, in full (what a lite page previewed). */
export const getEvents = (id: string, eids: number[]) =>
  apiFetch<{ events: ProviderEvent[] }>(`/api/history/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ eids }),
  });

// ---- background tasks ----
export const listTasks = (sid: string) => apiFetch<TaskInfo[]>(`/api/sessions/${sid}/tasks`);
export const allTasks = () => apiFetch<TaskInfo[]>("/api/tasks");
export const taskOutput = (sid: string, taskId: string, tail = 65536) =>
  apiFetch<{ output: string; truncated: boolean; available: boolean; size?: number }>(
    `/api/sessions/${sid}/tasks/${encodeURIComponent(taskId)}/output?tail=${tail}`,
  );
export const stopTask = (sid: string, taskId: string) =>
  apiFetch(`/api/sessions/${sid}/tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST" });

// ---- per-turn changes ----
export const changesDiff = (sid: string, eid: number, repo = 0, path?: string) => {
  const q = new URLSearchParams({ repo: String(repo) });
  if (path) q.set("path", path);
  return apiFetch<{ patch: string }>(`/api/sessions/${sid}/changes/${eid}/diff?${q}`);
};
export const revertChanges = (sid: string, eid: number, body: { repo?: number; paths?: string[] }) =>
  apiFetch<{ reverted: string[] }>(`/api/sessions/${sid}/changes/${eid}/revert`, {
    method: "POST",
    body: JSON.stringify(body),
  });

// ---- workspace file preview ----
export const fileUrl = (sid: string, path: string) =>
  `/api/sessions/${sid}/file?path=${encodeURIComponent(path)}`;
/** `conn`: the file's host when known (null = this server; undefined = let the server find it). */
export const fileText = (sid: string, path: string, conn?: string | null) =>
  apiFetch<{ path: string; mime: string; content: string; truncated: boolean }>(
    `/api/sessions/${sid}/file?path=${encodeURIComponent(path)}&text=1${
      conn === undefined ? "" : `&connection_id=${encodeURIComponent(conn || "local")}`
    }`,
  );
