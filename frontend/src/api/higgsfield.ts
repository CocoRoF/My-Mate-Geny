// Higgsfield (docs/higgsfield.md): sign-in, accounts, credits, quotes, the CLI and skills the chats get.
import { apiFetch } from "./client";

export interface HiggsfieldWorkspace {
  id: string;
  name: string;
  type?: string | null;
}

export interface HiggsfieldAccount {
  id: string;
  label: string;
  email: string | null;
  source: "oauth" | "import" | string;
  is_default: boolean;
  plan: string | null;
  credits: number | null;
  workspace_id: string | null;
  workspaces: HiggsfieldWorkspace[];
  refreshed_at: string | null;
  /** ok | reauth (sign in again) | error (the last check failed) */
  status: "ok" | "reauth" | "error" | string;
  error: string | null;
  checked_at: string | null;
  has_refresh_token: boolean;
  token_expires_at: string | null;
  created_at: string | null;
}

export interface HiggsfieldStatus {
  connected: boolean;
  default_id: string | null;
  accounts: HiggsfieldAccount[];
  cli: { available: boolean; path: string | null };
  skills: { host: string[]; bundled: string[]; installed_at: string | null; source: string };
  redirect_uri: string;
}

export interface HiggsfieldTransaction {
  action: string;
  created_at: string | null;
  credits: number | null;
  display_name: string;
}

export interface HiggsfieldJobType {
  job_type: string;
  display_name: string;
  type: string | null;
}

export const getHiggsfield = (recheck = false) =>
  apiFetch<HiggsfieldStatus>(`/api/higgsfield${recheck ? "?recheck=1" : ""}`);

export const startHiggsfieldLogin = (accountId?: string) =>
  apiFetch<{ authorize_url: string; redirect_uri: string; state: string; expires_in: number }>(
    "/api/higgsfield/login/start",
    { method: "POST", body: JSON.stringify({ account_id: accountId ?? null }) },
  );

export const completeHiggsfieldLogin = (callback: string) =>
  apiFetch<HiggsfieldAccount>("/api/higgsfield/login/complete", {
    method: "POST",
    body: JSON.stringify({ callback }),
  });

export const importHiggsfieldCredentials = (credentials: string) =>
  apiFetch<HiggsfieldAccount>("/api/higgsfield/import", { method: "POST", body: JSON.stringify({ credentials }) });

export const refreshHiggsfieldAccount = (id: string) =>
  apiFetch<HiggsfieldAccount>(`/api/higgsfield/accounts/${id}/refresh`, { method: "POST" });

export const updateHiggsfieldAccount = (id: string, patch: { label?: string; workspace_id?: string; is_default?: boolean }) =>
  apiFetch<HiggsfieldAccount>(`/api/higgsfield/accounts/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export const disconnectHiggsfieldAccount = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/higgsfield/accounts/${id}`, { method: "DELETE" });

export const higgsfieldTransactions = (id: string, size = 20) =>
  apiFetch<{ items: HiggsfieldTransaction[]; cursor: string | null }>(`/api/higgsfield/accounts/${id}/transactions?size=${size}`);

export const higgsfieldUsage = () =>
  apiFetch<{ connected: boolean; account: HiggsfieldAccount | null; transactions: HiggsfieldTransaction[]; error: string | null }>(
    "/api/higgsfield/usage",
  );

export const higgsfieldJobTypes = () => apiFetch<{ job_types: HiggsfieldJobType[] }>("/api/higgsfield/job-types");

export const higgsfieldQuote = (jobType: string, params: Record<string, unknown>) =>
  apiFetch<{ job_type: string; credits: number }>("/api/higgsfield/quote", {
    method: "POST",
    body: JSON.stringify({ job_type: jobType, params }),
  });

export const installHiggsfieldSkills = () =>
  apiFetch<HiggsfieldStatus["skills"]>("/api/higgsfield/skills/install", { method: "POST" });

export const removeHiggsfieldSkills = () => apiFetch<HiggsfieldStatus["skills"]>("/api/higgsfield/skills", { method: "DELETE" });

/** "<code>: <message>" (the server's error) → the code, when it is one of ours */
export function higgsfieldErrorCode(e: unknown): string | null {
  const text = String((e as Error)?.message ?? e ?? "");
  const m = /^([a-z_]+)(?::|$)/.exec(text);
  return m ? m[1] : null;
}
