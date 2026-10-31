import { useMemo, useState } from "react";
import { API_COST_HINT, fmtUsd } from "../../../lib/usage";
import { ctxBar, fmtCtx, fmtWindow, limitsFor, meterOf } from "../../../lib/context";
import { useUsageStore } from "../../../stores/usageStore";
import { useChatStore, type Turn } from "../../../stores/chatStore";
import { useConfigStore } from "../../../stores/configStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useSessionStore } from "../../../stores/sessionStore";
import type { Session } from "../../../types";
import Icon, { type IconName } from "../../ui/Icon";
import GitContext from "../GitContext";
import TodoCard, { todosOf, type Todo } from "../turn/TodoCard";
import FolderPicker from "./FolderPicker";
import { relPath } from "../turn/toolMeta";
import { openPath } from "../../../stores/workbenchStore";

function Section({
  title,
  icon,
  count,
  action,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: IconName;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border/70">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-2 text-left">
          <Icon name={open ? "chevron-down" : "chevron"} size={12} className="text-content-faint" />
          <Icon name={icon} size={13} className="text-accent" />
          <span className="text-[12.5px] font-semibold text-content">{title}</span>
          {count !== undefined && <span className="font-mono text-[11px] text-content-faint">{count}</span>}
        </button>
        {action}
      </div>
      {open && <div className="px-4 pb-3">{children}</div>}
    </section>
  );
}

const base = (p: string) => p.split("/").filter(Boolean).pop() || p;

interface Change {
  path: string;
  ops: number;
  created: boolean;
  failed: boolean;
}

/** Files the agent changed this session: exact git-based turn changes when
 * the workspace is a repo, otherwise what Edit/Write/apply_patch touched. */
function changesOf(turns: Turn[]): Change[] {
  const map = new Map<string, Change>();
  if (turns.some((t) => t.changes)) {
    for (const t of turns)
      for (const r of t.changes?.repos || [])
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
  for (const t of turns)
    for (const tool of t.tools) {
      const n = tool.name.replace(/^mcp__remote__/, "").toLowerCase();
      const i = (tool.input || {}) as Record<string, any>;
      if (["edit", "multiedit", "notebookedit"].includes(n)) touch(i.file_path || i.notebook_path, false, !!tool.isError);
      else if (n === "write" || n === "remote_write") touch(i.file_path || i.path, true, !!tool.isError);
      else if (n === "apply_patch" && Array.isArray(i.changes))
        i.changes.forEach((c: any) => touch(String(c.path || ""), c.kind === "add", !!tool.isError));
    }
  return [...map.values()].reverse();
}

function latestTodos(turns: Turn[]): Todo[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const tools = turns[i].tools;
    for (let j = tools.length - 1; j >= 0; j--)
      if (tools[j].name.toLowerCase() === "todowrite") return todosOf(tools[j].input);
  }
  return [];
}

export default function SessionPanel({ session, onClose }: { session: Session; onClose: () => void }) {
  const turns = useChatStore((s) => s.turns);
  const info = useChatStore((s) => s.info);
  const cost = useChatStore((s) => s.runningCostUsd);
  const update = useSessionStore((s) => s.update);
  const connections = useConnectionStore((s) => s.connections);
  const catalog = useConfigStore((s) => s.catalog);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState("");
  const [showSkills, setShowSkills] = useState(false);

  const conn = connections.find((c) => c.id === session.connection_id);
  const hostLabel = conn ? `${conn.name} (${conn.username}@${conn.host})` : "this server";
  const dirs = session.extra_dirs || [];
  const changes = useMemo(() => changesOf(turns), [turns]);
  const todos = useMemo(() => latestTodos(turns), [turns]);
  // Context = the last model call's input + cache tokens (each call re-reads
  // the whole context), NOT a turn's usage, which sums every call of the turn.
  const context = useChatStore((s) => s.context);
  const poolDefault = useUsageStore((s) => s.accounts[session.provider]?.pool?.auto_compact_window) ?? 0;
  const fallback = limitsFor(session.model, session.auto_compact_window ?? poolDefault);
  const ctxMeter = session.provider === "claude" ? meterOf(context, fallback) : null;
  const ctxTokens = ctxMeter?.tokens || 0;
  const ctxWindow = ctxMeter?.window || catalog[session.provider]?.models.find((m) => m.id === session.model)?.context_window || null;
  const live = info || session.cli_info;
  // The account this chat's engine leased (same source as the composer footer).
  const account = useUsageStore((s) => s.account[session.id] ?? null);

  const setDirs = async (next: string[]) => {
    setError("");
    try {
      await update(session.id, { extra_dirs: next });
    } catch (e: any) {
      setError(String(e.message || e));
      throw e;
    }
  };

  return (
    <aside className="flex h-full w-[340px] max-w-[92vw] shrink-0 flex-col border-l border-border bg-surface/95 backdrop-blur-xl">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-4">
        <Icon name="activity" size={15} className="text-accent" />
        <span className="text-[13px] font-semibold">Session</span>
        <button onClick={onClose} className="ml-auto rounded-md p-1 text-content-faint hover:text-content hover:bg-surface-3" title="Close panel">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section title="Workspace" icon={session.connection_id ? "server" : "folder"}>
          <div className="text-[11px] text-content-faint">{hostLabel}</div>
          <div className="mt-0.5 break-all font-mono text-[12px] text-content">{session.workspace_path}</div>
          <div className="mt-2">
            <GitContext path={session.workspace_path} connectionId={session.connection_id} />
          </div>
        </Section>

        <Section
          title="Additional folders"
          icon="folder"
          count={dirs.length}
          action={
            <button onClick={() => setPicker(true)} className="btn-soft py-1 px-2 text-[11.5px]" title="Connect another folder">
              <Icon name="plus" size={12} /> Add
            </button>
          }
        >
          {dirs.length === 0 ? (
            <p className="text-[12px] text-content-faint">
              Give the agent access to more folders on {conn ? conn.name : "this server"} — e.g. a shared library or a
              second repo. Applies from the next message.
            </p>
          ) : (
            <ul className="space-y-1">
              {dirs.map((d) => (
                <li key={d} className="group flex items-center gap-2 rounded-lg bg-surface-2/70 px-2.5 py-1.5">
                  <Icon name="folder" size={13} className="shrink-0 text-content-faint" />
                  <span className="min-w-0 flex-1" title={d}>
                    <span className="block truncate text-[12.5px] text-content">{base(d)}</span>
                    <span className="block truncate font-mono text-[10.5px] text-content-faint">{d}</span>
                  </span>
                  <button
                    onClick={() => setDirs(dirs.filter((x) => x !== d)).catch(() => {})}
                    className="shrink-0 rounded p-1 text-content-faint hover:text-danger sm:opacity-0 group-hover:opacity-100 transition"
                    title="Disconnect folder"
                  >
                    <Icon name="x" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="mt-1.5 text-[11.5px] text-danger">{error}</p>}
        </Section>

        {todos.length > 0 && (
          <Section title="Tasks" icon="check" count={todos.length}>
            <TodoCard todos={todos} compact />
          </Section>
        )}

        <Section title="Changed files" icon="pencil" count={changes.length}>
          {changes.length === 0 ? (
            <p className="text-[12px] text-content-faint">Files the agent edits or creates show up here.</p>
          ) : (
            <ul className="space-y-0.5">
              {changes.map((c) => (
                <li
                  key={c.path}
                  onClick={() => {
                    openPath(session, c.path);
                    if (window.innerWidth < 1280) onClose(); // drawer: show the file
                  }}
                  className="-mx-1.5 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-surface-3"
                  title={`Open ${c.path}`}
                >
                  <span
                    className={`w-4 shrink-0 text-center font-mono text-[11px] ${
                      c.failed ? "text-danger" : c.created ? "text-success" : "text-warning"
                    }`}
                  >
                    {c.failed ? "!" : c.created ? "A" : "M"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                    <span className="text-content-dim">{base(c.path)}</span>
                    {(() => {
                      const rel = relPath(c.path, session.workspace_path);
                      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : rel === base(c.path) ? "" : rel;
                      return dir ? <span className="text-content-faint"> {dir}</span> : null;
                    })()}
                  </span>
                  {c.ops > 1 && <span className="shrink-0 text-[10.5px] text-content-faint">×{c.ops}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Agent" icon="bolt">
          <dl className="space-y-1 text-[12px]">
            {[
              ["Mode", session.mode === "plan" ? "Plan (read-only)" : "Agent (full access)"],
              ["Model", live?.model || session.model || "default"],
              ["Account", account?.account || live?.account],
              ["Permissions", live?.permissionMode],
              ["CLI", live?.claude_code_version ? `Claude Code ${live.claude_code_version}` : session.provider],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-content-faint">{k}</dt>
                  <dd className="truncate font-mono text-content-dim">{v}</dd>
                </div>
              ))}
          </dl>
          {live?.mcp_servers && live.mcp_servers.length > 0 && (
            <div className="mt-2.5">
              <div className="mb-1 text-[10.5px] uppercase tracking-wide text-content-faint">MCP servers</div>
              {live.mcp_servers.map((m) => (
                <div key={m.name} className="flex items-center gap-2 py-0.5 text-[12px]">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      m.status === "connected" ? "bg-success" : m.status === "failed" ? "bg-danger" : "bg-warning"
                    }`}
                  />
                  <span className="truncate text-content-dim">{m.name}</span>
                  <span className="ml-auto text-[10.5px] text-content-faint">{m.status}</span>
                </div>
              ))}
            </div>
          )}
          {live?.agents && live.agents.length > 0 && (
            <div className="mt-2.5">
              <div className="mb-1 text-[10.5px] uppercase tracking-wide text-content-faint">Subagents</div>
              <div className="flex flex-wrap gap-1">
                {live.agents.map((a) => (
                  <span key={a} className="pill bg-surface-3 text-content-dim">
                    {a}
                  </span>
                ))}
              </div>
            </div>
          )}
          {live?.skills && live.skills.length > 0 && (
            <div className="mt-2.5">
              <button
                onClick={() => setShowSkills(!showSkills)}
                className="mb-1 flex items-center gap-1 text-[10.5px] uppercase tracking-wide text-content-faint hover:text-content-dim"
              >
                Skills {live.skills.length} <Icon name={showSkills ? "chevron-down" : "chevron"} size={10} />
              </button>
              {showSkills && (
                <div className="flex flex-wrap gap-1">
                  {live.skills.map((s) => (
                    <span key={s} className="pill bg-surface-3 font-mono text-content-dim">
                      /{s}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {live?.tools && (
            <div className="mt-2 text-[11px] text-content-faint">{live.tools.length} tools available · type / in the composer</div>
          )}
          {!live && <p className="mt-1 text-[11.5px] text-content-faint">Details appear after the first message.</p>}
        </Section>

        <Section title="Usage" icon="cpu">
          <dl className="space-y-1 text-[12px]">
            <div className="flex justify-between">
              <dt className="text-content-faint" title={API_COST_HINT}>API-equivalent cost</dt>
              <dd className="font-mono text-content-dim" title={API_COST_HINT}>≈ {fmtUsd(cost)}</dd>
            </div>
            {ctxTokens > 0 && (
              <div className="flex justify-between">
                <dt className="text-content-faint" title="The last model call's input + cache tokens">Context now</dt>
                <dd className="font-mono text-content-dim">
                  {fmtCtx(ctxTokens)}
                  {ctxWindow ? ` / ${fmtWindow(ctxWindow)}` : ""}
                </dd>
              </div>
            )}
            {ctxMeter && ctxTokens > 0 && (
              <div className="flex justify-between">
                <dt className="text-content-faint">Auto-compacts at</dt>
                <dd className="font-mono text-content-dim">{ctxMeter.threshold ? fmtCtx(ctxMeter.threshold) : "off"}</dd>
              </div>
            )}
          </dl>
          {ctxWindow && ctxTokens > 0 && (
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-accent/15">
              <div
                className={`h-full rounded-full ${ctxBar(ctxMeter?.toCompact ?? ctxTokens / ctxWindow)}`}
                style={{ width: `${Math.min(100, (ctxTokens / ctxWindow) * 100)}%` }}
              />
            </div>
          )}
          {ctxMeter && (ctxMeter.toCompact ?? 0) >= 0.75 && (
            <p className="mt-1 text-[11px] text-warning">
              Context is filling up — it auto-compacts at {fmtCtx(ctxMeter.threshold)}; /compact now or /clear to start fresh.
            </p>
          )}
        </Section>
      </div>

      {picker && (
        <FolderPicker
          connectionId={session.connection_id}
          hostLabel={hostLabel}
          initialPath={session.workspace_path}
          exclude={[session.workspace_path, ...dirs]}
          onAdd={(p) => setDirs([...dirs, p.replace(/\/+$/, "")])}
          onClose={() => setPicker(false)}
        />
      )}
    </aside>
  );
}
