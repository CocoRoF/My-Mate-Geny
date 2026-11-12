/**
 * A call in her conversation (the message's meta.call, app/mate/calls.py): who called, how long, when — "음성 통화",
 * "부재중 전화", "거절한 전화"… — and what was said, folded until asked for. The user can delete it like their own message
 * (their words on the call are theirs).
 */
import { memo, useState } from "react";
import type { CallCardData } from "../../../api/calls";
import type { MessageMeta } from "../../../stores/chatStore";
import { useMateChat } from "../../../mate/useMateConversation";
import { callLength } from "../../../mate/call/machine";
import { fmtTime } from "../../../i18n/format";
import { useT, type MsgKey } from "../../../i18n";
import Icon, { type IconName } from "../../ui/Icon";
import DeleteMessageButton from "../../chat/DeleteMessageButton";

const TITLE: Record<CallCardData["status"], MsgKey> = {
  talked: "mate.callCardTalked",
  missed: "mate.callCardMissed",
  declined: "mate.callCardDeclined",
  cancelled: "mate.callCardCancelled",
  failed: "mate.callCardFailed",
};

function icon(c: CallCardData): IconName {
  if (c.status === "missed" || c.status === "declined" || c.status === "failed") return "phone-missed";
  return c.direction === "outgoing" ? "phone-outgoing" : "phone-incoming";
}

export default memo(function CallCard({ meta, name, messageId, text }: { meta: MessageMeta; name: string; messageId?: string; text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const c = meta.call as CallCardData | undefined;
  if (!c || meta.hidden) return null;
  const bad = c.status === "missed" || c.status === "declined" || c.status === "failed";
  const lines = (c.transcript || []).filter((x) => x.text);
  const when = c.started_at ? fmtTime(c.started_at) : "";
  const who = c.direction === "outgoing" ? t("mate.callCardYouCalled", { name }) : t("mate.callCardSheCalled", { name });
  return (
    <div className="flex w-full flex-col items-center gap-1.5" data-testid="mate-call-card" data-status={c.status}>
      <div className="group flex max-w-[92%] items-center gap-1">
        <div className={`flex min-w-0 items-center gap-2.5 rounded-2xl border bg-surface/80 px-3 py-2 ${bad ? "border-danger/25" : "border-border"}`}>
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${bad ? "bg-danger/12 text-danger" : "bg-success/15 text-success"}`}>
            <Icon name={icon(c)} size={15} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-content">
              {t(TITLE[c.status] ?? "mate.callCardTalked")}
              {c.status === "talked" && c.duration_s > 0 && <span className="ml-1.5 font-normal tabular-nums text-content-dim">{callLength(c.duration_s)}</span>}
            </span>
            <span className="block truncate text-[11.5px] text-content-faint" title={c.error || undefined}>
              {who}
              {when && ` · ${when}`}
            </span>
          </span>
          {lines.length > 0 && (
            <button type="button" onClick={() => setOpen((v) => !v)} className="ml-1 shrink-0 rounded-full px-2 py-1 text-[11.5px] text-accent hover:bg-accent-soft" aria-expanded={open} data-testid="mate-call-transcript-toggle">
              {open ? t("mate.callTranscriptHide") : t("mate.callTranscript")}
            </button>
          )}
        </div>
        {/* (what they said on it is theirs to delete) */}
        {!meta.internal && <DeleteMessageButton messageId={messageId} text={text} attachments={[]} meta={meta} store={useMateChat} />}
      </div>
      {open && (
        <div className="w-full max-w-[92%] rounded-2xl border border-border bg-surface-2/70 px-3.5 py-2.5 text-[12.5px] leading-relaxed animate-fade-in" data-testid="mate-call-transcript">
          {lines.map((x, i) => (
            <p key={i} className="break-words">
              <span className={`mr-1.5 font-medium ${x.who === "user" ? "text-accent" : "text-success"}`}>{x.who === "user" ? t("mate.callYou") : name}</span>
              <span className="text-content-dim">{x.text}</span>
              {x.cut && <span className="ml-1 text-[11px] text-content-faint">({t("mate.callCutOff")})</span>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
});
