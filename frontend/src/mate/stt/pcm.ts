/**
 * Microphone audio for realtime speech-to-text (docs/mate.md §5): the AudioContext's float samples at the device rate
 * (44.1 / 48 kHz…) → 16 kHz mono 16-bit PCM (what ElevenLabs' `pcm_16000` takes), cut into ~100 ms chunks, base64 for
 * the JSON frames; a WAV of the same PCM for the recording fallback. Pure (tested in test/mate-stt.test.ts).
 */

export const STT_RATE = 16000;
/** one frame to the recognizer: 100 ms (ElevenLabs recommends 0.1 – 1 s; smaller = lower latency) */
export const CHUNK_SAMPLES = STT_RATE / 10;

/** float [-1, 1] → int16 (clamped) */
export function toInt16(x: number): number {
  const s = x > 1 ? 1 : x < -1 ? -1 : x;
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

/**
 * Streaming resampler. Downsampling averages each output sample's span of input (a box filter: the anti-aliasing a
 * voice needs at 3:1, cheap enough for a phone), upsampling interpolates linearly. Pushing a stream in pieces gives
 * the same samples as pushing it whole.
 */
export class Resampler {
  readonly inRate: number;
  readonly outRate: number;
  readonly ratio: number;
  /** where the next output sample starts, in input samples from the start of `carry` */
  private pos = 0;
  private carry: Float32Array = new Float32Array(0);

  constructor(inRate: number, outRate: number = STT_RATE) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error("bad sample rate"); // i18n-ignore (a bug, never shown)
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate;
  }

  push(input: Float32Array): Int16Array {
    const buf = this.carry.length ? concatF32(this.carry, input) : input;
    const r = this.ratio;
    const out: number[] = [];
    let pos = this.pos;
    if (r === 1) {
      for (let i = 0; i < buf.length; i++) out.push(toInt16(buf[i]));
      pos = buf.length;
    } else if (r > 1) {
      while (pos + r <= buf.length) {
        const a = pos;
        const b = pos + r;
        let sum = 0;
        for (let i = Math.floor(a); i < Math.ceil(b); i++) {
          const w = Math.min(b, i + 1) - Math.max(a, i);
          if (w > 0) sum += buf[i] * w;
        }
        out.push(toInt16(sum / r));
        pos = b;
      }
    } else {
      while (pos + 1 < buf.length) {
        const i = Math.floor(pos);
        const f = pos - i;
        out.push(toInt16(buf[i] * (1 - f) + buf[i + 1] * f));
        pos += r;
      }
    }
    const keep = Math.min(Math.floor(pos), buf.length);
    this.carry = buf.slice(keep);
    this.pos = pos - keep;
    return Int16Array.from(out);
  }
}

function concatF32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** gathers PCM into fixed-size chunks (the last, shorter one comes with flush()) */
export class Chunker {
  readonly size: number;
  private buf: Int16Array;
  private n = 0;

  constructor(size: number = CHUNK_SAMPLES) {
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

  flush(): Int16Array | null {
    if (!this.n) return null;
    const out = this.buf.slice(0, this.n);
    this.n = 0;
    return out;
  }
}

/** little-endian int16 PCM → base64 (every platform a browser runs on is little-endian) */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** a mono 16-bit WAV of these PCM chunks (the recording fallback: Whisper / OpenAI / ElevenLabs batch take it) */
export function wavFromPcm(chunks: Int16Array[], rate: number = STT_RATE): Uint8Array {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(44 + samples * 2);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, c[i], true);
  }
  return out;
}

/** loudness of a chunk, 0..1 (RMS) — the level meter */
export function rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / pcm.length) / 0x8000;
}
