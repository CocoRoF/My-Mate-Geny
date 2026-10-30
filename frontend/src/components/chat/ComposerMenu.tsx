import { useEffect, useMemo, useRef, useState } from "react";
import { listDir } from "../../api/workspaces";
import type { CliInfo, DirEntry, Session } from "../../types";
import Icon from "../ui/Icon";

export interface MenuItem {
  key: string;
  label: string; // shown
  insert: string; // text that replaces the trigger token
  hint?: string;
  badge?: string;
  icon: Parameters<typeof Icon>[0]["name"];
  action?: "clear" | "plan" | "agent" | "stop"; // harness-handled commands
  keepOpen?: boolean; // e.g. a folder in @-mentions
}

/** Commands the harness itself implements (work for every provider). */
const BUILTIN: MenuItem[] = [
  { key: "b:clear", label: "/clear", insert: "", hint: "Start a fresh agent context (history stays visible)", icon: "refresh", action: "clear" },
  { key: "b:plan", label: "/plan", insert: "", hint: "Plan mode — read-only, the agent proposes a plan", icon: "file-text", action: "plan" },
  { key: "b:agent", label: "/agent", insert: "", hint: "Agent mode — full autonomy (edits, commands)", icon: "bolt", action: "agent" },
  { key: "b:stop", label: "/stop", insert: "", hint: "Stop the running turn", icon: "x", action: "stop" },
];

// Interactive-only Claude commands that make no sense in a headless web turn.
const HIDE = new Set(["clear", "exit", "quit", "resume", "login", "logout", "config", "theme", "color", "vim",
  "terminal-setup", "ide", "status", "statusline", "doctor", "help", "permissions", "hooks", "agents", "mcp",
  "model", "fast", "privacy-settings", "upgrade", "release-notes", "bug", "feedback", "add-dir", "rewind",
  "export", "copy", "keybindings-help", "install-github-app", "migrate-installer", "output-style", "view-mode"]);

export function slashItems(info: CliInfo | null, provider: string): MenuItem[] {
  const items = [...BUILTIN];
  if (provider !== "claude" || !info?.slash_commands) return items;
  const terminal = new Set(info.terminal_slash_commands || []);
  const skills = new Set(info.skills || []);
  items.splice(1, 0, {
    key: "c:compact", label: "/compact", insert: "/compact ", hint: "Summarize the conversation to free up context", icon: "file-text",
  });
  for (const name of info.slash_commands) {
    if (HIDE.has(name) || terminal.has(name) || name === "compact") continue;
    items.push({
      key: `c:${name}`,
      label: `/${name}`,
      insert: `/${name} `,
      badge: skills.has(name) ? "skill" : "command",
      icon: skills.has(name) ? "bolt" : "terminal",
    });
  }
  return items;
}

/** Trigger under the caret: "/cmd" at the very start, or "@path" anywhere. */
export function triggerAt(text: string, caret: number): { kind: "slash" | "mention"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const slash = /^\/([\w:.-]*)$/.exec(before);
  if (slash) return { kind: "slash", query: slash[1], start: 0 };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: "mention", query: at[2], start: before.length - at[2].length - 1 };
  return null;
}

const join = (a: string, b: string) => (a.endsWith("/") ? a + b : `${a}/${b}`);

function useMentionItems(session: Session, query: string, enabled: boolean): MenuItem[] {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const slash = query.lastIndexOf("/");
  const dir = slash >= 0 ? query.slice(0, slash) : "";
  const leaf = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase();
  const root = session.workspace_path;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    listDir(dir ? join(root, dir) : root, session.connection_id)
      .then((r) => alive && setEntries(r.entries))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [enabled, dir, root, session.connection_id]);

  return useMemo(
    () =>
      entries
        .filter((e) => !leaf || e.name.toLowerCase().includes(leaf))
        .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
        .slice(0, 60)
        .map((e) => {
          const rel = dir ? `${dir}/${e.name}` : e.name;
          return {
            key: `m:${rel}`,
            label: e.is_dir ? `${e.name}/` : e.name,
            insert: e.is_dir ? `@${rel}/` : `@${rel} `,
            hint: dir || undefined,
            icon: e.is_dir ? ("folder" as const) : ("file" as const),
            keepOpen: e.is_dir,
          };
        }),
    [entries, leaf, dir],
  );
}

export default function ComposerMenu({
  trigger,
  session,
  info,
  onPick,
  onClose,
  activeIndex,
  setActiveIndex,
  setItems,
}: {
  trigger: { kind: "slash" | "mention"; query: string };
  session: Session;
  info: CliInfo | null;
  onPick: (item: MenuItem) => void;
  onClose: () => void;
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  setItems: (items: MenuItem[]) => void;
}) {
  const mention = useMentionItems(session, trigger.query, trigger.kind === "mention");
  const items = useMemo(() => {
    if (trigger.kind === "mention") return mention;
    const q = trigger.query.toLowerCase();
    return slashItems(info, session.provider).filter((i) => i.label.slice(1).toLowerCase().includes(q)).slice(0, 80);
  }, [trigger, mention, info, session.provider]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setItems(items), [items, setItems]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!items.length) {
    return (
      <div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-40 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-[12px] text-content-faint shadow-float">
        {trigger.kind === "mention" ? "No matching files" : "No matching commands"}
        <button onClick={onClose} className="float-right hover:text-content">
          Esc
        </button>
      </div>
    );
  }

  return (
    <div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-40 overflow-hidden rounded-xl border border-border bg-surface-2 shadow-float animate-fade-in">
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5 text-[10.5px] uppercase tracking-wide text-content-faint">
        {trigger.kind === "mention" ? `Files in ${session.workspace_path}` : "Commands"}
        <span className="ml-auto normal-case tracking-normal">↑↓ navigate · Enter/Tab select · Esc close</span>
      </div>
      <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
        {items.map((it, i) => (
          <button
            key={it.key}
            data-idx={i}
            onMouseEnter={() => setActiveIndex(i)}
            onMouseDown={(e) => {
              e.preventDefault(); // keep textarea focus
              onPick(it);
            }}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${i === activeIndex ? "bg-surface-3" : ""}`}
          >
            <Icon name={it.icon} size={14} className={i === activeIndex ? "text-accent" : "text-content-faint"} />
            <span className="shrink-0 font-mono text-[12.5px] text-content">{it.label}</span>
            {it.badge && <span className="pill bg-surface-3 text-content-faint">{it.badge}</span>}
            {it.hint && <span className="truncate text-[11.5px] text-content-faint">{it.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
