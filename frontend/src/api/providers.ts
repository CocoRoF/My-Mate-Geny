import { apiFetch } from "./client";
import type { ProviderStatus } from "../types";

export const listProviders = () => apiFetch<ProviderStatus[]>("/api/providers");

export const connectProvider = (provider: string, auth_mode: string, api_key = "") =>
  apiFetch<ProviderStatus>(`/api/providers/${provider}/connect`, {
    method: "POST",
    body: JSON.stringify({ auth_mode, api_key }),
  });

export const disconnectProvider = (provider: string) =>
  apiFetch(`/api/providers/${provider}/disconnect`, { method: "POST" });

// ---- web OAuth ----
export interface OAuthStart {
  flow: "device" | "paste";
  url?: string;
  user_code?: string;
  error?: string;
}
export const oauthStart = (provider: string) =>
  apiFetch<OAuthStart>(`/api/providers/${provider}/oauth/start`, { method: "POST" });

export const oauthStatus = (provider: string) =>
  apiFetch<{ status: "pending" | "connected" | "failed"; error?: string }>(
    `/api/providers/${provider}/oauth/status`,
  );

export const oauthComplete = (provider: string, code: string) =>
  apiFetch<{ ok: boolean; error?: string }>(`/api/providers/${provider}/oauth/complete`, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
