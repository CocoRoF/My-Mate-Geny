import Constants from "expo-constants";

// Point this at your 2223 server (LAN IP or tunnel URL). Overridable via
// app.json > expo.extra.apiBaseUrl, or AsyncStorage at runtime.
export const API_BASE: string =
  (Constants.expoConfig?.extra as any)?.apiBaseUrl || "http://127.0.0.1:8080";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function wsUrl(path: string): string {
  return API_BASE.replace(/^http/, "ws") + path;
}

// Shared API surface — same endpoints as the web client.
export interface Session {
  id: string;
  title: string;
  provider: string;
  workspace_path: string;
}

export const listSessions = () => apiFetch<Session[]>("/api/sessions");
export const createSession = (body: Record<string, unknown>) =>
  apiFetch<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) });
