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
  /** why the numbers are old: rate_limited | token_expired | needs_login | auth | network | http | no_credentials */
  plan_stale_reason?: string | null;
  plan_retry_at?: string | null; // when the server will ask again (while something is wrong)
  plan_checked_at?: string | null;
  session?: LoginSession | null; // the login, read from the credentials file (never a token)
  total_leases: number;
  total_failures: number;
  consecutive_failures: number;
  cooldown_until: string | null;
  last_used_at: string | null;
  last_error: string | null;
}

export type SessionHealth = "valid" | "expiring" | "expired" | "refresh_failed" | "needs_login" | "no_credentials";

/** An account's login session (backend providers/login_session.py) — what the CLI's credentials file says. */
export interface LoginSession {
  method: "oauth" | "setup_token" | "api_key" | "chatgpt" | "none";
  email: string;
  organization: string;
  plan: string;
  rate_limit_tier: string;
  expires_at: string | null; // access token
  expires_in_s: number | null;
  has_refresh_token: boolean;
  refresh_expires_at: string | null;
  updated_at: string | null; // the file was last written (Claude) / last_refresh (Codex)
  scopes: string[];
  /** expired = the access token ran out but renews on the next use (information); needs_login / refresh_failed = act */
  health: SessionHealth;
  detail: string;
  actionable: boolean;
  renewable: boolean;
  checked_at: string | null;
  last_renew?: { at: string | null; ok: boolean; method: string | null; code: string | null; error: string | null };
}

export interface RenewResult {
  ok: boolean;
  method?: "cli" | "direct" | "already" | null; // who renewed it
  code: string; // why not (invalid_grant, lock_busy, network, …) / not_needed
  error: string;
  session: LoginSession | null;
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

/** Renew the login the CLI's way (the host login's id is `__primary__<provider>`). */
export const renewSession = (provider: string, id: string) =>
  apiFetch<RenewResult>(`${base(provider)}/accounts/${encodeURIComponent(id)}/session/renew`, { method: "POST" });

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
