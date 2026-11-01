/**
 * The mate's composer: the Chat composer's machinery (components/composer: drafts + files + queue per conversation,
 * paste / + menu / drop, steer while she answers, Queue, IME-safe Enter, Escape stops, auto-grow, `/` commands) in
 * the mate's chrome, plus push-to-talk and the read-aloud toggle (phones: in the Mate view's header, so the row is
 * just + · text · mic · send). Drafts are keyed by the mate's session id.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Mate } from "../../api/mates";
import { useDraftStore } from "../../stores/draftStore";
import { useMateStore } from "../../stores/mateStore";
import { useMateChat, type MateConversation } from "../../mate/useMateConversation";
import AttachmentTray from "../attachments/AttachmentTray";
import ComposerMenu, { type MenuItem } from "../chat/ComposerMenu";
import { AttachMenu, FileInputs, QueuedList } from "../composer/ComposerParts";
import { useComposer, type ComposerAction } from "../composer/useComposer";
import Icon from "../ui/Icon";
import { useMic } from "./useMic";
import { useT, type TFunction } from "../../i18n";

const HOLD_MS = 350;

const ACTIONS: readonly ComposerAction[] = ["clear", "stop"];
const commandsFor = (t: TFunction, name: string): MenuItem[] => [
  { key: "m:clear", label: "/clear", insert: "", hint: t("mate.cmdClearHint", { name }), icon: "refresh", action: "clear" },
  { key: "m:stop", label: "/stop", insert: "", hint: t("mate.cmdStopHint", { name }), icon: "x", action: "stop" },
];

interface Props {
  mate: Mate;
  conv: MateConversation;
  compact?: boolean;
  enterSends?: boolean;
  autoFocus?: boolean;
  /** change it to focus the field again (quick card re-opened) */
  focusKey?: number;
  onSent?: () => void;
  showVoiceToggle?: boolean;
  placeholder?: string;
  /** the + button opens the file picker right away (no menu) */
  attachDirect?: boolean;
  /** Escape stops the reply (the quick card uses Escape to close itself) */
  escapeStops?: boolean;
  /** the window grows with the box (desktop quick card): no "40 % of the window" cap */
  growsWindow?: boolean;
  /** told whether the box holds something (text or files) — the quick card stays open then */
  onContentChange?: (has: boolean) => void;
}

export default function MateComposer(props: Props) {
  const sid = props.conv.sessionId;
  // the conversation opens first (its session id keys the draft and the uploads)
  if (!sid) return <ComposerPlaceholder compact={props.compact} name={props.mate.name} />;
  return <Composer key={sid} sid={sid} {...props} />;
}

function ComposerPlaceholder({ compact, name }: { compact?: boolean; name: string }) {
  const t = useT();
  return (
    <div className={compact ? "" : "pb-safe"}>
      <div className={`mx-auto flex max-w-2xl items-center rounded-2xl border border-border bg-surface-2/60 text-content-faint ${compact ? "h-10 px-3 text-[13px]" : "h-12 px-4 text-sm"}`}>
        {t("mate.connectingTo", { name })}
      </div>
    </div>
  );
}

function Composer({
  sid,
  mate,
  conv,
  compact = false,
  enterSends,
  autoFocus,
  focusKey,
  onSent,
  showVoiceToggle = true,
  placeholder,
  escapeStops,
  attachDirect = false,
  growsWindow = false,
  onContentChange,
}: Props & { sid: string }) {
  const t = useT();
  const { send, steer, stop, setListening } = conv;

  // a draft written before drafts were per conversation ("mate:<id>") moves over once
  useEffect(() => {
    const st = useDraftStore.getState();
    st.pin(sid);
    const old = st.drafts[`mate:${mate.id}`]?.text;
    if (old) {
      if (!st.drafts[sid]?.text) st.setText(sid, old);
      st.setText(`mate:${mate.id}`, "");
    }
  }, [sid, mate.id]);

  const runAction = useCallback(
    async (action: ComposerAction) => {
      if (action === "stop") {
        stop();
        return;
      }
      await conv.reset();
      return t("mate.resetDone", { name: mate.name });
    },
    [stop, conv, mate.name, t],
  );
  const commands = useMemo(() => commandsFor(t, mate.name), [t, mate.name]);

  const c = useComposer({
    sid,
    store: useMateChat,
    onSend: send,
    onSteer: steer,
    onStop: stop,
    actions: ACTIONS,
    runAction,
    slash: true,
    enterSends,
    maxHeight: compact ? 120 : 180,
    onSent,
    escapeStops,
    viewportCap: !growsWindow,
  });
  const { input, items, uploading, failed, hasContent, notice, isStreaming: streaming, touch, sendsOnEnter, trigger } = c;

  const contentRef = useRef(onContentChange);
  contentRef.current = onContentChange;
  useEffect(() => {
    contentRef.current?.(hasContent);
  }, [hasContent]);

  const mic = useMic(mate, (heard) => {
    c.submit("auto", heard);
  });
  const recording = mic.state === "recording" || mic.state === "starting";

  useEffect(() => {
    setListening(recording || (!!input.trim() && document.activeElement === c.taRef.current));
  }, [recording, input, setListening, c.taRef]);

  useEffect(() => {
    if (autoFocus || focusKey) c.taRef.current?.focus();
  }, [autoFocus, focusKey, c.taRef]);

  // push-to-talk: hold to talk, or tap to start / tap again to stop
  const pressAt = useRef(0);
  const onMicDown = (e: React.PointerEvent) => {
    e.preventDefault();
    if (mic.unavailable) return;
    if (recording) {
      pressAt.current = 0;
      mic.stop();
      return;
    }
    pressAt.current = Date.now();
    mic.start();
  };
  const onMicUp = () => {
    if (pressAt.current && Date.now() - pressAt.current > HOLD_MS) mic.stop();
    pressAt.current = 0;
  };

  const btn = `grid shrink-0 place-items-center rounded-full transition ${compact ? "h-8 w-8" : "h-9 w-9 touch:h-10 touch:w-10"}`;
  const micTitle = mic.unavailable
    ? mic.unavailable
    : recording
      ? t("mate.micListening")
      : mic.state === "transcribing"
        ? t("mate.transcribing")
        : t("mate.micHold");
  const connected = conv.connection === "open";
  const ph =
    placeholder && !streaming && !items.length
      ? placeholder
      : streaming
        ? touch || compact
          ? t("mate.phSteerTouch", { name: mate.name })
          : t("mate.phSteer", { name: mate.name })
        : items.length
          ? t("mate.phWithFiles")
          : t("mate.phTalk", { name: mate.name });

  return (
    <div className={compact ? "" : "pb-safe"}>
      {(mic.error || (recording && mic.interim) || mic.state === "transcribing") && (
        <div
          className={`mx-auto mb-1.5 flex max-w-2xl items-start gap-2 rounded-lg px-3 py-1.5 text-[12px] ${
            mic.error ? "bg-danger/10 text-danger" : "bg-surface-2 text-content-dim"
          }`}
          data-testid="mate-mic-status"
        >
          <Icon name={mic.error ? "warning" : mic.state === "transcribing" ? "spinner" : "mic"} size={12} spin={mic.state === "transcribing"} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{mic.error || (mic.state === "transcribing" ? t("mate.transcribing") : mic.interim)}</span>
          {mic.error && (
            <button onClick={mic.clearError} className="shrink-0 opacity-70 hover:opacity-100" aria-label={t("common.dismiss")}>
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      )}
      <QueuedList queue={c.queue} onRemove={c.unqueue} className="mx-auto mb-1.5 max-w-2xl" />
      <div
        className={`relative mx-auto max-w-2xl rounded-2xl border bg-surface-2/90 shadow-card transition ${
          recording ? "border-danger/50" : "border-border focus-within:border-accent/50"
        }`}
        data-testid="mate-composer"
      >
        {c.menuOpen && trigger && (
          <ComposerMenu
            trigger={trigger}
            commands={commands}
            onPick={c.pick}
            onClose={c.closeMenu}
            activeIndex={c.activeIndex}
            setActiveIndex={c.setActiveIndex}
            setItems={c.setMenuItems}
          />
        )}
        <AttachmentTray items={items} />
        <div className={`flex items-end gap-1 ${compact ? "p-1" : "p-1.5"}`}>
          <div className="relative shrink-0">
            <button
              // (a window that hugs its one-line card has no room for the menu: straight to the file picker)
              onClick={() => (attachDirect ? c.pickFile("file") : c.setAttachOpen((v) => !v))}
              className={`${btn} ${c.attachOpen ? "bg-accent-soft text-accent" : "text-content-dim hover:text-content hover:bg-surface-3"}`}
              title={t("mate.attach")}
              aria-label={t("mate.attach")}
              data-testid="mate-attach"
            >
              <Icon name="plus" size={compact ? 16 : 18} />
            </button>
            {c.attachOpen && <AttachMenu onPick={c.pickFile} onClose={() => c.setAttachOpen(false)} />}
          </div>
          {showVoiceToggle && <ReadAloudToggle mate={mate} conv={conv} className={btn} size={compact ? 15 : 17} />}
          <textarea
            {...c.textareaProps}
            value={recording && mic.interim ? mic.interim : input}
            onFocus={() => input.trim() && setListening(true)}
            onBlur={() => !recording && setListening(false)}
            placeholder={ph}
            // one line is exactly a button's height (h-8: 6 + 20 + 6, h-9: 8 + 20 + 8) with the text centred in it; more
            // lines grow upwards from the row's bottom (items-end) while +, mic and send stay level with the last line
            className={`mate-input min-w-0 flex-1 resize-none bg-transparent px-2 text-content placeholder:text-content-faint outline-none ${
              compact ? "py-1.5 text-[13.5px] leading-5" : "py-2 text-sm leading-5 touch:py-2.5"
            }`}
            data-testid="mate-input"
          />
          <button
            onPointerDown={onMicDown}
            onPointerUp={onMicUp}
            onPointerLeave={onMicUp}
            onContextMenu={(e) => e.preventDefault()}
            className={`${btn} select-none touch-none ${
              recording
                ? "bg-danger text-white animate-pulse"
                : mic.unavailable
                  ? "text-content-faint/50 hover:text-content-faint"
                  : "text-content-dim hover:text-content hover:bg-surface-3"
            }`}
            title={micTitle}
            aria-label={micTitle}
            data-testid="mate-mic"
          >
            <Icon name={mic.state === "transcribing" ? "spinner" : mic.unavailable ? "mic-off" : "mic"} size={compact ? 15 : 17} spin={mic.state === "transcribing"} />
          </button>
          {streaming && hasContent && (
            <button
              onClick={() => c.submit("queue")}
              disabled={uploading}
              className={`shrink-0 rounded-full border border-border px-2.5 text-[12px] text-content-dim transition hover:bg-surface-3 hover:text-content disabled:opacity-40 ${compact ? "h-8" : "h-9 touch:h-10"}`}
              title={t("mate.queueTitle", { name: mate.name })}
              data-testid="mate-queue"
            >
              {t("mate.queue")}
            </button>
          )}
          {streaming && !hasContent ? (
            <button onClick={stop} className={`${btn} bg-surface-3 text-content hover:bg-border-strong`} title={touch ? t("common.stop") : t("mate.stopEsc")} data-testid="mate-stop">
              <Icon name="stop" size={compact ? 12 : 14} />
            </button>
          ) : (
            <button
              onClick={() => c.submit()}
              disabled={!hasContent || uploading || !connected}
              className={`${btn} text-white disabled:opacity-40`}
              style={{ background: "linear-gradient(135deg,#6e8bff,#5b7cff)" }}
              title={
                !connected
                  ? t("mate.connecting")
                  : uploading
                    ? t("mate.waitingUploads")
                    : streaming
                      ? sendsOnEnter
                        ? t("mate.steerNowEnter", { name: mate.name })
                        : t("mate.steerNow", { name: mate.name })
                      : sendsOnEnter
                        ? t("mate.sendEnter")
                        : t("common.send")
              }
              data-testid="mate-send"
            >
              {uploading ? <Icon name="spinner" size={compact ? 14 : 16} spin /> : <Icon name="arrow-up" size={compact ? 15 : 17} />}
            </button>
          )}
        </div>
        <FileInputs photoRef={c.photoRef} cameraRef={c.cameraRef} fileRef={c.fileRef} onFiles={c.addFiles} />
      </div>
      {(notice || failed > 0 || !compact) && (
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-2 pt-1 text-[10.5px] text-content-faint" data-testid="mate-composer-hint">
          {notice ? (
            <span className="truncate text-warning">{notice}</span>
          ) : failed > 0 ? (
            <span className="truncate text-danger">{t("mate.filesFailed", { count: failed })}</span>
          ) : streaming ? (
            <span className="truncate">
              {touch ? t("mate.hintSteerTouch") : t("mate.hintSteer")}
            </span>
          ) : (
            <span className="hidden truncate sm:inline">
              {touch ? t("mate.hintTouch") : t("mate.hintKeys")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Read replies aloud on/off (the composer's row on wide screens; the Mate view's header on phones). */
export function ReadAloudToggle({ mate, conv, className, size = 17 }: { mate: Mate; conv: MateConversation; className: string; size?: number }) {
  const t = useT();
  const muted = useMateStore((s) => s.muted);
  const reading = mate.voice.auto_read && !muted && mate.voice.tts.engine !== "off";
  const toggle = () => {
    const st = useMateStore.getState();
    if (reading) st.setMuted(true);
    else if (muted) st.setMuted(false);
    else void st.patch(mate.id, { voice: { auto_read: true } }).catch(() => {});
    if (reading) conv.stopVoice();
  };
  return (
    <button
      onClick={toggle}
      className={`${className} ${reading ? "text-accent hover:bg-accent/10" : "text-content-faint hover:text-content hover:bg-surface-3"}`}
      title={reading ? t("mate.readingAloudClick") : t("mate.readAloud")}
      aria-label={reading ? t("mate.readingAloudTap") : t("mate.readAloud")}
      aria-pressed={reading}
      data-testid="mate-read-toggle"
    >
      <Icon name={reading ? "volume" : "volume-off"} size={size} />
    </button>
  );
}
