export interface ProviderStatus {
  provider: string;
  connected: boolean;
  auth_mode: string;
  detail: string;
  /** enabled accounts whose login needs the user (needs a sign-in / renewal failed) — the Settings badge */
  session_attention?: { account_id: string; label: string; health: string; detail: string }[];
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

/** An additional folder of a chat: a path on this server (connection_id null) or on an SSH connection's host. */
export interface Folder {
  path: string;
  connection_id: string | null;
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
  extra_dirs: string[]; // (older view: the folders on the workspace's own host)
  /** every additional folder with its host: connection_id null = this server, else an SSH connection */
  folders?: Folder[];
  git_repo?: string | null; // the top bar's Git repo: null = the workspace's own (auto), "" = none, else a path
  git_repo_host?: string | null; // that repo's host (null = this server)
  cli_info?: CliInfo;
  running?: boolean;
  background?: number; // background tasks still running (subagents, background shells)
  /** how the last run ended (null: none yet) — the sidebar's Complete / Failed / Stopped while unseen */
  last_result?: "ok" | "error" | "stopped" | null;
  last_result_at?: string | null;
  /** that result came after anyone last had this chat open (cleared by opening it, on every device) */
  result_unseen?: boolean;
  auto_compact_window?: number | null; // Claude: this chat's auto-compact window (null = global default, 0 = CLI default)
  accounts?: Record<string, { id?: string; label?: string; manual?: boolean; at?: string }>; // account it ran on last
  /** this chat's Higgsfield (docs/higgsfield.md): on unless turned off; max_credits = ask before jobs above it */
  mcp?: Record<string, boolean>;
  higgsfield?: { enabled: boolean; max_credits: number | null };
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
  auto_compact_presets?: number[]; // Claude: auto-compact window choices (0 = CLI default)
  auto_compact_buffer?: number; // the CLI compacts at window - buffer
}

export type ProviderCatalog = Record<string, ProviderCatalogEntry>;

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface Attachment {
  origin?: "user" | "screen";
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
  role: "user" | "assistant" | "steer";
  content: string;
  created_at?: string;
  attachments?: Attachment[];
  meta?: import("../stores/chatStore").MessageMeta | null;
}

export type EventType =
  | "session.start"
  | "text.delta"
  | "thinking.start"
  | "thinking.delta"
  | "thinking.end"
  | "tool.use"
  | "tool.result"
  | "subagent.text"
  | "subagent.thinking"
  | "turn.complete"
  | "error"
  | "notice"
  | "session.info"
  | "run.state"
  | "user.message"
  | "speech.pending"
  | "speech.closed"
  | "speech.failed"
  | "user.steer"
  | "session.rewound"
  | "steer.rejected"
  | "task.update"
  | "task.state"
  | "usage.update"
  | "turn.changes"
  | "context.update";

export interface ProviderEvent {
  type: EventType;
  seq: number;
  eid?: number; // events-table id (resume cursor); absent for live-only messages
  timestamp: string;
  data: Record<string, unknown>;
  /** lite history pages (backend services/history_lite.py): this tool event's
   * input / output is a preview; the original comes from the events endpoint */
  lazy?: { input?: { size: number; cut: string[] }; output?: { size: number; lines: number } };
  /** a folded task.update: the eids of the updates it stands for */
  covers?: number[];
}

/** A background / long-running task the Claude engine reported. */
export interface TaskInfo {
  updated_at?: string;
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
  // Subagent progress (live from the engine, not stored with the task)
  subagent_type?: string | null;
  activity?: string | null; // what it is doing now ("Running …")
  last_tool_name?: string | null;
  tool_uses?: number | null;
  total_tokens?: number | null;
  duration_ms?: number | null;
  parent_task_id?: string | null;
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
  connection_id?: string | null; // its host (null = this server; absent in records from before hosts)
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

/** The main conversation's context size against the window the CLI uses
 * (Claude). ``source`` "cli" = the engine's own count after a turn; "call" =
 * the latest API call's input + cache tokens while the turn runs. */
export interface ContextInfo {
  tokens: number | null;
  window?: number | null; // effective window (auto-compact window or the model's)
  model_window?: number | null;
  threshold?: number | null; // the CLI auto-compacts once the context reaches this
  auto_compact?: boolean;
  window_source?: string | null; // env | model-default | settings… | estimate
  source?: "cli" | "call";
  model?: string | null;
  at?: string;
}

/** A compaction boundary (the CLI summarised the conversation). */
export interface Compaction {
  trigger?: "auto" | "manual" | null;
  pre_tokens?: number | null;
  post_tokens?: number | null;
  at: string;
}
