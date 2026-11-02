/**
 * The mate conversation as bubbles: her lines (MateReply: a bubble per line or markdown block, emotion tags stripped,
 * streaming-safe), what she did with her tools as small activity chips, delegation results as compact cards linking to
 * the worker chat.
 */
import { memo, useState } from "react";
import type { FlowItem, ToolActivity, Turn } from "../../stores/chatStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUIStore } from "../../stores/uiStore";
import { parseEmotionText } from "../../mate/emotion";
import { currentSurface, desktopMate } from "../../mate/desktop";
import Icon, { type IconName } from "../ui/Icon";
import MateReply from "./MateReply";
import MessageAttachments from "../attachments/MessageAttachments";
import type { Attachment } from "../../types";
import { useMateChat } from "../../mate/useMateConversation";
import { useHistoryScroll } from "../../hooks/useHistoryScroll";
import HistoryEdge from "../chat/HistoryEdge";
import { tr, useT, type MsgKey } from "../../i18n";
import { useMateStore } from "../../stores/mateStore";
import { changeIdOf, describeChanges, flatArgs, resolveChange, useStyleChanges } from "../../mate/styleChanges";

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
/** how many files a tool call forwarded (0 without) */
const fileCount = (a: unknown) => (Array.isArray(a) ? a.length : 0);

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
      return { icon: "chat", label: input.query ? tr("mate.toolSearchedChats", { query: short(String(input.query), 30) }) : tr("mate.toolListedChats") };
    case "read_session": {
      const j = parseJson(out);
      return {
        icon: "eye",
        label: j?.title ? tr("mate.toolReadTitled", { title: short(j.title) }) : tr("mate.toolReadChat"),
        sessionId: String(input.session_id || "") || undefined,
      };
    }
    case "send_to_session":
      return {
        icon: "send",
        label: (() => {
          const n = fileCount(input.attachments);
          const to = quoted ? tr("mate.toolQuoted", { title: short(quoted[1]) }) : tr("mate.toolAChat");
          return n ? tr("mate.toolSentFiles", { count: n, to }) : tr("mate.toolSent", { to });
        })(),
        sessionId: String(input.session_id || "") || undefined,
      };
    case "create_session":
      return {
        icon: "folder-plus",
        label: (() => {
          const where = input.workspace_path ? base(String(input.workspace_path)) : tr("mate.toolAFolder");
          const n = fileCount(input.attachments);
          return n ? tr("mate.toolStartedFiles", { where, count: n }) : tr("mate.toolStarted", { where });
        })(),
        sessionId: quoted?.[2],
      };
    case "find_folders":
      return { icon: "search", label: tr("mate.toolFoundFolders", { query: short(String(input.query || ""), 30) }) };
    case "remember":
      return { icon: "brain", label: tr("mate.toolRemembered", { text: short(String(input.text || ""), 60) }) };
    case "forget":
      return { icon: "brain", label: tr("mate.toolForgot") };
    case "update_conversation_style": {
      // (her own change of how she talks: the chip below shows it with Undo / Apply)
      const what = describeChanges(flatArgs(input));
      if (t.durationMs === undefined) return { icon: "sliders", label: tr("mate.toolStyleChanging") };
      if (t.isError) return { icon: "sliders", label: tr("mate.toolStyleFailed") };
      return { icon: "sliders", label: /^Proposed/.test(out) ? tr("mate.toolStyleProposed", { what }) : /^Nothing/.test(out) ? tr("mate.toolStyleSame") : tr("mate.toolStyleChanged", { what }) };
    }
    case "see_screen":
      // (docs/mate.md §4 "Seeing the screen": the picture shows under the chip)
      return {
        icon: "monitor",
        label: t.durationMs === undefined ? tr("mate.toolSeeingScreen") : t.isError ? tr("mate.toolScreenNotShared") : tr("mate.toolSawScreen"),
      };
    default:
      return { icon: "bolt", label: name };
  }
}

/** her own change of the conversation style: what changed, with Undo (applied) or Apply / Dismiss (proposed) */
function StyleChip({ tool }: { tool: ToolActivity }) {
  const t = useT();
  const sid = useMateChat((s) => s.sid);
  const mateId = useMateStore((s) => s.mates.find((m) => m.session_id && m.session_id === sid)?.id ?? null);
  const cid = changeIdOf(tool.output);
  const list = useStyleChanges(cid ? mateId : null);
  const rec = cid ? list?.find((c) => c.id === cid) : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = describeTool(tool);
  const label = rec ? (rec.status === "proposed" ? tr("mate.toolStyleProposed", { what: describeChanges(rec.changes) }) : tr("mate.toolStyleChanged", { what: describeChanges(rec.changes) })) : d.label;
  const act = (action: "undo" | "apply" | "dismiss") => {
    if (!mateId || !cid) return;
    setBusy(true);
    setError(null);
    resolveChange(mateId, cid, action)
      .catch((e) => setError(String((e as Error)?.message || e)))
      .finally(() => setBusy(false));
  };
  const done = rec && (rec.status === "undone" || rec.status === "dismissed");
  return (
    <div className="flex max-w-full flex-col items-start gap-1" data-testid="mate-style-change" data-status={rec?.status ?? ""}>
      <div className={`inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[11.5px] ${tool.isError ? "border-danger/30 bg-danger/10 text-danger" : "border-accent/30 bg-accent-soft/60 text-content-dim"}`}>
        <Icon name={tool.durationMs === undefined ? "spinner" : tool.isError ? "warning" : "sliders"} size={11} spin={tool.durationMs === undefined} />
        <span className={`min-w-0 break-words ${done ? "line-through opacity-70" : ""}`}>{label}</span>
        {rec && rec.status !== "applied" && rec.status !== "proposed" && <span className="text-content-faint">· {t(`mateSettings.styleStatus_${rec.status}` as MsgKey)}</span>}
        {rec?.status === "applied" && (
          <button type="button" className="rounded-full px-1.5 font-medium text-accent hover:underline disabled:opacity-50" disabled={busy} onClick={() => act("undo")} data-testid="mate-style-undo">
            {t("mateSettings.styleUndo")}
          </button>
        )}
        {rec?.status === "proposed" && (
          <>
            <button type="button" className="rounded-full px-1.5 font-medium text-accent hover:underline disabled:opacity-50" disabled={busy} onClick={() => act("apply")} data-testid="mate-style-apply">
              {t("mateSettings.styleApply")}
            </button>
            <button type="button" className="rounded-full px-1.5 text-content-faint hover:underline disabled:opacity-50" disabled={busy} onClick={() => act("dismiss")} data-testid="mate-style-dismiss">
              {t("mateSettings.styleDismiss")}
            </button>
          </>
        )}
      </div>
      {rec?.reason && <span className="pl-2 text-[11px] text-content-faint">“{rec.reason}”</span>}
      {error && <span className="pl-2 text-[11px] text-danger">{error}</span>}
    </div>
  );
}

function ActivityChip({ tool }: { tool: ToolActivity }) {
  const t = useT(); // (describeTool reads the language: re-render when it changes)
  if (tool.name.replace(/^mcp__mate__/, "") === "update_conversation_style") return <StyleChip tool={tool} />;
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
  const shot = !!tool.images?.length && tool.name.endsWith("see_screen");
  return (
    <div className={shot ? "flex flex-col items-start gap-1.5" : "flex"} data-testid="mate-activity">
      {d.sessionId && !tool.isError ? (
        <button
          className={`${cls} hover:text-content hover:border-border-strong transition`}
          onClick={() => openWorkerChat(d.sessionId!)}
          title={tool.isError ? tool.output : t("mate.openThatChat")}
        >
          {body}
        </button>
      ) : (
        <span className={cls} title={tool.isError ? tool.output : undefined}>
          {body}
        </span>
      )}
      {shot && (
        <div className="max-w-full" data-testid="mate-screen-shot">
          <MessageAttachments attachments={tool.images!} />
        </div>
      )}
    </div>
  );
}

/** what the user said: the files they attached (thumbnails / file cards, like the Chat view), then the text */
function UserBubble({ text, attachments, pending, compact }: { text: string; attachments?: Attachment[]; pending?: boolean; compact?: boolean }) {
  return (
    <div className={`flex flex-col items-end gap-1.5 ${pending ? "opacity-70" : ""}`} data-testid="mate-user-message">
      {!!attachments?.length && (
        // (the full width: three thumbnails in a row don't fit 85 % of a phone)
        <div className="max-w-full" data-testid="mate-user-attachments">
          <MessageAttachments attachments={attachments} />
        </div>
      )}
      {text.trim() && (
        <div
          className={`max-w-[85%] rounded-2xl rounded-br-md border text-content whitespace-pre-wrap break-words shadow-bubble ${
            compact ? "px-3 py-[7px] text-[13px] leading-[1.55]" : "px-3.5 py-2 text-sm leading-relaxed"
          } ${pending ? "border-border bg-surface-2/60" : "border-accent/30 bg-gradient-to-br from-accent/[0.22] to-accent/[0.12]"}`}
          data-testid="mate-user-bubble"
        >
          {text}
        </div>
      )}
    </div>
  );
}

function Typing() {
  const t = useT();
  return (
    <div className="w-fit rounded-2xl rounded-bl-md border border-border bg-surface-2 px-3.5 py-2.5" aria-label={t("mate.thinking")}>
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 rounded-full bg-content-dim animate-pulse-dot" style={{ animationDelay: `${i * 0.18}s` }} />
        ))}
      </span>
    </div>
  );
}

const STATUS: Record<string, { label: MsgKey; cls: string; icon: IconName }> = {
  ok: { label: "mate.delegFinished", cls: "text-success", icon: "check" },
  error: { label: "mate.delegFailed", cls: "text-danger", icon: "warning" },
  stopped: { label: "mate.delegStopped", cls: "text-warning", icon: "pause" },
};

function DelegationCards({ turn }: { turn: Turn }) {
  const t = useT();
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
            title={t("mate.openThatChat")}
          >
            <Icon name={st.icon} size={12} className={st.cls} />
            <span className="truncate">
              {t.rich(st.label, { title: <span className="font-medium text-content">{d.title || t("mate.aChat")}</span> })}
            </span>
            <Icon name="external" size={11} className="shrink-0 opacity-50 group-hover:opacity-100" />
          </button>
        );
      })}
      {!list.length && <span className="text-[11.5px] text-content-faint">{t("mate.chatReportedBack")}</span>}
    </div>
  );
}

const AssistantBubbles = memo(function AssistantBubbles({ turn, compact }: { turn: Turn; compact?: boolean }) {
  const tt = useT();
  const running = !turn.complete;
  const toolsById = new Map(turn.tools.map((t) => [t.id, t]));
  const lastText = turn.flow.reduce((n, f, i) => (f.kind === "text" ? i : n), -1);
  const items: JSX.Element[] = [];
  turn.flow.forEach((f: FlowItem, i) => {
    if (f.kind === "text") {
      items.push(<MateReply key={i} keyPrefix={`${i}.`} text={f.text} streaming={running && i === lastText} compact={compact} />);
    } else if (f.kind === "tool") {
      const t = toolsById.get(f.toolId);
      if (t) items.push(<ActivityChip key={i} tool={t} />);
    } else if (f.kind === "steer") {
      items.push(<UserBubble key={i} text={f.text} attachments={f.attachments} pending={f.pending} compact={compact} />);
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
          <span className="break-words">{turn.error.message || tt("nav.errSomethingWrong")}</span>
        </div>
      )}
      {turn.status === "interrupted" && <span className="text-[11px] text-content-faint">{tt("mate.stopped")}</span>}
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
  const tt = useT();
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
              return <UserBubble key={t.key} text={t.text} attachments={t.attachments} compact={compact} />;
            }
            if (t.role === "system") {
              const reset = t.code === "context.reset";
              return (
                <div key={t.key} className="flex items-center gap-3 py-1 text-[11px] text-content-faint">
                  <span className="h-px flex-1 bg-border" />
                  <span className={`text-center ${t.level === "warning" ? "text-warning" : ""}`}>
                    {reset ? tt("mate.resetDivider") : t.text}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              );
            }
            return <AssistantBubbles key={t.key} turn={t} compact={compact} />;
          })}
        </div>
      </div>
      {/* only while scrolled up (at the bottom the list follows by itself), just above the composer */}
      {showJump && (
        <button
          onClick={jump}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full border border-border bg-surface-2/95 px-3 py-1 touch:h-9 touch:px-4 text-[11.5px] text-content-dim shadow-float hover:text-content animate-fade-in"
          data-testid="mate-jump-latest"
        >
          <Icon name="arrow-up" size={12} className="rotate-180" /> {tt("mate.latest")}
        </button>
      )}
    </div>
  );
}
