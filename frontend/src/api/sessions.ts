import { apiFetch } from "./client";
import type { ChatMessage, ProviderEvent, Session } from "../types";

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
