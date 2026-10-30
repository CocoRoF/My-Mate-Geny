import { apiFetch } from "./client";

export interface UsageSummary {
  total: { turns: number; cost_usd: number; input: number; output: number; cache_read: number; cache_write: number };
  by_provider: Record<string, { turns: number; cost_usd: number; input: number; output: number }>;
  by_model: Record<string, { turns: number; cost_usd: number; tokens: number }>;
  series: { day: string; turns: number; cost_usd: number; tokens: number }[];
  recent: { session_id: string; title: string; provider: string; model: string; cost_usd: number; tokens: number; at: string }[];
}

export const getUsage = (days = 14) => apiFetch<UsageSummary>(`/api/usage?days=${days}`);

export interface UsageWindow {
  label: string;
  percent: number;
  resets_at: string | null;
}
export interface SubscriptionUsage {
  provider: string;
  available: boolean;
  error?: string;
  detail?: string;
  account?: { auth_method: string; email: string; organization: string; plan: string };
  windows?: UsageWindow[];
  model_windows?: UsageWindow[];
  manage_url?: string;
}

export const getSubscription = (provider: string, accountId?: string) => {
  const q = new URLSearchParams({ provider });
  if (accountId) q.set("account_id", accountId);
  return apiFetch<SubscriptionUsage>(`/api/usage/subscription?${q}`);
};
