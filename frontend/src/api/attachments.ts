import type { Attachment } from "../types";
import { apiFetch, toLogin } from "./client";
import { tr } from "../i18n";

export const getUploadLimits = () =>
  apiFetch<{ max_mb: number; max_files: number }>("/api/attachments/limits");

/** Upload one file with progress (XHR — fetch can't report upload progress). */
export function uploadAttachment(
  sessionId: string,
  file: File,
  onProgress: (fraction: number) => void,
): { promise: Promise<Attachment>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open("POST", `/api/sessions/${sessionId}/attachments`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status === 401) toLogin();
      if (xhr.status >= 200 && xhr.status < 300 && Array.isArray(body)) resolve(body[0]);
      else reject(new Error(body?.detail || tr("files.uploadFailed", { status: String(xhr.status) })));
    };
    xhr.onerror = () => reject(new Error(tr("files.uploadNetwork")));
    xhr.onabort = () => reject(new Error(tr("files.uploadCancelled")));
    const form = new FormData();
    form.append("files", file, file.name);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export const deleteAttachment = (id: string) =>
  apiFetch(`/api/attachments/${id}`, { method: "DELETE" });

export const downloadUrl = (a: Attachment) => `${a.url}?download=1`;
