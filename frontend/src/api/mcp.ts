import { apiFetch } from "./client";

export interface McpEntry {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: (string | null)[];
  cwd: string;
  url: string;
  env: Record<string, null>;
  headers: Record<string, null>;
  enabled: boolean;
  timeout_s: number;
  log_stderr: boolean;
  server_info?: { name?: string; version?: string };
  protocol?: string;
  state: string;
  error: string;
  error_code?: string;
  catalog_id?: string;
  repair_recipe?: string | null;
  updated_at: string;
  connected_at: number | null;
  execution_mode: string;
  tool_count: number;
  tools: McpToolSummary[];
  metrics: {
    calls: number;
    errors: number;
    cancelled?: number;
    last_ms: number;
    stderr_dropped: number;
  };
}
export interface McpCatalog {
  items: McpEntry[];
  execution_mode: string;
}
export type McpInput = Partial<
  Pick<
    McpEntry,
    | "name"
    | "transport"
    | "command"
    | "args"
    | "cwd"
    | "url"
    | "enabled"
    | "timeout_s"
    | "log_stderr"
    | "catalog_id"
  >
> & {
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
};
export const getMcp = () => apiFetch<McpCatalog>("/api/mcp");
export const saveMcp = (body: McpInput, id?: string) =>
  apiFetch<McpEntry>(id ? `/api/mcp/${encodeURIComponent(id)}` : "/api/mcp", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(body),
  });
export const removeMcp = (id: string) =>
  apiFetch(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
export const reconnectMcp = (id: string) =>
  apiFetch<McpEntry>(`/api/mcp/${encodeURIComponent(id)}/reconnect`, {
    method: "POST",
  });
export const importMcp = (body: object) =>
  apiFetch<{ items: McpEntry[]; skipped: string[] }>("/api/mcp/import", {
    method: "POST",
    body: JSON.stringify(body),
  });

export interface McpToolSummary {
  name: string;
  description?: string;
}
export const getMcpTools = (id: string, offset = 0) =>
  apiFetch<{
    items: McpToolSummary[];
    total: number;
    has_more: boolean;
    offset: number;
  }>(`/api/mcp/${encodeURIComponent(id)}/tools?offset=${offset}&limit=50`);

export interface McpTest {
  ok: boolean;
  test_id?: string;
  error?: string;
  error_code?: string;
  tool_count: number;
  tools?: { name: string }[];
  expires_in?: number;
}
export const testMcp = (definition: McpInput, existing_id?: string) =>
  apiFetch<McpTest>("/api/mcp/test", {
    method: "POST",
    body: JSON.stringify({ definition, existing_id }),
  });
export const registerMcpTest = (id: string) =>
  apiFetch<McpEntry>(`/api/mcp/tests/${encodeURIComponent(id)}/register`, {
    method: "POST",
  });
export const discardMcpTest = (id: string) =>
  apiFetch(`/api/mcp/tests/${encodeURIComponent(id)}`, { method: "DELETE" });
export interface McpInstallation {
  installed: boolean;
  version: string;
  download_required: boolean;
  phase: string;
  step: string;
  log: string[];
  error: string;
}
export type McpText = { ko: string; en: string };
export interface McpRecipeField {
  key: string;
  label: McpText;
  kind: string;
  required: boolean;
  default: string | boolean;
  choices: { value: string; label: McpText }[];
}
export interface McpRecipe {
  id: string;
  name: string;
  publisher: string;
  official: boolean;
  category: string;
  kind: "remote" | "npm" | "python";
  package?: string;
  method: string;
  source: string;
  docs: string;
  summary: McpText;
  help: McpText;
  fields: McpRecipeField[];
  verified_at: string;
  installation: McpInstallation;
}
export const listMcpRecipes = () =>
  apiFetch<{ items: McpRecipe[]; execution_mode: string }>("/api/mcp/recipes");
export const mcpRecipeDefaults = (id: string, existing_id?: string) =>
  apiFetch<{
    values: Record<string, string | boolean>;
    saved_fields: string[];
  }>(
    `/api/mcp/recipes/${encodeURIComponent(id)}/defaults${existing_id ? "?existing_id=" + encodeURIComponent(existing_id) : ""}`,
  );
export const downloadMcpRecipe = (id: string) =>
  apiFetch<McpInstallation>(
    `/api/mcp/recipes/${encodeURIComponent(id)}/download`,
    { method: "POST" },
  );
export const mcpDownloadState = (id: string) =>
  apiFetch<McpInstallation>(
    `/api/mcp/recipes/${encodeURIComponent(id)}/download`,
  );
export const cancelMcpDownload = (id: string) =>
  apiFetch<McpInstallation>(
    `/api/mcp/recipes/${encodeURIComponent(id)}/download`,
    { method: "DELETE" },
  );
export const testMcpRecipe = (
  id: string,
  values: Record<string, string | boolean>,
  name: string,
  existing_id?: string,
) =>
  apiFetch<McpTest>(`/api/mcp/recipes/${encodeURIComponent(id)}/test`, {
    method: "POST",
    body: JSON.stringify({ values, name, existing_id }),
  });
