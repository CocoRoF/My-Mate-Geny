import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Point this at your 2223 deployment. Defaults to the public tunnel domain.
export const API_BASE: string =
  (Constants.expoConfig?.extra as any)?.apiBaseUrl || "https://agent.hrletsgo.me";

const TOKEN_KEY = "hrh_token";
let _token: string | null = null;

export async function loadToken(): Promise<string | null> {
  if (_token) return _token;
  _token = await AsyncStorage.getItem(TOKEN_KEY);
  return _token;
}
export async function setToken(t: string | null): Promise<void> {
  _token = t;
  if (t) await AsyncStorage.setItem(TOKEN_KEY, t);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

async function authHeaders(): Promise<Record<string, string>> {
  const t = await loadToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    const d = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(d.detail || res.statusText);
  }
  return (await res.json()) as T;
}

// Native WS can't set Authorization headers reliably -> pass ?token=.
export async function wsUrl(path: string): Promise<string> {
  const t = await loadToken();
  const base = API_BASE.replace(/^http/, "ws") + path;
  return t ? `${base}?token=${encodeURIComponent(t)}` : base;
}

// ---- auth ----
export async function login(username: string, password: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({ detail: "login failed" }));
    throw new Error(d.detail || "login failed");
  }
  const d = await res.json();
  await setToken(d.token);
}
export async function logout(): Promise<void> {
  await setToken(null);
}

// ---- types + endpoints (same surface as the web client) ----
export interface ProviderStatus {
  provider: string;
  connected: boolean;
  auth_mode: string;
  detail: string;
}
export interface Connection {
  id: string;
  name: string;
  host: string | null;
  port: number | null;
  username: string | null;
}
export interface Session {
  id: string;
  title: string;
  provider: string;
  workspace_path: string;
  connection_id: string | null;
}
export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const listProviders = () => apiFetch<ProviderStatus[]>("/api/providers");
export const listConnections = () => apiFetch<Connection[]>("/api/connections");
export const listSessions = () => apiFetch<Session[]>("/api/sessions");
export const listDir = (path: string, connectionId: string | null) => {
  const q = new URLSearchParams({ path });
  if (connectionId) q.set("connection_id", connectionId);
  return apiFetch<{ entries: DirEntry[]; path: string }>(`/api/workspaces/list?${q}`);
};
export const createSession = (body: {
  provider: string;
  model: string;
  connection_id: string | null;
  workspace_path: string;
  title: string;
}) => apiFetch<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) });
