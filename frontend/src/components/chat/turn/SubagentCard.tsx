import type { ToolActivity } from "../../../stores/chatStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { useSubagentUi } from "../../../stores/subagentStore";
import { useTaskStore } from "../../../stores/taskStore";
import Icon from "../../ui/Icon";
import { useNow } from "./ToolGroup";
import { agentStatus, agentView, taskFor, type AgentStatus, type AgentView } from "./subagent";
import { fmtMs } from "./toolMeta";
import { useT, type MsgKey } from "../../../i18n";

/** A subagent's live view: its call + streamed steps + the engine's task state. */
export function useAgentView(tool: ToolActivity, allTools: ToolActivity[]): AgentView {
  const sid = useSessionStore((s) => s.activeId);
  const tasks = useTaskStore((s) => (sid ? s.bySession[sid] : undefined));
  const task = taskFor(tool, tasks);
  const now = useNow(agentStatus(tool, task) === "running");
  return agentView(tool, allTools, task, now);
}

export function StatusIcon({ status, size = 14 }: { status: AgentStatus; size?: number }) {
  if (status === "running")
    return (
      <span
        className="shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin"
        style={{ width: size, height: size }}
      />
    );
  if (status === "failed") return <Icon name="alert-circle" size={size} className="shrink-0 text-danger" />;
  if (status === "stopped") return <Icon name="ban" size={size} className="shrink-0 text-content-faint" />;
  return <Icon name="check" size={size} className="shrink-0 text-success" />;
}

const PILL: Record<AgentStatus, string> = {
  running: "bg-accent-soft text-accent",
  done: "bg-success/12 text-success",
  failed: "bg-danger/15 text-danger",
  stopped: "bg-surface-3 text-content-dim",
};

const STATUS_LABEL: Record<AgentStatus, MsgKey> = {
  running: "turn.stRunning",
  done: "turn.stDone",
  failed: "turn.stFailed",
  stopped: "turn.stStopped",
};

export function StatusPill({ status }: { status: AgentStatus }) {
  const t = useT();
  // never squeezed: in a narrow header the label wrapped one syllable per line and pushed the header open
  return <span className={`pill shrink-0 whitespace-nowrap ${PILL[status]}`}>{t(STATUS_LABEL[status])}</span>;
}

/** An Agent/Task call in the chat: what it is, how it's going; opens the full detail. */
export default function SubagentCard({ tool, allTools }: { tool: ToolActivity; allTools: ToolActivity[] }) {
  const t = useT();
  const v = useAgentView(tool, allTools);
  const open = useSubagentUi((s) => s.open);
  const running = v.status === "running";
  return (
    <button
      onClick={() => open(tool.id)}
      data-agent-id={tool.id}
      className={`group block w-full rounded-xl border bg-surface/50 px-3 py-2.5 text-left transition hover:bg-surface-2/50 ${
        running ? "border-violet/35" : "border-border/80"
      }`}
      title={t("turn.showSubagent")}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid place-items-center w-6 h-6 shrink-0 rounded-lg bg-violet/12 text-violet">
          <Icon name="bolt" size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">{v.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
          {v.type && <span className="pill hidden bg-surface-3 text-content-dim sm:inline-flex">{v.type}</span>}
          {v.background && <span className="pill hidden bg-violet/12 text-violet sm:inline-flex">{t("turn.background")}</span>}
          <StatusPill status={v.status} />
          <span className="font-mono text-[10.5px] tabular-nums text-content-faint">{fmtMs(v.elapsedMs)}</span>
          <Icon name="chevron" size={13} className="text-content-faint transition group-hover:text-content-dim" />
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 pl-[34px] text-[12px] text-content-faint">
        {running && <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-accent animate-pulse-dot" />}
        {v.background && <span className="shrink-0 text-violet sm:hidden">{t("turn.background")} ·</span>}
        <span className={`min-w-0 truncate ${running ? "text-content-dim" : ""}`}>{v.activity}</span>
        {v.toolCount > 0 && (
          <span className="shrink-0">
            · {t("turn.toolsN", { count: v.toolCount })}
          </span>
        )}
      </div>
    </button>
  );
}
