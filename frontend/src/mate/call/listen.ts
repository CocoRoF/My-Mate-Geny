/**
 * Listening on a call (docs/mate-calls.md "Listening"): the mic stays open for the whole call and each finished utterance
 * of the user's becomes text. Three ways, as the server's plan says (calls.CallService.plan):
 *
 * - realtime — ElevenLabs Scribe v2 Realtime (mate/stt/realtime.ts) with the call's shorter pause; her echo is filtered by
 *   text, and the user's own words while she speaks are a barge-in at once. The stream can't be had (a token refused for
 *   a moment, the line to ElevenLabs down): the token is asked again at once, then each utterance is recorded for the
 *   server's engine (as `record`) while the stream is tried again now and then — a call never goes deaf for a hiccup;
 * - record — a server engine (Whisper, OpenAI, Google, ElevenLabs batch): voice activity (vad.ts) cuts the utterances,
 *   each goes as a WAV to /transcribe; while she speaks the VAD takes clearer speech, and a transcript that is just her
 *   is dropped;
 *
 * Her echo is only looked for in what was heard while her voice played (or just after): anything else is theirs as it
 * was heard, a short "응" or "네" included.
 * - browser — the page's Web Speech recognition (desktop Chrome; the Android WebView has none: the server's engine for a
 *   recording then, if there is one).
 *
 * Nothing works here → `onFail` in words (the call screen says so plainly; she can still be heard). Muted: the mic sends
 * silence (realtime / record) or the recognition stops (browser).
 */
import { realtimeSttToken, RealtimeTokenError, transcribe } from "../../api/mates";
import { sttFailureText } from "../stt/failure";
import { tr } from "../../i18n";
import { webSpeechRecognition } from "../desktop";
import { browserResults } from "../stt/browser";
import { micErrorKind, openMic, type MicHandle } from "../stt/capture";
import { meaningful, ownWords } from "../stt/echo";
import { Resampler, STT_RATE, wavFromPcm } from "../stt/pcm";
import { RealtimeStt, TokenError, type RealtimeDeps, type RealtimeToken } from "../stt/realtime";
import type { SttFailure } from "../stt/scribe";
import { Framer, Vad } from "./vad";
import { TurnTaker } from "./turns";
import type { CallPlan } from "../../api/calls";

export interface ListenCallbacks {
  /** one finished utterance of theirs (their words only); `endAt`: when they stopped talking (ms, Date.now). With
   *  realtime listening, a turn as it stands — sent before its end is sure (`onConfirm` says when it is), and `amend`:
   *  the whole of the last one again, they went on (mate/call/turns.ts) */
  onUtterance: (text: string, endAt: number, how: string, amend?: boolean, aside?: boolean) => void;
  /** (realtime) the end of their turn is sure: her answer may be heard */
  onConfirm?: () => void;
  /** (realtime) their voice again after the end seemed sure, before her voice began: her answer waits once more */
  onHold?: () => void;
  /** (realtime) they went on after their turn was sent: her answer to it waits, or stops if it began */
  onResumed?: () => void;
  /** they started talking — `sure`: their own words (talk over her at once), else perhaps her echo (turn her down) */
  onSpeech: (sure: boolean) => void;
  /** what seemed like speech wasn't (a blip, her echo): her volume back */
  onSilence: () => void;
  onPartial: (text: string) => void;
  onLevel: (v: number) => void;
  onNotice: (text: string | null) => void;
  /** no way to listen here */
  onFail: (text: string) => void;
  /** what happened to the listening (the call keeps it, for when it didn't hear them: calls.CallService "diag") */
  onDiag?: (ev: string, data?: Record<string, unknown>) => void;
}

export interface ListenDeps {
  mateId: string;
  lang: string | undefined;
  plan: CallPlan["stt"];
  /** she is speaking on the call now */
  speaking: () => boolean;
  /** her voice actually coming out now (or between two of its sentences) — not her first words still being made:
   *  the turn-taking's "her voice" (default: `speaking`) */
  audible?: () => boolean;
  /** what she said lately on the call (the echo filter) */
  spoken: () => string[];
  /** when her voice last played (ms, Date.now; 0: not yet) — now, while it plays */
  voicedAt?: () => number;
  /** how long her current answer has played (ms; 0: not yet) */
  heardMs?: () => number;
  /** her names (called, they stop her) */
  herNames?: string[];
  /** what the microphone hears, for the server's ear (app/mate/ear.py) — given while it is on */
  ear?: (pcm: Int16Array, at: number) => void;
  muted: () => boolean;
  /** (tests) the server, the microphone and the page's recognition, as given */
  io?: Partial<ListenIO>;
}

export interface ListenIO {
  /** `legacy`: Scribe v2 with its own pause, for when Scribe v3 Live can't be had */
  token: (mateId: string, legacy?: boolean) => Promise<RealtimeToken>;
  transcribe: (mateId: string, wav: Blob, engine?: string) => Promise<{ text: string; engine?: string }>;
  openMic: (onFrames: (samples: Float32Array, rate: number) => void) => Promise<MicHandle>;
  webSpeech: () => any;
  newSocket?: RealtimeDeps["newSocket"];
}

const IO: ListenIO = {
  token: (mateId, legacy) => realtimeSttToken(mateId, { call: true, legacy }),
  transcribe: (mateId, wav, engine) => transcribe(mateId, wav, engine),
  openMic: (onFrames) => openMic(onFrames),
  webSpeech: () => webSpeechRecognition(),
};
const ioOf = (d: ListenDeps): ListenIO => ({ ...IO, ...d.io });

export interface Listener {
  mode: string;
  start: () => Promise<void>;
  stop: () => void;
  setMuted: (on: boolean) => void;
  /** an utterance of theirs is being heard now (not a moment to switch the way of listening) */
  busy?: () => boolean;
  /** the server's ear: their voice began / ended at `at` (page ms), `p`: Smart Turn at its end; `null`: the ear is gone */
  heard?: (ev: { on: boolean; at: number; p?: number } | null) => void;
}

const ENGINE: Record<string, string> = { whisper: "Whisper", openai: "OpenAI", elevenlabs: "ElevenLabs", google: "Google" };

/** after her voice stops, what is heard may still be her (the room, the recognizer's lag) */
export const HER_TAIL_MS = 900;

/**
 * Their words of what was heard: all of it, as heard — unless her voice played while they spoke (`overlapped`): her echo
 * is dropped then, and a short word while she is still talking (`voicing`) is them listening, not a turn of theirs.
 */
export function theirs(text: string, spoken: string[], overlapped = true, voicing = false): string {
  const t = text.trim();
  if (!t || !overlapped || !spoken.some(Boolean)) return t;
  const mine = ownWords(t, spoken);
  return mine && (!voicing || meaningful(mine)) ? mine : "";
}

export function listen(d: ListenDeps, cb: ListenCallbacks): Listener {
  const plan = d.plan;
  if (plan.mode === "realtime") return realtimeListener(d, cb);
  if (plan.mode === "record") return recordListener(d, cb, plan.engine, false);
  if (ioOf(d).webSpeech()) return browserListener(d, cb);
  if (plan.fallback) return recordListener(d, cb, plan.fallback, true);
  return {
    mode: "none",
    start: async () => cb.onFail(tr("mate.callNoStt")),
    stop: () => {},
    setMuted: () => {},
  };
}

function micFailure(e: unknown): string {
  const kind = micErrorKind(e);
  return kind === "denied" ? tr("mate.callMicDenied") : kind === "nodevice" ? tr("mate.callNoMic") : tr("mate.noMic", { reason: String((e as Error)?.message || e) });
}

// ── a server engine: voice activity cuts, /transcribe hears ──────────────────────────────────────────────────────────

function recordListener(d: ListenDeps, cb: ListenCallbacks, engine: string, fallback: boolean): Listener {
  const io = ioOf(d);
  let mic: MicHandle | null = null;
  let stopped = false;
  let resampler: Resampler | null = null;
  const framer = new Framer(Math.round((STT_RATE * 30) / 1000));
  const vad = new Vad();
  let chain: Promise<void> = Promise.resolve();
  let herAt = 0; // her voice last heard playing (ms)
  let overlapped = false; // her voice played during the utterance in progress (or just before it)
  const onFrames = (samples: Float32Array, rate: number) => {
    if (stopped) return;
    if (!resampler || resampler.inRate !== rate) resampler = new Resampler(rate, STT_RATE);
    let pcm = resampler.push(samples);
    if (d.muted()) pcm = new Int16Array(pcm.length);
    const now = Date.now();
    const voicing = d.speaking();
    if (voicing) herAt = now;
    vad.guard = voicing;
    if (vad.speaking && voicing) overlapped = true;
    for (const f of framer.push(pcm)) {
      for (const ev of vad.push(f, now)) {
        if (ev.type === "start") {
          overlapped = voicing || now - herAt < HER_TAIL_MS;
          cb.onSpeech(false);
        } else if (ev.type === "drop") cb.onSilence();
        else {
          const wav = new Blob([wavFromPcm(ev.audio, STT_RATE) as BlobPart], { type: "audio/wav" });
          const endAt = ev.at;
          const spoken = d.spoken();
          const heardHer = overlapped || voicing;
          overlapped = false;
          // (one at a time, in order: what they said stays in the order they said it)
          chain = chain.then(async () => {
            try {
              const r = await io.transcribe(d.mateId, wav, fallback ? engine : undefined);
              if (stopped) return;
              const heard = (r.text || "").trim();
              const mine = theirs(heard, spoken, heardHer, d.speaking());
              if (mine) cb.onUtterance(mine, endAt, "record");
              else {
                if (heard) cb.onDiag?.("dropped", { text: heard.slice(0, 80), how: "record" });
                cb.onSilence();
              }
            } catch (e) {
              if (!stopped) {
                cb.onNotice(tr("mate.transcribeFailed", { error: (e as Error).message }));
                cb.onDiag?.("transcribe.error", { error: String((e as Error)?.message || e).slice(0, 120) });
              }
              cb.onSilence();
            }
          });
        }
      }
    }
    cb.onLevel(d.muted() ? 0 : Math.min(1, levelOf(pcm) * 6));
  };
  return {
    mode: "record",
    busy: () => vad.speaking,
    start: async () => {
      if (fallback) cb.onNotice(tr("mate.callSttServer", { engine: ENGINE[engine] ?? engine }));
      cb.onDiag?.("record", { engine });
      try {
        mic = await io.openMic(onFrames);
        if (stopped) mic.close();
        else
          mic.onEnded = () => {
            cb.onDiag?.("mic.ended");
            cb.onFail(tr("mate.micEnded"));
          };
      } catch (e) {
        cb.onDiag?.("mic.error", { error: String((e as Error)?.message || e).slice(0, 120) });
        cb.onFail(micFailure(e));
      }
    },
    stop: () => {
      stopped = true;
      mic?.close();
      mic = null;
    },
    setMuted: () => {},
  };
}

function levelOf(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i += 4) s += pcm[i] * pcm[i];
  return Math.sqrt(s / Math.max(1, pcm.length / 4)) / 0x8000;
}

// ── ElevenLabs realtime ──────────────────────────────────────────────────────────────────────────────────────────

/** a token refused for a moment (their side, the network): asked again after these (ms) before the stream is given up */
export const TOKEN_RETRY_MS = [400, 1200];
/** the stream given up for a recording: tried again after these (ms; the last one repeats) */
export const STREAM_RETRY_MS = [15_000, 45_000, 120_000];
/** codes no retry mends (the key, the credits, none set up, too many sessions in a minute) */
const FINAL: ReadonlySet<string> = new Set(["auth", "quota", "missing", "busy"]);

function realtimeListener(d: ListenDeps, cb: ListenCallbacks): Listener {
  const io = ioOf(d);
  let stopped = false;
  let session: RealtimeStt | null = null;
  let inner: Listener | null = null; // (the stream out: each utterance recorded for the server's engine)
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let tries = 0; // the stream given up this many times in a row
  let herAt = 0;
  let legacy = false; // Scribe v3 Live refused: v2, with its own pause
  let heardOnce = false; // a stream got as far as listening
  let ticker: ReturnType<typeof setTimeout> | undefined;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // whose turn it is: their words say when they have finished (mate/call/turns.ts) — the stream only hears
  const turns = new TurnTaker(
    {
      send: (text, endAt, amend, aside) => cb.onUtterance(text, endAt, "realtime", amend, aside),
      confirm: () => cb.onConfirm?.(),
      hold: () => cb.onHold?.(),
      resumed: () => cb.onResumed?.(),
      barge: () => cb.onSpeech(true),
      // (words of theirs, not a backchannel, while she talks: she softens until it is clear whether they mean it)
      duck: () => cb.onSpeech(false),
      commit: () => session?.commitNow(),
      ignored: (text, why) => cb.onDiag?.("ignored", { text: text.slice(0, 60), why }),
    },
    { herVoice: () => (d.audible ?? d.speaking)(), heardMs: () => d.heardMs?.() ?? 0 },
  );
  turns.herNames = d.herNames ?? [];

  const getToken = async () => {
    for (let i = 0; ; i++) {
      try {
        return await io.token(d.mateId, legacy);
      } catch (e) {
        const te = e instanceof RealtimeTokenError ? new TokenError(e.message, e.code as SttFailure, e.fallback) : new TokenError((e as Error)?.message || String(e), "network", null);
        cb.onDiag?.("token.error", { code: te.code, error: te.message.slice(0, 120), try: i + 1 });
        if (stopped || FINAL.has(te.code) || i >= TOKEN_RETRY_MS.length) throw te;
        await wait(TOKEN_RETRY_MS[i]);
      }
    }
  };

  /** the stream can't be had: each utterance recorded for `engine` (the server's) — or, without one, nothing here */
  const toRecording = (engine: string | null, code: SttFailure, message: string) => {
    if (stopped) return;
    const old = session;
    session = null;
    // (a recording of the stream's own still holds what they were saying: the server's engine hears it, then it closes)
    if (old) setTimeout(() => void (old.state === "recording" ? old.stop() : old.cancel()), 0);
    if (engine && engine !== "browser") inner = recordListener(d, cb, engine, true);
    else if (io.webSpeech()) inner = browserListener(d, cb);
    if (!inner) {
      cb.onDiag?.("deaf", { code, error: message.slice(0, 120) });
      cb.onFail(sttFailureText(code, message));
      return;
    }
    cb.onDiag?.("stream.out", { code, error: message.slice(0, 120), then: inner.mode, engine });
    void inner.start();
    const ms = STREAM_RETRY_MS[Math.min(tries, STREAM_RETRY_MS.length - 1)];
    tries++;
    if (!FINAL.has(code)) retryTimer = setTimeout(retryStream, ms);
  };

  /** the stream again, at a quiet moment (nobody talking): the recording stops once it is back */
  const retryStream = () => {
    retryTimer = undefined;
    if (stopped || session) return;
    if (inner?.busy?.() || d.speaking()) {
      retryTimer = setTimeout(retryStream, 1500);
      return;
    }
    const rec = inner;
    inner = null;
    rec?.stop();
    cb.onDiag?.("stream.retry", { tries });
    void startStream();
  };

  const startStream = (): Promise<void> => {
    const s = new RealtimeStt(
      {
        getToken,
        transcribe: (wav, engine) => io.transcribe(d.mateId, wav, engine),
        // (muted: the stream hears silence — it stays open, so unmuting is instant)
        openMic: (onFrames) => io.openMic((x, rate) => onFrames(d.muted() ? new Float32Array(x.length) : x, rate)),
        newSocket: io.newSocket,
        voicing: d.speaking,
        spoken: d.spoken,
        bargeIn: () => true,
      },
      {
        onState: (st) => {
          if (s !== session) return;
          if (st === "listening") {
            if (tries) cb.onNotice(null);
            tries = 0;
            heardOnce = true;
          }
          if (st === "listening" || st === "reconnecting") cb.onDiag?.("stream." + st);
        },
        onPcm: (pcm, at) => d.ear?.(pcm, at),
        onPartial: (text) => {
          cb.onPartial(text);
          turns.keyterms = s.keyterms;
          turns.partial(text, Date.now());
        },
        onCommitted: (text) => {
          turns.commitSilenceMs = s.commitSilenceMs;
          turns.keyterms = s.keyterms;
          turns.committed(text, Date.now());
        },
        onSegment: (text, how) => {
          if (how === "fallback") {
            // (the stream's own recording, transcribed by the server's engine: nothing filtered it yet)
            const mine = theirs(text, d.spoken(), true, d.speaking());
            if (mine) cb.onUtterance(mine, Date.now(), "record");
          }
          // (realtime: the turn-taking sends the turn — when their words say it is over, not when the stream pauses)
        },
        // (whether they talk over her is the turn-taking's to say: a backchannel isn't)
        onBargeIn: () => {},
        onDropped: (text) => cb.onDiag?.("dropped", { text: text.slice(0, 80), how: "realtime" }),
        onLevel: (v, raw) => {
          const now = Date.now();
          if ((d.audible ?? d.speaking)()) herAt = now;
          turns.level(now - herAt > HER_TAIL_MS ? (raw ?? v) : -1, now);
          cb.onLevel(v);
        },
        onNotice: (n) => {
          if (s !== session) return;
          // (Scribe v3 Live not to be had with this key: v2 then, before a recording)
          if (n.kind === "fallback" && n.code === "input" && !legacy && !heardOnce) {
            legacy = true;
            cb.onDiag?.("stream.legacy", { error: n.reason.slice(0, 120) });
            session = null;
            setTimeout(() => void s.cancel(), 0);
            void startStream();
            return;
          }
          // (the stream went to a recording kept until the end — no good on a call: one per utterance instead)
          if (n.kind === "fallback") toRecording(n.engine, n.code, n.reason);
          else if (n.kind === "reconnected") cb.onNotice(null);
        },
        onError: (code, message, serverFallback) => {
          if (stopped || s !== session) return;
          // (Scribe v3 Live not to be had with this key: v2 then, before anything else)
          if (code === "input" && !legacy && !heardOnce) {
            legacy = true;
            cb.onDiag?.("stream.legacy", { error: message.slice(0, 120) });
            session = null;
            void startStream();
            return;
          }
          if (code === "mic") {
            cb.onDiag?.("mic.error", { error: message.slice(0, 120) });
            session = null;
            return cb.onFail(micFailure(s.micError));
          }
          // (the stream can't be had: a recording for the server's engine, else the browser's recognition)
          const fb = serverFallback && !(serverFallback === "elevenlabs" && FINAL.has(code)) ? serverFallback : d.plan.fallback;
          toRecording(fb && !(fb === "elevenlabs" && FINAL.has(code)) ? fb : null, code, message);
        },
      },
      { idleMs: 0 },
    );
    session = s;
    return s.start();
  };

  return {
    mode: "realtime",
    start: () => {
      // (the turn-taking's clock: a timer chain — never holds a page or a test open)
      const loop = () => {
        if (stopped) return;
        turns.tick(Date.now());
        ticker = setTimeout(loop, 50);
        (ticker as unknown as { unref?: () => void }).unref?.();
      };
      loop();
      return startStream();
    },
    stop: () => {
      stopped = true;
      clearTimeout(ticker);
      clearTimeout(retryTimer);
      session?.cancel();
      session = null;
      inner?.stop();
      inner = null;
    },
    setMuted: (on) => inner?.setMuted(on),
    busy: () => inner?.busy?.() ?? false,
    heard: (ev) => {
      if (ev) turns.heard(ev.on, ev.at, ev.p, Date.now());
      else turns.earGone();
    },
  };
}

// ── the page's own recognition ────────────────────────────────────────────────────────────────────────────────────

const BROWSER_TAIL_MS = 2500;

function browserListener(d: ListenDeps, cb: ListenCallbacks): Listener {
  const SR = ioOf(d).webSpeech()!;
  let r: any = null;
  let stopped = false;
  let muted = d.muted();
  let delivered = 0;
  let restart: ReturnType<typeof setTimeout> | undefined;
  let began = 0;
  let quick = 0; // recognitions in a row that ended at once (no service here): give up after a few
  const begin = () => {
    if (stopped || muted) return;
    began = Date.now();
    r = new SR();
    r.lang = d.lang || "";
    r.interimResults = true;
    r.continuous = true;
    delivered = 0;
    r.onresult = (e: any) => {
      const res = browserResults(e.results, delivered);
      delivered = res.delivered;
      const spoken = d.spoken();
      const voicing = d.speaking();
      // (the recognizer's results lag the voice: her voice a moment ago may be what it heard)
      const overlapped = voicing || Date.now() - (d.voicedAt?.() ?? 0) < BROWSER_TAIL_MS;
      if (res.partial) {
        const mine = theirs(res.partial, spoken, overlapped, voicing);
        cb.onPartial(mine);
        if (mine && voicing && meaningful(mine)) cb.onSpeech(true);
      }
      for (const text of res.finals) {
        cb.onPartial("");
        const mine = theirs(text, spoken, overlapped, voicing);
        if (mine) cb.onUtterance(mine, Date.now(), "browser");
        else {
          cb.onDiag?.("dropped", { text: text.slice(0, 80), how: "browser" });
          cb.onSilence();
        }
      }
    };
    r.onspeechstart = () => cb.onSpeech(false);
    r.onerror = (e: any) => {
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        stopped = true;
        cb.onFail(tr("mate.callMicDenied"));
      }
    };
    // (it stops by itself after a quiet while: a call keeps listening)
    r.onend = () => {
      r = null;
      if (stopped || muted) return;
      quick = Date.now() - began < 1500 ? quick + 1 : 0;
      if (quick >= 4) {
        stopped = true;
        if (d.plan.fallback) {
          const rec = recordListener(d, cb, d.plan.fallback, true);
          inner = rec;
          void rec.start();
        } else cb.onFail(tr("mate.callNoStt"));
        return;
      }
      restart = setTimeout(begin, quick ? 600 * quick : 250);
    };
    try {
      r.start();
    } catch (e) {
      cb.onFail(tr("mate.sttFailed", { reason: (e as Error).message }));
    }
  };
  let inner: Listener | null = null;
  return {
    mode: "browser",
    start: async () => begin(),
    stop: () => {
      stopped = true;
      clearTimeout(restart);
      inner?.stop();
      try {
        r?.abort();
      } catch {
        /* gone */
      }
    },
    setMuted: (on) => {
      muted = on;
      if (on) {
        clearTimeout(restart);
        try {
          r?.abort();
        } catch {
          /* gone */
        }
      } else if (!r) begin();
    },
  };
}
