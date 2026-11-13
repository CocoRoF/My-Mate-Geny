/**
 * The call on this page (docs/mate-calls.md): the state machine (mate/call/machine.ts) plus what the call screen shows —
 * her caption, who is talking, the live text, a notice — and the session that carries it (mate/call/session.ts, loaded
 * when a call starts). Ringing comes from /ws/sessions (`call.ring`, `call.update`: hooks/useSessionSync.ts).
 */
import { create } from "zustand";
import { acceptCall, activeCall, declineCall, dialMate, type CallInfo, type CallPlan } from "../api/calls";
import type { Mate } from "../api/mates";
import { tr } from "../i18n";
import { getMateAudioQueue } from "../mate/audioQueue";
import { IDLE, reduceCall, type CallEvent, type CallMachine, type EndReason } from "../mate/call/machine";
import { callNative, onAndroid } from "../mate/call/native";
import { Tones, vibrate } from "../mate/call/tones";
import { deviceId } from "../mate/voiceOwner";
import { useMateStore } from "./mateStore";

type Session = import("../mate/call/session").CallSession;

export interface CallState extends CallMachine {
  call: CallInfo | null;
  mate: Mate | null;
  plan: CallPlan | null;
  herSpeaking: boolean;
  userTalking: boolean;
  caption: string;
  partial: string;
  level: number;
  notice: string | null;
  /** can't listen on this device: said plainly on the call screen */
  deaf: string | null;
  error: string | null;

  dial: (mate: Mate) => Promise<void>;
  /** her ringing on this page (`quiet`: the phone rings already — the app came up from her call notification) */
  incoming: (call: CallInfo, quiet?: boolean) => void;
  remote: (call: CallInfo) => void;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
  hangup: () => void;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  minimize: (on: boolean) => void;
  dismiss: () => void;
  /** a page that came back (reload, the app reopened): the call it was on, or her ringing (`quiet`: the phone rings) */
  resume: (quiet?: boolean) => Promise<void>;
}

/** a call is on (or ringing) on this page */
export const callBusy = (s: { phase: CallMachine["phase"] }) => s.phase === "dialing" || s.phase === "incoming" || s.phase === "active";

let session: Session | null = null;
let ringStop: (() => void) | null = null;
let buzz: ReturnType<typeof setInterval> | undefined;
let endTimer: ReturnType<typeof setTimeout> | undefined;
const tones = new Tones();

const CLEARED = { herSpeaking: false, userTalking: false, caption: "", partial: "", level: 0, notice: null, deaf: null, error: null };

function stopRinging(id?: string) {
  ringStop?.();
  ringStop = null;
  clearInterval(buzz);
  buzz = undefined;
  vibrate(false);
  if (id) void callNative.cancelRing(id);
}

function mateOf(id: string): Mate | null {
  return useMateStore.getState().mates.find((m) => m.id === id) ?? null;
}

export const useCallStore = create<CallState>((set, get) => {
  const step = (e: CallEvent) => {
    const before = get();
    const next = reduceCall(before, e);
    if (next !== before) set(next);
    if (next.phase === "ended" && before.phase !== "ended") ended(next.endReason ?? "gone");
    return next;
  };

  const ended = (reason: EndReason) => {
    stopRinging(get().callId ?? undefined);
    const s = session;
    session = null;
    s?.finish(reason);
    set({ herSpeaking: false, userTalking: false, partial: "" });
    clearTimeout(endTimer);
    // (the end shows for a moment, the way a phone's does; one taken elsewhere just goes)
    endTimer = setTimeout(() => get().dismiss(), reason === "elsewhere" ? 0 : reason === "network" || reason === "failed" ? 2600 : 1500);
  };

  const begin = async (call: CallInfo, plan: CallPlan, mate: Mate) => {
    getMateAudioQueue().stop(); // (her chat voice is quiet while she is on the phone)
    const { CallSession } = await import("../mate/call/session");
    if (get().callId !== call.id || !callBusy(get())) return;
    const st = get();
    session = new CallSession(call, mate, plan, {
      connected: (at) => step({ type: "connected", at }),
      speaking: (on) => set({ herSpeaking: on }),
      caption: (text) => set({ caption: text }),
      partial: (text) => set({ partial: text }),
      userTalking: (on) => set({ userTalking: on }),
      level: (v) => {
        if (Math.abs(v - get().level) > 0.04) set({ level: v });
      },
      notice: (text) => set({ notice: text }),
      deaf: (text) => set({ deaf: text }),
      reconnecting: (on) => step({ type: on ? "lost" : "resumed" }),
      ended: (reason) => step({ type: "ended", reason, at: Date.now() }),
      server: (c) => set({ call: c }),
    }, { muted: st.muted, speaker: st.speaker });
    session.start();
  };

  return {
    ...IDLE,
    ...CLEARED,
    call: null,
    mate: null,
    plan: null,

    dial: async (mate) => {
      if (callBusy(get())) return;
      clearTimeout(endTimer);
      step({ type: "dial", mateId: mate.id, at: Date.now() });
      set({ ...CLEARED, mate, call: null, plan: null });
      try {
        const { call, plan } = await dialMate(mate.id, deviceId);
        if (get().phase !== "dialing") {
          void import("../api/calls").then((m) => m.hangupCall(call.id)).catch(() => {}); // (hung up meanwhile)
          return;
        }
        step({ type: "dialed", callId: call.id });
        set({ call, plan });
        await begin(call, plan, mate);
      } catch (e) {
        const code = (e as { code?: string }).code;
        set({ error: code === "busy" ? tr("mate.callBusy") : tr("mate.callFailed", { error: (e as Error).message }) });
        step({ type: "ended", reason: code === "busy" ? "busy" : "failed", at: Date.now() });
      }
    },

    incoming: (call, quiet = false) => {
      if (call.device && call.device !== deviceId) return;
      const before = get();
      if (callBusy(before)) return;
      clearTimeout(endTimer);
      step({ type: "ring", callId: call.id, mateId: call.mate_id, at: Date.now() });
      const mate = mateOf(call.mate_id);
      set({ ...CLEARED, call, mate, plan: null });
      // the ring: the phone's own (a call notification, while the app is in the background or the phone locked), else
      // the page's — never both
      const name = mate?.name || call.name;
      const own = () => {
        if (get().callId !== call.id || get().phase !== "incoming" || ringStop) return;
        ringStop = tones.play("ringtone");
        vibrate(true);
        buzz = setInterval(() => vibrate(true), 3200);
      };
      if (!onAndroid()) return own();
      void callNative.ring(call.id, call.mate_id, name, tr("mate.callRingBody", { name })).then((phone) => {
        if (!phone && !quiet) own();
      });
    },

    remote: (call) => {
      const s = get();
      if (s.callId !== call.id) return;
      set({ call });
      step({ type: "remote", callId: call.id, status: call.status, endReason: call.end_reason, at: Date.now() });
    },

    accept: async () => {
      const s = get();
      if (s.phase !== "incoming" || !s.callId) return;
      const id = s.callId;
      stopRinging(id);
      step({ type: "accept", at: Date.now() });
      try {
        const { call, plan } = await acceptCall(id, deviceId);
        const mate = mateOf(call.mate_id) ?? get().mate;
        set({ call, plan, mate });
        if (mate) await begin(call, plan, mate);
      } catch (e) {
        set({ error: tr("mate.callFailed", { error: (e as Error).message }) });
        step({ type: "ended", reason: "gone", at: Date.now() });
      }
    },

    decline: async () => {
      const s = get();
      if (s.phase !== "incoming" || !s.callId) return;
      const id = s.callId;
      step({ type: "decline", at: Date.now() });
      await declineCall(id).catch(() => {});
    },

    hangup: () => {
      const s = get();
      if (s.phase === "incoming") return void get().decline();
      if (!callBusy(s)) return;
      const live = session;
      session = null;
      if (live) live.hangup();
      else if (s.callId) void import("../api/calls").then((m) => m.hangupCall(s.callId!)).catch(() => {});
      step({ type: "hangup", at: Date.now() });
    },

    toggleMute: () => {
      const next = step({ type: "mute" });
      session?.setMuted(next.muted);
    },
    toggleSpeaker: () => {
      const next = step({ type: "speaker" });
      session?.setSpeaker(next.speaker);
    },
    minimize: (on) => {
      step({ type: "minimize", on });
    },
    dismiss: () => {
      clearTimeout(endTimer);
      const next = reduceCall(get(), { type: "dismiss" });
      if (next !== get()) set({ ...next, ...CLEARED, call: null, mate: null, plan: null });
    },

    resume: async (quiet = false) => {
      if (callBusy(get())) return;
      let call: CallInfo | null = null;
      try {
        call = await activeCall();
      } catch {
        return;
      }
      if (!call || (call.device && call.device !== deviceId)) return;
      if (call.status === "ringing") {
        if (onAndroid()) get().incoming(call, quiet);
        return;
      }
      // (a call this page was on before it went away: it can't carry on without its sound — it ends cleanly)
      void import("../api/calls").then((m) => m.hangupCall(call!.id)).catch(() => {});
    },
  };
});

// a handle for checks from the console / browser tests (like window.__hrhMateAudio): the store, and words for her
if (typeof window !== "undefined")
  (window as unknown as { __hrhCall?: unknown }).__hrhCall = { store: useCallStore, say: (text: string) => session?.typed(text) };

let actions = false;
/** what is tapped on her call notification (the Android app): once the app's bridge is there */
export function installCallActions(): void {
  if (actions) return;
  actions = true;
  callNative.onAction(({ action, id }) => {
    const s = useCallStore.getState();
    if (s.callId !== id) {
      if (action === "decline") void declineCall(id).catch(() => {});
      // (the app came up from it — started for it, perhaps: her ringing shows, and 받기 takes it at once)
      else
        void s.resume(true).then(() => {
          const now = useCallStore.getState();
          if (action === "accept" && now.callId === id && now.phase === "incoming") void now.accept();
        });
      return;
    }
    if (action === "accept") void s.accept();
    else if (action === "decline") void s.decline();
  });
  linkPhone();
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") linkPhone();
    });
}

let linking = false;
let facesSent = "";
/**
 * The Android app's background link (docs/mate-calls.md "On Android"): this page is `deviceId` there, signed in as the
 * page is, and her face rings with her calls — so she calls with the app closed, like a phone. Again whenever the app
 * comes back (a fresh sign-in, new faces).
 */
export function linkPhone(): void {
  if (!onAndroid() || linking) return;
  linking = true;
  void (async () => {
    try {
      const st = useMateStore.getState();
      if (!st.loaded) await st.load().catch(() => {});
      const { facesOf } = await import("../mate/call/faces");
      const faces = await facesOf(useMateStore.getState().mates);
      const key = JSON.stringify(faces);
      await callNative.link(deviceId, key === facesSent ? {} : faces);
      facesSent = key;
    } finally {
      linking = false;
    }
  })();
}
