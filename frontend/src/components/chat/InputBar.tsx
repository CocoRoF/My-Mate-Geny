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
  const sid = session.id;
  // Phones: the mode/engine/model/think chips fold into one button in the composer.
  const phone = usePhone();
  const info = useChatStore((s) => s.info);
  const updateSession = useSessionStore((s) => s.update);

  const runAction = useCallback(
    async (action: ComposerAction) => {
      if (action === "clear") {
        await resetContext(sid);
        return "Context cleared — the next message starts a fresh agent conversation.";
      }
      if (action === "plan" || action === "agent") {
        await updateSession(sid, { mode: action });
        return action === "plan" ? "Plan mode: read-only, the agent will propose a plan." : "Agent mode: full autonomy.";
      }
      onStop();
    },
    [sid, updateSession, onStop],
  );
  const c = useComposer({ sid, store: useChatStore, onSend, onSteer, onStop, actions: ACTIONS, runAction, slash: true, mentions: true });
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
          <AttachmentTray items={items} />
          <textarea
            {...c.textareaProps}
            placeholder={
              isStreaming
                ? touch
                  ? "Add instructions while it works…"
                  : "Add instructions while it works — Enter adds them to this turn…"
                : items.length
                  ? "Add a message (optional)…"
                  : window.innerWidth < 640
                    ? "Message the agent…"
                    : "Message the agent…   / for commands · @ for files"
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
                title="Attach photos or files"
              >
                <Icon name="plus" size={18} />
              </button>
              {c.attachOpen && <AttachMenu onPick={c.pickFile} onClose={() => c.setAttachOpen(false)} />}
            </div>
            {/* while a turn runs, Queue / Add now need the room */}
            {phone && !(isStreaming && hasContent) && <ChatControls session={session} compact />}
            {items.length > 0 && (
              <span className="shrink-0 text-[11px] text-content-faint">
                {items.length} attached
                {uploading && " · uploading…"}
                {failed > 0 && <span className="text-danger"> · {failed} failed</span>}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {isStreaming && hasContent && (
                <>
                  <button
                    onClick={() => c.submit("queue")}
                    disabled={uploading}
                    className="h-10 sm:h-9 rounded-xl border border-border px-3 text-[12px] text-content-dim hover:text-content hover:bg-surface-3 transition disabled:opacity-40"
                    title="Send after the current turn finishes"
                  >
                    Queue
                  </button>
                  <button
                    onClick={() => c.submit()}
                    disabled={uploading}
                    className="h-10 sm:h-9 inline-flex items-center gap-1.5 rounded-xl px-3 text-[12px] font-medium text-white transition disabled:opacity-40"
                    style={{ background: "linear-gradient(135deg,#6e8bff,#5b7cff)" }}
                    title={`Add to the running turn now${touch ? "" : " (Enter)"} — ${
                      session.provider === "codex"
                        ? "Codex pauses its current step and continues with this"
                        : "the agent picks it up at its next step"
                    }`}
                  >
                    <Icon name="arrow-up" size={14} /> Add now
                  </button>
                </>
              )}
              {isStreaming ? (
                <button
                  onClick={onStop}
                  className="grid place-items-center w-10 h-10 sm:w-9 sm:h-9 rounded-xl bg-content text-bg hover:bg-white transition"
                  title="Stop (Esc)"
                >
                  <span className="block w-3 h-3 rounded-[3px] bg-bg" />
                </button>
              ) : (
                <button
                  onClick={() => c.submit()}
                  disabled={!hasContent || uploading}
                  className="grid place-items-center w-10 h-10 sm:w-9 sm:h-9 rounded-xl text-white transition disabled:opacity-30"
                  style={{ background: "linear-gradient(135deg,#6e8bff,#5b7cff)" }}
                  title={uploading ? "Waiting for uploads…" : touch ? "Send" : "Send (Enter)"}
                >
                  {uploading ? <Icon name="spinner" size={16} spin /> : <Icon name="arrow-up" size={17} />}
                </button>
              )}
            </div>
          </div>
          <FileInputs photoRef={c.photoRef} cameraRef={c.cameraRef} fileRef={c.fileRef} onFiles={c.addFiles} />
        </div>
        <div className="flex items-center justify-between gap-3 px-1.5 pt-1.5 text-[10px] text-content-faint">
          <span className="truncate">
            {notice ? (
              <span className="text-warning">{notice}</span>
            ) : isStreaming ? (
              <span className="inline-flex items-center gap-1.5 text-accent">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" />
                {touch
                  ? "working… · Add now joins this turn · Queue sends after · keeps running if you close the app"
                  : "working… · Enter adds to this turn · Queue sends after · Esc stops · keeps running if you close this tab"}
              </span>
            ) : touch ? (
              <span className="hidden sm:inline">Return adds a line · tap ↑ to send · / commands · @ files</span>
            ) : (
              <span className="hidden sm:inline">Enter to send · Shift+Enter newline · / commands · @ files · paste or drop files</span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-2 font-mono">
            <ContextMeter
              session={session}
              onCompact={() => {
                if (!onSend("/compact", [])) setNotice("Not connected — try again in a moment.");
              }}
            />
            <UsageFooter session={session} />
          </span>
        </div>
      </div>
    </div>
  );
}
