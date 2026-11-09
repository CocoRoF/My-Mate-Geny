import { isApiProvider } from "../../../api/apiProviders";
import { useMemo, useState } from "react";
import { apiCostHint, fmtUsd } from "../../../lib/usage";
import { ctxBar, fmtCtx, fmtWindow, limitsFor, meterOf } from "../../../lib/context";
import { useUsageStore } from "../../../stores/usageStore";
import { useChatStore, type Turn } from "../../../stores/chatStore";
import type { HistoryBefore } from "../../../api/sessions";
import { useConfigStore } from "../../../stores/configStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import type { Session } from "../../../types";
import Icon, { type IconName } from "../../ui/Icon";
import TodoCard, { todosOf, type Todo } from "../turn/TodoCard";
import { relPath } from "../turn/toolMeta";
import { openPath } from "../../../stores/workbenchStore";
import { useT } from "../../../i18n";
import { changesOf, latestChangeTurn, CHANGE_PREVIEW_LIMIT } from "../../../lib/turnChanges";
import McpControls from "./McpControls";
import HiggsfieldControls, { useHiggsfieldConnected } from "./HiggsfieldControls";

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

/** The latest TodoWrite: in the loaded turns, else the one the server found
 * in the part of the chat not loaded yet. */
function latestTodos(turns: Turn[], older: HistoryBefore | null): Todo[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const tools = turns[i].tools;
    for (let j = tools.length - 1; j >= 0; j--)
      if (tools[j].name.toLowerCase() === "todowrite") return todosOf(tools[j].input);
  }
  return older?.todos ? todosOf(older.todos) : [];
}

export default function SessionPanel({ session, onClose }: { session: Session; onClose: () => void }) {
  const t = useT();
  const turns = useChatStore((s) => s.turns);
  const older = useChatStore((s) => s.older);
  const info = useChatStore((s) => s.info);
  const cost = useChatStore((s) => s.runningCostUsd);
  const connections = useConnectionStore((s) => s.connections);
  const catalog = useConfigStore((s) => s.catalog);
  const [showSkills, setShowSkills] = useState(false);

  const conn = connections.find((c) => c.id === session.connection_id);
  const hostLabel = conn ? `${conn.name} (${conn.username}@${conn.host})` : t("session.thisServer");
  const latestTurn = latestChangeTurn(turns);
  const changes = useMemo(() => changesOf(latestTurn), [latestTurn]);
  // Expansion belongs to this session and turn, never to a previous result.
  const changeScope = `${session.id}:${latestTurn?.key || ""}`;
  const [expandedScope, setExpandedScope] = useState<string | null>(null);
  const expanded = expandedScope === changeScope;
  const visibleChanges = expanded ? changes : changes.slice(0, CHANGE_PREVIEW_LIMIT);
  const todos = useMemo(() => latestTodos(turns, older), [turns, older]);
  // Context = the last model call's input + cache tokens (each call re-reads
  // the whole context), NOT a turn's usage, which sums every call of the turn.
  const context = useChatStore((s) => s.context);
  const poolDefault = useUsageStore((s) => s.accounts[session.provider]?.pool?.auto_compact_window) ?? 0;
  const known = isApiProvider(session.provider) ? catalog[session.provider]?.models.find((m) => m.id === session.model)?.context_window : null;
  const fallback = limitsFor(session.model, session.auto_compact_window ?? poolDefault, undefined, known);
  const ctxMeter = session.provider === "claude" || isApiProvider(session.provider) ? meterOf(context, fallback) : null;
  const ctxTokens = ctxMeter?.tokens || 0;
  const ctxWindow = ctxMeter?.window || catalog[session.provider]?.models.find((m) => m.id === session.model)?.context_window || null;
  const live = info || session.cli_info;
  // The account this chat's engine leased (same source as the composer footer).
  const account = useUsageStore((s) => s.account[session.id] ?? null);
  const hfConnected = useHiggsfieldConnected();

  return (
    <div data-testid="session-panel" className="flex h-full min-w-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-4">
        <Icon name="activity" size={15} className="text-accent" />
        <span className="text-[13px] font-semibold">{t("session.session")}</span>
        <button
          onClick={onClose}
          className="ml-auto rounded-md p-1 text-content-faint hover:text-content hover:bg-surface-3"
          title={t("session.closePanel")}
          aria-label={t("session.closePanel")}
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section title={t("session.workspace")} icon={session.connection_id ? "server" : "folder"}>
          <div className="text-[11px] text-content-faint">{hostLabel}</div>
          <div className="mt-0.5 break-all font-mono text-[12px] text-content">{session.workspace_path}</div>
        </Section>

        {todos.length > 0 && (
          <Section title={t("session.tasks")} icon="check" count={todos.length}>
            <TodoCard todos={todos} compact />
          </Section>
        )}

        <Section title={t("session.changedFiles")} icon="pencil" count={changes.length}>
          {changes.length === 0 ? (
            <p className="text-[12px] text-content-faint">{t("session.noChanges")}</p>
          ) : (
            <>
              <ul id="session-changed-files" className="space-y-0.5">
                {visibleChanges.map((c) => (
                  <li
                    key={c.path}
                    onClick={() => {
                      openPath(session, c.path);
                      if (window.innerWidth < 1280) onClose(); // drawer: show the file
                    }}
                    className="-mx-1.5 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-surface-3"
                    title={t("session.openPath", { path: c.path })}
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
              {changes.length > CHANGE_PREVIEW_LIMIT && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls="session-changed-files"
                  onClick={() => setExpandedScope(expanded ? null : changeScope)}
                  className="mt-2 rounded-md px-2 py-1 text-xs text-accent hover:bg-surface-3"
                >
                  {expanded ? t("session.collapseChanges") : t("session.showAllChanges", { count: changes.length })}
                </button>
              )}
            </>
          )}
        </Section>

        <Section title={t("session.agent")} icon="bolt">
          <dl className="space-y-1 text-[12px]">
            {[
              [t("session.mode"), session.mode === "plan" ? t("session.modePlan") : t("session.modeAgent")],
              [t("session.model"), live?.model || session.model || t("common.default")],
              [t("session.account"), account?.account || live?.account],
              [t("session.permissions"), live?.permissionMode],
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
              <div className="mb-1 text-[10.5px] uppercase tracking-wide text-content-faint">{t("session.mcpServers")}</div>
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
              <div className="mb-1 text-[10.5px] uppercase tracking-wide text-content-faint">{t("session.subagents")}</div>
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
                {t("session.skills")} {live.skills.length} <Icon name={showSkills ? "chevron-down" : "chevron"} size={10} />
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
            <div className="mt-2 text-[11px] text-content-faint">{t("session.toolsAvailable", { count: live.tools.length })}</div>
          )}
          {!live && <p className="mt-1 text-[11.5px] text-content-faint">{t("session.detailsLater")}</p>}
        </Section>

        <Section title={t("mcp.title")} icon="plug"><McpControls session={session} /></Section>
        {hfConnected && (
          <Section title="Higgsfield" icon="sparkles">
            <HiggsfieldControls session={session} />
          </Section>
        )}

        <Section title={t("nav.usage")} icon="cpu">
          <dl className="space-y-1 text-[12px]">
            <div className="flex justify-between">
              <dt className="text-content-faint" title={apiCostHint()}>{t("session.apiCost")}</dt>
              <dd className="font-mono text-content-dim" title={apiCostHint()}>≈ {fmtUsd(cost)}</dd>
            </div>
            {ctxTokens > 0 && (
              <div className="flex justify-between">
                <dt className="text-content-faint" title={t("session.contextNowTitle")}>{t("session.contextNow")}</dt>
                <dd className="font-mono text-content-dim">
                  {fmtCtx(ctxTokens)}
                  {ctxWindow ? ` / ${fmtWindow(ctxWindow)}` : ""}
                </dd>
              </div>
            )}
            {ctxMeter && ctxTokens > 0 && (
              <div className="flex justify-between">
                <dt className="text-content-faint">{t("chat.autoCompactsAt")}</dt>
                <dd className="font-mono text-content-dim">{ctxMeter.threshold ? fmtCtx(ctxMeter.threshold) : t("common.off")}</dd>
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
              {t("session.contextFilling", { n: fmtCtx(ctxMeter.threshold) })}
            </p>
          )}
        </Section>
      </div>

    </div>
  );
}
