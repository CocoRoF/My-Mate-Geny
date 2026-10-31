/**
 * The mate conversation as bubbles: her lines (emotion tags stripped, light markdown, streaming), what she did with
 * her tools as small activity chips, delegation results as compact cards linking to the worker chat.
 */
import { memo } from "react";
import type { FlowItem, ToolActivity, Turn } from "../../stores/chatStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUIStore } from "../../stores/uiStore";
import { parseEmotionText } from "../../mate/emotion";
import { currentSurface, desktopMate } from "../../mate/desktop";
import Icon, { type IconName } from "../ui/Icon";
import MiniMarkdown from "./MiniMarkdown";
import MessageAttachments from "../attachments/MessageAttachments";
import type { Attachment } from "../../types";
import { useMateChat } from "../../mate/useMateConversation";
import { useHistoryScroll } from "../../hooks/useHistoryScroll";
import HistoryEdge from "../chat/HistoryEdge";

/** open a worker chat: in the console's Chat view, or (desktop Mate windows) in the console window */
export function openWorkerChat(sid: string) {
  if (currentSurface() === "console" || !desktopMate()) {
    if (new URLSearchParams(window.location.search).get("surface")) {
      window.open(`/?view=chat&session=${encodeURIComponent(sid)}`, "_blank");
      return;
    }
    useSessionStore.getState().setActive(sid);
    useUIStore.getState().setView("chat");
    return;
  }
  void desktopMate()!.openConsole(`${window.location.origin}/?view=chat&session=${encodeURIComponent(sid)}`);
}

const short = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
/** "2 files " for a tool call that forwarded attachments ("" without) */
const files = (a: unknown) => {
  const n = Array.isArray(a) ? a.length : 0;
  return n ? `${n} file${n === 1 ? "" : "s"} ` : "";
};

function parseJson(s: string | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** what a mate tool call reads as: "Looked at your chats", "Sent to ‹title›"… */
export function describeTool(t: ToolActivity): { icon: IconName; label: string; sessionId?: string } {
  const name = t.name.replace(/^mcp__mate__/, "");
  const input = (t.input || {}) as Record<string, any>;
  const out = t.output || "";
  const quoted = /"([^"]+)" \((sess_[\w-]+|[\w-]{6,})\)/.exec(out);
  switch (name) {
    case "list_sessions":
      return { icon: "chat", label: input.query ? `Looked for chats about “${short(String(input.query), 30)}”` : "Looked at your chats" };
    case "read_session": {
      const j = parseJson(out);
      return { icon: "eye", label: `Read ${j?.title ? `“${short(j.title)}”` : "a chat"}`, sessionId: String(input.session_id || "") || undefined };
    }
    case "send_to_session":
      return {
        icon: "send",
        label: `Sent ${files(input.attachments)}to ${quoted ? `“${short(quoted[1])}”` : "a chat"}`,
        sessionId: String(input.session_id || "") || undefined,
      };
    case "create_session":
      return {
        icon: "folder-plus",
        label: `Started a chat in ${input.workspace_path ? base(String(input.workspace_path)) : "a folder"}${
          Array.isArray(input.attachments) && input.attachments.length ? ` (${files(input.attachments).trim()})` : ""
        }`,
        sessionId: quoted?.[2],
      };
    case "find_folders":
      return { icon: "search", label: `Looked for folders “${short(String(input.query || ""), 30)}”` };
    case "remember":
      return { icon: "brain", label: `Remembered: ${short(String(input.text || ""), 60)}` };
    case "forget":
      return { icon: "brain", label: "Forgot a memory" };
    default:
      return { icon: "bolt", label: name };
  }
}

function ActivityChip({ tool }: { tool: ToolActivity }) {
  const d = describeTool(tool);
  const running = tool.durationMs === undefined;
  const cls = `inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] ${
    tool.isError ? "border-danger/30 bg-danger/10 text-danger" : "border-border bg-surface-2/80 text-content-dim"
  }`;
  const body = (
    <>
      <Icon name={running ? "spinner" : tool.isError ? "warning" : d.icon} size={11} spin={running} />
      <span className="truncate">{d.label}</span>
      {d.sessionId && !tool.isError && <Icon name="external" size={10} className="shrink-0 opacity-60" />}
    </>
  );
  return (
    <div className="flex" data-testid="mate-activity">
      {d.sessionId && !tool.isError ? (
        <button
          className={`${cls} hover:text-content hover:border-border-strong transition`}
          onClick={() => openWorkerChat(d.sessionId!)}
          title={tool.isError ? tool.output : "Open that chat"}
        >
          {body}
        </button>
      ) : (
        <span className={cls} title={tool.isError ? tool.output : undefined}>
          {body}
        </span>
      )}
    </div>
  );
}

function linesOf(text: string, streaming: boolean): string[] {
  return parseEmotionText(text, { streaming })
    .text.split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(?:\([^()]*\)|\*[^*]+\*)$/.test(l));
}

function Bubble({ text, compact }: { text: string; compact?: boolean }) {
  return (
    <div
      className={`max-w-[88%] w-fit rounded-2xl rounded-bl-md border border-border bg-surface-2 text-content break-words whitespace-pre-wrap ${
        compact ? "px-3 py-1.5 text-[13px]" : "px-3.5 py-2 text-sm"
      }`}
      data-testid="mate-bubble"
    >
      <MiniMarkdown text={text} />
    </div>
  );
}

/** what the user said: the files they attached (thumbnails / file cards, like the Chat view), then the text */
function UserBubble({ text, attachments, pending }: { text: string; attachments?: Attachment[]; pending?: boolean }) {
  return (
    <div className={`flex flex-col items-end gap-1.5 ${pending ? "opacity-70" : ""}`} data-testid="mate-user-message">
      {!!attachments?.length && (
        <div className="max-w-[85%]" data-testid="mate-user-attachments">
          <MessageAttachments attachments={attachments} />
        </div>
      )}
      {text.trim() && (
        <div
          className={`max-w-[85%] rounded-2xl rounded-br-md border px-3.5 py-2 text-sm text-content whitespace-pre-wrap break-words ${
            pending ? "border-border bg-surface-2/60" : "border-accent/25 bg-accent-soft"
          }`}
          data-testid="mate-user-bubble"
        >
          {text}
        </div>
      )}
    </div>
  );
}

function Typing() {
  return (
    <div className="w-fit rounded-2xl rounded-bl-md border border-border bg-surface-2 px-3.5 py-2.5" aria-label="Thinking">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 rounded-full bg-content-dim animate-pulse-dot" style={{ animationDelay: `${i * 0.18}s` }} />
        ))}
      </span>
    </div>
  );
}

const STATUS: Record<string, { label: string; cls: string; icon: IconName }> = {
  ok: { label: "finished", cls: "text-success", icon: "check" },
  error: { label: "failed", cls: "text-danger", icon: "warning" },
  stopped: { label: "stopped", cls: "text-warning", icon: "pause" },
};

function DelegationCards({ turn }: { turn: Turn }) {
  const list = turn.meta?.delegations?.length ? turn.meta.delegations : [];
  return (
    <div className="flex flex-col items-center gap-1.5" data-testid="mate-delegation-result">
      {list.map((d) => {
        const st = STATUS[d.status] || STATUS.error;
        return (
          <button
            key={d.session_id}
            onClick={() => openWorkerChat(d.session_id)}
            className="group flex max-w-[92%] items-center gap-2 rounded-xl border border-border bg-surface/80 px-3 py-1.5 text-[12px] text-content-dim transition hover:border-border-strong hover:text-content"
            title="Open that chat"
          >
            <Icon name={st.icon} size={12} className={st.cls} />
            <span className="truncate">
              <span className="font-medium text-content">{d.title || "A chat"}</span> {st.label}
            </span>
            <Icon name="external" size={11} className="shrink-0 opacity-50 group-hover:opacity-100" />
          </button>
        );
      })}
      {!list.length && <span className="text-[11.5px] text-content-faint">A chat reported back</span>}
    </div>
  );
}

const AssistantBubbles = memo(function AssistantBubbles({ turn, compact }: { turn: Turn; compact?: boolean }) {
  const running = !turn.complete;
  const toolsById = new Map(turn.tools.map((t) => [t.id, t]));
  const lastText = turn.flow.reduce((n, f, i) => (f.kind === "text" ? i : n), -1);
  const items: JSX.Element[] = [];
  turn.flow.forEach((f: FlowItem, i) => {
    if (f.kind === "text") {
      for (const [j, l] of linesOf(f.text, running && i === lastText).entries()) items.push(<Bubble key={`${i}.${j}`} text={l} compact={compact} />);
    } else if (f.kind === "tool") {
      const t = toolsById.get(f.toolId);
      if (t) items.push(<ActivityChip key={i} tool={t} />);
    } else if (f.kind === "steer") {
      items.push(<UserBubble key={i} text={f.text} attachments={f.attachments} pending={f.pending} />);
    } else if (f.kind === "notice") {
      items.push(
        <div key={i} className={`text-[11.5px] ${f.level === "warning" ? "text-warning" : "text-content-faint"}`}>
          {f.message}
        </div>,
      );
    }
  });
  const hasText = lastText >= 0 && !!parseEmotionText(turn.text, { streaming: running }).text.trim();
  const toolRunning = turn.tools.some((t) => t.durationMs === undefined);
  return (
    <div className="flex flex-col items-start gap-1.5 animate-fade-in" data-testid="mate-turn">
      {items}
      {running && (!hasText || toolRunning) && <Typing />}
      {turn.error && turn.status !== "interrupted" && (
        <div className="flex items-start gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
          <Icon name="warning" size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">{turn.error.message || "Something went wrong"}</span>
        </div>
      )}
      {turn.status === "interrupted" && <span className="text-[11px] text-content-faint">stopped</span>}
    </div>
  );
});

export default function MateMessages({
  turns,
  compact = false,
  emptyText,
  className = "",
}: {
  turns: Turn[];
  compact?: boolean;
  emptyText?: string;
  className?: string;
}) {
  // (the mate's store: older turns load as the reader scrolls up)
  const { ref, onScroll, showJump, jump, paging, loadOlder } = useHistoryScroll(useMateChat, 100);

  return (
    <div className={`relative min-h-0 flex-1 ${className}`}>
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain">
        <div className={`mx-auto flex max-w-2xl flex-col ${compact ? "gap-2.5 px-3 py-3" : "gap-3.5 px-4 py-5"}`}>
          <HistoryEdge paging={paging} empty={turns.length === 0} onRetry={loadOlder} />
          {turns.length === 0 && emptyText && <p className="pt-10 text-center text-sm text-content-faint">{emptyText}</p>}
          {turns.map((t) => {
            if (t.role === "user") {
              if (t.meta?.internal && t.meta.kind === "delegation_result") return <DelegationCards key={t.key} turn={t} />;
              if (t.meta?.internal) return null;
              return <UserBubble key={t.key} text={t.text} attachments={t.attachments} />;
            }
            if (t.role === "system") {
              const reset = t.code === "context.reset";
              return (
                <div key={t.key} className="flex items-center gap-3 py-1 text-[11px] text-content-faint">
                  <span className="h-px flex-1 bg-border" />
                  <span className={`text-center ${t.level === "warning" ? "text-warning" : ""}`}>
                    {reset ? "New conversation — what's above is forgotten" : t.text}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              );
            }
            return <AssistantBubbles key={t.key} turn={t} compact={compact} />;
          })}
        </div>
      </div>
      {showJump && (
        <button
          onClick={jump}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-3 py-1 text-[11.5px] text-content-dim shadow-float hover:text-content"
        >
          <Icon name="arrow-up" size={12} className="rotate-180" /> Latest
        </button>
      )}
    </div>
  );
}
