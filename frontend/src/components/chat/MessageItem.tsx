import { memo } from "react";
import type { Turn } from "../../stores/chatStore";
import Icon from "../ui/Icon";
import MessageAttachments from "../attachments/MessageAttachments";
import AssistantTurn from "./turn/AssistantTurn";
import CompactionDivider from "./CompactionDivider";
import ViaBadge from "./ViaBadge";
import RewindButton from "./RewindButton";
import DeleteMessageButton from "./DeleteMessageButton";
import { useChatStore } from "../../stores/chatStore";
import { tr } from "../../i18n";
import { noticeText } from "../../lib/notices";

// Memoized: a turn re-renders only when it changes (copy-on-write in the store)
// — prepending older turns or streaming into the last one leaves the rest alone.
export default memo(function MessageItem({ turn }: { turn: Turn }) {
  if (turn.role === "user" && turn.meta?.internal && turn.meta?.kind === "task_notification") {
    // (background work ended while no turn ran and the agent went on by itself: a note, not something the user said)
    return (
      <div className="flex items-center gap-3 py-1 text-[11.5px] text-content-faint animate-fade-in" data-testid="task-notification-turn">
        <span className="h-px flex-1 bg-border" />
        <span className="inline-flex items-center gap-1.5">
          <Icon name="activity" size={12} />
          {tr("chat.taskNotificationTurn")}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  if (turn.role === "user" && turn.meta?.hidden) return null; // (the user deleted it)
  if (turn.role === "user") {
    const atts = turn.attachments || [];
    return (
      <div className="group flex flex-col items-end gap-1.5 animate-fade-in">
        <ViaBadge meta={turn.meta} />
        {atts.length > 0 && <MessageAttachments attachments={atts} />}
        {turn.text && (
          <div className="max-w-[85%] sm:max-w-[78%] rounded-2xl rounded-br-md bg-accent-soft border border-accent/25 px-3.5 py-2 text-sm text-content whitespace-pre-wrap break-words">
            {turn.text}
          </div>
        )}
        <div className="flex items-center gap-0.5">
          <DeleteMessageButton messageId={turn.messageId} text={turn.text} attachments={atts} meta={turn.meta} store={useChatStore} />
          <RewindButton messageId={turn.messageId} text={turn.text} meta={turn.meta} />
        </div>
      </div>
    );
  }

  if (turn.role === "system") {
    if (turn.code === "context.compacted") return <CompactionDivider data={turn.data} message={turn.text} />;
    return (
      <div className="flex items-center gap-3 py-1 text-[11.5px] text-content-faint animate-fade-in">
        <span className="h-px flex-1 bg-border" />
        <span className={`inline-flex items-center gap-1.5 ${turn.level === "warning" ? "text-warning" : ""}`}>
          <Icon name={turn.level === "warning" ? "warning" : "info"} size={12} />
          {noticeText(turn.code, turn.data, turn.text)}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  return <AssistantTurn turn={turn} />;
});
