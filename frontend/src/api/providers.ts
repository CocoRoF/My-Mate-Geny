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
