/** Bits the avatar bodies share: emotion → clip/still lookup, visibility, the level-driven CSS motion. */
import { useEffect, useState, type RefObject } from "react";
import { emotionCandidates } from "../emotion";
import type { BodyMood, ClipKind, Rig, RigClip } from "../types";
import { subscribe as subscribeVoice, voiceBridge } from "../voiceBridge";

export const reducedMotion = (): boolean =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** the clips the renderer may play: every clip not switched off in the clip editor */
export const enabledClips = (clips: RigClip[]): RigClip[] => clips.filter((c) => !c.disabled);

/** the clip kind a mood plays */
export const kindOfMood = (m: BodyMood): ClipKind =>
  m === "talking" ? "talk" : m === "thinking" ? "think" : m === "listening" ? "listen" : m === "away" ? "away" : "idle";

/**
 * The clips a mood picks from (at random, not the same one twice in a row when there are others): the enabled clips of
 * its kind, else the idle ones (breathing), else the first enabled clip. The video body and the clip editor's trigger
 * preview both use this, so the preview shows exactly what the stage plays.
 */
export function moodPool(clips: RigClip[], mood: BodyMood, doing?: string): { kind: ClipKind; clips: RigClip[]; fallback: boolean } {
  const on = enabledClips(clips);
  const want = kindOfMood(mood);
  // (idle only: talking and listening go on as ever. Only `life` clips for this activity, and her breathing among them.)
  const busy = want === "idle" && doing ? on.filter((c) => c.kind === "life" && c.doing === doing) : [];
  if (busy.length && doing === "sleep") return { kind: "idle", clips: busy, fallback: false };
  if (busy.length) return { kind: "idle", clips: [...busy, ...busy, ...on.filter((c) => c.kind === "idle")], fallback: false };
  if (want === "idle" && doing === "sleep") {
    const dozing = on.filter((c) => c.kind === "away");
    if (dozing.length) return { kind: "idle", clips: dozing, fallback: false };
  }
  const own = on.filter((c) => c.kind === want);
  if (own.length) return { kind: want, clips: own, fallback: false };
  const idle = on.filter((c) => c.kind === "idle");
  if (idle.length) return { kind: "idle", clips: idle, fallback: want !== "idle" };
  return { kind: want, clips: on.slice(0, 1), fallback: true };
}

export interface EmotionClips {
  /** the clips this emotion plays (one of them, at random); empty: no reaction (she goes on with what she does) */
  clips: RigClip[];
  /** how they were found: the rig's `emotions` map (under `key`), a react clip's emotion / id (`key`), or not at all */
  via: "map" | "name" | "none";
  key: string | null;
}

/**
 * The react clips for an emotion, the way the renderer picks them (disabled clips never count): the rig's `emotions`
 * map first (the emotion, then the words rigs use for it — emotion.ts); a key with an empty list means "no clip for
 * this emotion"; a key whose clips are all disabled is passed over. Then the react clips whose emotion or id names it.
 */
export function clipsFor(rig: Pick<Rig, "clips" | "emotions">, name: string): EmotionClips {
  const names = emotionCandidates(name);
  const on = enabledClips(rig.clips);
  if (rig.emotions) {
    const keys = Object.keys(rig.emotions);
    for (const n of names) {
      const key = keys.find((k) => k.toLowerCase() === n);
      if (key === undefined) continue;
      const ids = rig.emotions[key] ?? [];
      if (!ids.length) return { clips: [], via: "map", key };
      const found = ids.map((id) => on.find((x) => x.id === id)).filter((c): c is RigClip => !!c);
      if (found.length) return { clips: found, via: "map", key };
    }
  }
  const reacts = on.filter((c) => c.kind === "react");
  for (const n of names) {
    const found = reacts.filter((x) => x.emotion?.toLowerCase() === n || x.id.toLowerCase() === n);
    if (found.length) return { clips: found, via: "name", key: n };
  }
  // (sleepy has no reaction of its own in most rigs, but dozing off is one)
  const away = names.includes("sleepy") ? on.filter((c) => c.kind === "away") : [];
  if (away.length) return { clips: away, via: "name", key: "sleepy" };
  return { clips: [], via: "none", key: null };
}

/** the react clip for an emotion (one of clipsFor's, at random), or null */
export function clipFor(rig: Pick<Rig, "clips" | "emotions">, name: string): RigClip | null {
  const { clips } = clipsFor(rig, name);
  return clips.length ? clips[Math.floor(Math.random() * clips.length)] : null;
}

/** stills that make her blink and talk: mechanics, never shown for an emotion */
export const MECHANIC_STILLS = ["blink", "mouth_half", "mouth_open", "mouth_o"];

/**
 * The name of the still shown for an emotion (or the moods "thinking" / "away"): the rig's `emotion_stills` map first
 * (the emotion, then its aliases; "" = none), else the still named like it (or an alias). Null: no still for it.
 */
export function stillNameFor(stills: Record<string, string>, name: string, map?: Record<string, string>): string | null {
  const names = emotionCandidates(name);
  if (map) {
    const keys = Object.keys(map);
    for (const n of names) {
      const key = keys.find((k) => k.toLowerCase() === n);
      if (key === undefined) continue;
      const v = map[key];
      if (v === "") return null;
      if (stills[v] && !MECHANIC_STILLS.includes(v)) return v;
    }
  }
  for (const n of names) if (stills[n] && !MECHANIC_STILLS.includes(n)) return n;
  return null;
}

/** the still for an emotion (see stillNameFor) */
export function stillFor(stills: Record<string, string>, name: string, map?: Record<string, string>): string | null {
  const n = stillNameFor(stills, name, map);
  return n ? stills[n] : null;
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
