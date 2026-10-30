import type { IconName } from "../../ui/Icon";

export type ToolCategory = "command" | "read" | "edit" | "search" | "fetch" | "agent" | "skill" | "todo" | "mcp" | "other";

export interface ToolMeta {
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
    return {
      category: "command",
      label: lower === "remote_bash" ? "Remote shell" : "Bash",
      target: clean,
      running: `Running ${clean.slice(0, 60)}`,
      icon: lower === "remote_bash" ? "server" : "terminal",
      tone: "text-content-dim bg-surface-3",
    };
  }
  if (["read", "remote_read", "notebookread"].includes(lower)) {
    const p = relPath(str(i.file_path) || str(i.path) || str(i.notebook_path), root);
    return { category: "read", label: "Read", target: p, running: `Reading ${base(p)}`, icon: "file", tone: "text-accent bg-accent/12" };
  }
  if (lower === "remote_list") {
    const p = str(i.path);
    return { category: "read", label: "List", target: p, running: `Listing ${p}`, icon: "folder", tone: "text-accent bg-accent/12" };
  }
  if (["edit", "multiedit", "write", "notebookedit", "remote_write", "apply_patch"].includes(lower)) {
    let p = relPath(str(i.file_path) || str(i.path) || str(i.notebook_path), root);
    if (lower === "apply_patch" && Array.isArray(i.changes)) {
      p = i.changes.map((c: any) => base(String(c.path || ""))).join(", ");
    }
    const label = lower === "write" || lower === "remote_write" ? "Write" : lower === "apply_patch" ? "Patch" : "Edit";
    return { category: "edit", label, target: p, running: `Editing ${base(p)}`, icon: "pencil", tone: "text-success bg-success/12" };
  }
  if (["grep", "glob", "toolsearch", "websearch", "web_search"].includes(lower)) {
    const q = str(i.pattern) || str(i.query);
    const web = lower.includes("web");
    return {
      category: "search",
      label: web ? "Web search" : lower === "glob" ? "Find files" : lower === "toolsearch" ? "Tool search" : "Search",
      target: q + (str(i.path) ? `  in ${relPath(i.path, root)}` : ""),
      running: `Searching ${q.slice(0, 50)}`,
      icon: web ? "external" : "search",
      tone: "text-violet bg-violet/12",
    };
  }
  if (lower === "webfetch") {
    const u = str(i.url);
    return { category: "fetch", label: "Fetch", target: u, running: `Fetching ${u}`, icon: "external", tone: "text-cyan bg-cyan/12" };
  }
  if (lower === "task" || lower === "agent") {
    const d = str(i.description) || str(i.subagent_type);
    return { category: "agent", label: "Subagent", target: d, running: `Subagent: ${d}`, icon: "bolt", tone: "text-violet bg-violet/12" };
  }
  if (lower === "skill") {
    const s = str(i.skill) || str(i.command) || str(i.name);
    return { category: "skill", label: "Skill", target: s, running: `Using skill ${s}`, icon: "bolt", tone: "text-warning bg-warning/12" };
  }
  if (lower === "todowrite") {
    return { category: "todo", label: "Tasks", target: "", running: "Updating tasks", icon: "check", tone: "text-accent bg-accent/12" };
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

const PHRASE: Record<ToolCategory, [string, string, string]> = {
  command: ["Ran", "command", "commands"],
  read: ["Read", "file", "files"],
  edit: ["Edited", "file", "files"],
  search: ["Searched", "time", "times"],
  fetch: ["Fetched", "page", "pages"],
  agent: ["Ran", "subagent", "subagents"],
  skill: ["Used", "skill", "skills"],
  todo: ["Updated", "task list", "task lists"],
  mcp: ["Called", "tool", "tools"],
  other: ["Used", "tool", "tools"],
};

/** "Ran 3 commands, read 2 files, edited 1 file" */
export function summarize(metas: ToolMeta[]): string {
  const counts = new Map<ToolCategory, number>();
  metas.forEach((m) => counts.set(m.category, (counts.get(m.category) || 0) + 1));
  const parts = [...counts.entries()].map(([cat, n], idx) => {
    const [verb, one, many] = PHRASE[cat];
    const v = idx === 0 ? verb : verb.toLowerCase();
    return `${v} ${n} ${n === 1 ? one : many}`;
  });
  return parts.join(", ");
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
