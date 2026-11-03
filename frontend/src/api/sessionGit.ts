import { apiFetch } from "./client";

/** A chat's Git repository (backend/app/services/session_git.py). */
export interface GitFile {
  path: string;
  status: string; // M A D R C U ? (git porcelain)
  staged: boolean;
}

export interface GitStatus {
  mode: "auto" | "set" | "off"; // auto = the workspace's repo; set = a chosen repo; off = disconnected
  path: string | null;
  connection_id?: string | null; // the repo's host (null = this server)
  connected: boolean;
  is_repo: boolean;
  error?: string;
  root?: string;
  remote?: string;
  repo?: string;
  branch?: string;
  detached?: boolean;
  initial?: boolean;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  changes?: number;
  counts?: { staged: number; modified: number; untracked: number; conflicted: number; deleted: number; added: number };
  files?: GitFile[];
  files_truncated?: boolean;
  last_commit?: { sha: string; subject: string; author: string; date: string } | null;
}

export interface GitBranches {
  current: string;
  local: { name: string; upstream: string | null }[];
  remote: { name: string; short: string }[];
}

export interface FoundRepo {
  path: string;
  branch: string;
  remote: string;
  repo: string;
  where: "workspace" | "folder";
  connection_id?: string | null; // its host (null = this server)
}

const base = (sid: string) => `/api/sessions/${sid}/git`;

export const getSessionGit = (sid: string) => apiFetch<GitStatus>(base(sid));
/** `conn`: the repo's host (null = this server; undefined = the workspace's host). */
export const connectSessionGit = (sid: string, path: string, addFolder = false, conn?: string | null) =>
  apiFetch<GitStatus>(base(sid), {
    method: "PUT",
    body: JSON.stringify({ path, add_folder: addFolder, ...(conn === undefined ? {} : { connection_id: conn }) }),
  });
export const disconnectSessionGit = (sid: string) => apiFetch<GitStatus>(base(sid), { method: "DELETE" });
export const sessionGitBranches = (sid: string) => apiFetch<GitBranches>(`${base(sid)}/branches`);
export const sessionGitCheckout = (sid: string, branch: string, track = false) =>
  apiFetch<GitStatus>(`${base(sid)}/checkout`, { method: "POST", body: JSON.stringify({ branch, track }) });
export const detectSessionRepos = (sid: string) =>
  apiFetch<{
    repos: FoundRepo[];
    mode: GitStatus["mode"];
    current: string | null;
    errors?: { connection_id: string | null; error: string }[]; // hosts that couldn't be read
  }>(`${base(sid)}/detect`);

export interface CloneInput {
  clone_url: string; // https, no credentials in it
  connection_id: string | null; // where: null = this server, else an SSH connection
  account_id?: string | null; // a Git account's token (else anonymous: a public repo)
  full_name?: string;
  parent?: string; // folder to clone into (an SSH host: default ~/repos)
}

/** Clone onto this server or an SSH host (the token is used once, never stored there), then connect it. */
export const cloneSessionRepo = (sid: string, body: CloneInput) =>
  apiFetch<GitStatus>(`${base(sid)}/clone`, { method: "POST", body: JSON.stringify(body) });
