import { apiFetch } from "./client";

export interface McpEntry {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string[];
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
