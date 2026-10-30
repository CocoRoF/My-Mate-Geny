import { useMemo, useState } from "react";
import type { FlowItem, ToolActivity, Turn } from "../../../stores/chatStore";
import Icon from "../../ui/Icon";
import Markdown from "../../ui/Markdown";
import MessageAttachments from "../../attachments/MessageAttachments";
import ThinkingBlock from "./ThinkingBlock";
import TodoCard, { todosOf } from "./TodoCard";
import ToolGroup from "./ToolGroup";
import { fmtMs } from "./toolMeta";
import TurnChangesCard from "../../changes/TurnChangesCard";
import { relTime, absTime } from "../../admin/format";
import { useChatStore } from "../../../stores/chatStore";

type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; item: Extract<FlowItem, { kind: "thinking" }> }
  | { kind: "tools"; tools: ToolActivity[] }
  | { kind: "todo"; tool: ToolActivity }
  | { kind: "notice"; item: Extract<FlowItem, { kind: "notice" }> }
  | { kind: "steer"; item: Extract<FlowItem, { kind: "steer" }> };

/** Flow -> render segments: prose stays prose, consecutive tool calls fold
 * into one group, task lists get their own checklist. */
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
      if (item.text.trim() || !item.endedAt) out.push({ kind: "thinking", item });
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

function tokens(usage?: Record<string, any>): string | null {
  if (!usage) return null;
  // Claude reports cache reads/writes separately; Codex's input_tokens already includes them.
  const inp =
    (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const out = usage.output_tokens || 0;
  if (!inp && !out) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  return `${k(inp)} in · ${k(out)} out`;
}

/** Ask the composer to re-send a message (retry after an error/stop). */
export function requestResend(text: string, attachments: any[] = []) {
  window.dispatchEvent(new CustomEvent("hrh:resend", { detail: { text, attachments } }));
}

function Footer({ turn }: { turn: Turn }) {
  const [copied, setCopied] = useState(false);
  const turns = useChatStore((s) => s.turns);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isLast = turns[turns.length - 1]?.key === turn.key;
  const prevUser = (() => {
    const i = turns.findIndex((t) => t.key === turn.key);
    for (let j = i - 1; j >= 0; j--) if (turns[j].role === "user") return turns[j];
    return null;
  })();
  const canRetry = isLast && !isStreaming && (turn.status === "error" || turn.status === "interrupted") && prevUser;
  const dur = turn.startedAt && turn.endedAt ? fmtMs(turn.endedAt - turn.startedAt) : null;
  const tk = tokens(turn.usage);
  const failed = turn.tools.filter((t) => t.isError).length;
  const parts = [
    turn.model,
    dur && `worked ${dur}`,
    turn.tools.length ? `${turn.tools.length} tool${turn.tools.length > 1 ? "s" : ""}${failed ? ` (${failed} failed)` : ""}` : null,
    tk,
    turn.costUsd ? `$${turn.costUsd.toFixed(4)}` : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-[10.5px] text-content-faint">
      {turn.status === "interrupted" && <span className="pill bg-surface-3 text-content-dim">Stopped</span>}
      <span className="font-mono">{parts.join(" · ")}</span>
      {turn.endedAt ? (
        <span title={absTime(new Date(turn.endedAt).toISOString())}>· {relTime(new Date(turn.endedAt).toISOString())}</span>
      ) : null}
      {canRetry && (
        <button
          onClick={() => requestResend(prevUser!.text)}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-accent hover:bg-accent-soft transition"
          title="Send the same message again"
        >
          <Icon name="refresh" size={11} /> Retry
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
          title="Copy response"
        >
          <Icon name={copied ? "check" : "copy"} size={11} /> {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

export default function AssistantTurn({ turn }: { turn: Turn }) {
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
            <Icon name="activity" size={12} /> Started by Claude after a background task finished
          </div>
        )}
        {segments.map((s, i) => {
          switch (s.kind) {
            case "text":
              return <Markdown key={i}>{s.text}</Markdown>;
            case "thinking":
              return (
                <ThinkingBlock key={i} text={s.item.text} startedAt={s.item.startedAt} endedAt={s.item.endedAt} live={live} />
              );
            case "tools":
              return <ToolGroup key={i} tools={s.tools} allTools={turn.tools} />;
            case "todo":
              return <TodoCard key={i} todos={todosOf(s.tool.input)} />;
            case "steer":
              return (
                <div key={i} className="flex flex-col items-end gap-1 py-0.5">
                  <span className="inline-flex items-center gap-1.5 text-[10.5px] text-content-faint">
                    {s.item.pending ? (
                      <>
                        <Icon name="spinner" size={10} spin /> sending to the agent…
                      </>
                    ) : (
                      <>
                        <Icon name="check" size={10} className="text-success" /> added while working
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
                </div>
              );
            case "notice":
              return (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] ${
                    s.item.level === "warning" ? "bg-warning/8 text-warning" : "bg-accent/8 text-content-dim"
                  }`}
                >
                  <Icon name={s.item.level === "warning" ? "warning" : "info"} size={14} className="mt-[1px] shrink-0" />
                  <span>{s.item.message}</span>
                </div>
              );
          }
        })}

        {live && (empty || segments[segments.length - 1].kind !== "tools") && (
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
              <div className="text-[13px] text-content whitespace-pre-wrap break-words">{turn.error.message}</div>
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
