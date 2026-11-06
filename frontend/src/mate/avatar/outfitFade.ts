/**
 * A change of clothes dissolves: what she has on fades away, the new set is made ready behind it, then it fades in. Only when
 * the set she wears changes: an edit of the same set, or another mate (a new body altogether), goes straight in.
 */
import { useEffect, useRef, useState } from "react";
import type { Avatar } from "../types";
import { reducedMotion } from "./shared";

/** how long each half takes (mateAvatar.css says the same) */
export const FADE_OUT_MS = 380;
export const FADE_IN_MS = 520;
/** the new picture may take this long to arrive before she comes back anyway (it shows when it comes) */
const READY_AT_MOST_MS = 1500;

export type FadePhase = "idle" | "out" | "in";

const pictureOf = (a: Avatar): string => (a.kind === "video" || a.kind === "photo" ? a.rig.home || a.rig.stills?.neutral || "" : "");

function ready(url: string): Promise<void> {
  if (!url || typeof Image === "undefined") return Promise.resolve();
  const img = new Image();
  img.src = url;
  const loaded = typeof img.decode === "function" ? img.decode().catch(() => {}) : Promise.resolve();
  return Promise.race([loaded, new Promise<void>((r) => setTimeout(r, READY_AT_MOST_MS))]);
}

/** -> the avatar to show now, and which part of the fade it is in */
export function useOutfitFade(worn: string, avatar: Avatar): { shown: Avatar; phase: FadePhase } {
  const [fade, setFade] = useState<{ shown: Avatar; phase: FadePhase } | null>(null);
  const latest = useRef(avatar);
  latest.current = avatar;
  const before = useRef({ worn, avatar });
  // (the set changed in this very render: she stays as she was until the fade has taken over, or the new body would flash)
  const starting = worn !== before.current.worn && !reducedMotion() ? before.current.avatar : null;
  useEffect(() => {
    if (worn === before.current.worn && !fade) before.current.avatar = avatar;
  });
  useEffect(() => {
    const was = before.current;
    if (worn === was.worn) return;
    before.current = { worn, avatar: latest.current };
    if (reducedMotion()) {
      setFade(null);
      return;
    }
    let alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    setFade((f) => ({ shown: f?.shown ?? was.avatar, phase: "out" }));
    const prepared = ready(pictureOf(latest.current));
    timers.push(
      setTimeout(() => {
        void prepared.then(() => {
          if (!alive) return;
          setFade({ shown: latest.current, phase: "in" });
          timers.push(setTimeout(() => alive && setFade(null), FADE_IN_MS));
        });
      }, FADE_OUT_MS),
    );
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
    // (only the set she wears starts one)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worn]);
  return fade ?? (starting ? { shown: starting, phase: "out" } : { shown: avatar, phase: "idle" });
}
