/**
 * Listening on a call (docs/mate-calls.md "Listening"): the mic stays open for the whole call and each finished utterance
 * of the user's becomes text. Three ways, as the server's plan says (calls.CallService.plan):
 *
 * - realtime — ElevenLabs Scribe v2 Realtime (mate/stt/realtime.ts) with the call's shorter pause; her echo is filtered by
 *   text, and the user's own words while she speaks are a barge-in at once;
 * - record — a server engine (Whisper, OpenAI, Google, ElevenLabs batch): voice activity (vad.ts) cuts the utterances,
 *   each goes as a WAV to /transcribe; while she speaks the VAD takes clearer speech, and a transcript that is just her
 *   is dropped;
 * - browser — the page's Web Speech recognition (desktop Chrome; the Android WebView has none: the server's engine for a
 *   recording then, if there is one).
 *
 * Nothing works here → `onFail` in words (the call screen says so plainly; she can still be heard). Muted: the mic sends
 * silence (realtime / record) or the recognition stops (browser).
 */
import { realtimeSttToken, RealtimeTokenError, transcribe } from "../../api/mates";
import { sttFailureText } from "../../components/mate/useMic";
import { tr } from "../../i18n";
import { webSpeechRecognition } from "../desktop";
import { browserResults } from "../stt/browser";
import { micErrorKind, openMic, type MicHandle } from "../stt/capture";
import { meaningful, userWords } from "../stt/echo";
import { Resampler, STT_RATE, wavFromPcm } from "../stt/pcm";
import { RealtimeStt, TokenError } from "../stt/realtime";
import type { SttFailure } from "../stt/scribe";
import { Framer, Vad } from "./vad";
import type { CallPlan } from "../../api/calls";

export interface ListenCallbacks {
  /** one finished utterance of theirs (their words only); `endAt`: when they stopped talking (ms, Date.now) */
  onUtterance: (text: string, endAt: number, how: string) => void;
  /** they started talking — `sure`: their own words (talk over her at once), else perhaps her echo (turn her down) */
  onSpeech: (sure: boolean) => void;
  /** what seemed like speech wasn't (a blip, her echo): her volume back */
  onSilence: () => void;
  onPartial: (text: string) => void;
  onLevel: (v: number) => void;
  onNotice: (text: string | null) => void;
  /** no way to listen here */
  onFail: (text: string) => void;
}

export interface ListenDeps {
  mateId: string;
  lang: string | undefined;
  plan: CallPlan["stt"];
  /** she is speaking on the call now */
  speaking: () => boolean;
  /** what she said lately on the call (the echo filter) */
  spoken: () => string[];
  muted: () => boolean;
}

export interface Listener {
  mode: string;
  start: () => Promise<void>;
  stop: () => void;
  setMuted: (on: boolean) => void;
}

const ENGINE: Record<string, string> = { whisper: "Whisper", openai: "OpenAI", elevenlabs: "ElevenLabs", google: "Google" };

/** their words of what was heard (her echo dropped while she spoke) */
function theirs(text: string, spoken: string[]): string {
  const t = text.trim();
  if (!t) return "";
  if (!spoken.length) return t;
  return userWords(t, spoken) || (meaningful(t) && !spoken.some((s) => s && t.includes(s)) ? t : "");
}

export function listen(d: ListenDeps, cb: ListenCallbacks): Listener {
  const plan = d.plan;
  if (plan.mode === "realtime") return realtimeListener(d, cb);
  if (plan.mode === "record") return recordListener(d, cb, plan.engine, false);
  if (webSpeechRecognition()) return browserListener(d, cb);
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
  let mic: MicHandle | null = null;
  let stopped = false;
  let resampler: Resampler | null = null;
  const framer = new Framer(Math.round((STT_RATE * 30) / 1000));
  const vad = new Vad();
  let chain: Promise<void> = Promise.resolve();
  const onFrames = (samples: Float32Array, rate: number) => {
    if (stopped) return;
    if (!resampler || resampler.inRate !== rate) resampler = new Resampler(rate, STT_RATE);
    let pcm = resampler.push(samples);
    if (d.muted()) pcm = new Int16Array(pcm.length);
    const now = Date.now();
    vad.guard = d.speaking();
    for (const f of framer.push(pcm)) {
      for (const ev of vad.push(f, now)) {
        if (ev.type === "start") cb.onSpeech(false);
        else if (ev.type === "drop") cb.onSilence();
        else {
          const wav = new Blob([wavFromPcm(ev.audio, STT_RATE) as BlobPart], { type: "audio/wav" });
          const endAt = ev.at;
          const spoken = d.spoken();
          // (one at a time, in order: what they said stays in the order they said it)
          chain = chain.then(async () => {
            try {
              const r = await transcribe(d.mateId, wav, fallback ? engine : undefined);
              if (stopped) return;
              const mine = theirs(r.text || "", spoken);
              if (mine) cb.onUtterance(mine, endAt, "record");
              else cb.onSilence();
            } catch (e) {
              if (!stopped) cb.onNotice(tr("mate.transcribeFailed", { error: (e as Error).message }));
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
    start: async () => {
      if (fallback) cb.onNotice(tr("mate.callSttServer", { engine: ENGINE[engine] ?? engine }));
      try {
        mic = await openMic(onFrames);
        if (stopped) mic.close();
        else mic.onEnded = () => cb.onFail(tr("mate.micEnded"));
      } catch (e) {
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

function realtimeListener(d: ListenDeps, cb: ListenCallbacks): Listener {
  let lastVoice = 0;
  let stopped = false;
  let inner: Listener | null = null;
  const session = new RealtimeStt(
    {
      getToken: async () => {
        try {
          return await realtimeSttToken(d.mateId, { call: true });
        } catch (e) {
          if (e instanceof RealtimeTokenError) throw new TokenError(e.message, e.code as SttFailure, e.fallback);
          throw e;
        }
      },
      transcribe: (wav, engine) => transcribe(d.mateId, wav, engine),
      // (muted: the stream hears silence — it stays open, so unmuting is instant)
      openMic: (onFrames) => openMic((s, rate) => onFrames(d.muted() ? new Float32Array(s.length) : s, rate)),
      voicing: d.speaking,
      spoken: d.spoken,
      bargeIn: () => true,
    },
    {
      onPartial: (text) => cb.onPartial(text),
      onSegment: (text) => {
        const at = lastVoice && Date.now() - lastVoice < 4000 ? lastVoice : Date.now();
        cb.onUtterance(text, at, "realtime");
      },
      onBargeIn: () => cb.onSpeech(true),
      onLevel: (v) => {
        if (v > 0.04 && !d.speaking()) lastVoice = Date.now();
        cb.onLevel(v);
      },
      onNotice: (n) => {
        if (n.kind === "fallback") cb.onNotice(tr("mate.callSttServer", { engine: ENGINE[n.engine] ?? n.engine }));
        else if (n.kind === "reconnected") cb.onNotice(null);
      },
      onError: (code, message, serverFallback) => {
        if (stopped) return;
        if (code === "mic") return cb.onFail(micFailure(session.micError));
        // (the stream can't be had: a recording for the server's engine, else the browser's recognition)
        const fb = serverFallback && !(serverFallback === "elevenlabs" && (code === "auth" || code === "quota" || code === "missing")) ? serverFallback : d.plan.fallback;
        if (fb && fb !== "elevenlabs") inner = recordListener(d, cb, fb, true);
        else if (webSpeechRecognition()) inner = browserListener(d, cb);
        if (inner) {
          void inner.start();
          return;
        }
        cb.onFail(sttFailureText(code, message));
      },
    },
    { idleMs: 0 },
  );
  return {
    mode: "realtime",
    start: () => session.start(),
    stop: () => {
      stopped = true;
      session.cancel();
      inner?.stop();
    },
    setMuted: (on) => inner?.setMuted(on),
  };
}

// ── the page's own recognition ────────────────────────────────────────────────────────────────────────────────────

function browserListener(d: ListenDeps, cb: ListenCallbacks): Listener {
  const SR = webSpeechRecognition()!;
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
      if (res.partial) {
        const mine = theirs(res.partial, d.speaking() ? spoken : []);
        cb.onPartial(mine);
        if (mine && d.speaking() && meaningful(mine)) cb.onSpeech(true);
      }
      for (const text of res.finals) {
        cb.onPartial("");
        const mine = theirs(text, spoken);
        if (mine) cb.onUtterance(mine, Date.now(), "browser");
        else cb.onSilence();
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
