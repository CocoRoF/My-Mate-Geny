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
