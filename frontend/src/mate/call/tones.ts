/**
 * The sounds of a phone line, made in the page (no audio files): the ring-back while her phone rings (Korean style,
 * 440 + 480 Hz, a second on, two off), her ringtone when she calls, the click of picking up, the beeps of hanging up.
 * `tonePlan` / `schedule` are pure (test/mate-call.test.ts); `Tones` plays them through the page's AudioContext.
 */
import { getAudioContext } from "../voiceBridge";

export type ToneKind = "ringback" | "ringtone" | "connect" | "hangup";

export interface ToneSeg {
  freqs: number[];
  dur: number;
}

export interface TonePlan {
  segs: ToneSeg[];
  /** quiet after the pattern, before it repeats (s) */
  gap: number;
  /** how many times (Infinity: until stopped) */
  times: number;
  gain: number;
  wave: OscillatorType;
}

const N = (f: number, dur: number): ToneSeg => ({ freqs: [f], dur });

export function tonePlan(kind: ToneKind): TonePlan {
  switch (kind) {
    case "ringback":
      return { segs: [{ freqs: [440, 480], dur: 1 }], gap: 2, times: Infinity, gain: 0.09, wave: "sine" };
    case "ringtone":
      // E6 C6 E6 G6 — a short, friendly phrase, then a pause
      return { segs: [N(1318.5, 0.13), N(1046.5, 0.13), N(1318.5, 0.13), N(1568, 0.32)], gap: 1.1, times: Infinity, gain: 0.16, wave: "triangle" };
    case "connect":
      return { segs: [N(1480, 0.045)], gap: 0, times: 1, gain: 0.07, wave: "sine" };
    case "hangup":
      return { segs: [{ freqs: [480, 620], dur: 0.2 }], gap: 0.14, times: 3, gain: 0.08, wave: "sine" };
  }
}

/** one pattern's length (s) */
export const cycleLength = (p: TonePlan) => p.segs.reduce((n, s) => n + s.dur, 0) + p.gap;

/** when each sound of `cycles` repeats starts (s from 0) and how long it lasts */
export function schedule(p: TonePlan, cycles: number): { at: number; dur: number; freqs: number[] }[] {
  const out: { at: number; dur: number; freqs: number[] }[] = [];
  const n = Math.min(cycles, p.times);
  let t = 0;
  for (let c = 0; c < n; c++) {
    for (const s of p.segs) {
      out.push({ at: t, dur: s.dur, freqs: s.freqs });
      t += s.dur;
    }
    t += p.gap;
  }
  return out;
}

const AHEAD_CYCLES = 3;

/** plays the line's sounds; each `play` returns its stop */
export class Tones {
  private stops = new Set<() => void>();

  play(kind: ToneKind, volume = 1): () => void {
    const ctx = getAudioContext();
    if (!ctx) return () => {};
    if (ctx.state !== "running") void ctx.resume().catch(() => {});
    const plan = tonePlan(kind);
    const out = ctx.createGain();
    out.gain.value = plan.gain * Math.max(0, Math.min(1.5, volume));
    out.connect(ctx.destination);
    const nodes: OscillatorNode[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let base = ctx.currentTime + 0.03;
    const queue = () => {
      if (stopped) return;
      const cycles = plan.times === Infinity ? AHEAD_CYCLES : plan.times;
      for (const s of schedule(plan, cycles)) {
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, base + s.at);
        env.gain.linearRampToValueAtTime(1 / s.freqs.length, base + s.at + 0.012);
        env.gain.setValueAtTime(1 / s.freqs.length, base + s.at + Math.max(0.012, s.dur - 0.02));
        env.gain.linearRampToValueAtTime(0, base + s.at + s.dur);
        env.connect(out);
        for (const f of s.freqs) {
          const o = ctx.createOscillator();
          o.type = plan.wave;
          o.frequency.value = f;
          o.connect(env);
          o.start(base + s.at);
          o.stop(base + s.at + s.dur + 0.02);
          nodes.push(o);
        }
      }
      if (plan.times === Infinity) {
        const span = cycleLength(plan) * cycles;
        base += span;
        timer = setTimeout(queue, Math.max(200, (base - ctx.currentTime - span / 2) * 1000));
      }
    };
    queue();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      for (const o of nodes) {
        try {
          o.stop();
        } catch {
          /* already */
        }
      }
      try {
        out.disconnect();
      } catch {
        /* gone */
      }
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    if (plan.times !== Infinity) setTimeout(stop, (cycleLength(plan) * plan.times + 0.2) * 1000);
    return stop;
  }

  stopAll(): void {
    for (const s of [...this.stops]) s();
  }
}

/** her ringing makes the phone vibrate too (where the page may: the Android app) */
export function vibrate(on: boolean): void {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    navigator.vibrate(on ? [700, 500, 700, 1300] : 0);
  } catch {
    /* not here */
  }
}
