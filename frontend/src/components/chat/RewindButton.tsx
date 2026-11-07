/**
 * "Go back to before this message" on a message the user sent: a small button under the bubble (on hover; always there on a
 * touch screen), and the dialog that says what it takes back before anything happens.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { rewindPreview, type RewindPreview } from "../../api/sessions";
import { useT } from "../../i18n";
import { rewindTo } from "../../lib/rewind";
import { useChatStore, type MessageMeta } from "../../stores/chatStore";
import Icon from "../ui/Icon";

const SHOWN_FILES = 6;

function RewindDialog({ sid, messageId, text, onClose }: { sid: string; messageId: string; text: string; onClose: () => void }) {
  const t = useT();
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    rewindPreview(sid, messageId)
      .then((p) => alive && setPreview(p))
      .catch((e: Error) => alive && setError(t("turn.rewindFailed", { error: e.message })));
    return () => {
      alive = false;
    };
  }, [sid, messageId, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // (a turn at work may have changed more by the time it stops; the server looks again then)
  const offerFiles = !!preview && (preview.file_count > 0 || (preview.running && !preview.joined));
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await rewindTo(sid, messageId, restoreFiles && offerFiles);
      onClose();
    } catch (e) {
      setError(t("turn.rewindFailed", { error: (e as Error).message }));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] grid place-items-center bg-scrim/60 p-4 backdrop-blur-sm" onClick={() => !busy && onClose()} data-testid="rewind-dialog">
      <div role="dialog" aria-modal="true" aria-label={t("turn.rewindTitle")} className="flex max-h-[85vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-surface-2 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Icon name="rotate" size={16} className="text-accent" /> {t("turn.rewindTitle")}
        </h2>
        {text && <p className="line-clamp-3 whitespace-pre-wrap break-words rounded-lg border border-accent/25 bg-accent-soft px-3 py-2 text-[13px]">{text}</p>}
        {!preview && !error && (
          <div className="grid h-16 place-items-center text-content-faint">
            <Icon name="spinner" size={16} spin />
          </div>
        )}
        {preview && (
          <div className="space-y-2 text-[13px] leading-relaxed text-content-dim">
            <p data-testid="rewind-gone">{t("turn.rewindGone", { count: preview.messages })}</p>
            <p>{t("turn.rewindBack")}</p>
            {preview.running && <p className="text-warning">{t("turn.rewindRunning")}</p>}
            {preview.joined && <p>{t("turn.rewindJoined")}</p>}
            {offerFiles && (
              <div className="rounded-lg border border-border/70 px-3 py-2">
                <label className="flex cursor-pointer items-start gap-2 text-content">
                  <input type="checkbox" className="mt-0.5" checked={restoreFiles} onChange={(e) => setRestoreFiles(e.target.checked)} data-testid="rewind-files" />
                  <span>{preview.file_count > 0 ? t("turn.rewindFiles", { count: preview.file_count }) : t("turn.rewindFilesRunning")}</span>
                </label>
                <ul className="mt-1.5 space-y-0.5 pl-6 font-mono text-[11.5px] text-content-faint">
                  {preview.files.slice(0, SHOWN_FILES).map((f) => (
                    <li key={f.root + f.path} className="truncate">
                      {f.path}
                    </li>
                  ))}
                  {preview.file_count > SHOWN_FILES && <li className="font-sans">{t("turn.rewindMoreFiles", { count: preview.file_count - SHOWN_FILES })}</li>}
                </ul>
                {restoreFiles && <p className="mt-1.5 pl-6 text-[11.5px] text-warning">{t("turn.rewindFilesHint")}</p>}
              </div>
            )}
            <p className="text-[11.5px] text-content-faint">{t("turn.rewindNotUndone")}</p>
          </div>
        )}
        {error && <p className="text-[12.5px] text-danger" data-testid="rewind-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn-primary" disabled={busy || !preview} onClick={() => void go()} data-testid="rewind-confirm">
            {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="rotate" size={14} />} {t("turn.rewindConfirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function RewindButton({ messageId, text, meta }: { messageId?: string; text: string; meta?: MessageMeta }) {
  const t = useT();
  const sid = useChatStore((s) => s.sid);
  const [open, setOpen] = useState(false);
  // (a message a mate sent or the system made isn't the user's to take back)
  if (!messageId || !sid || meta?.via || meta?.internal || meta?.speech_pending) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-content-faint transition hover:bg-surface-3 hover:text-content md:can-hover:opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        title={t("turn.rewind")}
        aria-label={t("turn.rewind")}
        data-testid="rewind-open"
      >
        <Icon name="rotate" size={12} />
      </button>
      {open && <RewindDialog sid={sid} messageId={messageId} text={text} onClose={() => setOpen(false)} />}
    </>
  );
}
