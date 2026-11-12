/**
 * The call on screen (docs/mate-calls.md), over everything — whatever view is open:
 * - ringing (she calls): her picture and name, why she calls, 거절 / 수락;
 * - on the call: her picture (a soft ring moves with her voice), her name, "연결 중.." → "통화 중 01:23", her words as she
 *   says them and yours as they are heard; big round 스피커 · 종료 · 음소거; the top corner folds it into a pill so the
 *   chat can be read while you talk (tap the pill to come back);
 * - the end, for a moment: "통화 종료 · 03:12", "연결이 끊겼어요"…
 * Android's Back folds the call screen (it never hangs up). Dark and light, small phones (the buttons shrink).
 */
import { useEffect, useState } from "react";
import { useBackHandler } from "../../../lib/back";
import { callBusy, useCallStore, type CallState } from "../../../stores/callStore";
import { callClock } from "../../../mate/call/machine";
import { useVoiceLevel } from "../../../mate/voiceBridge";
import { useT, type MsgKey, type TFunction } from "../../../i18n";
import Icon, { type IconName } from "../../ui/Icon";
import { MateThumb } from "../MateStage";

function useNow(on: boolean, ms = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

/** "연결 중.." with the dots going */
function Dots() {
  const [n, setN] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setN((x) => (x % 3) + 1), 450);
    return () => clearInterval(t);
  }, []);
  return <span className="inline-block w-[1.2em] text-left">{".".repeat(n)}</span>;
}

const ENDED: Partial<Record<string, MsgKey>> = {
  network: "mate.callLost",
  failed: "mate.callCantConnect",
  busy: "mate.callBusy",
  declined: "mate.callDeclinedEnd",
  missed: "mate.callMissedEnd",
};

function status(t: TFunction, s: CallState, now: number) {
  if (s.phase === "ended") {
    const key = ENDED[s.endReason ?? ""];
    if (key) return t(key);
    return s.connectedAt && s.endedAt ? t("mate.callEndedAfter", { time: callClock(s.endedAt - s.connectedAt) }) : t("mate.callEnded");
  }
  if (s.reconnecting) return t("mate.callReconnecting");
  if (s.phase === "active" && s.connectedAt) return t("mate.callOnCall", { time: callClock(now - s.connectedAt) });
  return (
    <>
      {t("mate.callConnecting")}
      <Dots />
    </>
  );
}

function Backdrop({ tone = "call" }: { tone?: "call" | "ring" | "end" }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className={`absolute inset-0 bg-gradient-to-b ${tone === "end" ? "from-content-faint/15" : "from-success/30"} via-success/[0.07] to-transparent`} />
      <div className="absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-success/20 blur-3xl" />
    </div>
  );
}

/** her picture, with a ring that breathes with her voice (or pulses while she rings) */
function Face({ s, ringing }: { s: CallState; ringing?: boolean }) {
  const level = useVoiceLevel();
  const speaking = s.herSpeaking && !ringing;
  return (
    <div className="relative grid place-items-center">
      {ringing && <span className="absolute h-full w-full animate-ping rounded-full bg-success/25" />}
      <span
        className="absolute h-full w-full rounded-full bg-success/25 transition-transform duration-100"
        style={{ transform: `scale(${speaking ? 1.06 + Math.min(1, level * 2.2) * 0.22 : 1})`, opacity: speaking ? 1 : 0 }}
      />
      {s.mate ? (
        <MateThumb mate={s.mate} className="h-28 w-28 ring-4 ring-bg/70 [@media(max-height:620px)]:h-20 [@media(max-height:620px)]:w-20" />
      ) : (
        <span className="grid h-28 w-28 place-items-center rounded-full bg-surface-3 text-content-dim">
          <Icon name="phone" size={36} />
        </span>
      )}
    </div>
  );
}

function RoundButton({ icon, label, onClick, tone, pressed, testid, rotate }: {
  icon: IconName; label: string; onClick: () => void; tone: "on" | "off" | "end" | "accept"; pressed?: boolean; testid: string; rotate?: boolean;
}) {
  const cls = {
    on: "bg-content text-bg",
    off: "bg-surface-3/90 text-content border border-border",
    end: "bg-danger text-white",
    accept: "bg-success text-white",
  }[tone];
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
        className={`grid h-[4.5rem] w-[4.5rem] place-items-center rounded-full shadow-float transition active:scale-95 max-[360px]:h-16 max-[360px]:w-16 [@media(max-height:560px)]:h-14 [@media(max-height:560px)]:w-14 ${cls}`}
        data-testid={testid}
      >
        <Icon name={icon} size={28} className={rotate ? "rotate-[135deg]" : ""} />
      </button>
      <span className="text-[13px] text-content-dim">{label}</span>
    </div>
  );
}

function CallScreen() {
  const t = useT();
  const s = useCallStore();
  const now = useNow(s.phase === "active" && !!s.connectedAt);
  const live = callBusy(s);
  const name = s.mate?.name || s.call?.name || "";
  useBackHandler(live, () => s.minimize(true));
  return (
    <div className="fixed inset-0 z-[90] flex flex-col overflow-hidden bg-bg text-content animate-fade-in" role="dialog" aria-modal="true" aria-label={name} data-testid="call-screen" data-phase={s.phase}>
      <Backdrop tone={s.phase === "ended" ? "end" : "call"} />
      <div className="relative flex min-h-0 flex-1 flex-col pt-safe pb-safe">
        <div className="flex h-16 items-center justify-between px-4">
          {/* (the mic: lit while they are heard) */}
          <span className={`grid h-9 w-9 place-items-center rounded-full transition ${s.userTalking && !s.muted ? "bg-success text-white" : "text-content-faint"}`} aria-hidden>
            <Icon name={s.muted ? "mic-off" : "mic"} size={17} />
          </span>
          {live && (
            <button type="button" onClick={() => s.minimize(true)} className="grid h-11 w-11 place-items-center rounded-full bg-surface-3/80 text-content hover:bg-surface-3" aria-label={t("mate.callMinimize")} title={t("mate.callMinimize")} data-testid="call-minimize">
              <Icon name="minimize" size={19} />
            </button>
          )}
        </div>
        <div className="flex flex-col items-center px-6 pt-2 text-center [@media(max-height:620px)]:pt-0">
          <Face s={s} />
          <div className="mt-4 max-w-full truncate text-[26px] font-semibold leading-tight [@media(max-height:620px)]:mt-2 [@media(max-height:620px)]:text-[22px]" data-testid="call-name">{name}</div>
          <div className="mt-2 text-[17px] tabular-nums text-content-dim" aria-live="polite" data-testid="call-status">{status(t, s, now)}</div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden px-8 text-center">
          {s.caption && s.phase !== "ended" && (
            <p className={`line-clamp-3 max-w-md text-[15px] leading-relaxed transition-opacity ${s.herSpeaking ? "text-content" : "text-content-dim"}`} data-testid="call-caption">{s.caption}</p>
          )}
          {s.partial && !s.muted && <p className="line-clamp-2 max-w-md text-[14px] italic text-content-faint" data-testid="call-partial">{s.partial}</p>}
        </div>
        {(s.deaf || s.notice || s.error) && (
          <div className={`mx-5 mb-4 rounded-xl px-3.5 py-2 text-center text-[12.5px] leading-snug ${s.deaf || s.error ? "bg-warning/15 text-warning" : "bg-surface-2/90 text-content-dim"}`} role="status" data-testid="call-notice">
            {s.error || s.deaf || s.notice}
          </div>
        )}
        <div className="flex items-start justify-center gap-8 px-6 pb-8 max-[360px]:gap-5 [@media(max-height:560px)]:pb-4">
          <RoundButton icon="volume" label={t("mate.callSpeaker")} onClick={s.toggleSpeaker} tone={s.speaker ? "on" : "off"} pressed={s.speaker} testid="call-speaker" />
          <RoundButton icon="phone" rotate label={t("mate.callEnd")} onClick={live ? s.hangup : s.dismiss} tone="end" testid="call-end" />
          <RoundButton icon="mic-off" label={t("mate.callMute")} onClick={s.toggleMute} tone={s.muted ? "on" : "off"} pressed={s.muted} testid="call-mute" />
        </div>
      </div>
    </div>
  );
}

function IncomingCall() {
  const t = useT();
  const s = useCallStore();
  const name = s.mate?.name || s.call?.name || "";
  const why = s.call?.reason ? (`mate.callWhy_${s.call.reason}` as MsgKey) : null;
  useBackHandler(true, () => {}); // (Back doesn't answer or turn it down)
  return (
    <div className="fixed inset-0 z-[90] flex flex-col overflow-hidden bg-bg text-content animate-fade-in" role="dialog" aria-modal="true" aria-label={t("mate.callIncoming")} data-testid="call-incoming">
      <Backdrop tone="ring" />
      <div className="relative flex min-h-0 flex-1 flex-col items-center pt-safe pb-safe text-center">
        <div className="mt-[12vh] text-[15px] text-content-dim [@media(max-height:620px)]:mt-8">{t("mate.callIncoming")}</div>
        <div className="mt-8 [@media(max-height:620px)]:mt-4">
          <Face s={s} ringing />
        </div>
        <div className="mt-5 max-w-full truncate px-6 text-[28px] font-semibold leading-tight" data-testid="call-name">{name}</div>
        {why && <div className="mt-2 px-8 text-[15px] text-content-dim">{t(why)}</div>}
        <div className="flex-1" />
        <div className="flex w-full items-start justify-around px-10 pb-12 [@media(max-height:560px)]:pb-5">
          <RoundButton icon="phone" rotate label={t("mate.callDecline")} onClick={() => void s.decline()} tone="end" testid="call-decline" />
          <RoundButton icon="phone" label={t("mate.callAccept")} onClick={() => void s.accept()} tone="accept" testid="call-accept" />
        </div>
      </div>
    </div>
  );
}

/** the call folded away: a pill at the top while the chat is read */
function CallPill() {
  const t = useT();
  const s = useCallStore();
  const now = useNow(!!s.connectedAt);
  const name = s.mate?.name || s.call?.name || "";
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.4rem)] z-[85] flex justify-center px-3 animate-fade-in">
      <div className="pointer-events-auto flex h-11 max-w-full items-center gap-1 rounded-full bg-success py-1 pl-1 pr-1 text-white shadow-float" data-testid="call-pill">
        <button type="button" onClick={() => s.minimize(false)} className="flex min-w-0 items-center gap-2 rounded-full pl-0.5 pr-2" aria-label={t("mate.callExpand")} title={t("mate.callExpand")}>
          {s.mate ? <MateThumb mate={s.mate} className="h-9 w-9" /> : <Icon name="phone" size={16} />}
          <span className="min-w-0 truncate text-[13.5px] font-medium">{name}</span>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-white ${s.herSpeaking ? "animate-pulse" : "opacity-50"}`} aria-hidden />
          <span className="shrink-0 text-[13px] tabular-nums opacity-90">
            {s.reconnecting ? t("mate.callReconnecting") : s.connectedAt ? callClock(now - s.connectedAt) : t("mate.callConnecting")}
          </span>
        </button>
        <button type="button" onClick={s.toggleMute} className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${s.muted ? "bg-white text-success" : "bg-white/15"}`} aria-label={t("mate.callMute")} aria-pressed={s.muted}>
          <Icon name="mic-off" size={15} />
        </button>
        <button type="button" onClick={s.hangup} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-danger" aria-label={t("mate.callEnd")} data-testid="call-pill-end">
          <Icon name="phone" size={15} className="rotate-[135deg]" />
        </button>
      </div>
    </div>
  );
}

export default function CallLayer() {
  const s = useCallStore();
  if (s.phase === "idle") return null;
  if (s.phase === "incoming") return <IncomingCall />;
  if (s.minimized && (s.phase === "dialing" || s.phase === "active")) return <CallPill />;
  return <CallScreen />;
}
