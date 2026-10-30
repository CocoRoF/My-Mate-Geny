import { apiFetch } from "./client";
import type { DirEntry } from "../types";

export interface ListDirResult {
  connection_id: string | null;
  path: string;
  entries: DirEntry[];
}

export const listDir = (path: string, connectionId: string | null = null) => {
  const q = new URLSearchParams({ path });
  if (connectionId) q.set("connection_id", connectionId);
  return apiFetch<ListDirResult>(`/api/workspaces/list?${q.toString()}`);
};

export interface GitInfo {
  is_repo: boolean;
  remote?: string;
  repo?: string;
  branch?: string;
  changes?: number;
  ahead?: number;
  behind?: number;
  error?: string;
}

export const getGitInfo = (path: string, connectionId: string | null = null) => {
  const q = new URLSearchParams({ path });
  if (connectionId) q.set("connection_id", connectionId);
  return apiFetch<GitInfo>(`/api/workspaces/git-info?${q.toString()}`);
};
