/**
 * The mate's voice: TTS clips played one after another (docs/mate.md §5), each through the voice bridge so the
 * avatar talks with it. Ported in spirit from Geny `audioManager.ts` (sequential queue, autoplay unlock on the first
 * gesture, iOS-safe single audio element) and ailism-mate `attachAudio`.
 *
 *   const q = getMateAudioQueue();
 *   q.setResolver(async (item) => (await fetch(`/api/mates/${id}/speech`, {...})).blob());   // the fetch hook
 *   q.enqueue({ text: "안녕하세요!", emotion: "joy" });   // resolved one ahead, played in order
 *   q.enqueue({ source: "/some/clip.mp3" });              // a ready URL / Blob
 *   q.enqueue({ text: "...", browser: { lang: "ko-KR" } }); // speechSynthesis (level faked while speaking)
 *
 * A resolver returning null (engine "browser"/"off", HTTP 204) falls back to speechSynthesis when `fallbackToBrowser`
 * is on (the default), else the item is skipped.
 */
import { attachAudio, end as voiceEnd, fakeLevel, level as voiceLevel, start as voiceStart, unlockAudio } from "./voiceBridge";
import { useSyncExternalStore } from "react";

export type ClipSource = string | Blob;

export interface BrowserVoiceOptions {
  /** BCP-47, e.g. "ko-KR" */
  lang?: string;
  /** SpeechSynthesisVoice name or voiceURI */
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export interface AudioQueueItem {
  id?: string;
  /** a ready clip (URL or Blob); without it the resolver is asked */
  source?: ClipSource | (() => Promise<ClipSource | null>);
  /** what is said (for the resolver, the browser fallback and captions) */
  text?: string;
  emotion?: string | null;
  /** speak with the browser's speechSynthesis instead of a clip */
  browser?: BrowserVoiceOptions | true;
  /** anything the caller wants back in events */
  meta?: unknown;
}

export type Resolver = (item: AudioQueueItem, signal: AbortSignal) => Promise<ClipSource | null>;

export interface QueueState {
  /** the item playing now (null when idle) */
  current: AudioQueueItem | null;
  /** items waiting (current not included) */
  pending: number;
  /** play() was refused (autoplay policy): waiting for a tap */
  blocked: boolean;
}

type Job = {
  item: AudioQueueItem & { id: string };
  /** resolved clip (started early for the next item: one-ahead prefetch) */
  ready: Promise<ClipSource | null> | null;
  abort: AbortController;
};

/** 50 ms of 8-bit mono silence as a WAV data URL (plays everywhere; used to unlock the audio element) */
function silentWav(): string {
  const n = 400;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  tag(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  tag(36, "data");
  v.setUint32(40, n, true);
  b.fill(128, 44);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return "data:audio/wav;base64," + btoa(bin);
}

let seq = 0;

export class MateAudioQueue {
  private jobs: Job[] = [];
  private playing: Job | null = null;
  private el: HTMLAudioElement | null = null;
  private detach: (() => void) | null = null;
  private resolver: Resolver | null = null;
  private listeners = new Set<() => void>();
  private state: QueueState = { current: null, pending: 0, blocked: false };
  private objectUrl: string | null = null;
  private finishCurrent: (() => void) | null = null;
  private browserDefaults: BrowserVoiceOptions = {};
  /** null from the resolver → speak with speechSynthesis */
  fallbackToBrowser = true;
  /** how many items ahead are resolved while one plays (docs: one-ahead) */
  prefetch = 1;
  onItemStart: ((item: AudioQueueItem) => void) | null = null;
  onItemEnd: ((item: AudioQueueItem) => void) | null = null;
  onIdle: (() => void) | null = null;
  onError: ((item: AudioQueueItem, err: unknown) => void) | null = null;

  constructor() {
    installAutoplayUnlock(() => this.element());
  }

  /** the fetch hook: turns a text item into a clip (null = nothing to play / let the browser speak) */
  setResolver(fn: Resolver | null): void {
    this.resolver = fn;
  }

  /** defaults for speechSynthesis items (language, voice, rate) */
  setBrowserVoice(opts: BrowserVoiceOptions): void {
    this.browserDefaults = { ...opts };
  }

  enqueue(item: AudioQueueItem): string {
    const id = item.id ?? `clip-${++seq}`;
    this.jobs.push({ item: { ...item, id }, ready: null, abort: new AbortController() });
    this.prefetchAhead();
    this.publish();
    if (!this.playing) void this.next();
    return id;
  }

  /** say a text with the browser's speechSynthesis */
  speakBrowser(text: string, opts?: BrowserVoiceOptions): string {
    return this.enqueue({ text, browser: opts ?? true });
  }

  /** stop now and drop everything waiting */
  stop(): void {
    for (const j of this.jobs) j.abort.abort();
    this.jobs = [];
    const cur = this.playing;
    this.playing = null;
    cur?.abort.abort();
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute("src");
      this.el.load();
    }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.finishCurrent?.();
    this.finishCurrent = null;
    this.revoke();
    voiceEnd();
    this.state = { current: null, pending: 0, blocked: false };
    this.publish();
  }

  getState(): QueueState {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  // ── internals ──

  private publish(): void {
    this.state = { ...this.state, current: this.playing?.item ?? null, pending: this.jobs.length };
    for (const l of [...this.listeners]) l();
  }

  private element(): HTMLAudioElement {
    if (!this.el) {
      const el = new Audio();
      el.preload = "auto";
      (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      el.setAttribute("playsinline", "");
      this.el = el;
      this.detach = attachAudio(el, "mate-voice");
    }
    return this.el;
  }

  private resolve(job: Job): Promise<ClipSource | null> {
    if (job.ready) return job.ready;
    const { item } = job;
    job.ready = (async () => {
      if (item.browser) return null;
      if (typeof item.source === "function") return item.source();
      if (item.source) return item.source;
      if (this.resolver) return this.resolver(item, job.abort.signal);
      return null;
    })().catch((err) => {
      if (!job.abort.signal.aborted) this.onError?.(item, err);
      return null;
    });
    return job.ready;
  }

  private prefetchAhead(): void {
    for (const j of this.jobs.slice(0, this.prefetch)) void this.resolve(j);
  }

  private async next(): Promise<void> {
    const job = this.jobs.shift();
    if (!job) {
      this.playing = null;
      this.publish();
      this.onIdle?.();
      return;
    }
    this.playing = job;
    this.publish();
    const clip = await this.resolve(job);
    this.prefetchAhead();
    if (this.playing !== job || job.abort.signal.aborted) return;
    try {
      this.onItemStart?.(job.item);
      if (clip) await this.playClip(job, clip);
      else if ((job.item.browser || this.fallbackToBrowser) && job.item.text) await this.playBrowser(job);
    } catch (err) {
      if (!job.abort.signal.aborted) this.onError?.(job.item, err);
    } finally {
      this.revoke();
      this.onItemEnd?.(job.item);
    }
    if (this.playing === job) void this.next();
  }

  private revoke(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  private playClip(job: Job, clip: ClipSource): Promise<void> {
    const el = this.element();
    this.revoke();
    const url = typeof clip === "string" ? clip : (this.objectUrl = URL.createObjectURL(clip));
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (err?: unknown) => {
        if (done) return;
        done = true;
        el.removeEventListener("ended", ok);
        el.removeEventListener("error", bad);
        this.finishCurrent = null;
        if (err) reject(err);
        else resolve();
      };
      const ok = () => finish();
      const bad = () => finish(el.error ?? new Error("audio error"));
      this.finishCurrent = () => finish();
      el.addEventListener("ended", ok);
      el.addEventListener("error", bad);
      delete el.dataset.mateSilent;
      el.src = url;
      const tryPlay = () =>
        el.play().then(
          () => {
            if (this.state.blocked) {
              this.state = { ...this.state, blocked: false };
              this.publish();
            }
          },
          (err: DOMException) => {
            if (done) return;
            if (err?.name === "NotAllowedError") {
              // autoplay refused: wait for the next tap, then play this clip
              this.state = { ...this.state, blocked: true };
              this.publish();
              onNextGesture(() => {
                if (!done && this.playing === job) {
                  unlockAudio();
                  void tryPlay();
                }
              });
            } else if (err?.name !== "AbortError") finish(err);
          },
        );
      void tryPlay();
    });
  }

  private playBrowser(job: Job): Promise<void> {
    if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined")
      return Promise.resolve();
    const text = job.item.text ?? "";
    const opts = { ...this.browserDefaults, ...(job.item.browser === true ? {} : job.item.browser ?? {}) };
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      if (opts.lang) u.lang = opts.lang;
      if (opts.rate) u.rate = opts.rate;
      if (opts.pitch) u.pitch = opts.pitch;
      if (opts.volume !== undefined) u.volume = opts.volume;
      const voice = pickVoice(opts);
      if (voice) u.voice = voice;
      const id = job.item.id;
      let raf = 0;
      let last = 0;
      let t0 = 0;
      let bump = 0;
      let done = false;
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        if (now - last < 33) return;
        last = now;
        bump *= 0.8;
        voiceLevel(Math.min(1, fakeLevel(now - t0) + bump));
      };
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        cancelAnimationFrame(raf);
        voiceEnd(id);
        this.finishCurrent = null;
        resolve();
      };
      u.onstart = () => {
        t0 = performance.now();
        voiceStart(id);
        raf = requestAnimationFrame(tick);
      };
      u.onboundary = () => {
        bump = 0.12;
      };
      u.onend = finish;
      u.onerror = finish;
      this.finishCurrent = finish;
      // some engines never fire onend (or never start): give up after a generous estimate
      const guard = setTimeout(finish, 4000 + text.length * 250);
      speechSynthesis.speak(u);
    });
  }

  /** release the audio element (tests / hot reload) */
  dispose(): void {
    this.stop();
    this.detach?.();
    this.detach = null;
    this.el = null;
  }
}

function pickVoice(opts: BrowserVoiceOptions): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices();
  if (opts.voice) {
    const v = voices.find((x) => x.voiceURI === opts.voice || x.name === opts.voice);
    if (v) return v;
  }
  if (opts.lang) {
    const lang = opts.lang.toLowerCase();
    return (
      voices.find((x) => x.lang.toLowerCase() === lang) ??
      voices.find((x) => x.lang.toLowerCase().startsWith(lang.split("-")[0])) ??
      null
    );
  }
  return null;
}

// ── autoplay unlock ──────────────────────────────────────────────────────────────────────────────────────────────

const gestureWaiters: (() => void)[] = [];
let unlockInstalled = false;

function onNextGesture(fn: () => void): void {
  gestureWaiters.push(fn);
}

/**
 * On the first user gesture (and every one after, cheaply): resume the AudioContext, play a silent clip on the
 * queue's audio element (iOS lets an element play later only once it played inside a gesture) and wake
 * speechSynthesis (iOS speaks only after a first utterance inside a gesture).
 */
export function installAutoplayUnlock(element?: () => HTMLAudioElement): void {
  if (unlockInstalled || typeof document === "undefined") return;
  unlockInstalled = true;
  let first = true;
  const handler = () => {
    unlockAudio();
    if (first) {
      first = false;
      const el = element?.();
      if (el && !el.src) {
        // the voice bridge ignores this element while it plays the silence (no talking for an unlock)
        el.dataset.mateSilent = "1";
        el.src = silentWav();
        const done = () => {
          if (el.src.startsWith("data:audio/wav")) el.removeAttribute("src");
          delete el.dataset.mateSilent;
        };
        void el.play().then(
          () => el.addEventListener("ended", done, { once: true }),
          done,
        );
      }
      if (typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined") {
        try {
          const u = new SpeechSynthesisUtterance("");
          u.volume = 0;
          speechSynthesis.speak(u);
        } catch {
          /* no speech here */
        }
      }
    }
    const waiting = gestureWaiters.splice(0);
    for (const w of waiting) w();
  };
  document.addEventListener("pointerdown", handler, { capture: true, passive: true });
  document.addEventListener("touchend", handler, { capture: true, passive: true });
  document.addEventListener("keydown", handler, { capture: true });
}

// ── shared queue + hook ──────────────────────────────────────────────────────────────────────────────────────────

let shared: MateAudioQueue | null = null;

/** the page's mate voice queue (one voice at a time across all surfaces) */
export function getMateAudioQueue(): MateAudioQueue {
  return (shared ??= new MateAudioQueue());
}

const EMPTY: QueueState = { current: null, pending: 0, blocked: false };

/** the shared queue and its state (re-renders when an item starts/ends or the queue grows) */
export function useMateAudio(): { queue: MateAudioQueue; state: QueueState } {
  const queue = getMateAudioQueue();
  const state = useSyncExternalStore(
    (cb) => queue.subscribe(cb),
    () => queue.getState(),
    () => EMPTY,
  );
  return { queue, state };
}
