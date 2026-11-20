// A mate as a file (app/mate/transfer.py; docs/mate.md "Export and import"): her package to download, a new mate from one.
import { toLogin } from "./client";
import type { Mate } from "./mates";

/** where her package downloads from (a plain link: the browser, the desktop app and the phone app save it as a download) */
export const mateExportUrl = (id: string) => `/api/mates/${encodeURIComponent(id)}/export`;

/** what of her couldn't come along as it was: "voice:tts:elevenlabs" (that engine isn't set up here), "llm", "icon" */
export interface MateImport {
  mate: Mate;
  notes: string[];
}

export async function importMateFile(file: File): Promise<MateImport> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch("/api/mates/import", { method: "POST", body: form });
  if (res.status === 401) {
    toLogin();
    throw new Error("authentication required"); // i18n-ignore (the page goes to the login page)
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json() as Promise<MateImport>;
}
