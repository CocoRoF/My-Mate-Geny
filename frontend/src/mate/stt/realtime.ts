/**
 * One realtime listening session (ElevenLabs Scribe v2 Realtime, docs/mate.md §5):
 *
 *   mic (capture.ts) → 16 kHz PCM, 100 ms chunks (pcm.ts) → [gate: silence while she speaks, barge-in off] →
 *   wss (the backend's single-use token in the URL) → partial / committed transcripts (scribe.ts) → [echo filter] →
 *   onPartial / onSegment
 *
 * - The socket opens while the mic does; audio captured before ElevenLabs says `session_started` is sent then.
 * - A dropped socket (network, their transcriber, the session's time limit) reconnects with a fresh token — the live
 *   text stays on screen meanwhile, and the new session gets the utterance's audio again (since the last committed
 *   text, ≤ 30 s, incl. what was captured while reconnecting), so nothing said is lost. After 3 failed tries,
 *   or when the key / credits fail mid-way, the session turns into a recording: on stop, the audio since the last
 *   committed text goes to the server's fallback engine (a WAV via /transcribe).
 * - The token can't be had at the start: the same recording fallback when the server has an engine for it;
 *   otherwise `onError` with the code (useMic may then use the browser's Web Speech).
 * - stop() sends a commit and waits (≤ 2.5 s) for the last committed text; cancel() drops everything.
 * - Nothing is said for `idleMs` (and she isn't speaking): it stops by itself (silence is billed too).
 *
 * Everything the browser provides is injectable (tests: test/mate-stt.test.ts).
 */
import { EchoGate } from "./echo.ts";
import { Chunker, pcmToBase64, Resampler, STT_RATE, wavFromPcm } from "./pcm.ts";
import { audioFrame, closeFailure, parseScribeMessage, type SttFailure } from "./scribe.ts";
import type { MicHandle } from "./capture.ts";

export interface RealtimeToken {
  url: string;
  sample_rate?: number;
  language?: string;
  fallback?: string | null;
}

export class TokenError extends Error {
  code: SttFailure;
  fallback: string | null;
  constructor(message: string, code: SttFailure, fallback: string | null) {
    super(message);
    this.code = code;
    this.fallback = fallback;
  }
}

export type RealtimeState = "connecting" | "listening" | "reconnecting" | "recording" | "finishing" | "transcribing" | "closed";

export type RealtimeNotice =
  /** the stream can't be used: this recording is transcribed by `engine` when you stop */
  | { kind: "fallback"; engine: string; code: SttFailure; reason: string }
  | { kind: "reconnected" }
  /** stopped by itself after a quiet stretch */
  | { kind: "idle" };

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface RealtimeDeps {
  getToken: () => Promise<RealtimeToken>;
  /** a WAV of the recording → its text (the server's fallback engine) */
  transcribe: (wav: Blob, engine: string) => Promise<{ text: string; engine?: string }>;
  openMic: (onFrames: (samples: Float32Array, rate: number) => void) => Promise<MicHandle>;
  /** the mate speaks on this device now (any window) */
  voicing: () => boolean;
  /** what she said lately (the echo filter compares with it) */
  spoken: () => string[];
  bargeIn: () => boolean;
  newSocket?: (url: string) => WsLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface RealtimeCallbacks {
  onState?: (s: RealtimeState) => void;
  /** the live text of the utterance in progress ("" = none) */
  onPartial?: (text: string) => void;
  /** a finished utterance (committed by ElevenLabs' VAD, by stop(), or transcribed by the fallback) */
  onSegment?: (text: string, how: "realtime" | "fallback") => void;
  /** the user started talking while she speaks (barge-in on) */
  onBargeIn?: () => void;
  onNotice?: (n: RealtimeNotice) => void;
  /** the session ended with a failure (start / mic / no fallback) */
  onError?: (code: SttFailure, message: string, serverFallback: string | null) => void;
  /** mic level 0..1 (per chunk) */
  onLevel?: (level: number) => void;
}

const OPEN = 1;
const MAX_RETRIES = 3;
const MAX_BUFFERED = 150; // chunks (15 s) kept while (re)connecting
const MAX_FALLBACK_S = 120; // what the recording fallback keeps (since the last committed text)
const FINAL_WAIT_MS = 2500;
const RESEND_S = 30; // after a drop, at most this much of the utterance is sent again

export class RealtimeStt {
  readonly gate: EchoGate;
  state: RealtimeState = "connecting";
  /** the server's fallback engine for a recording (from the token answer) */
  serverFallback: string | null = null;
  idleMs: number;

  private d: Required<Pick<RealtimeDeps, "now" | "setTimer" | "clearTimer">> & RealtimeDeps;
  private cb: RealtimeCallbacks;
  private mic: MicHandle | null = null;
  private resampler: Resampler | null = null;
  private chunker = new Chunker();
  private ws: WsLike | null = null;
  private started = false; // session_started on the current socket
  private pending: Int16Array[] = [];
  private since: Int16Array[] = []; // PCM since the last committed text (fallback)
  private sinceSamples = 0;
  private carry = ""; // live text of a socket that dropped mid-utterance
  private partialText = "";
  private retries = 0;
  private mode: "live" | "record" = "live";
  private fallbackEngine: string | null = null;
  private stopping = false;
  private done = false;
  private finalWaiter: (() => void) | null = null;
  private lastSpeech: number;
  private idleTimer: unknown = null;
  private wasVoicing = false;
  private connectGen = 0;
  private resend = false; // the next session_started: send the utterance since the last commit again

  constructor(deps: RealtimeDeps, cb: RealtimeCallbacks, opts: { idleMs?: number } = {}) {
    this.d = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...deps,
    };
    this.cb = cb;
    this.idleMs = opts.idleMs ?? 45_000;
    this.gate = new EchoGate({ bargeIn: deps.bargeIn() });
    this.lastSpeech = this.d.now();
  }

  private set(s: RealtimeState) {
    if (this.state === s) return;
    this.state = s;
    this.cb.onState?.(s);
  }

  /** open the mic and the stream (resolves once both are under way; failures come through the callbacks) */
  async start(): Promise<void> {
    this.set("connecting");
    const mic = this.d
      .openMic((samples, rate) => this.onFrames(samples, rate))
      .then((m) => {
        if (this.done) return m.close();
        this.mic = m;
        m.onEnded = () => this.fail("mic", "ended"); // i18n-ignore (useMic words it)
      })
      .catch((e: unknown) => {
        this.fail("mic", (e as Error)?.message || String(e), e);
      });
    const sock = this.connect();
    await Promise.all([mic, sock]);
    this.armIdle();
  }

  /** the microphone error object of the last mic failure (for the page's wording) */
  micError: unknown = null;

  // ── audio ──

  private onFrames(samples: Float32Array, rate: number) {
    if (this.done) return;
    if (!this.resampler || this.resampler.inRate !== rate) this.resampler = new Resampler(rate, STT_RATE);
    for (const c of this.chunker.push(this.resampler.push(samples))) this.onChunk(c);
  }

  private onChunk(pcm: Int16Array) {
    const now = this.d.now();
    const voicing = this.d.voicing();
    if (voicing !== this.wasVoicing) {
      this.wasVoicing = voicing;
      this.gate.setVoicing(voicing, now);
    }
    this.gate.bargeIn = this.d.bargeIn();
    const muted = this.gate.muted(now);
    const out = muted ? new Int16Array(pcm.length) : pcm;
    let s = 0;
    for (let i = 0; i < pcm.length; i += 4) s += pcm[i] * pcm[i];
    const loud = Math.sqrt(s / Math.max(1, pcm.length / 4));
    this.cb.onLevel?.(muted ? 0 : Math.min(1, loud / 8000));
    // (a recording has no transcript to tell speech from quiet: its loudness does)
    if (this.mode === "record" && loud > 600 && !muted) this.lastSpeech = now;
    // (the fallback hears what the stream would have)
    this.since.push(out);
    this.sinceSamples += out.length;
    while (this.sinceSamples > MAX_FALLBACK_S * STT_RATE && this.since.length > 1) this.sinceSamples -= this.since.shift()!.length;
    if (this.mode !== "live") return;
    if (this.ws && this.ws.readyState === OPEN && this.started) {
      this.flushPending();
      this.send(out);
    } else {
      this.pending.push(out);
      if (this.pending.length > MAX_BUFFERED) this.pending.shift();
    }
  }

  private send(pcm: Int16Array, commit = false) {
    try {
      this.ws?.send(audioFrame(pcm.length ? pcmToBase64(pcm) : "", commit, STT_RATE));
    } catch {
      /* closing: the close handler takes over */
    }
  }

  private flushPending() {
    const p = this.pending;
    this.pending = [];
    for (const c of p) this.send(c);
  }

  // ── the socket ──

  private async connect(): Promise<void> {
    const gen = ++this.connectGen;
    let tok: RealtimeToken;
    try {
      tok = await this.d.getToken();
    } catch (e) {
      if (this.done || gen !== this.connectGen) return;
      const te = e instanceof TokenError ? e : new TokenError((e as Error)?.message || String(e), "network", this.serverFallback);
      if (te.fallback !== undefined && te.fallback !== null) this.serverFallback = te.fallback;
      // (a retry that can't get a token: the recording fallback, or the end)
      this.toRecording(te.code, te.message, te.fallback ?? this.serverFallback);
      return;
    }
    if (this.done || gen !== this.connectGen) return;
    this.serverFallback = tok.fallback ?? null;
    const ws = (this.d.newSocket ?? ((u: string) => new WebSocket(u) as unknown as WsLike))(tok.url);
    this.ws = ws;
    this.started = false;
    ws.onmessage = (ev) => this.onMessage(ws, ev.data);
    ws.onclose = (ev) => this.onClose(ws, ev.code, ev.reason);
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private onMessage(ws: WsLike, data: unknown) {
    if (ws !== this.ws) return;
    const ev = parseScribeMessage(data);
    const now = this.d.now();
    switch (ev.type) {
      case "started":
        this.started = true;
        if (this.retries) this.cb.onNotice?.({ kind: "reconnected" });
        if (this.resend) {
          // a new session after a drop: the whole utterance so far again (what the old one heard but never
          // committed is gone with it), the audio buffered meanwhile included
          this.resend = false;
          this.pending = [];
          let n = 0;
          const keep: Int16Array[] = [];
          for (let i = this.since.length - 1; i >= 0 && n < RESEND_S * STT_RATE; i--) {
            keep.unshift(this.since[i]);
            n += this.since[i].length;
          }
          for (const c of keep) this.send(c);
        } else this.flushPending();
        if (this.stopping) this.finishLive();
        else this.set("listening");
        return;
      case "partial": {
        const r = this.gate.partial(ev.text, this.d.spoken(), now);
        if (r.barge) this.cb.onBargeIn?.();
        // (after a drop the new session hears the utterance from its start: its text replaces the old live text)
        const shown = r.show || this.carry;
        if (r.show) this.lastSpeech = now;
        if (shown !== this.partialText) {
          this.partialText = shown;
          this.cb.onPartial?.(shown);
        }
        return;
      }
      case "committed": {
        const mine = this.gate.committed(ev.text, this.d.spoken(), now);
        const text = mine?.trim() || this.carry;
        this.carry = "";
        this.partialText = "";
        this.cb.onPartial?.("");
        this.since = [];
        this.sinceSamples = 0;
        this.retries = 0;
        if (text) {
          this.lastSpeech = now;
          this.cb.onSegment?.(text, "realtime");
        }
        this.finalWaiter?.();
        return;
      }
      case "idle":
        this.cb.onNotice?.({ kind: "idle" });
        void this.stop();
        return;
      case "error":
        if (!ev.retry) return this.toRecording(ev.code, ev.message, this.serverFallback);
        return this.retry(ev.code, ev.message);
    }
  }

  private onClose(ws: WsLike, code: number, reason: string) {
    if (ws !== this.ws) return;
    this.ws = null;
    this.started = false;
    if (this.done) return;
    if (this.stopping) return this.finalWaiter?.();
    const f = closeFailure(code, reason);
    this.retry(f.code, f.message);
  }

  private retry(code: SttFailure, message: string) {
    if (this.done || this.mode !== "live") return;
    const old = this.ws;
    this.ws = null;
    this.started = false;
    if (old) {
      old.onclose = null;
      old.onmessage = null;
      try {
        old.close(1000);
      } catch {
        /* gone */
      }
    }
    // the words heard so far stay on screen; the next session gets the utterance's audio again (since the last commit)
    if (this.partialText) this.carry = this.partialText;
    this.resend = true;
    if (this.stopping) {
      // stopping anyway: what was heard is the text
      return this.finishWith(this.carry);
    }
    if (++this.retries > MAX_RETRIES) return this.toRecording(code, message, this.serverFallback);
    this.set("reconnecting");
    this.d.setTimer(() => void (!this.done && this.mode === "live" && this.connect()), 400 * 2 ** (this.retries - 1));
  }

  /** the stream is out: keep recording; stop() transcribes it with the server's fallback engine */
  private toRecording(code: SttFailure, reason: string, fallback: string | null) {
    if (this.done) return;
    const engine = fallback && !(fallback === "elevenlabs" && (code === "auth" || code === "quota" || code === "missing")) ? fallback : null;
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null;
      old.onmessage = null;
      try {
        old.close(1000);
      } catch {
        /* gone */
      }
    }
    if (!engine) {
      this.fail(code, reason);
      return;
    }
    if (this.partialText) this.carry = this.partialText;
    this.mode = "record";
    this.fallbackEngine = engine;
    this.pending = []; // (already in `since`)
    this.set("recording");
    this.cb.onNotice?.({ kind: "fallback", engine, code, reason });
    if (this.stopping) void this.finishRecording();
  }

  private fail(code: SttFailure, message: string, err?: unknown) {
    if (this.done) return;
    if (err !== undefined) this.micError = err;
    this.teardown();
    this.cb.onError?.(code, message, this.serverFallback);
  }

  // ── the end ──

  /** finish: the last words become text (realtime: commit + wait; recording: the fallback transcribes) */
  async stop(): Promise<void> {
    if (this.done || this.stopping) return;
    this.stopping = true;
    this.clearIdle();
    // the user is done: the mic goes now (the rest is network)
    const tail = this.chunker.flush();
    this.mic?.close();
    this.mic = null;
    if (tail) this.onChunkTail(tail);
    if (this.mode === "record") return this.finishRecording();
    this.set("finishing");
    const waited = new Promise<void>((res) => {
      this.finalWaiter = res;
      this.d.setTimer(res, FINAL_WAIT_MS + (this.started ? 0 : 3000));
    });
    if (this.started) this.finishLive();
    await waited;
    if ((this.mode as string) === "record") return; // (fell back meanwhile: finishRecording ends it)
    this.finishWith(this.partialText);
  }

  private onChunkTail(pcm: Int16Array) {
    if (this.mode === "live" && this.ws && this.started) this.send(pcm);
    else if (this.mode === "live") this.pending.push(pcm);
    this.since.push(pcm);
  }

  private finishLive() {
    this.flushPending();
    this.send(new Int16Array(0), true);
  }

  /** whatever is still only live text becomes the last segment; then close */
  private finishWith(text: string) {
    if (this.done) return;
    const t = text.trim();
    this.teardown();
    this.cb.onPartial?.("");
    if (t) this.cb.onSegment?.(t, "realtime");
  }

  private async finishRecording() {
    if (this.done) return;
    const engine = this.fallbackEngine!;
    const chunks = this.since;
    const carry = this.carry;
    this.teardown(false);
    const samples = chunks.reduce((n, c) => n + c.length, 0);
    if (samples < STT_RATE * 0.3) {
      this.done = true;
      this.set("closed");
      if (carry) this.cb.onSegment?.(carry, "realtime");
      return;
    }
    this.set("transcribing");
    try {
      const wav = wavFromPcm(chunks, STT_RATE);
      const r = await this.d.transcribe(new Blob([wav as BlobPart], { type: "audio/wav" }), engine);
      if (this.cancelled) return;
      const text = (r.text || "").trim() || carry; // (the recording holds the live text's audio too)
      this.done = true;
      this.set("closed");
      if (text) this.cb.onSegment?.(text, "fallback");
    } catch (e) {
      if (this.cancelled) return;
      this.done = true;
      this.set("closed");
      if (carry) this.cb.onSegment?.(carry, "realtime");
      this.cb.onError?.("upstream", (e as Error)?.message || String(e), null);
    }
  }

  private cancelled = false;

  /** drop everything (the mic released, nothing sent on) */
  cancel(): void {
    this.cancelled = true;
    if (this.done) return;
    this.teardown();
    this.cb.onPartial?.("");
  }

  private teardown(final = true) {
    this.clearIdle();
    this.connectGen++;
    this.mic?.close();
    this.mic = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close(1000);
      } catch {
        /* gone */
      }
    }
    this.finalWaiter?.();
    this.finalWaiter = null;
    if (final) {
      this.done = true;
      this.set("closed");
    }
  }

  get closed(): boolean {
    return this.done;
  }

  // ── a quiet stretch ends it ──

  private armIdle() {
    this.clearIdle();
    if (this.done || !this.idleMs) return;
    this.idleTimer = this.d.setTimer(() => this.checkIdle(), 1000);
  }

  private checkIdle() {
    this.idleTimer = null;
    if (this.done || this.stopping) return;
    const now = this.d.now();
    // her speaking (and thinking aloud) is not the user being quiet
    if (this.d.voicing() || this.gate.gated(now)) this.lastSpeech = now;
    if (now - this.lastSpeech > this.idleMs) {
      this.cb.onNotice?.({ kind: "idle" });
      void this.stop();
      return;
    }
    this.armIdle();
  }

  /** (she began a reply, the user typed…) — counts as activity */
  touch(): void {
    this.lastSpeech = this.d.now();
  }

  private clearIdle() {
    if (this.idleTimer !== null) this.d.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }
}
