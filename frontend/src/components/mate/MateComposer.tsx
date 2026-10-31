/**
 * The mate's composer: text (draft kept per mate, like a chat's), push-to-talk mic, read-aloud toggle, send / stop.
 * Enter sends on a desktop; on touch screens Enter is a new line (lib/device.ts) unless `enterSends`.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Mate } from "../../api/mates";
import { useTouchFirst } from "../../lib/device";
import { useDraftStore } from "../../stores/draftStore";
import { useMateStore } from "../../stores/mateStore";
import type { MateConversation } from "../../mate/useMateConversation";
import Icon from "../ui/Icon";
import { useMic } from "./useMic";

const HOLD_MS = 350;

export default function MateComposer({
  mate,
  conv,
  compact = false,
  enterSends,
  autoFocus,
  focusKey,
  onSent,
  showVoiceToggle = true,
  placeholder,
}: {
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
}) {
  const key = `mate:${mate.id}`;
  const text = useDraftStore((s) => s.drafts[key]?.text ?? "");
  const setText = (v: string) => useDraftStore.getState().setText(key, v);
  const touch = useTouchFirst();
  const sendsOnEnter = enterSends ?? !touch;
  const ta = useRef<HTMLTextAreaElement>(null);
  const muted = useMateStore((s) => s.muted);
  const reading = mate.voice.auto_read && !muted && mate.voice.tts.engine !== "off";

  const { send, setListening, streaming } = conv;
  const mic = useMic(mate, (heard) => {
    if (send(heard)) onSent?.();
    else setText(heard); // not connected: keep it
  });
  const recording = mic.state === "recording" || mic.state === "starting";

  useEffect(() => {
    setListening(recording || (!!text.trim() && document.activeElement === ta.current));
  }, [recording, text, setListening]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, compact ? 120 : 180)}px`;
  }, [text, compact]);

  useEffect(() => {
    if (autoFocus || focusKey) ta.current?.focus();
  }, [autoFocus, focusKey]);

  const submit = () => {
    const v = text.trim();
    if (!v) return;
    if (send(v)) {
      setText("");
      onSent?.();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (e.key === "Enter" && !e.shiftKey && !composing && (sendsOnEnter || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

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

  const toggleRead = () => {
    const st = useMateStore.getState();
    if (reading) st.setMuted(true);
    else if (muted) st.setMuted(false);
    else void st.patch(mate.id, { voice: { auto_read: true } }).catch(() => {});
    if (reading) conv.stopVoice();
  };

  const btn = `grid shrink-0 place-items-center rounded-full transition ${compact ? "h-8 w-8" : "h-9 w-9 touch:h-10 touch:w-10"}`;
  const micTitle = mic.unavailable
    ? mic.unavailable
    : recording
      ? "Listening… release (or tap) to send"
      : mic.state === "transcribing"
        ? "Transcribing…"
        : "Hold to talk (or tap to start, tap to stop)";

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
          <span className="min-w-0 flex-1 break-words">{mic.error || (mic.state === "transcribing" ? "Transcribing…" : mic.interim)}</span>
          {mic.error && (
            <button onClick={mic.clearError} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss">
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      )}
      <div
        className={`mx-auto flex max-w-2xl items-end gap-1.5 rounded-2xl border bg-surface-2/90 shadow-card transition ${
          recording ? "border-danger/50" : "border-border focus-within:border-accent/50"
        } ${compact ? "p-1" : "p-1.5"}`}
      >
        {showVoiceToggle && (
          <button
            onClick={toggleRead}
            className={`${btn} ${reading ? "text-accent hover:bg-accent/10" : "text-content-faint hover:text-content hover:bg-surface-3"}`}
            title={reading ? "Reading replies aloud — click to mute" : "Read replies aloud"}
            aria-pressed={reading}
            data-testid="mate-read-toggle"
          >
            <Icon name={reading ? "volume" : "volume-off"} size={compact ? 15 : 17} />
          </button>
        )}
        <textarea
          ref={ta}
          value={recording && mic.interim ? mic.interim : text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => text.trim() && setListening(true)}
          onBlur={() => !recording && setListening(false)}
          rows={1}
          enterKeyHint={sendsOnEnter ? "send" : "enter"}
          placeholder={placeholder ?? `Talk to ${mate.name}…`}
          className={`min-w-0 flex-1 resize-none bg-transparent px-2 text-content placeholder:text-content-faint outline-none ${
            compact ? "py-1.5 text-[13.5px]" : "py-2 text-sm"
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
        {streaming && !text.trim() ? (
          <button onClick={conv.stop} className={`${btn} bg-surface-3 text-content hover:bg-border-strong`} title="Stop" data-testid="mate-stop">
            <Icon name="stop" size={compact ? 12 : 14} />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim() || conv.connection !== "open"}
            className={`${btn} text-white disabled:opacity-40`}
            style={{ background: "linear-gradient(135deg,#6e8bff,#5b7cff)" }}
            title={conv.connection !== "open" ? "Connecting…" : sendsOnEnter ? "Send (Enter)" : "Send"}
            data-testid="mate-send"
          >
            <Icon name="arrow-up" size={compact ? 15 : 17} />
          </button>
        )}
      </div>
    </div>
  );
}
