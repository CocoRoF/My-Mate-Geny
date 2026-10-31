import { apiFetch } from "./client";

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_link?: boolean;
  size: number;
  mtime: number | null;
}

export interface FsStat {
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number | null;
  mime: string | null;
  secret?: boolean;
}

export interface FsText {
  path: string;
  size: number;
  mtime: number | null;
  mime: string;
  content: string;
  encoding: string;
  binary: boolean;
  truncated: boolean;
}

const q = (path: string, conn: string | null, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams({ path, ...extra });
  if (conn) p.set("connection_id", conn);
  return p.toString();
};

export const fsList = (path: string, conn: string | null) =>
  apiFetch<{ path: string; entries: FsEntry[]; truncated: boolean }>(`/api/fs/list?${q(path, conn)}`);

export const fsStat = (path: string, conn: string | null) => apiFetch<FsStat>(`/api/fs/stat?${q(path, conn)}`);

export const fsText = (path: string, conn: string | null, limit?: number) =>
  apiFetch<FsText>(`/api/fs/text?${q(path, conn, limit ? { limit: String(limit) } : {})}`);

export const fsRawUrl = (path: string, conn: string | null, download = false) =>
  `/api/fs/raw?${q(path, conn, download ? { download: "1" } : {})}`;

/** Raw bytes for the document viewers (xlsx, docx, pdf, media). */
export async function fsBytes(path: string, conn: string | null): Promise<ArrayBuffer> {
  const res = await fetch(fsRawUrl(path, conn));
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.arrayBuffer();
}
