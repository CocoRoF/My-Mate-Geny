import { apiFetch } from "./client";
import type { ChatMessage, ProviderEvent, Session, TaskInfo } from "../types";

export type SessionPatch = {
  provider?: string;
  model?: string;
  effort?: string;
  mode?: "agent" | "plan";
  extra_dirs?: string[];
  title?: string;
};

export const listSessions = () => apiFetch<Session[]>("/api/sessions");

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
}

export const getHistory = (id: string) => apiFetch<History>(`/api/history/${id}`);

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
export const fileText = (sid: string, path: string) =>
  apiFetch<{ path: string; mime: string; content: string; truncated: boolean }>(
    `/api/sessions/${sid}/file?path=${encodeURIComponent(path)}&text=1`,
  );
