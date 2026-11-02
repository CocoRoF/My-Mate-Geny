/**
 * ONE voice for a mate's replies (docs/mate.md §6).
 *
 * Across devices (and across browsers / profiles of one computer): a reply is read aloud on the device that sent the
 * message it answers. The device is this browser profile (`deviceId`, in localStorage — the desktop app's windows
 * share one); it travels inside the message's client_msg_id, which the server echoes on `user.message`, so every
 * window following the conversation knows where a turn came from. A turn the mate starts by itself (a delegated
 * task reporting back) is read where the user last talked from; never talked from here since the page loaded and
 * nobody else claimed the conversation: read here (one device, a page reloaded).
 *
 * Within one device: the windows showing the mate elect one speaker over a BroadcastChannel (heartbeats every
 * 300 ms, a peer silent for 1 s is gone, a closing page says bye):
 *   1. a window in the middle of reading a reply keeps it until that reply is done (no cut, no double start);
 *   2. else the desktop avatar overlay while it is on screen;
 *   3. else the most recently focused Mate surface on screen (the mate chat window or the console's Mate view);
 *   4. else one in the background (a hidden tab / minimised window — its throttled beats are given 75 s).
 * The quick card never speaks (its replies go to whoever is elected). Every window follows every reply's sentences,
 * and the speaker announces each sentence it starts — a window that takes over mid-reply (the speaker closed or
 * crashed) goes on from the next sentence, and a sentence another window started is never played again.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const DEVICE_KEY = "hrh_device_id";
const HEARTBEAT_MS = 300;
const GONE_MS = 1000;

/** a page in the background (hidden tab, minimised window): its timers are throttled, so its beats may come a minute
 * apart — peers keep it this long, and it only speaks when no page on screen is a candidate */
const GONE_HIDDEN_MS = 75_000;

export const RANK_OVERLAY = 3;
export const RANK_SURFACE = 2;
export const RANK_SURFACE_HIDDEN = 1;

function makeId(n: number): string {
  const a = new Uint8Array(n);
  crypto.getRandomValues?.(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join("");
}

/** this browser profile (the desktop app's windows share it; another device / browser has its own) */
export const deviceId: string = (() => {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[a-z0-9]{6,16}$/.test(id)) {
      id = makeId(10);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return makeId(10);
  }
})();

/** a client_msg_id that names this device: `<prefix><random>~<device>` */
export const clientMsgId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}~${deviceId}`;

/** the device a client_msg_id came from (null: an older page / another client / no id) */
export function deviceOf(cid: unknown): string | null {
  const m = typeof cid === "string" ? /~([a-z0-9]{6,16})$/.exec(cid) : null;
  return m ? m[1] : null;
}

// ── the election ─────────────────────────────────────────────────────────

interface Beat {
  type: "hb" | "bye" | "started" | "voicing" | "hush";
  id: string;
  mateId: string;
  rank?: number;
  focusAt?: number;
  hidden?: boolean;
  /** the turn this candidate is reading now (it keeps the voice until it is done) */
  speaking?: string | null;
  /** "started": a sentence began playing */
  turn?: string;
  idx?: number;
  /** "started": what it says (the mic's echo filter compares with it) */
  text?: string;
  /** hb / "voicing": audio of hers is playing in that window right now */
  voicing?: boolean;
}

interface Peer {
  id: string;
  mateId: string;
  rank: number;
  focusAt: number;
  speaking: string | null;
  hidden: boolean;
  seen: number;
}

// ── "she is speaking on this device" (the mic: mate/stt/echo.ts) ─────────
//
// Any window may be the one playing her voice; the mic may be in another (the quick card, the chat window while the
// overlay reads). Each window says when its audio starts / stops ("voicing", also in every heartbeat), every
// sentence started comes with its text, and a barge-in hushes her wherever she plays on this device.

/** this page (voicing is per page: one audio queue per page) */
const pageId = makeId(12);
/** mates whose voice plays in this page now */
const localVoicing = new Set<string>();
/** other pages of this device: mate id per page id → voicing, last heard */
const peerVoicing = new Map<string, { mateId: string; on: boolean; seen: number }>();
const spokenLog: { mateId: string; text: string; at: number }[] = [];
const hushListeners = new Set<(mateId: string) => void>();
const SPOKEN_KEEP_MS = 30_000;

function noteSpoken(mateId: string, text: string | undefined) {
  if (!text) return;
  const now = Date.now();
  spokenLog.push({ mateId, text: text.slice(0, 600), at: now });
  while (spokenLog.length && (spokenLog.length > 40 || now - spokenLog[0].at > SPOKEN_KEEP_MS)) spokenLog.shift();
}

/** this page plays (or stopped playing) the mate's voice: every window of the device is told at once */
export function setLocalVoicing(mateId: string, on: boolean): void {
  if (localVoicing.has(mateId) === on) return;
  if (on) localVoicing.add(mateId);
  else localVoicing.delete(mateId);
  post({ type: "voicing", id: pageId, mateId, voicing: on });
}

/** the mate's voice plays somewhere on this device now (this page or another window of this browser profile) */
export function deviceVoicing(mateId: string): boolean {
  if (localVoicing.has(mateId)) return true;
  const now = Date.now();
  for (const p of peerVoicing.values()) if (p.mateId === mateId && p.on && now - p.seen < VOICING_GONE_MS) return true;
  return false;
}

/** a page playing her voice says so again every second (a page playing audio isn't throttled); silent 3 s = stopped */
const VOICING_EVERY_MS = 1000;
const VOICING_GONE_MS = 3000;
if (typeof window !== "undefined") {
  setInterval(() => {
    for (const mateId of localVoicing) post({ type: "voicing", id: pageId, mateId, voicing: true });
  }, VOICING_EVERY_MS);
  window.addEventListener("pagehide", () => {
    for (const mateId of localVoicing) post({ type: "voicing", id: pageId, mateId, voicing: false });
  });
}

/** what she said on this device lately (newest last) */
export function recentSpoken(mateId: string, ms = 20_000): string[] {
  const now = Date.now();
  return spokenLog.filter((s) => s.mateId === mateId && now - s.at <= ms).map((s) => s.text);
}

/** stop her voice wherever it plays on this device (a barge-in): every window's queue for the mate stops */
export function hushDevice(mateId: string): void {
  post({ type: "hush", id: pageId, mateId });
  hushListeners.forEach((l) => l(mateId));
}

/** a barge-in hushed the mate (here or in another window of this device) */
export function onHush(cb: (mateId: string) => void): () => void {
  hushListeners.add(cb);
  return () => hushListeners.delete(cb);
}

const channel: BroadcastChannel | null = (() => {
  try {
    return typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("hrh-mate-voice") : null;
  } catch {
    return null;
  }
})();

const peers = new Map<string, Peer>();
/** per turn key: the highest sentence index any window of this device started */
const started = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

const post = (b: Beat) => {
  try {
    channel?.postMessage(b);
  } catch {
    /* closed */
  }
};

function noteStarted(turn: string, idx: number) {
  if ((started.get(turn) ?? -1) >= idx) return;
  started.set(turn, idx);
  if (started.size > 200) started.delete(started.keys().next().value as string);
}

if (channel) {
  channel.onmessage = (e: MessageEvent) => {
    const b = e.data as Beat | null;
    if (!b || typeof b.id !== "string" || typeof b.mateId !== "string") return;
    if (b.type === "bye") {
      if (peers.delete(b.id)) emit();
      return;
    }
    if (b.type === "started" && typeof b.turn === "string" && typeof b.idx === "number") {
      noteStarted(b.turn, b.idx);
      noteSpoken(b.mateId, typeof b.text === "string" ? b.text : undefined);
      return;
    }
    if (b.type === "voicing") {
      peerVoicing.set(`${b.id}:${b.mateId}`, { mateId: b.mateId, on: !!b.voicing, seen: Date.now() });
      return;
    }
    if (b.type === "hush") {
      hushListeners.forEach((l) => l(b.mateId));
      return;
    }
    if (b.type !== "hb") return;
    const prev = peers.get(b.id);
    const next: Peer = { id: b.id, mateId: b.mateId, rank: b.rank ?? 0, focusAt: b.focusAt ?? 0, speaking: b.speaking ?? null, hidden: !!b.hidden, seen: Date.now() };
    peers.set(b.id, next);
    if (!prev || prev.rank !== next.rank || prev.focusAt !== next.focusAt || prev.speaking !== next.speaking || prev.mateId !== next.mateId || prev.hidden !== next.hidden) emit();
  };
  setInterval(() => {
    const t = Date.now();
    let gone = false;
    for (const [id, p] of peers) if (t - p.seen > (p.hidden ? GONE_HIDDEN_MS : GONE_MS)) gone = peers.delete(id) || gone;
    if (gone) emit();
  }, 250);
}

/** the order of candidates: reading now > rank > most recently focused > id (the same answer in every window) */
function better(a: Omit<Peer, "seen" | "hidden">, b: Omit<Peer, "seen" | "hidden">): boolean {
  if (!!a.speaking !== !!b.speaking) return !!a.speaking;
  if (a.rank !== b.rank) return a.rank > b.rank;
  if (a.focusAt !== b.focusAt) return a.focusAt > b.focusAt;
  return a.id > b.id;
}

/** the highest sentence index of `turn` started by any window of this device (-1: none) */
export const startedUpTo = (turn: string) => started.get(turn) ?? -1;

/** a sentence of `turn` began playing in this window: tell the others (they never play it, nor anything before it) */
export function announceStarted(mateId: string, turn: string, idx: number, text?: string) {
  noteStarted(turn, idx);
  noteSpoken(mateId, text);
  post({ type: "started", id: "-", mateId, turn, idx, text: text?.slice(0, 600) });
}

/** a line said without a turn (a settings test): only remembered for the mic's echo filter */
export function noteSaid(mateId: string, text: string): void {
  noteSpoken(mateId, text);
  post({ type: "started", id: "-", mateId, turn: "-", idx: -1, text: text.slice(0, 600) });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/**
 * Take part in the election for `mateId` (null / rank 0: not a candidate). `speaking` is the turn this window is
 * reading now. Returns whether this window is the device's voice for the mate.
 */
export function useVoiceElection(mateId: string | null, rank: number, speaking: string | null): boolean {
  const idRef = useRef<string>("");
  if (!idRef.current) idRef.current = makeId(12);
  const id = idRef.current;
  const [focusAt, setFocusAt] = useState(() => (typeof document !== "undefined" && document.hasFocus?.() ? Date.now() : 0));
  const v = useSyncExternalStore(subscribe, () => version, () => 0);
  // a window that just opened listens for its peers first (it must not start reading over the one that does)
  const [ready, setReady] = useState(!channel);
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setReady(true), HEARTBEAT_MS + 150);
    return () => clearTimeout(t);
  }, [ready]);

  // focus = the user is here: the most recently focused Mate surface speaks
  useEffect(() => {
    const bump = () => setFocusAt(Date.now());
    window.addEventListener("focus", bump);
    window.addEventListener("pointerdown", bump, true);
    window.addEventListener("keydown", bump, true);
    return () => {
      window.removeEventListener("focus", bump);
      window.removeEventListener("pointerdown", bump, true);
      window.removeEventListener("keydown", bump, true);
    };
  }, []);

  const me = useRef({ mateId, rank, focusAt, speaking });
  me.current = { mateId, rank, focusAt, speaking };
  useEffect(() => {
    if (!channel) return;
    const beat = () => {
      const m = me.current;
      if (!m.mateId || m.rank <= 0) return;
      post({ type: "hb", id, mateId: m.mateId, rank: m.rank, focusAt: m.focusAt, speaking: m.speaking, hidden: document.visibilityState === "hidden" });
    };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    const bye = () => me.current.mateId && post({ type: "bye", id, mateId: me.current.mateId });
    window.addEventListener("pagehide", bye);
    return () => {
      clearInterval(t);
      window.removeEventListener("pagehide", bye);
      bye();
    };
  }, [id]);
  // a change is announced at once (not at the next beat)
  useEffect(() => {
    if (channel && mateId && rank > 0)
      post({ type: "hb", id, mateId, rank, focusAt, speaking, hidden: document.visibilityState === "hidden" });
    else if (channel && mateId) post({ type: "bye", id, mateId });
  }, [id, mateId, rank, focusAt, speaking]);

  if (!mateId || rank <= 0 || !ready) return false;
  void v;
  const self = { id, mateId, rank, focusAt, speaking };
  for (const p of peers.values()) {
    if (p.mateId !== mateId || p.id === id || p.rank <= 0) continue;
    if (better(p, self)) return false;
  }
  return true;
}
