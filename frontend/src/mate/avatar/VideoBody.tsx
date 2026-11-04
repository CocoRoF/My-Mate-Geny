/**
 * The video body: motion clips by mood, one-shot emotions played whole (ported from ailism-mate `MateBody.tsx`
 * VideoBody). Every clip is fetched once into a Blob URL in the order she needs them (idle first, then talk, think,
 * listen, the reactions), so a switch starts at once. Paused while the tab is hidden or the body is off screen.
 *
 * One player per avatar: MateAvatar keys this component by the rig (and MateStage by the mate), so another mate or
 * another size always gets a fresh player, canvas, videos and Blob URLs — nothing of the previous one is reused.
 *
 * Switching is calm on purpose. Every clip starts and ends on the same home frame, so a switch at the end of a clip
 * is invisible; a switch in the middle used to be a crossfade, i.e. two poses blended with alpha — the "overlapping
 * frames / bad chroma key" look (a see-through sleeve over her dress), and it ran on every thinking ↔ talking flip
 * while a reply streamed. Conversation activity settles for MOOD_SETTLE_MS and only prepares a future clip.
 * The video's own ended event is the only transition clock. Audio state is never read or subscribed to here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BodyMood, MateReact, Rig, RigClip } from "../types";
import { PlainPlayer, StackedPlayer, type ClipPlayer } from "./player";
import { clipFor, clipUrl, enabledClips, moodPool } from "./shared";

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

/** a mood shorter than this never switches a clip */
export const MOOD_SETTLE_MS = 600;

const RANK: Record<string, number> = { idle: 0, talk: 1, think: 2, listen: 3, react: 4, away: 5 };

type State = {
  /** the mood that counts (held for MOOD_SETTLE_MS) */
  mood: BodyMood;
  react: RigClip | null;
  playing: RigClip | null;
  last: string;
  /** the clip loaded ahead for when the one on screen ends (used then if it still suits what she is doing) */
  upcoming: RigClip | null;
};

export default function VideoBody({ rig, size, mood, react, poster, name, onFail }: VideoBodyProps) {
  const wrap = useRef<HTMLDivElement>(null);
  /** changes only prepare the next clip; onEnded is the sole transition clock */
  const changeRef = useRef<(() => void) | null>(null);
  /** a reaction queued for the next natural clip boundary */
  const reactRef = useRef<((c: RigClip) => void) | null>(null);
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const moodRef = useRef(mood);
  moodRef.current = mood;
  /** reactions older than this body belong to the previous mate/avatar */
  const born = useRef(Date.now());
  const [shown, setShown] = useState(false);
  const packing = rig.packing ?? "stacked-alpha";
  const aspectW = rig.aspect?.[0] > 0 ? rig.aspect[0] : 3;
  const aspectH = rig.aspect?.[1] > 0 ? rig.aspect[1] : 4;
  // the same clips coming back as new objects (a refetched mate) must not rebuild the player
  const clipsKey = JSON.stringify(rig.clips);
  const clips = useMemo<RigClip[]>(() => JSON.parse(clipsKey), [clipsKey]);
  const emotionsKey = JSON.stringify(rig.emotions ?? {});
  const emotions = useMemo<Record<string, string[]>>(() => JSON.parse(emotionsKey), [emotionsKey]);
  // clips switched off in the clip editor are never played nor preloaded
  const active = useMemo(() => enabledClips(clips), [clips]);
  // what the next clip should be is read when a clip ends: refs, not state (no re-render per clip)
  const st = useRef<State | null>(null);

  useEffect(() => {
    const box = wrap.current;
    if (!box) return;
    // fresh state for every player: nothing of a previous avatar (its upcoming clip, its reaction) carries over
    const s: State = {
      mood: moodRef.current,
      react: null,
      playing: null,
      last: "",
      upcoming: null,
    };
    st.current = s;
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
        const k = Math.min(bw / aspectW, bh / aspectH);
        frame.style.width = `${Math.round(aspectW * k)}px`;
        frame.style.height = `${Math.round(aspectH * k)}px`;
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
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    let alive = true;
    const memory = new Map<string, string>();
    const srcOf = (c: RigClip) => memory.get(clipUrl(c, size)) ?? clipUrl(c, size);
    void (async () => {
      for (const c of [...active].sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9))) {
        const url = clipUrl(c, size);
        if (!url || memory.has(url) || url.startsWith("blob:")) continue;
        try {
          const res = await fetch(url, { credentials: "include", signal: ctrl?.signal });
          if (!res.ok) continue;
          const blob = await res.blob();
          if (!alive) return;
          memory.set(url, URL.createObjectURL(blob));
        } catch {
          if (!alive) return;
          /* this clip plays from the network */
        }
      }
    })();
    /** the kind of clip a mood plays (breathing when the rig has none of that kind) */
    const wanted = (m: BodyMood) => moodPool(active, m).kind;
    const pickFrom = (list: RigClip[] | undefined) => {
      if (!list?.length) return null;
      const others = list.filter((c) => c.id !== s.last);
      const pool = others.length ? others : list;
      return pool[Math.floor(Math.random() * pool.length)];
    };
    const forMood = (m: BodyMood): RigClip | null => pickFrom(moodPool(active, m).clips);
    const moodNow = (): BodyMood => s.mood;
    /** load what plays when the clip on screen ends (a pending reaction, else a clip for the mood that counts) */
    const prepareNext = () => {
      let c: RigClip | null = s.react;
      if (!c) {
        const m = moodNow();
        c = s.playing?.loop && s.playing.kind === wanted(m) ? s.playing : s.upcoming && s.upcoming.kind === wanted(m) ? s.upcoming : forMood(m);
        s.upcoming = c;
      }
      if (c && c.id !== s.playing?.id) p.prepare(srcOf(c));
    };
    /** put the next clip on after the current clip's natural end */
    const next = () => {
      let c: RigClip | null;
      if (s.react) {
        c = s.react;
        s.react = null;
      } else {
        const m = moodNow();
        c = s.playing?.loop && s.playing.kind === wanted(m) ? s.playing : s.upcoming && s.upcoming.kind === wanted(m) ? s.upcoming : forMood(m);
      }
      s.upcoming = null;
      if (!c) return;
      s.playing = c;
      s.last = c.id;
      // which clip is on (tests, the clip editor's checks); a DOM attribute, not state: no re-render per clip
      box.dataset.mateClip = c.id;
      // Repeat looping clips in this controller at their natural end. No event
      // ever needs to edit the current media element's loop flag to leave one.
      p.show(srcOf(c), { loop: false });
      // have the likely next clip ready, so the switch at the end shows no seam
      const after = c.loop && c.kind === wanted(moodNow()) ? c : forMood(moodNow());
      if (after && after.id !== c.id) {
        s.upcoming = after;
        p.prepare(srcOf(after));
      }
    };
    p.onFirstFrame = () => {
      setShown(true);
    };
    p.onEnded = next;
    changeRef.current = prepareNext;
    reactRef.current = (c) => {
      s.react = c;
      prepareNext();
    };
    next();
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
    return () => {
      alive = false;
      ctrl?.abort();
      io?.disconnect();
      document.removeEventListener("visibilitychange", vis);
      ro?.disconnect();
      p.onEnded = null;
      p.onFirstFrame = null;
      p.dispose();
      el?.remove();
      for (const url of memory.values()) URL.revokeObjectURL(url);
      changeRef.current = null;
      reactRef.current = null;
      if (st.current === s) st.current = null;
      delete box.dataset.mateClip;
      setShown(false);
    };
  }, [active, size, packing, aspectW, aspectH]);

  // Activity changes prepare a future clip. The currently playing clip is never touched.
  useEffect(() => {
    const t = setTimeout(() => {
      const s = st.current;
      if (!s || s.mood === mood) return;
      s.mood = mood;
      changeRef.current?.();
    }, MOOD_SETTLE_MS);
    return () => clearTimeout(t);
  }, [mood]);

  // a reaction plays once, now and whole (only a newer one cuts it)
  const reactAt = react?.at;
  const reactName = react?.name;
  useEffect(() => {
    if (!reactName || !reactAt || reactAt < born.current) return;
    const c = clipFor({ clips, emotions }, reactName);
    if (c) reactRef.current?.(c);
  }, [reactAt, reactName, clips, emotions]);

  return (
    <div
      className="mate-layer"
      ref={wrap}
      role="img"
      aria-label={name}
      data-mate-body="video"
      data-video-mood={mood}
      data-mate-shown={shown ? "1" : "0"}
    >
      {poster && !shown ? <img className="mate-fit" src={poster} alt="" decoding="async" /> : null}
    </div>
  );
}
