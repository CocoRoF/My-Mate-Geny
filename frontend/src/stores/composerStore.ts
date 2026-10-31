import { create } from "zustand";
import { deleteAttachment, getUploadLimits, uploadAttachment } from "../api/attachments";
import type { Attachment } from "../types";
import { useDraftStore } from "./draftStore";

// Files waiting in the composer. Each one starts uploading the moment it is
// added (claude.ai-style), so sending is instant once the bar turns green.
export interface PendingFile {
  localId: string;
  sessionId: string;
  file?: File; // absent for a file restored from a saved draft (already uploaded)
  name: string;
  size: number;
  mime: string;
  kind: "image" | "file";
  previewUrl?: string; // object URL — instant thumbnail before the upload finishes
  progress: number; // 0..1
  status: "uploading" | "done" | "error";
  error?: string;
  attachment?: Attachment;
  abort?: () => void;
}

interface ComposerState {
  items: PendingFile[];
  limits: { max_mb: number; max_files: number };
  add: (sessionId: string, files: File[]) => void;
  remove: (localId: string) => void;
  retry: (localId: string) => void;
  /** Drop the session's items after a send (keeps the server-side files). */
  clearSent: (sessionId: string) => void;
}

let seq = 0;
let limitsLoaded = false;

const isImage = (f: File) => f.type.startsWith("image/") && f.type !== "image/svg+xml";

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Clipboard images arrive as "image.png" (or nameless): give them a real name. */
export function nameClipboardFiles(files: File[]): File[] {
  const ts = stamp();
  return files.map((f, i) => {
    const generic = !f.name || /^image\.(png|jpe?g|gif|webp)$/i.test(f.name);
    if (!generic) return f;
    const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const suffix = files.length > 1 ? `-${i + 1}` : "";
    return new File([f], `pasted-${ts}${suffix}.${ext}`, { type: f.type || "image/png", lastModified: Date.now() });
  });
}

export const useComposerStore = create<ComposerState>((set, get) => {
  const patch = (localId: string, p: Partial<PendingFile>) =>
    set((s) => ({ items: s.items.map((it) => (it.localId === localId ? { ...it, ...p } : it)) }));

  const start = (item: PendingFile) => {
    if (!item.file) return;
    const { promise, abort } = uploadAttachment(item.sessionId, item.file, (f) =>
      patch(item.localId, { progress: f }),
    );
    patch(item.localId, { status: "uploading", progress: 0, error: undefined, abort });
    promise
      .then((att) => {
        // Removed while uploading? Clean the orphan up server-side.
        if (!get().items.some((it) => it.localId === item.localId)) {
          deleteAttachment(att.id).catch(() => {});
          return;
        }
        patch(item.localId, { status: "done", progress: 1, attachment: att, kind: att.kind, abort: undefined });
      })
      .catch((e: Error) => patch(item.localId, { status: "error", error: e.message, abort: undefined }));
  };

  return {
    items: restoreDrafts(),
    limits: { max_mb: 50, max_files: 20 },

    add: (sessionId, files) => {
      if (!limitsLoaded) {
        limitsLoaded = true;
        getUploadLimits()
          .then((limits) => set({ limits }))
          .catch(() => (limitsLoaded = false));
      }
      const { limits, items } = get();
      const room = limits.max_files - items.filter((i) => i.sessionId === sessionId).length;
      const fresh: PendingFile[] = files.map((file, i) => {
        const tooBig = file.size > limits.max_mb * 1024 * 1024;
        const overCount = i >= room;
        return {
          localId: `p${++seq}`,
          sessionId,
          file,
          name: file.name || "file",
          size: file.size,
          mime: file.type || "application/octet-stream",
          kind: isImage(file) ? "image" : "file",
          previewUrl: isImage(file) ? URL.createObjectURL(file) : undefined,
          progress: 0,
          status: tooBig || overCount ? "error" : "uploading",
          error: tooBig
            ? `Larger than the ${limits.max_mb} MB limit`
            : overCount
              ? `At most ${limits.max_files} files per message`
              : undefined,
        };
      });
      set((s) => ({ items: [...s.items, ...fresh] }));
      fresh.filter((it) => it.status === "uploading").forEach(start);
    },

    remove: (localId) => {
      const it = get().items.find((x) => x.localId === localId);
      if (!it) return;
      it.abort?.();
      if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
      if (it.attachment) deleteAttachment(it.attachment.id).catch(() => {});
      set((s) => ({ items: s.items.filter((x) => x.localId !== localId) }));
    },

    retry: (localId) => {
      const it = get().items.find((x) => x.localId === localId);
      if (it && it.file && it.status === "error" && it.size <= get().limits.max_mb * 1024 * 1024) start(it);
    },

    clearSent: (sessionId) => {
      get()
        .items.filter((i) => i.sessionId === sessionId && i.previewUrl)
        .forEach((i) => URL.revokeObjectURL(i.previewUrl!));
      set((s) => ({ items: s.items.filter((i) => i.sessionId !== sessionId) }));
    },
  };
});

/** Uploaded files of unsent drafts come back after a reload (thumbnails from the server). */
function restoreDrafts(): PendingFile[] {
  return Object.entries(useDraftStore.getState().drafts).flatMap(([sessionId, d]) =>
    d.attachments.map((att) => ({
      localId: `p${++seq}`,
      sessionId,
      name: att.name,
      size: att.size,
      mime: att.mime,
      kind: att.kind,
      progress: 1,
      status: "done" as const,
      attachment: att,
    })),
  );
}

// Keep each chat's saved draft in step with its uploaded files.
useComposerStore.subscribe((s, prev) => {
  if (s.items === prev.items) return;
  const sids = new Set([...s.items, ...prev.items].map((i) => i.sessionId));
  const { setAttachments } = useDraftStore.getState();
  for (const sid of sids) {
    setAttachments(
      sid,
      s.items.filter((i) => i.sessionId === sid && i.status === "done" && i.attachment).map((i) => i.attachment!),
    );
  }
});
