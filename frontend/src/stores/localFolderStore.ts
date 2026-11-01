import { create } from "zustand";
import { uploadCopy, type LocalFolder } from "../lib/localFolder";
import type { Session } from "../types";
import { useSessionStore } from "./sessionStore";
import { useWorkbench } from "./workbenchStore";
import { tr } from "../i18n";

/** A folder from the user's computer on its way into a chat (lib/localFolder.ts), per chat. Lives here, not in the
 * popover: closing the popover doesn't stop an upload, and the Folder button shows its progress. */
export interface LocalJob {
  phase: "reading" | "ready" | "uploading";
  folder?: LocalFolder;
  sent: number;
  files: number;
  error?: string;
  ctl?: AbortController;
}

interface LocalFolderState {
  jobs: Record<string, LocalJob | undefined>;
  set: (sid: string, job: LocalJob | undefined) => void;
  cancel: (sid: string) => void;
  upload: (session: Session) => Promise<void>;
}

export const useLocalFolders = create<LocalFolderState>((set, get) => ({
  jobs: {},
  set: (sid, job) =>
    set((s) => {
      const old = s.jobs[sid];
      if (old?.folder && old.folder !== job?.folder) old.folder.release?.();
      return { jobs: { ...s.jobs, [sid]: job } };
    }),
  cancel: (sid) => {
    const j = get().jobs[sid];
    if (j?.ctl) j.ctl.abort();
    else get().set(sid, undefined);
  },
  upload: async (session) => {
    const sid = session.id;
    const job = get().jobs[sid];
    const folder = job?.folder;
    if (!folder || job.phase !== "ready") return;
    const ctl = new AbortController();
    const put = (patch: Partial<LocalJob>) =>
      set((s) => ({ jobs: { ...s.jobs, [sid]: { ...(s.jobs[sid] || { sent: 0, files: 0, phase: "uploading" }), ...patch } } }));
    put({ phase: "uploading", sent: 0, files: 0, error: undefined, ctl });
    try {
      const out = await uploadCopy(session, folder, (sent, _t, files) => put({ sent, files }), ctl.signal);
      useSessionStore.getState().patchLocal(sid, out.session);
      get().set(sid, undefined);
      useWorkbench.getState().notify(tr("workspace.copied", { count: out.files, path: out.path }));
    } catch (e: any) {
      if (e?.name === "AbortError") get().set(sid, undefined);
      else put({ phase: "ready", ctl: undefined, error: String(e.message || e) });
    }
  },
}));
