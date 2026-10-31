export interface ProviderStatus {
  provider: string;
  connected: boolean;
  auth_mode: string;
  detail: string;
}

export interface Connection {
  id: string;
  name: string;
  kind: string;
  host: string | null;
  port: number | null;
  username: string | null;
  default_path: string | null;
  has_key: boolean;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  title: string;
  provider: string;
  model: string;
  effort: string;
  connection_id: string | null;
  workspace_path: string;
  cli_session_id: string | null;
  mode: "agent" | "plan";
  extra_dirs: string[];
  cli_info?: CliInfo;
  running?: boolean;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

/** What the provider CLI reported about itself at the start of the last turn. */
export interface CliInfo {
  model?: string;
  cwd?: string;
  tools?: string[];
  slash_commands?: string[];
  terminal_slash_commands?: string[]; // interactive-only; not usable headless
  skills?: string[];
  agents?: string[];
  mcp_servers?: { name: string; status: string; source?: string }[];
  plugins?: { name: string; source?: string }[];
  permissionMode?: string;
  additional_directories?: string[] | null;
  claude_code_version?: string;
  account?: string | null;
}

export interface CatalogModel {
  id: string;
  label: string;
  description?: string;
  effort?: string[]; // per-model reasoning levels (Codex)
  default_effort?: string;
  context_window?: number | null;
}

export interface ProviderCatalogEntry {
  label: string;
  models: CatalogModel[];
  default_model: string;
  effort: string[];
  default_effort: string;
}

export type ProviderCatalog = Record<string, ProviderCatalogEntry>;

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
  url: string; // original
  preview_url: string; // model-sized variant for images (falls back to original)
  created_at: string;
}

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  attachments?: Attachment[];
}

export type EventType =
  | "session.start"
  | "text.delta"
  | "thinking.delta"
  | "tool.use"
  | "tool.result"
  | "turn.complete"
  | "error"
  | "notice"
  | "session.info"
  | "run.state"
  | "user.message"
  | "user.steer"
  | "steer.rejected"
  | "task.update"
  | "task.state"
  | "usage.update"
  | "turn.changes";

export interface ProviderEvent {
  type: EventType;
  seq: number;
  eid?: number; // events-table id (resume cursor); absent for live-only messages
  timestamp: string;
  data: Record<string, unknown>;
}

/** A background / long-running task the Claude engine reported. */
export interface TaskInfo {
  session_id?: string;
  task_id: string;
  tool_use_id?: string | null;
  description?: string | null;
  task_type?: string | null;
  is_backgrounded?: boolean;
  status: string; // running | completed | failed | stopped | killed | lost
  summary?: string | null;
  started_at?: number | null; // epoch seconds
  ended_at?: number | null;
}

export interface ChangedFile {
  path: string;
  old_path?: string;
  status: string; // A M D R C
  added?: number;
  removed?: number;
  binary?: boolean;
}

export interface ChangeRepo {
  root: string;
  before: string;
  after: string;
  files: ChangedFile[];
  added: number;
  removed: number;
  truncated?: boolean;
}

/** Files one turn changed (git snapshots), plus the event id for diffs/revert. */
export interface TurnChanges {
  eid?: number;
  repos: ChangeRepo[];
  files: number;
  added: number;
  removed: number;
}

/** Live plan utilization (Claude rate_limit_event; utilization is a 0..1
 * fraction), tagged by the backend with the chat + account it belongs to. */
export interface PlanUsage {
  status?: string;
  utilization?: number;
  resetsAt?: number;
  rateLimitType?: string;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }>;
  account?: string | null;
  account_id?: string | null;
  session_id?: string;
  provider?: string;
  at?: string;
}

/** The account a chat's engine runs on (lease label + id). */
export interface AccountRef {
  account: string | null;
  account_id: string | null;
  provider?: string | null;
  live?: boolean; // its engine is running right now
}
