import { apiFetch } from "./client";
import type { ProviderStatus } from "../types";

export type LogLevel = "error" | "warning" | "info";

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  source: string;
  code: string;
  message: string;
  detail: Record<string, any>;
  session_id: string | null;
  path: string | null;
  ip: string | null;
}

export interface LogFilter {
  level?: string;
  source?: string;
  q?: string;
  session_id?: string;
  before_id?: number;
  limit?: number;
}

export interface LogStats {
  last_24h: Record<LogLevel, number>;
  last_7d: Record<LogLevel, number>;
  by_source_24h: Record<string, number>;
  hourly: { hour: string; error: number; warning: number }[];
  total: number;
}

export interface ActiveRun {
  session_id: string;
  title: string;
  provider: string;
  model: string;
  started_at: string;
  tools: number;
  attachments: number;
  account?: string;
  connection_id: string | null;
  workspace: string;
}

export interface SystemInfo {
  version: string;
  started_at: string;
  uptime_s: number;
  hostname: string;
  python: string;
  platform: string;
  cli: Record<string, string>;
  providers: ProviderStatus[];
  active_runs: ActiveRun[];
  engines?: {
    session_id: string;
    pid: number | null;
    model: string;
    mode: string;
    turn_active: boolean;
    running_tasks: number;
    idle_s: number;
    account?: string | null;
  }[];
  counts: Record<string, number>;
  storage: {
    db_bytes: number;
    uploads_bytes: number;
    disk_total: number | null;
    disk_used: number | null;
    disk_free: number | null;
  };
  memory?: { jobs: Record<string, number>; fts: boolean; sources: number; unindexed: number; episodes: number; latency_ms: number; cost_usd: number; daily_call_limit: number };
  limits: Record<string, number>;
}

export interface SecurityInfo {
  your_ip: string;
  max_login_fails: number;
  ban_hours: number;
  attempts: { ip: string; fails: number; banned_until: string | null; updated_at: string; banned: boolean }[];
}

const qs = (f: LogFilter) => {
  const p = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => v !== undefined && v !== "" && p.set(k, String(v)));
  return p.toString();
};

export const listLogs = (f: LogFilter) =>
  apiFetch<{ items: LogEntry[]; has_more: boolean }>(`/api/admin/logs?${qs(f)}`);
export const logStats = () => apiFetch<LogStats>("/api/admin/logs/stats");
export const clearLogs = () => apiFetch<{ deleted: number }>("/api/admin/logs", { method: "DELETE" });
export const systemInfo = () => apiFetch<SystemInfo>("/api/admin/system");
export const securityInfo = () => apiFetch<SecurityInfo>("/api/admin/security");
export const revokeAllSessions = () => apiFetch("/api/auth/revoke-all", { method: "POST" });

/** Where the sign-in credentials come from (precedence db > env > default). */
export interface AuthStatus {
  username: string;
  source: "db" | "env" | "default";
  default_password: boolean;
  updated_at: string | null;
  min_password_length: number;
}
export const authStatus = () => apiFetch<AuthStatus>("/api/auth/status");
/** Change username and/or password (empty new_password = keep it). Signs out
 * every other session; this browser gets a fresh cookie. */
export const changeCredentials = (body: { current_password: string; username: string; new_password: string }) =>
  apiFetch<AuthStatus & { ok: true }>("/api/auth/credentials", { method: "POST", body: JSON.stringify(body) });
/** Fired after a successful change so the banner / signed-in name re-check. */
export const AUTH_CHANGED_EVENT = "hrh-auth-changed";

// One request shared by every consumer (banner, sidebar) until a change.
let statusPromise: Promise<AuthStatus> | null = null;
export const sharedAuthStatus = () => {
  if (!statusPromise) statusPromise = authStatus().catch((e) => ((statusPromise = null), Promise.reject(e)));
  return statusPromise;
};
if (typeof window !== "undefined") window.addEventListener(AUTH_CHANGED_EVENT, () => (statusPromise = null), true);
export const unbanIp = (ip: string) =>
  apiFetch(`/api/admin/security/${encodeURIComponent(ip)}`, { method: "DELETE" });

// ---- browser error reporting -------------------------------------------------

let reporting = false;
const seen = new Map<string, number>();

/** Fire-and-forget: send an uncaught browser error to the admin log. */
export function reportClientError(e: { message: string; kind: string; stack?: string; source?: string }) {
  if (reporting) return;
  const key = `${e.kind}:${e.message}`;
  const last = seen.get(key) || 0;
  if (Date.now() - last < 30_000) return; // same error at most every 30s
  seen.set(key, Date.now());
  reporting = true;
  fetch("/api/admin/client-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...e, url: window.location.href, user_agent: navigator.userAgent }),
  })
    .catch(() => {})
    .finally(() => (reporting = false));
}

export function installClientErrorReporter() {
  window.addEventListener("error", (ev) => {
    reportClientError({
      kind: "error",
      message: String(ev.message || ev.error?.message || "script error"),
      stack: ev.error?.stack,
      source: ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r: any = ev.reason;
    reportClientError({
      kind: "unhandledrejection",
      message: String(r?.message || r || "unhandled promise rejection"),
      stack: r?.stack,
    });
  });
}
