import { create } from "zustand";
import {
  cancelCli,
  checkCli,
  getCliStatus,
  setCliSettings,
  upgradeCli,
  type CliJob,
  type CliStatus,
  type CliTool,
} from "../api/cliTools";

/**
 * Settings → Providers → CLI versions. Loaded once at start (the Settings badge: lib/attention.ts) and kept current
 * by the server's pushes on /ws/sessions (hooks/useSessionSync.ts): `cli.changed` → refetch the status (bursts
 * collapse into one fetch), `cli.log` → the running upgrade's new log lines. No polling.
 */
interface CliToolsState {
  status: CliStatus | null;
  error: string | null;
  checking: boolean;
  load: () => Promise<void>;
  check: (tool?: string) => Promise<void>;
  upgrade: (tool: string, opts: { version?: string; when?: "now" | "idle" }) => Promise<CliJob>;
  cancel: (tool: string) => Promise<void>;
  setSettings: (tool: string, patch: { auto_upgrade?: boolean; channel?: string; use_managed?: boolean }) => Promise<void>;
  /** a push from /ws/sessions */
  remote: (msg: { type?: string; data?: Record<string, unknown> }) => void;
}

let refetchTimer: ReturnType<typeof setTimeout> | undefined;

const patchTool = (s: CliStatus | null, tool: string, f: (t: CliTool) => CliTool): CliStatus | null =>
  s ? { ...s, tools: s.tools.map((t) => (t.id === tool ? f(t) : t)) } : s;

export const useCliToolsStore = create<CliToolsState>((set, get) => ({
  status: null,
  error: null,
  checking: false,
  load: async () => {
    try {
      set({ status: await getCliStatus(), error: null });
    } catch (e) {
      set({ error: String((e as Error)?.message || e) });
    }
  },
  check: async (tool) => {
    set({ checking: true });
    try {
      set({ status: await checkCli(tool), error: null });
    } catch (e) {
      set({ error: String((e as Error)?.message || e) });
    } finally {
      set({ checking: false });
    }
  },
  upgrade: async (tool, opts) => {
    const job = await upgradeCli(tool, opts);
    set((s) => ({ status: patchTool(s.status, tool, (t) => ({ ...t, job })) }));
    return job;
  },
  cancel: async (tool) => {
    const job = await cancelCli(tool);
    set((s) => ({ status: patchTool(s.status, tool, (t) => ({ ...t, job })) }));
  },
  setSettings: async (tool, patch) => {
    const next = await setCliSettings(tool, patch);
    set((s) => ({ status: patchTool(s.status, tool, () => next) }));
  },
  remote: (msg) => {
    const d = msg.data ?? {};
    if (msg.type === "cli.log") {
      const st = get().status;
      const tool = st?.tools.find((t) => t.id === d.tool);
      const job = tool?.job;
      const lines = Array.isArray(d.lines) ? (d.lines as string[]) : [];
      const start = typeof d.start === "number" ? d.start : -1;
      if (job && job.id === d.job_id) {
        const end = job.log_start + job.log.length;
        if (start <= end && start + lines.length > end) {
          const add = lines.slice(end - start);
          set((s) => ({ status: patchTool(s.status, job.tool, (t) => (t.job ? { ...t, job: { ...t.job, log: [...t.job.log, ...add] } } : t)) }));
          return;
        }
        if (start + lines.length <= end) return; // already have them
      }
      // a job we don't know yet, or a gap: the status has the whole snapshot
    } else if (msg.type !== "cli.changed") {
      return;
    }
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => get().load(), 150);
  },
}));
