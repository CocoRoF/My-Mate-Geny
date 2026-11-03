import type { Turn } from "../stores/chatStore";

export const CHANGE_PREVIEW_LIMIT = 10;

/** Ignore system notices, but never fall back past a new user message. */
export function latestChangeTurn(turns: Turn[]): Turn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role !== "system") return turns[i];
  }
  return undefined;
}

interface Change {
  path: string;
  ops: number;
  created: boolean;
  failed: boolean;
}

export function changesOf(turn: Turn | undefined): Change[] {
  if (!turn || turn.role !== "assistant") return [];
  const map = new Map<string, Change>();
  const repoMode = !!turn.changes;
  if (repoMode) {
    for (const r of turn.changes?.repos || [])
        for (const f of r.files) {
          const path = `${r.root}/${f.path}`;
          const c = map.get(path) || { path, ops: 0, created: false, failed: false };
          c.ops += 1;
          c.created ||= f.status === "A";
          map.delete(path);
          map.set(path, c);
        }
    return [...map.values()].reverse();
  }
  const touch = (path: string, created: boolean, failed: boolean) => {
    if (!path) return;
    const c = map.get(path) || { path, ops: 0, created: false, failed: false };
    c.ops += 1;
    c.created ||= created;
    c.failed ||= failed;
    map.delete(path);
    map.set(path, c); // most recent last
  };
  for (const tool of turn.tools) {
    const n = tool.name.replace(/^mcp__remote__/, "").toLowerCase();
    const i = (tool.input || {}) as Record<string, any>;
    if (["edit", "multiedit", "notebookedit"].includes(n)) touch(i.file_path || i.notebook_path, false, !!tool.isError);
    else if (n === "write" || n === "remote_write") touch(i.file_path || i.path, true, !!tool.isError);
    else if (n === "apply_patch" && Array.isArray(i.changes))
      i.changes.forEach((c: any) => touch(String(c.path || ""), c.kind === "add", !!tool.isError));
  }
  return [...map.values()].reverse();
}

