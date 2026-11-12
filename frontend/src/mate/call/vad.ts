/**
 * Voice activity on a call (docs/mate-calls.md "Listening"): where an utterance starts and ends in the mic's stream, for
 * the speech-to-text engines that transcribe a recording (Whisper, OpenAI, Google, ElevenLabs batch). Pure, frame by frame
 * (test/mate-call.test.ts).
 *
 * - Loudness (RMS, 0..1) against a noise floor that follows the room while nobody talks; speech is `ratio` × above it (and
 *   at least `minRms`), held for `startMs` before it counts — a click, a cough or a car is not speech.
 * - While she speaks (`guard`) it takes more (her voice from the loudspeaker can leak past echo cancellation): `guardRatio`
 *   × louder, for `guardStartMs`.
 * - Speech ends after `endMs` of quiet (a little hysteresis below the start level); shorter than `minSpeechMs` it was a
 *   blip (dropped). A very long run is cut at `maxSpeechMs`.
 * - The audio of an utterance starts `preRollMs` before the start was noticed (the first syllable is never lost).
 */

export interface VadOptions {
  frameMs?: number;
  minRms?: number;
  ratio?: number;
  guardRatio?: number;
  startMs?: number;
  guardStartMs?: number;
  endMs?: number;
  minSpeechMs?: number;
  maxSpeechMs?: number;
  preRollMs?: number;
  /** how fast the noise floor follows the room (0..1 per frame) */
  noiseAdapt?: number;
  /** the first stretch only learns the room (a fan, traffic): nothing in it is speech */
  calibrateMs?: number;
}

export type VadEvent =
  | { type: "start"; at: number }
  | { type: "end"; at: number; startAt: number; speechMs: number; audio: Int16Array[] }
  | { type: "drop"; at: number };

export const VAD_DEFAULTS: Required<VadOptions> = {
  frameMs: 30,
  minRms: 0.012,
  ratio: 3,
  guardRatio: 2.2,
  startMs: 90,
  guardStartMs: 240,
  endMs: 650,
  minSpeechMs: 260,
  maxSpeechMs: 15000,
  preRollMs: 300,
  noiseAdapt: 0.05,
  calibrateMs: 360,
};

export function frameRms(frame: Int16Array): number {
  if (!frame.length) return 0;
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / frame.length) / 0x8000;
}

export class Vad {
  readonly o: Required<VadOptions>;
  /** she is speaking: speech must be clearer */
  guard = false;
  noise: number;
  private speakingNow = false;
  private voicedMs = 0;
  private quietMs = 0;
  private startAt = 0;
  private lastVoiceAt = 0;
  private pre: Int16Array[] = [];
  private audio: Int16Array[] = [];
  private learned = 0; // frames of the room heard so far (calibration)

  constructor(opts: VadOptions = {}) {
    this.o = { ...VAD_DEFAULTS, ...opts };
    this.noise = this.o.minRms / this.o.ratio;
  }

  get speaking(): boolean {
    return this.speakingNow;
  }

  /** the level that counts as speech now */
  threshold(): number {
    const base = Math.max(this.o.minRms, this.noise * this.o.ratio);
    return this.guard ? base * this.o.guardRatio : base;
  }

  reset(): void {
    this.speakingNow = false;
    this.voicedMs = this.quietMs = 0;
    this.pre = [];
    this.audio = [];
  }

  /** one frame (`frameMs` of 16-bit PCM) heard at `at` (ms) → what happened */
  push(frame: Int16Array, at: number, level = frameRms(frame)): VadEvent[] {
    const o = this.o;
    const cap = o.minRms * 2;
    if (this.learned * o.frameMs < o.calibrateMs) {
      // (the room first: its mean loudness is where speech must stand out from)
      this.learned++;
      this.noise = this.learned === 1 ? Math.min(level, cap) : this.noise + (Math.min(level, cap) - this.noise) / this.learned;
      this.pre.push(frame);
      return [];
    }
    const th = this.threshold();
    if (!this.speakingNow) {
      this.pre.push(frame);
      while (this.pre.length * o.frameMs > o.preRollMs + o.guardStartMs) this.pre.shift();
      if (level > th) {
        this.voicedMs += o.frameMs;
        if (this.voicedMs >= (this.guard ? o.guardStartMs : o.startMs)) {
          this.speakingNow = true;
          this.startAt = at - this.voicedMs + o.frameMs;
          this.lastVoiceAt = at;
          this.quietMs = 0;
          const keep = Math.ceil((o.preRollMs + this.voicedMs) / o.frameMs);
          this.audio = this.pre.slice(-keep);
          this.pre = [];
          return [{ type: "start", at: this.startAt }];
        }
      } else {
        this.voicedMs = 0;
        // (the room, while nobody talks)
        this.noise = this.noise * (1 - o.noiseAdapt) + Math.min(level, cap) * o.noiseAdapt;
      }
      return [];
    }
    this.audio.push(frame);
    if (level > th * 0.7) {
      this.lastVoiceAt = at;
      this.quietMs = 0;
    } else this.quietMs += o.frameMs;
    const long = at - this.startAt >= o.maxSpeechMs;
    if (this.quietMs < o.endMs && !long) return [];
    const speechMs = this.lastVoiceAt - this.startAt + o.frameMs;
    // (keep a little of the quiet after the last word, not all of it)
    const tail = Math.max(0, Math.floor((this.quietMs - 200) / o.frameMs));
    const audio = tail ? this.audio.slice(0, this.audio.length - tail) : this.audio;
    const startAt = this.startAt;
    this.reset();
    if (speechMs < o.minSpeechMs) return [{ type: "drop", at }];
    return [{ type: "end", at: this.lastVoiceAt + o.frameMs, startAt, speechMs, audio }];
  }
}

/** cuts a resampled 16 kHz stream into the VAD's frames */
export class Framer {
  readonly size: number;
  private buf: Int16Array;
  private n = 0;
  constructor(size: number) {
    this.size = size;
    this.buf = new Int16Array(size);
  }
  push(pcm: Int16Array): Int16Array[] {
    const out: Int16Array[] = [];
    let i = 0;
    while (i < pcm.length) {
      const take = Math.min(this.size - this.n, pcm.length - i);
      this.buf.set(pcm.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.size) {
        out.push(this.buf);
        this.buf = new Int16Array(this.size);
        this.n = 0;
      }
    }
    return out;
  }
}
