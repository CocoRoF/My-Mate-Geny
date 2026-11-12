/**
 * A phone call with her, as the page sees it (docs/mate-calls.md) — pure (test/mate-call.test.ts):
 *
 *   idle ─dial→ dialing ─connected (her first sound)→ active ─hangup / ended→ ended ─dismiss→ idle
 *   idle ─ring (she calls)→ incoming ─accept→ active (her hello is ready: connected at once)
 *                              └─decline→ ended (declined) · ─remote ended→ ended (missed…)
 *
 * The server says where a call stands (`remote`: call.update); this window says what it did. A call taken in another
 * window is over here ("elsewhere", closed quietly). The line dropping for a moment is `reconnecting`, not a phase.
 */

export type CallPhase = "idle" | "dialing" | "incoming" | "active" | "ended";
export type EndReason =
  | "hangup" | "declined" | "missed" | "cancelled" | "network" | "failed" | "limit" | "busy" | "gone" | "elsewhere" | "restart";

export interface CallMachine {
  phase: CallPhase;
  callId: string | null;
  mateId: string | null;
  direction: "outgoing" | "incoming" | null;
  /** when the ringing / dialing began */
  startedAt: number | null;
  /** her first sound (the call timer starts here) */
  connectedAt: number | null;
  endedAt: number | null;
  endReason: EndReason | null;
  reconnecting: boolean;
  minimized: boolean;
  muted: boolean;
  speaker: boolean;
}

export type CallEvent =
  | { type: "dial"; mateId: string; at: number }
  | { type: "dialed"; callId: string }
  | { type: "ring"; callId: string; mateId: string; at: number }
  | { type: "accept"; at: number }
  | { type: "connected"; at: number }
  | { type: "lost" }
  | { type: "resumed" }
  | { type: "remote"; callId: string; status: string; endReason?: string; at: number }
  | { type: "hangup"; at: number }
  | { type: "decline"; at: number }
  | { type: "ended"; reason: EndReason; at: number }
  | { type: "mute" }
  | { type: "speaker" }
  | { type: "minimize"; on: boolean }
  | { type: "dismiss" };

export const IDLE: CallMachine = {
  phase: "idle", callId: null, mateId: null, direction: null, startedAt: null, connectedAt: null, endedAt: null,
  endReason: null, reconnecting: false, minimized: false, muted: false, speaker: true,
};

const END_REASONS = new Set<EndReason>(["hangup", "declined", "missed", "cancelled", "network", "failed", "limit", "busy", "gone", "elsewhere", "restart"]);

const live = (s: CallMachine) => s.phase === "dialing" || s.phase === "incoming" || s.phase === "active";

function end(s: CallMachine, reason: EndReason, at: number): CallMachine {
  return { ...s, phase: "ended", endReason: reason, endedAt: at, reconnecting: false, minimized: false };
}

export function reduceCall(s: CallMachine, e: CallEvent): CallMachine {
  switch (e.type) {
    case "dial":
      if (s.phase !== "idle" && s.phase !== "ended") return s; // (one call at a time)
      return { ...IDLE, phase: "dialing", mateId: e.mateId, direction: "outgoing", startedAt: e.at, speaker: s.speaker };
    case "dialed":
      return s.phase === "dialing" && !s.callId ? { ...s, callId: e.callId } : s;
    case "ring":
      if (s.phase !== "idle" && s.phase !== "ended") return s; // (busy here: the server keeps one call anyway)
      return { ...IDLE, phase: "incoming", callId: e.callId, mateId: e.mateId, direction: "incoming", startedAt: e.at, speaker: s.speaker };
    case "accept":
      return s.phase === "incoming" ? { ...s, phase: "active" } : s;
    case "connected":
      if (s.phase === "dialing" || s.phase === "active") return { ...s, phase: "active", connectedAt: s.connectedAt ?? e.at };
      return s;
    case "lost":
      return live(s) && s.phase !== "incoming" ? { ...s, reconnecting: true } : s;
    case "resumed":
      return { ...s, reconnecting: false };
    case "remote": {
      if (!s.callId || e.callId !== s.callId || !live(s)) return s;
      if (e.status === "ended") {
        const r = (e.endReason || "gone") as EndReason;
        return end(s, END_REASONS.has(r) ? r : "gone", e.at);
      }
      // (she called and another window picked up: this one is done with it)
      if (s.phase === "incoming" && e.status === "active") return { ...end(s, "elsewhere", e.at) };
      return s;
    }
    case "hangup":
      if (!live(s)) return s;
      if (s.phase === "incoming") return end(s, "declined", e.at);
      return end(s, s.phase === "dialing" && !s.connectedAt ? "cancelled" : "hangup", e.at);
    case "decline":
      return s.phase === "incoming" ? end(s, "declined", e.at) : s;
    case "ended":
      return live(s) ? end(s, e.reason, e.at) : s;
    case "mute":
      return live(s) ? { ...s, muted: !s.muted } : s;
    case "speaker":
      return { ...s, speaker: !s.speaker };
    case "minimize":
      return s.phase === "dialing" || s.phase === "active" ? { ...s, minimized: e.on } : { ...s, minimized: false };
    case "dismiss":
      return s.phase === "ended" ? { ...IDLE, speaker: s.speaker } : s;
  }
}

/** the call's clock: 0:07 → "00:07", 83 s → "01:23", an hour and more → "1:02:03" */
export function callClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/** how long a call lasted, from its card (seconds) — for the conversation's card: "3:12" */
export function callLength(sec: number): string {
  return callClock(Math.max(0, sec) * 1000).replace(/^0(\d:)/, "$1");
}
