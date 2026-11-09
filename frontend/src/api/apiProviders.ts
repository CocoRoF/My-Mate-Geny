/** Settings → Providers for the API-key providers (Anthropic, OpenAI, Google): keys and the model catalog
 *  (backend routers/api_providers.py, app/harness/models.py). Keys are the provider's pool accounts (api/accounts.ts). */
import { apiFetch } from "./client";
import type { Account } from "./accounts";

export const API_PROVIDERS = ["anthropic", "openai", "google"] as const;
export const isApiProvider = (p: string | null | undefined): boolean => !!p && (API_PROVIDERS as readonly string[]).includes(p);

export const KEY_HINTS: Record<string, { placeholder: string; url: string }> = {
  anthropic: { placeholder: "sk-ant-api03-…", url: "https://console.anthropic.com/settings/keys" },
  openai: { placeholder: "sk-proj-…", url: "https://platform.openai.com/api-keys" },
  google: { placeholder: "AIza…", url: "https://aistudio.google.com/apikey" }, // i18n-ignore (a key's format)
};

export interface KeyCheck {
  ok: boolean;
  models?: number;
  latency_ms?: number;
  kind?: string; // auth | quota | rate_limit | network | …
  error?: string;
  generation?: { ok: boolean; model: string; text?: string; latency_ms?: number; error?: string };
}

export interface ModelPrice {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  long_above?: number;
  long_input?: number;
  long_output?: number;
  long_cache_read?: number;
}

export interface ApiModel {
  id: string;
  label: string;
  enabled: boolean;
  listed: boolean; // in the vendor's list at the last refresh
  manual: boolean; // added by hand
  context_window: number | null;
  context_window_set: boolean;
  max_output: number | null;
  effort: string[];
  thinking: boolean;
  vision: boolean;
  price: ModelPrice | null;
  price_source: "custom" | "list" | null;
  list_price: ModelPrice | null;
  description: string;
  created: string | null;
  lifecycle: string | null;
}

export interface CatalogState {
  fetched_at: string | null;
  error: string | null;
}

export const addKey = (provider: string, body: { label: string; api_key: string }) =>
  apiFetch<{ account: Account | null; check: KeyCheck; catalog: { added?: number; total?: number; error?: string } | null }>(
    `/api/providers/${provider}/keys`,
    { method: "POST", body: JSON.stringify(body) },
  );

export const testKey = (provider: string, accountId: string) =>
  apiFetch<KeyCheck>(`/api/providers/${provider}/accounts/${accountId}/test`, { method: "POST" });

export const listModels = (provider: string) =>
  apiFetch<{ models: ApiModel[]; state: CatalogState }>(`/api/providers/${provider}/models`);

export const refreshModels = (provider: string) =>
  apiFetch<{ models: ApiModel[]; state: CatalogState; added: number; total: number }>(
    `/api/providers/${provider}/models/refresh`,
    { method: "POST" },
  );

export interface ModelPatch {
  enabled?: boolean;
  label?: string;
  price?: ModelPrice;
  clear_price?: boolean;
  context_window?: number;
  clear_context_window?: boolean;
}

export const updateModel = (provider: string, id: string, patch: ModelPatch) =>
  apiFetch<ApiModel>(`/api/providers/${provider}/models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const bulkModels = (provider: string, enabled: boolean, ids?: string[]) =>
  apiFetch<{ models: ApiModel[] }>(`/api/providers/${provider}/models/bulk`, {
    method: "POST",
    body: JSON.stringify({ enabled, ids }),
  });

export const addModel = (provider: string, id: string, label = "") =>
  apiFetch<ApiModel>(`/api/providers/${provider}/models`, { method: "POST", body: JSON.stringify({ id, label }) });

export const deleteModel = (provider: string, id: string) =>
  apiFetch(`/api/providers/${provider}/models/${encodeURIComponent(id)}`, { method: "DELETE" });

/** "$2 / $10" per million tokens (input / output). */
export function fmtPrice(p: ModelPrice | null | undefined): string {
  if (!p) return "";
  const f = (n: number) => (n >= 1 ? `$${+n.toFixed(2)}` : `$${+n.toFixed(3)}`);
  return `${f(p.input)} / ${f(p.output)}`;
}
