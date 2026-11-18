/**
 * Voice bridge (docs/mate.md §2): the one place between whatever makes the mate speak (TTS clips, the browser's
 * speechSynthesis, a lab slider) and her body. Bodies never know where speech comes from; they only hear
 *
 *   start(id) → level(0..1) about 30 times a second → marks([{char, t}]) optionally → end()
 *
 * Ported from ailism-mate `mateVoice.ts`. The level is the RMS of the analyser's frequency bins (0..1), exactly what
 * Geny's AudioManager feeds its lip-sync, so the Live2D body can keep Geny's mapping (smoothing 0.3, threshold 0.015,
 * scale 1.8). Speech usually sits around 0.1–0.4.
 *
 * Her mouth moves in every window that shows her (docs/mate.md §2 "In step"): the voice plays in one window of this
 * computer (mate/voiceOwner: the desktop overlay, the console, a call), and that window says what its voice does over a
 * BroadcastChannel ("hrh-mate-lips": start, level, marks, end — and whose voice it is: `claimVoice`). A window that shows
 * her (`showsMate`, from LiveMateAvatar) and speaks nothing itself plays the same along (ids `remote:…`; a voice that
 * goes quiet without its end — the window closed — ends after REMOTE_QUIET_MS).
 */
import { useEffect, useState, useSyncExternalStore } from "react";

export type VoiceMark = { char: string; t: number };

export type VoiceEvent =
  | { type: "start"; id: string }
  | { type: "level"; level: number }
  | { type: "marks"; marks: VoiceMark[] }
  | { type: "end"; id: string };

type Listener = (e: VoiceEvent) => void;

const listeners = new Set<Listener>();
let speaking: string | null = null;
let current = 0;

function emit(e: VoiceEvent) {
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch (err) {
      console.error("[voiceBridge] listener failed", err);
    }
  }
}

/** something started speaking (a new id replaces whatever was speaking) */
export function start(id: string): void {
  if (speaking && speaking !== id) {
    const was = speaking;
    emit({ type: "end", id: was });
    tell({ type: "end", id: was });
  }
  speaking = id;
  current = 0;
  emit({ type: "start", id });
  tell({ type: "start", id });
}

/** the loudness now, 0..1 (ignored while nothing speaks) */
export function level(v: number): void {
  if (!speaking) return;
  current = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  emit({ type: "level", level: current });
  tell({ type: "level", level: current });
}

/** optional per-character timing of what is being said (seconds from start) */
export function marks(m: VoiceMark[]): void {
  if (!speaking) return;
  emit({ type: "marks", marks: m });
  tell({ type: "marks", marks: m });
}

/** speaking stopped. With an id, only that speaker is ended (a late `ended` of an old clip cannot cut a newer one). */
export function end(id?: string): void {
  if (!speaking || (id !== undefined && id !== speaking)) return;
  const was = speaking;
  speaking = null;
  current = 0;
  emit({ type: "end", id: was });
  tell({ type: "end", id: was });
}

// ── her mouth in every window of this computer ──

/** a voice heard from another window that went quiet without its end (closed, crashed) ends after this */
export const REMOTE_QUIET_MS = 1200;
const REMOTE = "remote:";

const lips: BroadcastChannel | null = (() => {
  try {
    return typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("hrh-mate-lips") : null;
  } catch {
    return null;
  }
})();
/** whose voice this window plays (the newest claim: the conversation that speaks, a call) */
const claims: { token: number; mateId: string }[] = [];
let claimSeq = 0;
/** the mates whose avatar this window shows (how many avatars of each) */
const shown = new Map<string, number>();
let remoteSeen = 0;

/** this window plays `mateId`'s voice from now (released by the returned function): the other windows hear it */
export function claimVoice(mateId: string): () => void {
  const token = ++claimSeq;
  claims.push({ token, mateId });
  return () => {
    const i = claims.findIndex((c) => c.token === token);
    if (i >= 0) claims.splice(i, 1);
  };
}

/** an avatar of `mateId` is on this window (released by the returned function): it moves with her voice anywhere */
export function showsMate(mateId: string): () => void {
  shown.set(mateId, (shown.get(mateId) ?? 0) + 1);
  return () => {
    const n = (shown.get(mateId) ?? 1) - 1;
    if (n > 0) shown.set(mateId, n);
    else shown.delete(mateId);
  };
}

/** what this window's own voice does, to the others (a voice it only plays along is not told again) */
function tell(e: VoiceEvent): void {
  const claim = claims[claims.length - 1];
  if (!lips || !claim) return;
  const id = "id" in e ? e.id : speaking;
  if (!id || id.startsWith(REMOTE)) return;
  try {
    lips.postMessage({ mateId: claim.mateId, id, e });
  } catch {
    /* closed */
  }
}

if (lips) {
  lips.onmessage = (m: MessageEvent) => {
    const d = m.data as { mateId?: string; id?: string; e?: VoiceEvent } | null;
    if (!d || typeof d.mateId !== "string" || typeof d.id !== "string" || !d.e || !shown.has(d.mateId)) return;
    // (this window's own voice comes first: another's is only played along while it says nothing)
    if (speaking && !speaking.startsWith(REMOTE)) return;
    const id = REMOTE + d.id;
    const e = d.e;
    remoteSeen = Date.now();
    if (e.type === "end") return end(id);
    // (a window that came in mid-sentence joins at the next level)
    if (speaking !== id && e.type !== "start") start(id);
    if (e.type === "start") start(id);
    else if (e.type === "level") level(e.level);
    else if (e.type === "marks") marks(e.marks);
  };
  const quiet = setInterval(() => {
    if (speaking?.startsWith(REMOTE) && Date.now() - remoteSeen > REMOTE_QUIET_MS) end(speaking);
  }, 400);
  // (Node — the tests — must not stay up for them)
  (quiet as unknown as { unref?: () => void }).unref?.();
  (lips as unknown as { unref?: () => void }).unref?.();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export const voiceBridge = {
  start,
  level,
  marks,
  end,
  subscribe,
  /** id of what is speaking now, or null */
  get speaking() {
    return speaking;
  },
  /** last level (0 when silent): for render loops that poll instead of subscribing */
  get currentLevel() {
    return current;
  },
};

// ── shared AudioContext + autoplay unlock ────────────────────────────────────────────────────────────────────────

let ctx: AudioContext | null = null;
let gestureHooked = false;

/** the page's one AudioContext (created on first use; null where Web Audio is missing) */
export function getAudioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctx =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  try {
    ctx = new Ctx();
  } catch {
    return null;
  }
  return ctx;
}

/**
 * Resume the AudioContext. Call it from a user gesture (iOS WebKit only resumes inside one); it also hooks every
 * later touch/click so a context re-suspended in the background comes back on the next interaction.
 */
export function unlockAudio(): void {
  const c = getAudioContext();
  if (c && c.state !== "running") void c.resume().catch(() => {});
  if (gestureHooked || typeof document === "undefined") return;
  gestureHooked = true;
  const again = () => {
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
  };
  document.addEventListener("touchend", again, { passive: true, capture: true });
  document.addEventListener("pointerdown", again, { passive: true, capture: true });
  document.addEventListener("keydown", again, { capture: true });
}

// ── level from real audio ────────────────────────────────────────────────────────────────────────────────────────

/** the RMS of an analyser's frequency bins, 0..1 (Geny AudioManager.startAmplitudeTracking) */
function rmsOf(an: AnalyserNode, data: Uint8Array<ArrayBuffer>): number {
  an.getByteFrequencyData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += (data[i] / 255) ** 2;
  return Math.sqrt(sum / data.length);
}

function makeAnalyser(c: AudioContext): AnalyserNode {
  const an = c.createAnalyser();
  an.fftSize = 256;
  // Geny uses 0.8; that averages syllables away (a sentence reads as one steady level, the mouth never closes).
  // 0.5 keeps the same scale (it averages magnitudes) but lets the level dip between syllables.
  an.smoothingTimeConstant = 0.5;
  return an;
}

/** a speech-like level while there is no real signal (browser speechSynthesis, an analyser we could not attach) */
export function fakeLevel(tMs: number): number {
  const t = tMs / 1000;
  const syllable = Math.abs(Math.sin(t * Math.PI * 4.3));
  const phrase = 0.55 + 0.45 * Math.abs(Math.sin(t * Math.PI * 0.9 + 0.7));
  return Math.max(0, Math.min(1, 0.03 + 0.32 * syllable * phrase + Math.random() * 0.04));
}

// ── output volume (0 – 300 %) ────────────────────────────────────────────────────────────────────────────────────

/** the loudest a mate may be: 3 = 300 % */
export const MAX_VOLUME = 3;

/**
 * An element routed through Web Audio: source → analyser → gain → limiter → speakers. The analyser sits before the gain,
 * so the level (lip-sync) is the same at any volume. The limiter (a compressor) is transparent up to 100 % and catches
 * the peaks above it, so 300 % gets loud without clipping harshly.
 */
type ElementGraph = { an: AnalyserNode; gain: GainNode; limiter: DynamicsCompressorNode };

/** a media element can feed only one MediaElementSource, ever: made once per element */
const elementGraphs = new WeakMap<HTMLMediaElement, ElementGraph>();
/** the volume asked for per element (kept until the graph exists) */
const elementVolumes = new WeakMap<HTMLMediaElement, number>();

const clampVolume = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(MAX_VOLUME, v)) : 1);

function applyVolume(el: HTMLMediaElement): void {
  const v = elementVolumes.get(el) ?? 1;
  const g = elementGraphs.get(el);
  if (!g) {
    // not routed (yet): the element itself can only go down to silence and up to 100 %
    el.volume = Math.min(1, v);
    return;
  }
  el.volume = 1;
  g.gain.gain.value = v;
  const l = g.limiter;
  if (v > 1) {
    l.threshold.value = -6;
    l.knee.value = 4;
    l.ratio.value = 12;
    l.attack.value = 0.002;
    l.release.value = 0.2;
  } else {
    // ratio 1 = no compression (and no make-up gain): what you hear at ≤ 100 % is the clip as it is
    l.threshold.value = 0;
    l.knee.value = 0;
    l.ratio.value = 1;
  }
}

/**
 * The volume of an element, 0..MAX_VOLUME (1 = as recorded). Above 1 it really amplifies (a GainNode + limiter), once
 * the element is routed through the page's AudioContext (it is the first time it plays with a running context, or
 * after routeOutput); until then it is capped at 100 % by the element's own volume.
 */
export function setOutputVolume(el: HTMLMediaElement, v: number): void {
  elementVolumes.set(el, clampVolume(v));
  applyVolume(el);
}

/** the gain the element's GainNode applies now (null: not routed through Web Audio) */
export function outputGain(el: HTMLMediaElement): number | null {
  return elementGraphs.get(el)?.gain.gain.value ?? null;
}

/**
 * Route an element through Web Audio now (resuming the context first — call it from a gesture), so a volume over
 * 100 % applies. Only for same-origin / blob: media: a cross-origin element without CORS would play silence.
 */
export async function routeOutput(el: HTMLMediaElement): Promise<boolean> {
  const c = getAudioContext();
  if (!c) return false;
  if (c.state !== "running") await c.resume().catch(() => {});
  return graphFor(el) !== null;
}

function graphFor(el: HTMLMediaElement): AnalyserNode | null {
  const known = elementGraphs.get(el);
  if (known) return known.an;
  const c = getAudioContext();
  // Routing an element through a context that is not running would mute it: until the page is unlocked we leave the
  // element alone (it plays directly) and fake the level instead.
  if (!c || c.state !== "running") return null;
  try {
    const src = c.createMediaElementSource(el);
    const an = makeAnalyser(c);
    const gain = c.createGain();
    const limiter = c.createDynamicsCompressor();
    src.connect(an);
    an.connect(gain);
    gain.connect(limiter);
    limiter.connect(c.destination);
    elementGraphs.set(el, { an, gain, limiter });
    applyVolume(el);
    return an;
  } catch {
    return null;
  }
}

let autoId = 0;

/**
 * Drive the bridge from real audio, ~30 levels a second.
 *
 * - An `HTMLMediaElement`: speaking while it plays (play → start, pause/ended → end), its loudness as the level.
 *   It is routed through the shared AudioContext once (it keeps playing to the speakers).
 * - An `AudioNode` (e.g. an AudioBufferSourceNode you route yourself): speaking from now until the returned detach
 *   (or the node's `ended`). The node is only tapped, not connected to the destination.
 *
 * Returns the detach.
 */
export function attachAudio(target: HTMLMediaElement | AudioNode, id = `voice-${++autoId}`): () => void {
  let raf = 0;
  let last = 0;
  let t0 = 0;
  let an: AnalyserNode | null = null;
  let data: Uint8Array<ArrayBuffer> | null = null;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (now - last < 33) return;
    last = now;
    if (an && data) level(rmsOf(an, data));
    else level(fakeLevel(now - t0));
  };
  const run = () => {
    cancelAnimationFrame(raf);
    t0 = performance.now();
    last = 0;
    raf = requestAnimationFrame(tick);
  };
  const halt = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };

  if (typeof (target as AudioNode).connect === "function" && !(target instanceof HTMLMediaElement)) {
    const node = target as AudioNode;
    an = makeAnalyser(node.context as AudioContext);
    data = new Uint8Array(an.frequencyBinCount);
    node.connect(an);
    start(id);
    run();
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      halt();
      try {
        node.disconnect(an!);
      } catch {
        /* already gone */
      }
      end(id);
    };
    if (typeof AudioScheduledSourceNode !== "undefined" && node instanceof AudioScheduledSourceNode)
      node.addEventListener("ended", stop, { once: true });
    return stop;
  }

  const el = target as HTMLMediaElement;
  const play = () => {
    if (el.dataset.mateSilent) return; // an autoplay unlock playing silence
    const c = getAudioContext();
    if (c && c.state !== "running") void c.resume().catch(() => {});
    an = graphFor(el);
    data = an ? new Uint8Array(an.frequencyBinCount) : null;
    start(id);
    run();
  };
  const stop = () => {
    halt();
    end(id);
  };
  el.addEventListener("play", play);
  el.addEventListener("playing", play);
  el.addEventListener("pause", stop);
  el.addEventListener("ended", stop);
  el.addEventListener("emptied", stop);
  if (!el.paused && !el.ended) play();
  return () => {
    stop();
    el.removeEventListener("play", play);
    el.removeEventListener("playing", play);
    el.removeEventListener("pause", stop);
    el.removeEventListener("ended", stop);
    el.removeEventListener("emptied", stop);
  };
}

// ── React hooks ──────────────────────────────────────────────────────────────────────────────────────────────────

/** the current level (re-renders ~30 times a second while speaking; use sparingly — bodies subscribe instead) */
export function useVoiceLevel(): number {
  const [v, setV] = useState(current);
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "level") setV(e.level);
        else if (e.type === "end" || e.type === "start") setV(0);
      }),
    [],
  );
  return v;
}

const subscribeSpeaking = (cb: () => void) =>
  subscribe((e) => {
    if (e.type === "start" || e.type === "end") cb();
  });

/** the id speaking now, or null (re-renders only on start/end) */
export function useVoiceSpeaking(): string | null {
  return useSyncExternalStore(
    subscribeSpeaking,
    () => speaking,
    () => null,
  );
}
