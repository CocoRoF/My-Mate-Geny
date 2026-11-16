/**
 * When her reply shows is behaviour too (docs/geny-state-system.md §6): angry at what they did, she takes her time — her typing
 * dots for a moment longer, the angrier the longer. Only anger *at them* (app/mate/state.py `_at_them`): hungry, stressed or on
 * her off day she answers as soon as ever. Pure functions of the state the mate document carries; useMateConversation holds the
 * reply back with them (its words, captions and voice alike, so they stay together).
 */
import type { MateState } from "../api/mates";
import type { Turn } from "../stores/chatStore";

/** reasons that are something they did or said (app/mate/state.py AT_THEM: keep the two the same) */
export const AT_THEM: ReadonlySet<string> = new Set([
  "rude", "hostile", "dismissed", "pestered", "poked", "said", "interrupted", "ignored", "curt", "apology", "declined_call",
  "missed_call", "brushed_over",
]);
/** from this anger at them she takes her time: TAKES_LEAST_MS, up to TAKES_MOST_MS at TAKES_MOST_AT and above */
export const TAKES_TIME_FROM = 0.45;
export const TAKES_MOST_AT = 0.9;
export const TAKES_LEAST_MS = 1500;
export const TAKES_MOST_MS = 5000;

/** how long (ms) her reply waits after it began: 0 unless she is angry at them, enough */
export function replyDelay(state: MateState | null | undefined): number {
  const angry = state?.top?.find((t) => t.emotion === "angry");
  if (!angry || angry.v < TAKES_TIME_FROM || !AT_THEM.has(angry.why?.code ?? "")) return 0;
  const k = Math.min(1, (angry.v - TAKES_TIME_FROM) / (TAKES_MOST_AT - TAKES_TIME_FROM));
  return Math.round(TAKES_LEAST_MS + k * (TAKES_MOST_MS - TAKES_LEAST_MS));
}

/**
 * Until when (ms epoch) a reply is held back: `delay` after it began (`started`: her turn's start on the server), but never
 * longer than `delay` after this page first saw it (`seen`), whatever the clocks say — what has arrived waits at most that
 * long. 0: not held.
 */
export function heldUntil(started: number | undefined, seen: number, delay: number): number {
  if (delay <= 0) return 0;
  const from = Math.min(seen, Math.max(started ?? seen, seen - delay));
  return from + delay;
}

/** her turn as it shows while it is held back: no words yet, still being written (her typing dots), what she did kept */
export const heldBack = (turn: Turn): Turn => ({
  ...turn,
  text: "",
  flow: turn.flow.filter((f) => f.kind !== "text"),
  complete: false,
});
