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
 * while a reply streamed. Now: a mood has to hold for MOOD_SETTLE_MS before it counts; only talking (or a real voice
 * starting), a reaction, or leaving a looping clip cuts in, and it does so by hurrying the clip on screen to its end
 * (faster playback, ≤ HURRY_S) so the next clip starts on the home frame; everything else waits for the clip on screen
 * to end. A crossfade is only the fallback, at least MIN_FADE_GAP_MS apart.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BodyMood, MateReact, Rig, RigClip } from "../types";
import { subscribe as subscribeVoice, voiceBridge } from "../voiceBridge";
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
/** at most one crossfade per this long */
export const MIN_FADE_GAP_MS = 1200;
/** a clip with less than this left plays to its end (the switch there is seamless) */
const END_SOON_S = 0.6;
/** a clip that has to make way (talking starts, a reaction) finishes within about this long, played faster */
const HURRY_S = 0.8;
const HURRY_MAX_RATE = 4;
const FADE_MS = 220;

const RANK: Record<string, number> = { idle: 0, talk: 1, think: 2, listen: 3, react: 4, away: 5 };

type State = {
  /** the mood that counts (held for MOOD_SETTLE_MS) */
  mood: BodyMood;
  voice: boolean;
  react: RigClip | null;
  playing: RigClip | null;
  last: string;
  /** the clip loaded ahead for when the one on screen ends (used then if it still suits what she is doing) */
  upcoming: RigClip | null;
  lastFade: number;
};

export default function VideoBody({ rig, size, mood, react, poster, name, onFail }: VideoBodyProps) {
  const wrap = useRef<HTMLDivElement>(null);
  /** what she does changed: `now` = the mood that counts asks for a cut, else only get the end-of-clip switch ready */
  const changeRef = useRef<((now: boolean) => void) | null>(null);
  /** a reaction: on now (or at the end of a clip that is about to end) */
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
      voice: !!voiceBridge.speaking,
      react: null,
      playing: null,
      last: "",
      upcoming: null,
      lastFade: 0,
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
    const moodNow = (): BodyMood => (s.voice ? "talking" : s.mood);
    /** the first frame is on the canvas (before that, a switch is instant: nothing to fade from) */
    const shownRef = { current: false };
    /** load what plays when the clip on screen ends (a pending reaction, else a clip for the mood that counts) */
    const prepareNext = () => {
      let c: RigClip | null = s.react;
      if (!c) {
        const m = moodNow();
        c = s.upcoming && s.upcoming.kind === wanted(m) ? s.upcoming : forMood(m);
        s.upcoming = c;
      }
      if (c && c.id !== s.playing?.id) p.prepare(srcOf(c));
    };
    /** put the next clip on (urgent: now, crossfading; otherwise the clip on screen just ended) */
    const next = (urgent: boolean) => {
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
      // which clip is on (tests, the clip editor's checks); a DOM attribute, not state: no re-render per clip
      box.dataset.mateClip = c.id;
      const fade = urgent && shownRef.current;
      if (fade) s.lastFade = performance.now();
      // a clip marked loop (e.g. dozing) loops
      p.show(srcOf(c), { loop: !!c.loop, fadeMs: fade ? FADE_MS : 0 });
      // have the likely next clip ready, so the switch at the end shows no seam
      const after = forMood(moodNow());
      if (after && after.id !== c.id) {
        s.upcoming = after;
        p.prepare(srcOf(after));
      }
    };
    let gapTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * the next clip as soon as possible, without blending two poses: the clip on screen hurries to its end (played
     * faster, ≤ HURRY_S) and the next one starts on the shared home frame. Only when that can't be done (e.g. the
     * player is mid-crossfade) a crossfade, and those at least MIN_FADE_GAP_MS apart.
     */
    const cut = () => {
      if (gapTimer) clearTimeout(gapTimer);
      gapTimer = null;
      prepareNext();
      if (p.remaining() < END_SOON_S || p.hurry(HURRY_S, HURRY_MAX_RATE)) return;
      const since = performance.now() - s.lastFade;
      if (since < MIN_FADE_GAP_MS) {
        gapTimer = setTimeout(() => (s.react ? cut() : change(true)), MIN_FADE_GAP_MS - since);
        return;
      }
      next(true);
    };
    /** what she does changed: a cut when asked for and needed; a reaction always plays to its end */
    const change = (now: boolean) => {
      if (s.playing?.kind === "react" || (s.playing && s.playing.kind === wanted(moodNow()))) return prepareNext();
      if (now) cut();
      else prepareNext();
    };
    p.onFirstFrame = () => {
      shownRef.current = true;
      setShown(true);
    };
    p.onEnded = () => next(false);
    changeRef.current = change;
    reactRef.current = (c) => {
      s.react = c;
      cut();
    };
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
    // a voice actually starting is talking for real: the talk clip now
    const unsub = subscribeVoice((e) => {
      if (e.type === "start") {
        s.voice = true;
        change(true);
      } else if (e.type === "end") {
        s.voice = false;
        change(false);
      }
    });
    return () => {
      alive = false;
      ctrl?.abort();
      if (gapTimer) clearTimeout(gapTimer);
      unsub();
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

  // a new mood counts once it held MOOD_SETTLE_MS: talking cuts in (and so does leaving a looping clip, e.g. waking
  // from a doze); thinking, listening, idle and away wait for the clip on screen to end
  useEffect(() => {
    const t = setTimeout(() => {
      const s = st.current;
      if (!s || s.mood === mood) return;
      s.mood = mood;
      changeRef.current?.(mood === "talking" || !!s.playing?.loop);
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
      data-mate-shown={shown ? "1" : "0"}
    >
      {poster && !shown ? <img className="mate-fit" src={poster} alt="" decoding="async" /> : null}
    </div>
  );
}
