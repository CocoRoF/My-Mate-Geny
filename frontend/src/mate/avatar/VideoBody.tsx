/**
 * The video body: motion clips by mood, one-shot emotions played whole (ported from ailism-mate `MateBody.tsx`
 * VideoBody). Every clip is fetched once into a Blob URL in the order she needs them (idle first, then talk, think,
 * listen, the reactions), so a switch starts at once. Paused while the tab is hidden or the body is off screen.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BodyMood, MateReact, Rig, RigClip } from "../types";
import { subscribe as subscribeVoice, voiceBridge } from "../voiceBridge";
import { PlainPlayer, StackedPlayer, type ClipPlayer } from "./player";
import { clipFor, clipUrl, useLevelVar } from "./shared";

export interface VideoBodyProps {
  rig: Rig;
  size: "lg" | "sm";
  mood: BodyMood;
  react: MateReact;
  poster: string | null;
  name: string;
  /** the player could not start (no WebGL): the caller shows the still body instead */
  onFail?: () => void;
}

const RANK: Record<string, number> = { idle: 0, talk: 1, think: 2, listen: 3, react: 4, away: 5 };

const kindOf = (m: BodyMood) =>
  m === "talking" ? "talk" : m === "thinking" ? "think" : m === "listening" ? "listen" : m === "away" ? "away" : "idle";

export default function VideoBody({ rig, size, mood, react, poster, name, onFail }: VideoBodyProps) {
  const wrap = useRef<HTMLDivElement>(null);
  /** puts the next clip on (urgent: now, with a short crossfade; otherwise the clip on screen just ended) */
  const nextRef = useRef<((urgent: boolean) => void) | null>(null);
  /** what she does changed (her mood, her voice): the clip for it now, unless a reaction is playing */
  const changeRef = useRef<(() => void) | null>(null);
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const [shown, setShown] = useState(false);
  const packing = rig.packing ?? "stacked-alpha";
  const aspectW = rig.aspect?.[0] > 0 ? rig.aspect[0] : 3;
  const aspectH = rig.aspect?.[1] > 0 ? rig.aspect[1] : 4;
  // the same clips coming back as new objects (a refetched mate) must not rebuild the player
  const clipsKey = JSON.stringify(rig.clips);
  const clips = useMemo<RigClip[]>(() => JSON.parse(clipsKey), [clipsKey]);
  const emotionsKey = JSON.stringify(rig.emotions ?? {});
  const emotions = useMemo<Record<string, string[]>>(() => JSON.parse(emotionsKey), [emotionsKey]);
  const byKind = useMemo(() => {
    const m: Record<string, RigClip[]> = {};
    for (const c of clips) (m[c.kind] ??= []).push(c);
    return m;
  }, [clips]);
  // what the next clip should be is read when a clip ends: refs, not state (no re-render per clip)
  const st = useRef({
    mood,
    voice: !!voiceBridge.speaking,
    react: null as RigClip | null,
    playing: null as RigClip | null,
    last: "",
    /** the clip loaded ahead for when the one on screen ends (used then if it still suits what she is doing) */
    upcoming: null as RigClip | null,
  });

  useLevelVar(wrap);

  useEffect(() => {
    const box = wrap.current;
    if (!box) return;
    let p: ClipPlayer;
    let el: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;
    if (packing === "plain") {
      // a frame exactly the clip's shape (contained, bottom centre), so the rounded corners sit on the picture
      const frame = document.createElement("div");
      frame.className = "mate-plain-frame";
      box.appendChild(frame);
      el = frame;
      const fit = () => {
        const bw = box.clientWidth;
        const bh = box.clientHeight;
        if (!bw || !bh) return;
        const s = Math.min(bw / aspectW, bh / aspectH);
        frame.style.width = `${Math.round(aspectW * s)}px`;
        frame.style.height = `${Math.round(aspectH * s)}px`;
      };
      fit();
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(fit);
        ro.observe(box);
      }
      p = new PlainPlayer(frame);
    } else {
      // a fresh canvas for every player: a WebGL context once released never draws again
      const canvas = document.createElement("canvas");
      canvas.className = "mate-canvas";
      canvas.setAttribute("aria-hidden", "true");
      box.appendChild(canvas);
      el = canvas;
      try {
        p = new StackedPlayer(canvas);
      } catch {
        canvas.remove();
        failRef.current?.();
        return;
      }
    }
    let alive = true;
    const memory = new Map<string, string>();
    const srcOf = (c: RigClip) => memory.get(clipUrl(c, size)) ?? clipUrl(c, size);
    void (async () => {
      for (const c of [...clips].sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9))) {
        const url = clipUrl(c, size);
        if (!url || memory.has(url) || url.startsWith("blob:")) continue;
        try {
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) continue;
          const blob = await res.blob();
          if (!alive) return;
          memory.set(url, URL.createObjectURL(blob));
        } catch {
          /* this clip plays from the network */
        }
      }
    })();
    /** the kind of clip a mood plays (breathing when the rig has none of that kind) */
    const wanted = (m: BodyMood) => (byKind[kindOf(m)]?.length ? kindOf(m) : "idle");
    const pickFrom = (list: RigClip[] | undefined) => {
      if (!list?.length) return null;
      const others = list.filter((c) => c.id !== st.current.last);
      const pool = others.length ? others : list;
      return pool[Math.floor(Math.random() * pool.length)];
    };
    const forMood = (m: BodyMood): RigClip | null => pickFrom(byKind[wanted(m)]) ?? clips[0] ?? null;
    const moodNow = (): BodyMood => (st.current.voice ? "talking" : st.current.mood);
    const next = (urgent: boolean) => {
      const s = st.current;
      let c: RigClip | null;
      if (s.react) {
        c = s.react;
        s.react = null;
      } else {
        const m = moodNow();
        c = s.upcoming && s.upcoming.kind === wanted(m) ? s.upcoming : forMood(m);
      }
      s.upcoming = null;
      if (!c) return;
      s.playing = c;
      s.last = c.id;
      // a clip marked loop (e.g. dozing) loops; so does the only clip of an idle rig
      p.show(srcOf(c), { loop: !!c.loop, fadeMs: urgent ? 200 : 0 });
      // have the likely next clip ready, so the switch at the end shows no seam
      const after = forMood(moodNow());
      if (after && after.id !== c.id) {
        s.upcoming = after;
        p.prepare(srcOf(after));
      }
    };
    /** what she does changed: the clip for it starts now, except over a reaction, which always plays to its end */
    const change = () => {
      if (st.current.playing?.kind === "react") return;
      next(true);
    };
    p.onFirstFrame = () => setShown(true);
    p.onEnded = () => next(false);
    nextRef.current = next;
    changeRef.current = change;
    next(false);
    // asleep when nobody can see it: the tab is hidden or the body is off screen
    let hidden = document.hidden;
    let off = false;
    const sync = () => p.setPaused(hidden || off);
    const vis = () => {
      hidden = document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", vis);
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([e]) => {
            off = !e.isIntersecting;
            sync();
          })
        : null;
    io?.observe(box);
    const unsub = subscribeVoice((e) => {
      const s = st.current;
      if (e.type === "start") {
        s.voice = true;
        if (s.playing?.kind !== "talk") change();
      } else if (e.type === "end") {
        s.voice = false;
      }
    });
    return () => {
      alive = false;
      unsub();
      io?.disconnect();
      document.removeEventListener("visibilitychange", vis);
      ro?.disconnect();
      p.dispose();
      el?.remove();
      for (const url of memory.values()) URL.revokeObjectURL(url);
      nextRef.current = null;
      changeRef.current = null;
      setShown(false);
    };
  }, [byKind, clips, size, packing, aspectW, aspectH]);

  // a new mood: talking, thinking and dozing start now (a short crossfade); the others wait for the clip to end
  useEffect(() => {
    const s = st.current;
    const was = s.mood;
    s.mood = mood;
    if (mood !== was && (mood === "talking" || mood === "thinking" || mood === "away" || s.playing?.kind === "away"))
      changeRef.current?.();
  }, [mood]);

  // a reaction plays once, now and whole (only a newer one cuts it)
  const reactAt = react?.at;
  const reactName = react?.name;
  useEffect(() => {
    if (!reactName) return;
    const c = clipFor({ clips, emotions }, reactName);
    if (!c) return;
    st.current.react = c;
    nextRef.current?.(true);
  }, [reactAt, reactName, clips, emotions]);

  return (
    <div
      className="mate-layer mate-motion"
      ref={wrap}
      role="img"
      aria-label={name}
      data-mate-body="video"
      data-mate-shown={shown ? "1" : "0"}
    >
      {poster && !shown ? <img className="mate-fit" src={poster} alt="" decoding="async" /> : null}
    </div>
  );
}
