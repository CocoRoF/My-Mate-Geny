/**
 * A folder on the user's OWN computer for a chat (the top bar's Folder button).
 *
 * The server runs elsewhere, so such a folder can't simply be linked:
 * - desktop app (`hrhNative.folders`, desktop/src/folders.js): the native folder dialog; when the server shares this
 *   machine's filesystem (its probe file is readable by the server) the folder is linked as is, otherwise its files
 *   are uploaded as a copy;
 * - browsers: `<input type="file" webkitdirectory>`, always uploaded as a copy.
 * Copies land in `<workspace>/.geny-uploads/<name>` on the workspace host (backend/app/services/folder_upload.py).
 */
import {
  abortFolderUpload,
  beginFolderUpload,
  finishFolderUpload,
  sendFolderBatch,
  type FolderUploadLimits,
} from "../api/folderUploads";
import type { Session } from "../types";

export interface FolderBridge {
  pick(): Promise<{ path: string; name: string; probe: { path: string; nonce: string } } | null>;
  scan(
    root: string,
    o?: { maxFiles?: number; maxBytes?: number },
  ): Promise<{ files: { rel: string; size: number }[]; bytes: number; skipped: number; skippedNames: string[]; truncated: boolean } | null>;
  read(root: string, rel: string, maxBytes?: number): Promise<Uint8Array | null>;
  release(root: string): Promise<boolean>;
}

/** The desktop app's folder bridge; null in browsers, Android and desktop apps older than it. */
export const folderBridge = (): FolderBridge | null => {
  const f = (typeof window !== "undefined" && (window.hrhNative as any)?.folders) || null;
  return f && typeof f.pick === "function" && typeof f.read === "function" ? f : null;
};

/** Browsers that can pick a whole folder (not phones / tablets: their pickers return files, not folders). */
export const canPickDirInBrowser = () =>
  typeof document !== "undefined" &&
  "webkitdirectory" in document.createElement("input") &&
  !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export const COPY_DIR = ".geny-uploads";
export const isCopy = (path: string) => path.includes(`/${COPY_DIR}/`);

/** Picked folder, ready to upload. */
export interface LocalFolder {
  name: string;
  files: { rel: string; size: number; blob: () => Promise<Blob> }[];
  bytes: number;
  skipped: number;
  skippedNames: string[];
  truncated: boolean; // over the limits: not everything was listed
  release?: () => void;
}

const DEFAULT_SKIP = [".git", "node_modules", "__pycache__", ".venv", "venv", ".DS_Store"];

/** Browser: a webkitdirectory FileList → the folder (paths without the folder's own name; skipped names left out). */
export function fromFileList(list: FileList | File[], limits: FolderUploadLimits | null): LocalFolder | null {
  const all = Array.from(list);
  if (!all.length) return null;
  const skip = new Set(limits?.skip || DEFAULT_SKIP);
  const first = (all[0] as any).webkitRelativePath || all[0].name;
  const name = first.includes("/") ? first.split("/")[0] : "folder";
  const files: LocalFolder["files"] = [];
  const skippedNames = new Set<string>();
  let skipped = 0;
  let bytes = 0;
  let truncated = false;
  for (const f of all) {
    const full: string = (f as any).webkitRelativePath || f.name;
    const rel = full.includes("/") ? full.slice(full.indexOf("/") + 1) : full;
    const hit = rel.split("/").find((s) => skip.has(s));
    if (hit) {
      skipped += 1;
      skippedNames.add(hit);
      continue;
    }
    if (limits && (files.length + 1 > limits.max_files || bytes + f.size > limits.max_bytes)) {
      truncated = true;
      continue;
    }
    files.push({ rel, size: f.size, blob: async () => f });
    bytes += f.size;
  }
  return { name, files, bytes, skipped, skippedNames: [...skippedNames].sort(), truncated };
}

/** Desktop: a picked folder, scanned in the app (files read one by one at upload time). */
export async function fromDesktop(
  bridge: FolderBridge,
  picked: { path: string; name: string },
  limits: FolderUploadLimits | null,
): Promise<LocalFolder> {
  const s = await bridge.scan(picked.path, {
    maxFiles: limits?.max_files,
    maxBytes: limits?.max_bytes,
  });
  if (!s) throw new Error("the app could not read this folder");
  return {
    name: picked.name,
    files: s.files.map((f) => ({
      rel: f.rel,
      size: f.size,
      blob: async () => {
        const data = await bridge.read(picked.path, f.rel, limits?.max_file_bytes);
        if (!data) throw new Error(`could not read ${f.rel}`);
        return new Blob([data as BlobPart]);
      },
    })),
    bytes: s.bytes,
    skipped: s.skipped,
    skippedNames: s.skippedNames,
    truncated: s.truncated,
    release: () => void bridge.release(picked.path).catch(() => {}),
  };
}

const BATCH_FILES = 100;
const BATCH_BYTES = 4 * 1024 * 1024;

/** Upload a folder as a copy, in batches; `onProgress(sentBytes, totalBytes, files)`. Resolves with the new session. */
export async function uploadCopy(
  session: Session,
  folder: LocalFolder,
  onProgress: (sent: number, total: number, files: number) => void,
  signal: AbortSignal,
): Promise<{ path: string; files: number; skipped: number; session: Session }> {
  const sid = session.id;
  const files = folder.files;
  const total = Math.max(1, folder.bytes);
  const up = await beginFolderUpload(sid, folder.name, files.length, folder.bytes);
  let done = 0;
  let count = 0;
  try {
    for (let i = 0; i < files.length; ) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const batch: { rel: string; blob: Blob }[] = [];
      let size = 0;
      while (i < files.length && batch.length < BATCH_FILES && (batch.length === 0 || size + files[i].size <= BATCH_BYTES)) {
        batch.push({ rel: files[i].rel, blob: await files[i].blob() });
        size += files[i].size;
        i++;
      }
      // (multipart overhead makes `loaded` a bit larger than the files: capped at the batch's size)
      await sendFolderBatch(sid, up.id, batch, (loaded) => onProgress(done + Math.min(loaded, size), total, count), signal);
      done += size;
      count += batch.length;
      onProgress(done, total, count);
    }
    const out = await finishFolderUpload(sid, up.id);
    return { path: out.path, files: out.files, skipped: out.skipped + folder.skipped, session: out.session };
  } catch (e) {
    abortFolderUpload(sid, up.id);
    throw e;
  }
}

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
