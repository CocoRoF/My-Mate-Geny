/**
 * The video body: motion clips by mood, one-shot emotions played whole (ported from ailism-mate `MateBody.tsx`
 * VideoBody). The clips that play all the time are fetched once into Blob URLs (idle first, then talk, think,
 * listen; the rest load when they come up), so a switch starts at once. Paused while the tab is hidden or the body is off screen.
 *
 * One player per avatar: MateAvatar keys this component by the rig (and MateStage by the mate), so another mate or
 * another size always gets a fresh player, canvas, videos and Blob URLs — nothing of the previous one is reused.
 *
 * Switching is calm on purpose. Every clip starts and ends on the same home frame, so a switch at the end of a clip
 * is invisible; a switch in the middle used to be a crossfade, i.e. two poses blended with alpha — the "overlapping
 * frames / bad chroma key" look (a see-through sleeve over her dress), and it ran on every thinking ↔ talking flip
 * while a reply streamed. Conversation activity settles for MOOD_SETTLE_MS and only prepares a future clip.
 * The video's own ended event is the only transition clock. Audio state is never read or subscribed to here.
 *
 * In step with her other windows (`sync`, mate/avatarSync.ts): the leading window says which clip it starts and when;
 * a following one plays the same clip that far into it — when its own clip ends (it waits up to FOLLOW_HOLD_MS for the
 * leader's next one, then picks its own), or at once (a short dissolve) when the leader went another way. With no leader
 * heard for FOLLOW_FRESH_MS it picks its own clips, as a body alone does.
 *
 * A player that stopped moving (player.ts `onStall`) is made again — at most REBUILDS_PER_MIN times a minute.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BodyMood, MateReact, Rig, RigClip } from "../types";
import { PlainPlayer, StackedPlayer, type ClipPlayer } from "./player";
import { clipFor, clipUrl, enabledClips, faceMix, facesIn, moodPool, pickFace, sameMix, type FaceMix } from "./shared";
import { leaderClip, onClip, tellClip } from "../avatarSync";

export interface VideoBodyProps {
  rig: Rig;
  size: "lg" | "sm";
  mood: BodyMood;
  /** what she is up to in her own day: what she does while nothing else is going on */
  doing?: string;
  react: MateReact;
  /** the face she rests on, from how she feels (mate/stateLook.ts): a rig with mood families stays in that mood (faceFor) */
  look?: string;
  /** how strongly she feels it (0 – 1): a weak feeling plays that mood now and then, a strong one all the time (faceMix);
   *  none: all the time */
  lookLevel?: number;
  poster: string | null;
  name: string;
  /** the player could not start (no WebGL): the caller shows the still body instead */
  onFail?: () => void;
  /** in step with her other windows: whose body this is, and whether this window leads (mate/avatarSync.ts) */
  sync?: { mateId: string; lead: boolean };
}

/** a following body waits this long at the end of a clip for the leader's next one (every clip ends on her home frame:
 *  she stands still meanwhile, nothing jumps) */
export const FOLLOW_HOLD_MS = 2500;
/** the leader's last clip counts this long (a long life clip included); then a follower picks its own */
export const FOLLOW_FRESH_MS = 90_000;
/** a player that stalls is made again at most this often in a minute (a clip that never plays doesn't loop it) */
const REBUILDS_PER_MIN = 3;
/** a player that can't be made again at once (no WebGL: the GPU process restarting) is tried this often, this far apart */
const REMAKE_TRIES = 6;
const REMAKE_WAIT_MS = 1500;

/** a mood shorter than this never switches a clip */
export const MOOD_SETTLE_MS = 600;

/** a clip that starts on its own expression (`fade_in`) comes on with this dissolve from her rest face: a quick change of face */
const FADE_IN_MS = 200;
/** from one face to another at a seam (her rest face into a mood family's, and back): only her face differs, quickly */
const FACE_FADE_MS = 300;
const EAGER = new Set(["idle", "talk", "listen", "think"]);
const RANK: Record<string, number> = { idle: 0, talk: 1, think: 2, listen: 3, react: 4, away: 5, life: 6 };

type State = {
  /** the mood that counts (held for MOOD_SETTLE_MS) */
  mood: BodyMood;
  react: RigClip | null;
  playing: RigClip | null;
  last: string;
  /** the clip loaded ahead for when the one on screen ends (used then if it still suits what she is doing) */
  upcoming: RigClip | null;
  /** the faces she is in (faceMix her look): her mood family by how strongly she feels it, her calm face between */
  mix: FaceMix;
  /** when the clip on screen started (Date.now()) */
  playingAt: number;
  /** following: at a clip's end, waiting for the leader's next */
  holding: ReturnType<typeof setTimeout> | null;
};

export default function VideoBody({ rig, size, mood, doing, react, look, lookLevel, poster, name, onFail, sync }: VideoBodyProps) {
  const wrap = useRef<HTMLDivElement>(null);
  // (whether this window leads may change while the player plays on: read when a clip is chosen)
  const syncRef = useRef(sync);
  syncRef.current = sync;
  /** the player is made again (it stalled) */
  const [gen, setGen] = useState(0);
  const rebuilds = useRef<number[]>([]);
  /** changes only prepare the next clip; onEnded is the sole transition clock */
  const changeRef = useRef<(() => void) | null>(null);
  /** a reaction queued for the next natural clip boundary */
  const reactRef = useRef<((c: RigClip) => void) | null>(null);
  /** the faces she is in changed: what comes next is from them (the clip on screen plays out) */
  const faceRef = useRef<((mix: FaceMix) => void) | null>(null);
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const doingRef = useRef(doing);
  doingRef.current = doing;
  const lookRef = useRef(look);
  lookRef.current = look;
  const levelRef = useRef(lookLevel);
  levelRef.current = lookLevel;
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
      mix: faceMix(active, lookRef.current, levelRef.current),
      playingAt: 0,
      holding: null,
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
        // (made again after its context was lost: the GPU may still be starting up — a moment later, a few times)
        if (gen > 0 && gen <= REMAKE_TRIES) {
          const t = setTimeout(() => setGen((g) => g + 1), REMAKE_WAIT_MS);
          return () => clearTimeout(t);
        }
        failRef.current?.();
        return;
      }
    }
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    let alive = true;
    const memory = new Map<string, string>();
    const srcOf = (c: RigClip) => memory.get(clipUrl(c, size)) ?? clipUrl(c, size);
    const warm = (face: string | undefined) => void (async () => {
      for (const c of [...active].filter((x) => (x.face ?? undefined) === face).sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9))) {
        // (only what plays all the time is kept in memory: a reaction, a long silence or what she does in her day loads when it
        // comes up, while the clip on screen plays out, and the one she is doing now)
        if (!EAGER.has(c.kind) && !(c.kind === "life" && c.doing === doingRef.current)) continue;
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
    for (const face of facesIn(s.mix)) warm(face);
    /** this clip is one of those a mood plays (breathing when the rig has none of that kind), in a face she is in */
    const suits = (c: RigClip | null | undefined, m: BodyMood) =>
      !!c && facesIn(s.mix).some((face) => moodPool(active, m, doingRef.current, face).clips.some((x) => x.id === c.id));
    const pickFrom = (list: RigClip[] | undefined) => {
      if (!list?.length) return null;
      const others = list.filter((c) => c.id !== s.last);
      const pool = others.length ? others : list;
      return pool[Math.floor(Math.random() * pool.length)];
    };
    // (each clip: her mood family as often as she feels it, else her calm face — mixed at random, clip by clip)
    const forMood = (m: BodyMood): RigClip | null => pickFrom(moodPool(active, m, doingRef.current, pickFace(s.mix, Math.random())).clips);
    const moodNow = (): BodyMood => s.mood;
    /** load what plays when the clip on screen ends (a pending reaction, else a clip for the mood that counts) */
    const prepareNext = () => {
      let c: RigClip | null = s.react;
      if (!c) {
        const m = moodNow();
        c = s.playing?.loop && suits(s.playing, m) ? s.playing : suits(s.upcoming, m) ? s.upcoming : forMood(m);
        s.upcoming = c;
      }
      if (c && c.id !== s.playing?.id) p.prepare(srcOf(c));
    };
    /** the leader's clip for her, when this body follows one that is still heard from */
    const following = () => {
      const sy = syncRef.current;
      if (!sy || sy.lead) return null;
      const lc = leaderClip(sy.mateId);
      return lc && Date.now() - lc.at < FOLLOW_FRESH_MS ? lc : null;
    };
    /** play the leader's clip, as far into it as the leader is */
    const follow = (id: string, at: number, fadeMs: number): boolean => {
      const c = active.find((x) => x.id === id);
      if (!c) return false;
      if (s.holding) clearTimeout(s.holding);
      s.holding = null;
      s.react = null;
      s.upcoming = null;
      s.playing = c;
      s.last = c.id;
      s.playingAt = at;
      box.dataset.mateClip = c.id;
      p.show(srcOf(c), { loop: false, fadeMs, alignTo: at });
      return true;
    };
    /** put the next clip on after the current clip's natural end */
    const next = () => {
      const lc = following();
      if (lc) {
        // the leader moved on before this clip ended: its clip now; else wait a moment for its next one
        if (lc.at > s.playingAt && follow(lc.clip, lc.at, 0)) return;
        if (!s.holding)
          s.holding = setTimeout(() => {
            s.holding = null;
            own();
          }, FOLLOW_HOLD_MS);
        return;
      }
      own();
    };
    /** this body's own choice (no leader to follow) */
    const own = () => {
      let c: RigClip | null;
      if (s.react) {
        c = s.react;
        s.react = null;
      } else {
        const m = moodNow();
        c = s.playing?.loop && suits(s.playing, m) ? s.playing : suits(s.upcoming, m) ? s.upcoming : forMood(m);
      }
      s.upcoming = null;
      if (!c) return;
      // (from one face to another — into a mood and out of it — a quick dissolve; a clip that starts on its own face, its own)
      const before = s.playing;
      const fadeMs = !before ? 0 : (before.face ?? "") !== (c.face ?? "") ? FACE_FADE_MS : c.fade_in ? FADE_IN_MS : 0;
      s.playing = c;
      s.last = c.id;
      s.playingAt = Date.now();
      // which clip is on (tests, the clip editor's checks); a DOM attribute, not state: no re-render per clip
      box.dataset.mateClip = c.id;
      // Repeat looping clips in this controller at their natural end. No event
      // ever needs to edit the current media element's loop flag to leave one.
      p.show(srcOf(c), { loop: false, fadeMs });
      // have the likely next clip ready, so the switch at the end shows no seam
      const after = c.loop && suits(c, moodNow()) ? c : forMood(moodNow());
      if (after && after.id !== c.id) {
        s.upcoming = after;
        p.prepare(srcOf(after));
      }
    };
    p.onFirstFrame = () => {
      setShown(true);
    };
    p.onEnded = next;
    // (leading: the other windows play it too — from when it really starts, its load waited for)
    p.onStart = (src) => {
      const sy = syncRef.current;
      const c = s.playing && srcOf(s.playing) === src ? s.playing : active.find((x) => srcOf(x) === src);
      if (!c) return;
      box.dataset.mateClipOn = c.id; // (on screen now — data-mate-clip is the one asked for)
      if (c === s.playing && !following()) s.playingAt = Date.now();
      if (sy?.lead) tellClip(sy.mateId, c.id, Date.now());
    };
    p.onStall = () => {
      const now = Date.now();
      rebuilds.current = rebuilds.current.filter((t) => now - t < 60_000);
      if (rebuilds.current.length >= REBUILDS_PER_MIN) return;
      rebuilds.current.push(now);
      setGen((g) => g + 1);
    };
    // following: the leader started another clip — the same here (at once when it went another way)
    const offClip = onClip((mid, id, at) => {
      const sy = syncRef.current;
      if (!sy || sy.lead || mid !== sy.mateId) return;
      if (s.holding) follow(id, at, 0);
      else if (s.playing?.id !== id) follow(id, at, FACE_FADE_MS);
    });
    changeRef.current = prepareNext;
    reactRef.current = (c) => {
      s.react = c;
      prepareNext();
    };
    faceRef.current = (mix) => {
      if (sameMix(mix, s.mix)) return;
      s.mix = mix;
      for (const face of facesIn(mix)) warm(face);
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
      offClip();
      if (s.holding) clearTimeout(s.holding);
      ctrl?.abort();
      io?.disconnect();
      document.removeEventListener("visibilitychange", vis);
      ro?.disconnect();
      p.onEnded = null;
      p.onFirstFrame = null;
      p.onStall = null;
      p.onStart = null;
      p.dispose();
      el?.remove();
      for (const url of memory.values()) URL.revokeObjectURL(url);
      changeRef.current = null;
      reactRef.current = null;
      faceRef.current = null;
      if (st.current === s) st.current = null;
      delete box.dataset.mateClip;
      delete box.dataset.mateClipOn;
      setShown(false);
    };
  }, [active, size, packing, aspectW, aspectH, gen]);

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
  // (what she is doing only decides what comes next: a clip is never cut short for it)
  useEffect(() => {
    changeRef.current?.();
  }, [doing]);
  // how she feels holds her face: a mood family while she feels it (as much as she feels it), her rest face when it passes
  useEffect(() => {
    faceRef.current?.(faceMix(active, look, lookLevel));
  }, [look, lookLevel, active]);

  // a reaction plays once, now and whole (only a newer one cuts it)
  const reactAt = react?.at;
  const reactName = react?.name;
  useEffect(() => {
    if (!reactName || !reactAt || reactAt < born.current) return;
    const c = clipFor({ clips, emotions }, reactName);
    // (in a mood only a reaction of a face she is in plays: a laugh between two sulks would be a mood swing, not her)
    const mix = st.current?.mix;
    if (c && (!mix?.face || facesIn(mix).includes(c.face ?? undefined))) reactRef.current?.(c);
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
      data-mate-lead={sync ? (sync.lead ? "1" : "0") : undefined}
    >
      {poster && !shown ? <img className="mate-fit" src={poster} alt="" decoding="async" /> : null}
    </div>
  );
}
