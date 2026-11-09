import { useMemo, useState } from "react";
import type { FlowItem, ToolActivity, Turn } from "../../../stores/chatStore";
import Icon from "../../ui/Icon";
import Markdown from "../../ui/Markdown";
import MessageAttachments from "../../attachments/MessageAttachments";
import ThinkingBlock from "./ThinkingBlock";
import TodoCard, { todosOf } from "./TodoCard";
import ToolGroup, { wasStopped } from "./ToolGroup";
import SubagentCard from "./SubagentCard";
import { isAgentTool } from "./subagent";
import { fmtMs } from "./toolMeta";
import TurnChangesCard from "../../changes/TurnChangesCard";
import { useT } from "../../../i18n";
import { fmtDateTime, relTime } from "../../../i18n/format";
import { useChatStore } from "../../../stores/chatStore";
import RewindButton from "../RewindButton";
import DeleteMessageButton from "../DeleteMessageButton";
import TurnCost from "../TurnCost";
import CompactionDivider from "../CompactionDivider";
import ViaBadge from "../ViaBadge";
import HiggsfieldSpend from "./HiggsfieldSpend";

type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; item: Extract<FlowItem, { kind: "thinking" }> }
  | { kind: "tools"; tools: ToolActivity[] }
  | { kind: "todo"; tool: ToolActivity }
  | { kind: "agent"; tool: ToolActivity }
  | { kind: "notice"; item: Extract<FlowItem, { kind: "notice" }> }
  | { kind: "steer"; item: Extract<FlowItem, { kind: "steer" }> };

/** Flow -> render segments: prose stays prose, consecutive tool calls fold
 * into one group, task lists get their own checklist, subagents their card. */
function segment(turn: Turn): Segment[] {
  const byId = new Map(turn.tools.map((t) => [t.id, t]));
  const out: Segment[] = [];
  for (const item of turn.flow) {
    if (item.kind === "text") {
      if (!item.text.trim()) continue;
      const last = out[out.length - 1];
      if (last?.kind === "text") last.text += item.text;
      else out.push({ kind: "text", text: item.text });
    } else if (item.kind === "thinking") {
      if (item.scope === "response" && item.endedAt !== undefined && item.endedAt - item.startedAt < 100) continue;
      if (item.text.trim() || item.timingKnown || !item.endedAt) out.push({ kind: "thinking", item });
    } else if (item.kind === "notice") {
      out.push({ kind: "notice", item });
    } else if (item.kind === "steer") {
      out.push({ kind: "steer", item });
    } else {
      const tool = byId.get(item.toolId);
      if (!tool) continue;
      if (tool.name.toLowerCase() === "todowrite") {
        out.push({ kind: "todo", tool });
        continue;
      }
      if (isAgentTool(tool)) {
        out.push({ kind: "agent", tool });
        continue;
      }
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.tools.push(tool);
      else if (last?.kind === "thinking" && out[out.length - 2]?.kind === "tools") {
        // reasoning between tool calls doesn't break the group visually
        (out[out.length - 2] as Extract<Segment, { kind: "tools" }>).tools.push(tool);
      } else out.push({ kind: "tools", tools: [tool] });
    }
  }
  return out;
}

function tokens(usage: Record<string, any> | undefined, t: ReturnType<typeof useT>): string | null {
  if (!usage) return null;
  // Claude reports cache reads/writes separately; Codex's input_tokens already includes them.
  const inp =
    (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const out = usage.output_tokens || 0;
  if (!inp && !out) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  return t("turn.tokensInOut", { in: k(inp), out: k(out) });
}

/** Ask the composer to re-send a message (retry after an error/stop). */
export function requestResend(text: string, attachments: any[] = []) {
  window.dispatchEvent(new CustomEvent("hrh:resend", { detail: { text, attachments } }));
}

function Footer({ turn }: { turn: Turn }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  // (narrow selectors: a footer re-renders only when it becomes / stops being
  // the last turn — not on every change of a long, paged transcript)
  const isLast = useChatStore((s) => s.turns[s.turns.length - 1]?.key === turn.key);
  const prevUser = useChatStore((s) => {
    if (s.turns[s.turns.length - 1]?.key !== turn.key) return null;
    for (let j = s.turns.length - 2; j >= 0; j--) if (s.turns[j].role === "user") return s.turns[j];
    return null;
  });
  const isStreaming = useChatStore((s) => s.isStreaming);
  const canRetry = isLast && !isStreaming && (turn.status === "error" || turn.status === "interrupted") && prevUser;
  const dur = turn.startedAt && turn.endedAt ? fmtMs(turn.endedAt - turn.startedAt) : null;
  const tk = tokens(turn.usage, t);
  const failed = turn.tools.filter((x) => x.isError && !wasStopped(x)).length;
  const parts = [
    turn.model,
    dur && t("turn.worked", { d: dur }),
    (() => {
      const ms = turn.flow.reduce((n, f) => n + (f.kind === "thinking" && !f.scope && f.timingKnown && f.endedAt !== undefined ? Math.max(0, f.endedAt - f.startedAt) : 0), 0);
      return ms > 0 ? t("turn.thoughtFor", { d: fmtMs(ms) }) : null;
    })(),
    turn.tools.length ? `${t("turn.toolsN", { count: turn.tools.length })}${failed ? ` (${t("turn.failedN", { count: failed })})` : ""}` : null,
    tk,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-[10.5px] text-content-faint">
      {turn.status === "interrupted" && <span className="pill bg-surface-3 text-content-dim">{t("turn.stopped")}</span>}
      <span className="font-mono">{parts.join(" · ")}</span>
      <TurnCost turn={turn} />
      {turn.endedAt ? (
        <span title={fmtDateTime(turn.endedAt)}>· {relTime(turn.endedAt)}</span>
      ) : null}
      {canRetry && (
        <button
          onClick={() => requestResend(prevUser!.text)}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-accent hover:bg-accent-soft transition"
          title={t("turn.retryTitle")}
        >
          <Icon name="refresh" size={11} /> {t("common.retry")}
        </button>
      )}
      {turn.text.trim() && (
        <button
          onClick={() =>
            navigator.clipboard?.writeText(turn.text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-content-dim hover:bg-surface-3 transition"
          title={t("turn.copyResponse")}
        >
          <Icon name={copied ? "check" : "copy"} size={11} /> {copied ? t("common.copied") : t("common.copy")}
        </button>
      )}
    </div>
  );
}

export default function AssistantTurn({ turn }: { turn: Turn }) {
  const t = useT();
  const segments = useMemo(() => segment(turn), [turn]);
  const live = !turn.complete;
  const empty = segments.length === 0;

  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="mt-0.5 grid place-items-center w-7 h-7 shrink-0 rounded-lg bg-gradient-to-br from-accent to-cyan shadow-glow">
        <Icon name="bolt" size={14} className="text-white" />
      </div>
      <div className="min-w-0 flex-1 space-y-2.5">
        {turn.trigger === "background" && (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-[11.5px] text-accent">
            <Icon name="activity" size={12} /> {t("turn.startedByBackground")}
          </div>
        )}
        {segments.map((s, i) => {
          switch (s.kind) {
            case "text":
              return <Markdown key={i}>{s.text}</Markdown>;
            case "thinking":
              return (
                <ThinkingBlock key={i} text={s.item.text} startedAt={s.item.startedAt} endedAt={s.item.endedAt} timingKnown={s.item.timingKnown} scope={s.item.scope} live={live} />
              );
            case "tools":
              return <ToolGroup key={i} tools={s.tools} allTools={turn.tools} />;
            case "todo":
              return <TodoCard key={i} todos={todosOf(s.tool.input)} />;
            case "agent":
              return <SubagentCard key={i} tool={s.tool} allTools={turn.tools} />;
            case "steer":
              if (s.item.meta?.hidden) return null; // (the user deleted it)
              return (
                <div key={i} className="group flex flex-col items-end gap-1 py-0.5">
                  <span className="inline-flex items-center gap-1.5 text-[10.5px] text-content-faint">
                    <ViaBadge meta={s.item.meta} />
                    {s.item.pending ? (
                      <>
                        <Icon name="spinner" size={10} spin /> {t("turn.sendingToAgent")}
                      </>
                    ) : (
                      <>
                        <Icon name="check" size={10} className="text-success" /> {t("turn.addedWhileWorking")}
                      </>
                    )}
                  </span>
                  {s.item.attachments.length > 0 && <MessageAttachments attachments={s.item.attachments} />}
                  {s.item.text && (
                    <div
                      className={`max-w-[85%] rounded-2xl rounded-br-md border px-3.5 py-2 text-sm text-content whitespace-pre-wrap break-words ${
                        s.item.pending ? "border-border bg-surface-2/60 opacity-70" : "border-accent/25 bg-accent-soft"
                      }`}
                    >
                      {s.item.text}
                    </div>
                  )}
                  {!s.item.pending && (
                    <div className="flex items-center gap-0.5">
                      <DeleteMessageButton messageId={s.item.messageId} text={s.item.text} attachments={s.item.attachments} meta={s.item.meta} store={useChatStore} />
                      <RewindButton messageId={s.item.messageId} text={s.item.text} meta={s.item.meta} />
                    </div>
                  )}
                </div>
              );
            case "notice":
              if (s.item.code === "context.compacted")
                return <CompactionDivider key={i} data={s.item.data} message={s.item.message} />;
              if (s.item.code === "higgsfield.spend") return <HiggsfieldSpend key={i} data={s.item.data} />;
              return (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] ${
                    s.item.level === "warning" ? "bg-warning/8 text-warning" : "bg-accent/8 text-content-dim"
                  }`}
                >
                  <Icon name={s.item.level === "warning" ? "warning" : "info"} size={14} className="mt-[1px] shrink-0" />
                  <span>{s.item.code === "screen.capture_failed" ? t("screen.messageWithoutScreen") : s.item.message}</span>
                </div>
              );
          }
        })}

        {live && !turn.flow.some(f => f.kind === "thinking" && f.endedAt === undefined) && (empty || !["tools", "agent"].includes(segments[segments.length - 1].kind)) && (
          <div className="flex items-center gap-1.5 py-1 text-content-faint text-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" />
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot [animation-delay:0.2s]" />
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot [animation-delay:0.4s]" />
          </div>
        )}

        {turn.status === "error" && turn.error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/8 px-3.5 py-2.5">
            <Icon name="alert-circle" size={15} className="mt-[2px] shrink-0 text-danger" />
            <div className="min-w-0">
              <div className="text-[13px] text-content whitespace-pre-wrap break-words">{turn.error.code === "turn.lost" ? t("turn.runLost") : turn.error.message}</div>
              <div className="mt-0.5 font-mono text-[10.5px] text-content-faint">{turn.error.code}</div>
            </div>
          </div>
        )}

        {turn.changes && turn.changes.files > 0 && <TurnChangesCard changes={turn.changes} />}

        {turn.complete && <Footer turn={turn} />}
      </div>
    </div>
  );
}
