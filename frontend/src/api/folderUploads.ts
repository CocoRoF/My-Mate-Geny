import { apiFetch, toLogin } from "./client";
import type { Session } from "../types";
import { tr } from "../i18n";

/** backend/app/services/folder_upload.py: a folder from the user's computer, uploaded as a copy. */
export interface FolderUploadLimits {
  max_bytes: number;
  max_files: number;
  max_file_bytes: number;
  skip: string[];
  dir: string; // ".geny-uploads"
}

export const folderUploadLimits = () => apiFetch<FolderUploadLimits>("/api/folder-uploads/limits");

/** Does the server see this computer's filesystem? (the desktop app's probe file) */
export const probeSameHost = (probe_path: string, nonce: string, path: string) =>
  apiFetch<{ same_host: boolean; is_dir: boolean; path: string }>("/api/folder-uploads/probe", {
    method: "POST",
    body: JSON.stringify({ probe_path, nonce, path }),
  });

export const beginFolderUpload = (sid: string, name: string, files: number, bytes: number) =>
  apiFetch<{ id: string; name: string; remote: boolean }>(`/api/sessions/${sid}/folder-uploads`, {
    method: "POST",
    body: JSON.stringify({ name, files, bytes }),
  });

export const finishFolderUpload = (sid: string, uid: string) =>
  apiFetch<{ path: string; files: number; bytes: number; skipped: number; session: Session }>(
    `/api/sessions/${sid}/folder-uploads/${uid}/finish`,
    { method: "POST" },
  );

export const abortFolderUpload = (sid: string, uid: string) =>
  apiFetch(`/api/sessions/${sid}/folder-uploads/${uid}`, { method: "DELETE" }).catch(() => {});

/** One batch (multipart: files + their paths), with upload progress (bytes of this batch). */
export function sendFolderBatch(
  sid: string,
  uid: string,
  items: { rel: string; blob: Blob }[],
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<{ files: number; bytes: number; skipped: number }> {
  const form = new FormData();
  for (const it of items) {
    form.append("files", it.blob, it.rel.split("/").pop() || "file");
    form.append("paths", it.rel);
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/sessions/${sid}/folder-uploads/${uid}/files`);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status === 401) {
        toLogin();
        return reject(new Error("authentication required")); // i18n-ignore (the page goes to the login screen)
      }
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not json */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.detail || xhr.statusText || tr("workspace.uploadFailed", { status: String(xhr.status) })));
    };
    xhr.onerror = () => reject(new Error(tr("files.uploadNetwork")));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}
