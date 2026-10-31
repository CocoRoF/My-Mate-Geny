/** Bits the avatar bodies share: emotion → clip/still lookup, visibility, the level-driven CSS motion. */
import { useEffect, useState, type RefObject } from "react";
import { emotionCandidates } from "../emotion";
import type { Rig, RigClip } from "../types";
import { subscribe as subscribeVoice, voiceBridge } from "../voiceBridge";

export const reducedMotion = (): boolean =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** the react clip for an emotion: the rig's `emotions` map first, then clips whose emotion or id names it */
export function clipFor(rig: Pick<Rig, "clips" | "emotions">, name: string): RigClip | null {
  const names = emotionCandidates(name);
  const reacts = rig.clips.filter((c) => c.kind === "react");
  if (rig.emotions) {
    const keys = Object.keys(rig.emotions);
    for (const n of names) {
      const key = keys.find((k) => k.toLowerCase() === n);
      if (!key) continue;
      for (const id of rig.emotions[key]) {
        const c = rig.clips.find((x) => x.id === id);
        if (c) return c;
      }
    }
  }
  for (const n of names) {
    const c = reacts.find((x) => x.emotion?.toLowerCase() === n || x.id.toLowerCase() === n);
    if (c) return c;
  }
  return null;
}

/** the still for an emotion (a still's name is the emotion word, or one of its aliases) */
export function stillFor(stills: Record<string, string>, name: string): string | null {
  for (const n of emotionCandidates(name)) if (stills[n]) return stills[n];
  return null;
}

/** false while the tab is hidden or the element is scrolled out of view (bodies pause then) */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const [off, setOff] = useState(false);
  useEffect(() => {
    const vis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", vis);
    let io: IntersectionObserver | null = null;
    if (ref.current && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(([e]) => setOff(!e.isIntersecting));
      io.observe(ref.current);
    }
    return () => {
      document.removeEventListener("visibilitychange", vis);
      io?.disconnect();
    };
  }, [ref]);
  return !hidden && !off;
}

/**
 * Writes the voice level (smoothed, ×gain, 0..1) into `--mate-level` on the element, eased per animation frame;
 * nothing runs while silent.
 */
export function useLevelVar(ref: RefObject<HTMLElement | null>, gain = 1.8): void {
  useEffect(() => {
    let target = 0;
    let value = 0;
    let raf = 0;
    const frame = () => {
      value += (target - value) * 0.3;
      if (Math.abs(target - value) < 0.002) value = target;
      ref.current?.style.setProperty("--mate-level", value.toFixed(3));
      raf = value === 0 && target === 0 ? 0 : requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const unsub = subscribeVoice((e) => {
      if (e.type === "level") target = Math.min(1, e.level * gain);
      else if (e.type === "end") target = 0;
      kick();
    });
    if (voiceBridge.speaking) {
      target = Math.min(1, voiceBridge.currentLevel * gain);
      kick();
    }
    return () => {
      unsub();
      cancelAnimationFrame(raf);
    };
  }, [ref, gain]);
}

/** the URL of a clip for a size ("sm" prefers `small`) */
export const clipUrl = (c: RigClip, size: "lg" | "sm"): string => (size === "sm" ? c.small || c.src : c.src || c.small) || "";
