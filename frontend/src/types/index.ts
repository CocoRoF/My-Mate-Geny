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
  connection_id: string | null;
  workspace_path: string;
  cli_session_id: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type EventType =
  | "session.start"
  | "text.delta"
  | "thinking.delta"
  | "tool.use"
  | "tool.result"
  | "turn.complete"
  | "error";

export interface ProviderEvent {
  type: EventType;
  seq: number;
  timestamp: string;
  data: Record<string, unknown>;
}
