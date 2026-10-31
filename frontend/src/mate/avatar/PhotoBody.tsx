/**
 * The photo body (ported from ailism-mate `MateBody.tsx` StillBody): whole-figure stills over the home picture —
 * a blink every 2.5–6 s, mouth stills (mouth_half / mouth_open / mouth_o) driven by the voice level instead of a
 * random timer, emotion stills for `react` (≈2.6 s) and for the thinking / away moods.
 *
 * Without blink/mouth stills (a single photo), the picture breathes and sways gently and pulses with the level.
 */
import { useEffect, useRef, useState } from "react";
import type { BodyMood, MateReact } from "../types";
import { subscribe as subscribeVoice, voiceBridge } from "../voiceBridge";
import { stillFor, useLevelVar } from "./shared";

export interface PhotoBodyProps {
  stills: Record<string, string>;
  /** emotion / mood -> still name ("" = none): the clip editor's choices (Rig.emotion_stills) */
  emotionStills?: Record<string, string>;
  home: string;
  mood: BodyMood;
  react: MateReact;
  name: string;
}

/** mouth index: 0 half, 1 open, 2 "o", -1 closed */
type Mouth = -1 | 0 | 1 | 2;

const REACT_MS = 2600;

export default function PhotoBody(props: PhotoBodyProps) {
  const { stills } = props;
  const single = !stills.blink && !stills.mouth_half && !stills.mouth_open && !stills.mouth_o;
  return single ? <SinglePhoto {...props} /> : <StillBody {...props} />;
}

function SinglePhoto({ stills, emotionStills, home, mood, react, name }: PhotoBodyProps) {
  const pulse = useRef<HTMLDivElement>(null);
  useLevelVar(pulse, 1.8);
  const [over, setOver] = useState(0);
  const reactAt = react?.at ?? 0;
  useEffect(() => {
    if (!reactAt) return;
    const t = setTimeout(() => setOver(reactAt), REACT_MS);
    return () => clearTimeout(t);
  }, [reactAt]);
  const feeling = react && react.at > over ? stillFor(stills, react.name, emotionStills) : null;
  const face = mood === "thinking" ? stillFor(stills, "thinking", emotionStills) : mood === "away" ? stillFor(stills, "sleepy", emotionStills) : null;
  const src = feeling ?? face ?? home;
  return (
    <div className="mate-layer mate-breathe" data-mate-body="photo-single">
      <div className="mate-layer mate-pulse" ref={pulse}>
        <img className="mate-fit" src={src} alt={name} decoding="async" draggable={false} />
      </div>
    </div>
  );
}

function StillBody({ stills, emotionStills, home, mood, react, name }: PhotoBodyProps) {
  const [blink, setBlink] = useState(false);
  const [mouth, setMouth] = useState<Mouth>(-1);
  const [voice, setVoice] = useState(() => !!voiceBridge.speaking);
  // the reaction shows until this moment has passed (set by a timer, so nothing is set while rendering)
  const [over, setOver] = useState(0);

  // the voice level opens the mouth: smoothed like Geny's lip-sync (0.3), ×1.8, with a little hysteresis
  useEffect(() => {
    let smooth = 0;
    let peak = 0.15;
    let shown: Mouth = -1;
    let since = 0;
    const set = (m: Mouth) => {
      const now = performance.now();
      if (m === shown || now - since < 70) return;
      shown = m;
      since = now;
      setMouth(m);
    };
    return subscribeVoice((e) => {
      if (e.type === "start") {
        setVoice(true);
      } else if (e.type === "end") {
        setVoice(false);
        smooth = 0;
        shown = -1;
        setMouth(-1);
      } else if (e.type === "level") {
        smooth = 0.3 * smooth + 0.7 * e.level;
        const v = Math.min(1, smooth * 1.8);
        // relative to the recent peak too: an analyser's smoothed level rarely drops to zero between syllables,
        // so absolute thresholds alone would leave the mouth wide open for a whole sentence
        peak = Math.max(v, peak * 0.995, 0.15);
        const n = v / peak;
        if (v < 0.08 || n < 0.5) set(-1);
        else if (n < 0.78) set(0);
        else if (shown === 1 || shown === 2) set(shown);
        else set(Math.random() < 0.3 ? 2 : 1);
      }
    });
  }, []);

  const reactAt = react?.at ?? 0;
  useEffect(() => {
    if (!reactAt) return;
    const t = setTimeout(() => setOver(reactAt), REACT_MS);
    return () => clearTimeout(t);
  }, [reactAt]);

  // blink now and then
  useEffect(() => {
    if (!stills.blink) return;
    let t: ReturnType<typeof setTimeout>;
    let u: ReturnType<typeof setTimeout>;
    const loop = () => {
      t = setTimeout(() => {
        setBlink(true);
        u = setTimeout(() => setBlink(false), 130);
        loop();
      }, 2500 + Math.random() * 3500);
    };
    loop();
    return () => {
      clearTimeout(t);
      clearTimeout(u);
    };
  }, [stills.blink]);

  // talking without a voice (a reply streaming in as text): the mouth moves on a timer, as in ailism-mate
  const [timerMouth, setTimerMouth] = useState(0);
  const textTalking = mood === "talking" && !voice;
  useEffect(() => {
    if (!textTalking) return;
    const t = setInterval(() => setTimerMouth((m) => (m + 1 + Math.floor(Math.random() * 2)) % 4), 140);
    return () => clearInterval(t);
  }, [textTalking]);

  // every picture is ready before it is needed (a swap never shows an empty frame)
  useEffect(() => {
    for (const src of Object.values(stills)) {
      const im = new Image();
      im.decoding = "async";
      im.src = src;
    }
  }, [stills]);

  const mouths = [stills.mouth_half, stills.mouth_open, stills.mouth_o];
  const pickMouth = (i: number): string | null => {
    if (i < 0 || i > 2) return null;
    return mouths[i] ?? mouths[1] ?? mouths[0] ?? mouths[2] ?? null;
  };
  const feeling = react && react.at > over ? stillFor(stills, react.name, emotionStills) : null;
  const face = mood === "thinking" ? stillFor(stills, "thinking", emotionStills) : mood === "away" ? stillFor(stills, "sleepy", emotionStills) : null;
  const mouthShown = voice ? pickMouth(mouth) : textTalking ? pickMouth(timerMouth === 3 ? -1 : timerMouth) : null;
  const shown = feeling ?? mouthShown ?? face ?? (blink ? stills.blink : null);
  // a feeling or a face fades in; a blink and talking mouths switch at once
  const quick = !feeling && !face && (!!mouthShown || blink);
  // each picture is the whole of her (a face composite): it replaces the base
  return (
    <div className={quick ? "mate-layer mate-still quick" : "mate-layer mate-still"} data-mate-body="photo" data-mate-mouth={mouthShown ? "open" : "closed"}>
      <img
        className={shown ? "mate-fit mate-still-base off" : "mate-fit mate-still-base"}
        src={home}
        alt={name}
        decoding="async"
        draggable={false}
      />
      {shown ? (
        <img key={shown} className="mate-fit mate-still-face" src={shown} alt="" decoding="async" draggable={false} />
      ) : null}
    </div>
  );
}
