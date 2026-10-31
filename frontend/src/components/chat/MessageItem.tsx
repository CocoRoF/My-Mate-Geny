import { memo } from "react";
import type { Turn } from "../../stores/chatStore";
import Icon from "../ui/Icon";
import MessageAttachments from "../attachments/MessageAttachments";
import AssistantTurn from "./turn/AssistantTurn";
import CompactionDivider from "./CompactionDivider";
import ViaBadge from "./ViaBadge";

// Memoized: a turn re-renders only when it changes (copy-on-write in the store)
// — prepending older turns or streaming into the last one leaves the rest alone.
export default memo(function MessageItem({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    const atts = turn.attachments || [];
    return (
      <div className="flex flex-col items-end gap-1.5 animate-fade-in">
        <ViaBadge meta={turn.meta} />
        {atts.length > 0 && <MessageAttachments attachments={atts} />}
        {turn.text && (
          <div className="max-w-[85%] sm:max-w-[78%] rounded-2xl rounded-br-md bg-accent-soft border border-accent/25 px-3.5 py-2 text-sm text-content whitespace-pre-wrap break-words">
            {turn.text}
          </div>
        )}
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
          {turn.text}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  return <AssistantTurn turn={turn} />;
});
