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
 *   3. else the most recently focused Mate surface (the mate chat window or the console's Mate view).
 * The quick card never speaks (its replies go to whoever is elected). Every window follows every reply's sentences,
 * and the speaker announces each sentence it starts — a window that takes over mid-reply (the speaker closed or
 * crashed) goes on from the next sentence, and a sentence another window started is never played again.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const DEVICE_KEY = "hrh_device_id";
const HEARTBEAT_MS = 300;
const GONE_MS = 1000;

export const RANK_OVERLAY = 3;
export const RANK_SURFACE = 1;

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
  type: "hb" | "bye" | "started";
  id: string;
  mateId: string;
  rank?: number;
  focusAt?: number;
  /** the turn this candidate is reading now (it keeps the voice until it is done) */
  speaking?: string | null;
  /** "started": a sentence began playing */
  turn?: string;
  idx?: number;
}

interface Peer {
  id: string;
  mateId: string;
  rank: number;
  focusAt: number;
  speaking: string | null;
  seen: number;
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
      return;
    }
    if (b.type !== "hb") return;
    const prev = peers.get(b.id);
    const next: Peer = { id: b.id, mateId: b.mateId, rank: b.rank ?? 0, focusAt: b.focusAt ?? 0, speaking: b.speaking ?? null, seen: Date.now() };
    peers.set(b.id, next);
    if (!prev || prev.rank !== next.rank || prev.focusAt !== next.focusAt || prev.speaking !== next.speaking || prev.mateId !== next.mateId) emit();
  };
  setInterval(() => {
    const t = Date.now();
    let gone = false;
    for (const [id, p] of peers) if (t - p.seen > GONE_MS) gone = peers.delete(id) || gone;
    if (gone) emit();
  }, 250);
}

/** the order of candidates: reading now > rank > most recently focused > id (the same answer in every window) */
function better(a: Omit<Peer, "seen">, b: Omit<Peer, "seen">): boolean {
  if (!!a.speaking !== !!b.speaking) return !!a.speaking;
  if (a.rank !== b.rank) return a.rank > b.rank;
  if (a.focusAt !== b.focusAt) return a.focusAt > b.focusAt;
  return a.id > b.id;
}

/** the highest sentence index of `turn` started by any window of this device (-1: none) */
export const startedUpTo = (turn: string) => started.get(turn) ?? -1;

/** a sentence of `turn` began playing in this window: tell the others (they never play it, nor anything before it) */
export function announceStarted(mateId: string, turn: string, idx: number) {
  noteStarted(turn, idx);
  post({ type: "started", id: "-", mateId, turn, idx });
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
      post({ type: "hb", id, mateId: m.mateId, rank: m.rank, focusAt: m.focusAt, speaking: m.speaking });
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
    if (channel && mateId && rank > 0) post({ type: "hb", id, mateId, rank, focusAt, speaking });
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
