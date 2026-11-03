import { apiFetch } from "./client";

// cost_usd everywhere = API-equivalent (what the tokens would cost on the API).
export interface UsageSummary {
  cost_basis?: "api_equivalent";
  total: {
    turns: number;
    cost_usd: number;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
  by_provider: Record<
    string,
    { turns: number; cost_usd: number; input: number; output: number }
  >;
  by_model: Record<string, { turns: number; cost_usd: number; tokens: number }>;
  series: { day: string; turns: number; cost_usd: number; tokens: number }[];
  recent: {
    session_id: string;
    title: string;
    provider: string;
    model: string;
    cost_usd: number;
    tokens: number;
    at: string;
  }[];
}

export const getUsage = (days = 14) =>
  apiFetch<UsageSummary>(`/api/usage?days=${days}`);

export interface UsageWindow {
  label: string;
  percent: number; // 0..100
  resets_at: string | null;
  kind?: "five_hour" | "seven_day" | "model_weekly" | "daily" | "other";
}
export interface SubscriptionUsage {
  provider: string;
  available: boolean;
  error?: string;
  detail?: string;
  account?: {
    auth_method: string;
    email: string;
    organization: string;
    plan: string;
  };
  windows?: UsageWindow[];
  model_windows?: UsageWindow[];
  manage_url?: string;
  stale?: string; // a refresh failed: these are the last good numbers, and why
  fetched_at?: string | null; // when these numbers were fetched
  stale_reason?: string | null; // rate_limited | token_expired | needs_login | auth | network | http | no_credentials
  retry_at?: string | null; // when the server asks again (while backing off)
}

/** `refresh`: ask now unless that account is backing off (Retry-After) — the same per-account fetcher as the cards */
export const getSubscription = (
  provider: string,
  accountId?: string,
  refresh = false,
) => {
  const q = new URLSearchParams({ provider });
  if (accountId) q.set("account_id", accountId);
  if (refresh) q.set("refresh", "true");
  return apiFetch<SubscriptionUsage>(`/api/usage/subscription?${q}`);
};

export interface WeekNumbers {
  turns: number;
  tokens: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  unknown_cost_turns: number;
  unknown_token_turns: number;
}
export interface WeekItem extends WeekNumbers {
  id: string;
  title: string;
  session_id: string;
  mate_id: string | null;
  share: number;
  models: { provider: string; model: string }[];
}
export interface WeekSource extends WeekNumbers {
  source: "chat" | "mate" | "internal";
  share: number;
  items: WeekItem[];
}
export interface UsageWeek {
  days: 7;
  timezone: string;
  from: string;
  to: string;
  cost_basis: "api_equivalent";
  ratio_basis: "tokens";
  total: WeekNumbers;
  sources: WeekSource[];
  daily: ({ day: string } & Record<
    "chat" | "mate" | "internal",
    WeekNumbers
  >)[];
  historical_source_inferred_turns: number;
}
export const getUsageWeek = () =>
  apiFetch<UsageWeek>(
    `/api/usage/week?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}`,
  );
