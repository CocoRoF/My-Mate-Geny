import { apiFetch } from "./client";
import type { OAuthStart } from "./providers";
import type { UsageWindow } from "./usage";

export interface Account {
  id: string;
  label: string;
  primary?: boolean;
  auth_mode: string;
  enabled: boolean;
  weight: number;
  max_concurrency: number;
  status: string;
  usable: boolean;
  in_flight: number; // active turns
  engines?: number; // live chat engines bound to it
  primary_mode?: PrimaryMode; // the host login: how it takes part in balancing
  limit?: { type?: string | null; resets_at?: number | null } | null; // a limit that refused it, while in force
  live_status?: string | null; // last rate-limit status an engine saw (allowed | allowed_warning | rejected)
  eligible: boolean;
  ineligible_reason: string | null;
  utilization?: number | null; // highest window % (what the balancer uses)
  windows?: UsageWindow[]; // 5-hour + 7-day (server-cached ~60s)
  model_windows?: UsageWindow[]; // per-model weekly limits, when the plan has them
  plan_fetched_at?: string | null;
  plan_error?: string | null;
  total_leases: number;
  total_failures: number;
  consecutive_failures: number;
  cooldown_until: string | null;
  last_used_at: string | null;
  last_error: string | null;
}

export type PrimaryMode = "normal" | "fallback" | "off";

/** balanced = whichever window is fuller; seven_day = spread the weekly budget
 *  first (5-hour breaks ties); five_hour = the reverse. */
export type LimitPriority = "balanced" | "seven_day" | "five_hour";

export interface PoolSettings {
  provider: string;
  enabled: boolean;
  strategy: string;
  primary_mode: PrimaryMode;
  near_5h: number; // avoid an account at/above this 5-hour %
  near_7d: number; // ... and this 7-day %
  limit_priority: LimitPriority; // which window decides between accounts
  auto_compact_window: number; // Claude: default auto-compact window (0 = CLI default)
}

export interface PoolConfig {
  pool: PoolSettings;
  accounts: Account[];
}

const base = (p: string) => `/api/providers/${p}`;

export const getPool = (provider: string) => apiFetch<PoolConfig>(`${base(provider)}/pool`);

export const setPool = (provider: string, patch: Partial<Omit<PoolSettings, "provider">>) =>
  apiFetch(`${base(provider)}/pool`, { method: "PUT", body: JSON.stringify(patch) });

export const createAccount = (
  provider: string,
  body: { label: string; auth_mode: string; weight?: number; max_concurrency?: number; api_key?: string },
) => apiFetch<Account>(`${base(provider)}/accounts`, { method: "POST", body: JSON.stringify(body) });

export const updateAccount = (
  provider: string,
  id: string,
  patch: { label?: string; enabled?: boolean; weight?: number; max_concurrency?: number },
) => apiFetch(`${base(provider)}/accounts/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export const deleteAccount = (provider: string, id: string) =>
  apiFetch(`${base(provider)}/accounts/${id}`, { method: "DELETE" });

export const clearCooldown = (provider: string, id: string) =>
  apiFetch(`${base(provider)}/accounts/${id}/cooldown/clear`, { method: "POST" });

// account OAuth (same shape as provider OAuth)
export const accountOAuthStart = (provider: string, id: string) =>
  apiFetch<OAuthStart>(`${base(provider)}/accounts/${id}/oauth/start`, { method: "POST" });
export const accountOAuthStatus = (provider: string, id: string) =>
  apiFetch<{ status: "pending" | "connected" | "failed"; error?: string }>(
    `${base(provider)}/accounts/${id}/oauth/status`,
  );
export const accountOAuthComplete = (provider: string, id: string, code: string) =>
  apiFetch<{ ok: boolean; error?: string }>(`${base(provider)}/accounts/${id}/oauth/complete`, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
