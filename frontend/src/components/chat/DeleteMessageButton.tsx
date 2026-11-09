/**
 * "Delete" on what the user wrote — a message, or one added while a turn worked — in a chat and in a mate's
 * conversation: a small button by the bubble, and a short dialog. It goes from the chat on every device, with the
 * photos and files sent along (backend services/hidden_messages.py); what the agent or the mate already read stays in
 * their context and memory, and the dialog says so.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { hideMessage } from "../../api/sessions";
import { useT } from "../../i18n";
import { deletable } from "../../lib/messageDelete";
import type { ChatStoreApi, MessageMeta } from "../../stores/chatStore";
import type { Attachment } from "../../types";
import Icon from "../ui/Icon";

function DeleteDialog({ sid, messageId, text, files, store, onClose }: { sid: string; messageId: string; text: string; files: number; store: ChatStoreApi; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await hideMessage(sid, messageId);
      // (the server tells every window of this chat; this one needn't wait for it)
      store.getState().applyEvent({ type: "message.hidden", seq: 0, timestamp: new Date().toISOString(), data: { message_id: messageId } });
      onClose();
    } catch (e) {
      setError(t("turn.deleteFailed", { error: (e as Error).message }));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] grid place-items-center bg-scrim/60 p-4 backdrop-blur-sm" onClick={() => !busy && onClose()} data-testid="delete-message-dialog">
      <div role="dialog" aria-modal="true" aria-label={t("turn.deleteTitle")} className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-border bg-surface-2 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Icon name="trash" size={16} className="text-danger" /> {t("turn.deleteTitle")}
        </h2>
        {text.trim() && <p className="line-clamp-3 whitespace-pre-wrap break-words rounded-lg border border-accent/25 bg-accent-soft px-3 py-2 text-[13px]">{text}</p>}
        <div className="space-y-1.5 text-[13px] leading-relaxed text-content-dim">
          <p>{files ? t("turn.deleteGoneFiles", { count: files }) : t("turn.deleteGone")}</p>
          <p className="text-[12px] text-content-faint">{t("turn.deleteKept")}</p>
        </div>
        {error && <p className="text-[12.5px] text-danger" data-testid="delete-message-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn bg-danger/15 text-danger hover:bg-danger/25" disabled={busy} onClick={() => void go()} data-testid="delete-message-confirm">
            {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="trash" size={14} />} {t("turn.deleteConfirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** `shown`: false keeps it out of sight until the bubble is hovered (a pointer) or tapped (the caller says) */
export default function DeleteMessageButton({
  messageId,
  text,
  attachments,
  meta,
  store,
  shown,
}: {
  messageId?: string;
  text: string;
  attachments?: Attachment[];
  meta?: MessageMeta;
  store: ChatStoreApi;
  shown?: boolean;
}) {
  const t = useT();
  const sid = store((s) => s.sid);
  const [open, setOpen] = useState(false);
  if (!sid || !deletable(messageId, meta)) return null;
  const visibility = shown === undefined ? "md:can-hover:opacity-0" : shown ? "" : "opacity-0 pointer-events-none can-hover:pointer-events-auto";
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-content-faint transition hover:bg-surface-3 hover:text-danger group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 ${visibility}`}
        title={t("turn.deleteMessage")}
        aria-label={t("turn.deleteMessage")}
        data-testid="delete-message"
      >
        <Icon name="trash" size={12} />
      </button>
      {open && <DeleteDialog sid={sid} messageId={messageId!} text={text} files={attachments?.length ?? 0} store={store} onClose={() => setOpen(false)} />}
    </>
  );
}
