import { apiFetch } from "./client";

export interface UsageSummary {
  total: { turns: number; cost_usd: number; input: number; output: number; cache_read: number; cache_write: number };
  by_provider: Record<string, { turns: number; cost_usd: number; input: number; output: number }>;
  by_model: Record<string, { turns: number; cost_usd: number; tokens: number }>;
  series: { day: string; turns: number; cost_usd: number; tokens: number }[];
  recent: { session_id: string; title: string; provider: string; model: string; cost_usd: number; tokens: number; at: string }[];
}

export const getUsage = (days = 14) => apiFetch<UsageSummary>(`/api/usage?days=${days}`);
