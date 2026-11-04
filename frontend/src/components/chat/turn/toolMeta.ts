import type { IconName } from "../../ui/Icon";
import { tr, type MsgKey } from "../../../i18n";

export type ToolCategory = "command" | "read" | "edit" | "search" | "fetch" | "agent" | "skill" | "todo" | "mcp" | "other";

export interface ToolMeta {
  descriptive?: boolean; // label is the agent's own description (not a tool name)
  category: ToolCategory;
  label: string; // display name
  target: string; // what it acted on (command / file / pattern / url)
  running: string; // present tense, for the live line
  icon: IconName;
  tone: string;
}

const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Path relative to the workspace when it's inside it (how Claude Code shows paths). */
export function relPath(p: string, root?: string | null): string {
  if (!p || !root) return p;
  const r = root.replace(/\/+$/, "");
  if (p === r) return ".";
  return p.startsWith(r + "/") ? p.slice(r.length + 1) : p;
}

export function toolMeta(name: string, input: unknown, root?: string | null): ToolMeta {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const n = name.startsWith("mcp__remote__") ? name.slice(13) : name;
  const lower = n.toLowerCase();

  if (["bash", "shell", "remote_bash"].includes(lower)) {
    const cmd = str(i.command) || (Array.isArray(i.command) ? i.command.join(" ") : str(input));
    const clean = cmd.replace(/^\/bin\/(ba)?sh -l?c\s+/, "").replace(/^'(.*)'$/s, "$1");
    // The agent's own one-line description reads better than the command.
    const desc = str(i.description);
    return {
      category: "command",
      label: desc || (lower === "remote_bash" ? tr("turn.toolRemoteShell") : "Bash"), // i18n-ignore: the tool name
      target: clean,
      running: desc ? `${desc}…` : tr("turn.runRunning", { x: clean.slice(0, 60) }),
      icon: lower === "remote_bash" ? "server" : "terminal",
      tone: "text-content-dim bg-surface-3",
      descriptive: !!desc,
    };
  }
  if (["read", "remote_read", "notebookread"].includes(lower)) {
    const p = relPath(str(i.file_path) || str(i.path) || str(i.notebook_path), root);
    return { category: "read", label: tr("turn.toolRead"), target: p, running: tr("turn.runReading", { x: base(p) }), icon: "file", tone: "text-accent bg-accent/12" };
  }
  if (lower === "remote_list") {
    const p = str(i.path);
    return { category: "read", label: tr("turn.toolList"), target: p, running: tr("turn.runListing", { x: p }), icon: "folder", tone: "text-accent bg-accent/12" };
  }
  if (["edit", "multiedit", "write", "notebookedit", "remote_write", "apply_patch"].includes(lower)) {
    let p = relPath(str(i.file_path) || str(i.path) || str(i.notebook_path), root);
    if (lower === "apply_patch" && Array.isArray(i.changes)) {
      p = i.changes.map((c: any) => base(String(c.path || ""))).join(", ");
    }
    const label = lower === "write" || lower === "remote_write" ? tr("turn.toolWrite") : lower === "apply_patch" ? tr("turn.toolPatch") : tr("turn.toolEdit");
    return { category: "edit", label, target: p, running: tr("turn.runEditing", { x: base(p) }), icon: "pencil", tone: "text-success bg-success/12" };
  }
  if (["grep", "glob", "toolsearch", "websearch", "web_search"].includes(lower)) {
    const q = str(i.pattern) || str(i.query);
    const web = lower.includes("web");
    return {
      category: "search",
      label: web ? tr("turn.toolWebSearch") : lower === "glob" ? tr("turn.toolFindFiles") : lower === "toolsearch" ? tr("turn.toolToolSearch") : tr("turn.toolSearch"),
      target: q + (str(i.path) ? `  ${tr("turn.inPath", { path: relPath(i.path, root) })}` : ""),
      running: tr("turn.runSearching", { x: q.slice(0, 50) }),
      icon: web ? "external" : "search",
      tone: "text-violet bg-violet/12",
    };
  }
  if (lower === "webfetch") {
    const u = str(i.url);
    return { category: "fetch", label: tr("turn.toolFetch"), target: u, running: tr("turn.runFetching", { x: u }), icon: "external", tone: "text-cyan bg-cyan/12" };
  }
  if (lower === "task" || lower === "agent") {
    const d = str(i.description) || str(i.subagent_type);
    return {
      category: "agent", label: d || tr("turn.toolSubagent"), target: str(i.subagent_type), running: tr("turn.runSubagent", { x: d }),
      icon: "bolt", tone: "text-violet bg-violet/12", descriptive: !!d,
    };
  }
  if (lower === "skill") {
    const s = str(i.skill) || str(i.command) || str(i.name);
    return { category: "skill", label: tr("turn.toolSkill"), target: s, running: tr("turn.runSkill", { x: s }), icon: "bolt", tone: "text-warning bg-warning/12" };
  }
  if (lower === "todowrite") {
    return { category: "todo", label: tr("turn.toolTasks"), target: "", running: tr("turn.runTasks"), icon: "check", tone: "text-accent bg-accent/12" };
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const tool = parts[parts.length - 1];
    const server = parts.slice(1, -1).join("__");
    const first = Object.values(i).find((v) => typeof v === "string") as string | undefined;
    return { category: "mcp", label: tool, target: first || server, running: `${server}: ${tool}`, icon: "plug", tone: "text-success bg-success/12" };
  }
  const first = Object.values(i).find((v) => typeof v === "string") as string | undefined;
  return { category: "other", label: n, target: first || "", running: n, icon: "bolt", tone: "text-content-dim bg-surface-3" };
}

const PHRASE: Record<ToolCategory, MsgKey> = {
  command: "turn.sumCommand",
  read: "turn.sumRead",
  edit: "turn.sumEdit",
  search: "turn.sumSearch",
  fetch: "turn.sumFetch",
  agent: "turn.sumAgent",
  skill: "turn.sumSkill",
  todo: "turn.sumTodo",
  mcp: "turn.sumMcp",
  other: "turn.sumOther",
};

/** "Ran 3 commands, read 2 files, edited 1 file" (in the UI's language; call while rendering) */
export function summarize(metas: ToolMeta[]): string {
  const counts = new Map<ToolCategory, number>();
  metas.forEach((m) => counts.set(m.category, (counts.get(m.category) || 0) + 1));
  const s = [...counts.entries()].map(([cat, n]) => tr(PHRASE[cat], { count: n })).join(tr("turn.sumSep"));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "850ms", "4.2s", "3m 5s", "1h 2m" / "4.2초", "3분 5초" … */
export function fmtMs(ms: number): string {
  if (ms < 1000) return tr("turn.ms", { n: String(Math.max(0, Math.round(ms))) });
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return tr("turn.sec", { n: s.toFixed(1) });
  const seconds = Math.round(s);
  const m = Math.floor(seconds / 60);
  if (m < 60) return tr("common.durMS", { m, s: seconds % 60 });
  return tr("common.durHM", { h: Math.floor(m / 60), m: m % 60 });
}
