import { apiFetch } from "./client";
import type { OAuthStart } from "./providers";

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
  in_flight: number;
  eligible: boolean;
  ineligible_reason: string | null;
  total_leases: number;
  total_failures: number;
  consecutive_failures: number;
  cooldown_until: string | null;
  last_used_at: string | null;
  last_error: string | null;
}

export interface PoolConfig {
  pool: { provider: string; enabled: boolean; strategy: string };
  accounts: Account[];
}

const base = (p: string) => `/api/providers/${p}`;

export const getPool = (provider: string) => apiFetch<PoolConfig>(`${base(provider)}/pool`);

export const setPool = (provider: string, patch: { enabled?: boolean; strategy?: string }) =>
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
