// Settings → Providers → CLI versions (backend: app/routers/cli_tools.py, app/services/cli_tools)
import { apiFetch } from "./client";

export type CliMethod = "native" | "npm" | "managed" | "unknown" | "missing";
export type JobState = "queued" | "waiting" | "running" | "verifying" | "succeeded" | "failed" | "cancelled";

export interface CliJob {
  id: string;
  tool: string;
  target: string;
  from_version: string | null;
  when: "now" | "idle";
  reason: "manual" | "auto" | "pin";
  method: string;
  command: string;
  switch_to_managed: boolean;
  state: JobState;
  active: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  log: string[];
  log_start: number;
  error_code: string | null;
  error: string | null;
  result: { version?: string; path?: string; seconds?: number; engines?: { restarted: number; deferred: number } };
  waiting_for: number;
  mem_cap: string | null;
}

export interface CliTool {
  id: string;
  label: string;
  package: string;
  installed: {
    binary: string;
    path: string | null;
    realpath: string | null;
    version: string | null;
    raw: string | null;
    error: string | null;
    method: CliMethod;
    prefix: string | null;
    writable: boolean;
    checked_at: string;
  };
  using_managed: boolean;
  managed_path: string;
  managed_installed: boolean;
  bundled: { path: string | null; version: string | null; method: CliMethod; error: string | null } | null;
  channel: string;
  channels: string[];
  latest: { version: string | null; tags: Record<string, string>; checked_at: string | null; error: string | null };
  update_available: boolean;
  notes: { url: string; sections: { version: string; items: string[]; count: number }[]; error: string | null } | null;
  release_url: string;
  upgrade:
    | { possible: true; method: string; in_place: boolean; switch_to_managed: boolean; reason: string; command: string; prefix: string | null }
    | { possible: false; code: string };
  previous_version: string | null;
  auto_upgrade: boolean;
  self_update: { enabled: boolean; source: string; channel: string } | null;
  restart: "next_turn" | "engine_restart";
  engines: { total: number; stale: number } | null;
  job: CliJob | null;
}

export interface CliStatus {
  tools: CliTool[];
  running_chats: number;
  checking: boolean;
  check_enabled: boolean;
  ttl_h: number;
  mem_cap: { available: boolean; size: string };
  managed_prefix: string;
  version: number;
}

/** an API error with the backend's machine-readable code (translated in the UI) */
export class CliError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

/** like apiFetch, but keeps `code` from {"detail", "code"} error bodies */
async function callCoded<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  if (res.status === 401) return apiFetch<T>(path, init); // the shared client sends us to the login page
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new CliError(String(body.detail || res.statusText), String(body.code || "error"));
  return body as T;
}

export const getCliStatus = () => apiFetch<CliStatus>("/api/cli-tools");
export const checkCli = (tool?: string) => apiFetch<CliStatus>("/api/cli-tools/check", { method: "POST", body: JSON.stringify({ tool: tool ?? null }) });
export const upgradeCli = (tool: string, opts: { version?: string; when?: "now" | "idle" }) =>
  callCoded<CliJob>(`/api/cli-tools/${tool}/upgrade`, { method: "POST", body: JSON.stringify({ version: opts.version ?? null, when: opts.when ?? "now" }) });
export const cancelCli = (tool: string) => callCoded<CliJob>(`/api/cli-tools/${tool}/cancel`, { method: "POST" });
export const setCliSettings = (tool: string, patch: { auto_upgrade?: boolean; channel?: string; use_managed?: boolean }) =>
  callCoded<CliTool>(`/api/cli-tools/${tool}`, { method: "PUT", body: JSON.stringify(patch) });
