import { useLocalScreenControls } from "../composer/LocalScreenControls";
import { useCallback, useEffect } from "react";
import { resetContext } from "../../api/sessions";
import { useChatStore } from "../../stores/chatStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { Attachment, Session } from "../../types";
import AttachmentTray from "../attachments/AttachmentTray";
import { AttachMenu, FileInputs, QueuedList } from "../composer/ComposerParts";
import { useComposer, type ComposerAction } from "../composer/useComposer";
import Icon from "../ui/Icon";
import ChatControls from "./ChatControls";
import ComposerMenu from "./ComposerMenu";
import UsageFooter from "./UsageFooter";
import ContextMeter from "./ContextMeter";
import { useWorkbench } from "../../stores/workbenchStore";
import { usePhone } from "../../lib/device";
import { tr, useT } from "../../i18n";

export { filesFromClipboard } from "../composer/files";

const ACTIONS: readonly ComposerAction[] = ["clear", "plan", "agent", "stop"];

/** The Chat view's composer: the shared composer (components/composer) + the chat's controls, context meter, usage. */
export default function InputBar({
  onSend,
  onSteer,
  onStop,
  session,
}: {
  onSend: (text: string, attachments: Attachment[]) => boolean;
  onSteer: (text: string, attachments: Attachment[]) => boolean;
  onStop: () => void;
  session: Session;
}) {
  const t = useT();
  const sid = session.id;
  // Phones: the mode/engine/model/think chips fold into one button in the composer.
  const phone = usePhone();
  const info = useChatStore((s) => s.info);
  const updateSession = useSessionStore((s) => s.update);

  const runAction = useCallback(
    async (action: ComposerAction) => {
      if (action === "clear") {
        await resetContext(sid);
        return tr("chat.noticeCleared");
      }
      if (action === "plan" || action === "agent") {
        await updateSession(sid, { mode: action });
        return action === "plan" ? tr("chat.noticePlan") : tr("chat.noticeAgent");
      }
      onStop();
    },
    [sid, updateSession, onStop],
  );
  const c = useComposer({ sid, store: useChatStore, onSend, onSteer, onStop, actions: ACTIONS, runAction, slash: true, mentions: true });
  const screen = useLocalScreenControls(sid, session.title, c.addFiles);
  const { items, uploading, failed, hasContent, notice, setNotice, isStreaming, touch, trigger } = c;

  // "Mention in chat" from the explorer appends `@path ` here.
  const insert = useWorkbench((s) => s.insert);
  useEffect(() => {
    if (!insert || insert.sid !== sid) return;
    c.setInput((v) => (v && !/\s$/.test(v) ? `${v} ` : v) + insert.text);
    requestAnimationFrame(() => {
      const ta = c.taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insert?.n]);

  // Retry from a failed/stopped turn's footer re-sends that message.
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (!isStreaming) onSend(String(d.text || ""), d.attachments || []);
    };
    window.addEventListener("hrh:resend", h);
    return () => window.removeEventListener("hrh:resend", h);
  }, [isStreaming, onSend]);

  return (
    <div className="px-3 sm:px-5 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:pb-5">
      <div className="mx-auto max-w-3xl">
        {!phone && (
          <div className="pb-2">
            <ChatControls session={session} />
          </div>
        )}

        <QueuedList queue={c.queue} onRemove={c.unqueue} />

        <div className="relative rounded-2xl border border-border bg-surface-2/80 shadow-card backdrop-blur-sm focus-within:border-accent/50 transition">
          {c.menuOpen && trigger && (
            <ComposerMenu
              trigger={trigger}
              session={session}
              info={info}
              onPick={c.pick}
              onClose={c.closeMenu}
              activeIndex={c.activeIndex}
              setActiveIndex={c.setActiveIndex}
              setItems={c.setMenuItems}
            />
          )}
          {screen.ui}
          <AttachmentTray items={items} />
          <textarea
            {...c.textareaProps}
            placeholder={
              isStreaming
                ? touch
                  ? t("chat.phSteerTouch")
                  : t("chat.phSteer")
                : items.length
                  ? t("chat.phOptional")
                  : window.innerWidth < 640
                    ? t("chat.phMessage")
                    : t("chat.phMessageKeys")
            }
            className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-content placeholder:text-content-faint outline-none max-h-[240px]"
          />
          <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
            <div className="relative">
              <button
                onClick={() => c.setAttachOpen((v) => !v)}
                className={`grid place-items-center w-10 h-10 sm:w-8 sm:h-8 rounded-lg transition ${
                  c.attachOpen ? "bg-accent-soft text-accent" : "text-content-dim hover:text-content hover:bg-surface-3"
                }`}
                title={t("chat.attachTitle")}
                aria-label={t("chat.attachTitle")}
              >
                <Icon name="plus" size={18} />
              </button>
              {c.attachOpen && <AttachMenu onPick={c.pickFile} onClose={() => c.setAttachOpen(false)} onShareScreen={screen.open} />}
            </div>
            {/* while a turn runs, Queue / Add now need the room */}
            {phone && !(isStreaming && hasContent) && <ChatControls session={session} compact />}
            {items.length > 0 && (
              <span className="shrink-0 text-[11px] text-content-faint">
                {t("chat.attachedN", { count: items.length })}
                {uploading && ` · ${t("chat.uploading")}`}
                {failed > 0 && <span className="text-danger"> · {t("chat.failedN", { count: failed })}</span>}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {isStreaming && hasContent && (
                <>
                  <button
                    onClick={() => c.submit("queue")}
                    disabled={uploading}
                    className="h-10 sm:h-9 rounded-xl border border-border px-3 text-[12px] text-content-dim hover:text-content hover:bg-surface-3 transition disabled:opacity-40"
                    title={t("chat.queueTitle")}
                  >
                    {t("chat.queue")}
                  </button>
                  <button
                    onClick={() => c.submit()}
                    disabled={uploading}
                    className="h-10 sm:h-9 inline-flex items-center gap-1.5 rounded-xl px-3 text-[12px] font-medium text-white transition disabled:opacity-40 bg-accent-grad"
                    title={`${t("chat.addNowTitle")}${touch ? "" : " (Enter)"} — ${
                      session.provider === "codex" ? t("chat.addNowCodex") : t("chat.addNowAgent")
                    }`}
                  >
                    <Icon name="arrow-up" size={14} /> {t("chat.addNow")}
                  </button>
                </>
              )}
              {isStreaming ? (
                <button
                  onClick={onStop}
                  className="grid place-items-center w-10 h-10 sm:w-9 sm:h-9 rounded-xl bg-content text-bg hover:bg-content/85 transition"
                  title={t("chat.stopEsc")}
                  aria-label={t("common.stop")}
                >
                  <span className="block w-3 h-3 rounded-[3px] bg-bg" />
                </button>
              ) : (
                <button
                  onClick={() => c.submit()}
                  disabled={!hasContent || uploading}
                  className="grid place-items-center w-10 h-10 sm:w-9 sm:h-9 rounded-xl text-white transition disabled:opacity-30 bg-accent-grad"
                  title={uploading ? t("chat.waitingUploads") : touch ? t("common.send") : t("chat.sendEnter")}
                  aria-label={t("common.send")}
                >
                  {uploading ? <Icon name="spinner" size={16} spin /> : <Icon name="arrow-up" size={17} />}
                </button>
              )}
            </div>
          </div>
          <FileInputs photoRef={c.photoRef} cameraRef={c.cameraRef} fileRef={c.fileRef} onFiles={c.addFiles} />
        </div>
        {/* (a phone: what's happening on a line of its own, the meters across the width of the message box) */}
        <div className="flex flex-col gap-0.5 px-1.5 pt-1.5 text-[10px] text-content-faint sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span className={`truncate ${notice || isStreaming ? "" : "hidden sm:inline"}`}>
            {notice ? (
              <span className="text-warning">{notice}</span>
            ) : isStreaming ? (
              <span className="inline-flex items-center gap-1.5 text-accent">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" />
                {touch ? t("chat.workingTouch") : t("chat.workingKeys")}
              </span>
            ) : touch ? (
              t("chat.hintTouch")
            ) : (
              t("chat.hintKeys")
            )}
          </span>
          <span className="flex min-w-0 items-center justify-between gap-2 font-mono sm:shrink-0 sm:justify-end" data-testid="chat-meters">
            <ContextMeter
              session={session}
              onCompact={() => {
                if (!onSend("/compact", [])) setNotice(t("chat.notConnectedRetry"));
              }}
            />
            <UsageFooter session={session} />
          </span>
        </div>
      </div>
    </div>
  );
}
