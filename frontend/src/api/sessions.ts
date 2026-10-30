import { apiFetch } from "./client";
import type { ChatMessage, ProviderEvent, Session } from "../types";

export const listSessions = () => apiFetch<Session[]>("/api/sessions");

export interface SessionInput {
  provider: string;
  model: string;
  effort?: string;
  connection_id: string | null;
  workspace_path: string;
  title: string;
}

export const createSession = (body: SessionInput) =>
  apiFetch<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) });

export const updateSession = (
  id: string,
  patch: { provider?: string; model?: string; effort?: string },
) =>
  apiFetch<Session>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export const deleteSession = (id: string) =>
  apiFetch(`/api/sessions/${id}`, { method: "DELETE" });

export const getHistory = (id: string) =>
  apiFetch<{ session_id: string; messages: ChatMessage[]; events: ProviderEvent[] }>(
    `/api/history/${id}`,
  );
