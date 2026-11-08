/**
 * The LivLiv body (lazy chunk: @livliv-dev/player, WebGL2, loaded only when a LivLiv mate shows). A 2.5D character in layers
 * that moves by itself (breathing, blinking, glances, hair that swings), moved by her conversation:
 *
 * - an emotion → the model's expression: the user's choice (`livliv.emotions`), else a standard id of that name or a near one
 *   (smile, shy, angry, sad, surprised, laugh… mean the same on every LivLiv model; mate/emotion.ts), held a while, then back to
 *   the face she rests on (`look`); what has no face gets a move: agree → a nod, greet → a hop, thinking → a tilt, shy → shy;
 * - her mood: away → she dozes (setAway), thinking → she looks up and aside;
 * - her voice (voice bridge) → the mouth: loudness → mouthOpen, the characters being said → round (ㅗ ㅜ o u) or wide (ㅣ ㅔ i e)
 *   shapes where the model has them;
 * - a tap → the swinging pieces near it are thrown (poke), and onTap;
 * - the mark a package asks for is drawn by the player itself: it is part of the package's licence, never hidden here.
 *
 * One player per canvas, released on unmount (a page has room for about 16 WebGL contexts); a lost context gets a new canvas.
 */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Player, type ActionId } from "@livliv-dev/player";
import type { BodyMood, LivLiv, MateReact } from "../types";
import { subscribe as subscribeVoice, type VoiceMark } from "../voiceBridge";
import { expressionFor, vowelOf } from "./livliv";
import { viewTransform, type AvatarViewT } from "./view";
import { useT } from "../../i18n";

export interface LivLivBodyProps {
  livliv: LivLiv;
  mood: BodyMood;
  react: MateReact;
  /** how she feels, as the face she rests on */
  look?: string;
  name: string;
  size?: "lg" | "sm";
  onTap?: (area: string | null) => void;
  /** pointer follow + taps (default true) */
  interactive?: boolean;
  view?: AvatarViewT;
}

type Status = { kind: "loading" } | { kind: "ready" } | { kind: "empty" } | { kind: "no-webgl" } | { kind: "error"; message: string };

const REACT_HOLD_MS = 6000;
// the voice bridge's level is the analyser's RMS (speech mostly 0.1–0.4): the Live2D body's mapping (Geny)
const SMOOTHING = 0.3;
const THRESHOLD = 0.015;
const MOUTH_SCALE = 1.8;
/** what has no face of its own gets a move */
const MOVES: Partial<Record<string, ActionId>> = { agree: "nod", greet: "hop", thinking: "tilt", shy: "shy" };

export default function LivLivBody({ livliv, mood, react, look, name, size = "lg", onTap, interactive = true, view }: LivLivBodyProps) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);
  const [status, setStatus] = useState<Status>(livliv.model ? { kind: "loading" } : { kind: "empty" });
  /** a lost WebGL context: a new canvas */
  const [canvasKey, setCanvasKey] = useState(0);
  /** the expression she shows now (null: none), as the page can read it */
  const [face, setFace] = useState<string | null>(null);
  const holdUntil = useRef(0);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const lookRef = useRef(look);
  lookRef.current = look;
  const lvRef = useRef(livliv);
  lvRef.current = livliv;

  // ── the player: one per canvas, the model loaded, the voice → mouth, released on unmount ──
  useEffect(() => {
    const el = box.current;
    if (!el || !livliv.model) {
      setStatus({ kind: "empty" });
      return;
    }
    if (!Player.isSupported()) {
      setStatus({ kind: "no-webgl" });
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.className = "mate-canvas";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.setAttribute("aria-hidden", "true");
    el.prepend(canvas);
    let p: Player;
    try {
      p = new Player(canvas, {
        followPointer: interactive && livliv.follow !== "off" ? "canvas" : false,
        maxPixelRatio: size === "sm" ? 1.5 : 2,
      });
    } catch (e) {
      canvas.remove();
      setStatus({ kind: "error", message: (e as Error).message });
      return;
    }
    player.current = p;
    let alive = true;
    p.onContextLost = () => {
      if (!alive) return;
      // (a phone reclaiming memory, a driver restart: a new canvas when someone is there to see it)
      const again = () => setCanvasKey((n) => n + 1);
      if (document.hidden) document.addEventListener("visibilitychange", again, { once: true });
      else again();
    };
    setStatus({ kind: "loading" });
    p.load(livliv.model, { poster: livliv.cover || undefined })
      .then(() => {
        if (alive) setStatus({ kind: "ready" });
      })
      .catch((e: Error) => {
        if (alive && e.name !== "AbortError") setStatus({ kind: "error", message: e.message });
      });

    // her voice → the mouth (loudness) and its shape (the character being said, from the marks)
    let smooth = 0;
    let target = 0;
    let shown = 0;
    let vowel = 0;
    let marks: VoiceMark[] = [];
    let startedAt = 0;
    const off = subscribeVoice((e) => {
      if (e.type === "start") {
        startedAt = performance.now();
        marks = [];
      } else if (e.type === "marks") marks = e.marks;
      else if (e.type === "level") {
        smooth = SMOOTHING * smooth + (1 - SMOOTHING) * e.level;
        target = smooth > THRESHOLD ? Math.min(smooth * MOUTH_SCALE, 1) : 0;
      } else if (e.type === "end") {
        smooth = 0;
        target = 0;
        marks = [];
      }
    });
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      shown += (target - shown) * 0.5;
      let want = 0;
      if (marks.length && shown > 0.05) {
        const at = (performance.now() - startedAt) / 1000;
        let i = marks.length - 1;
        while (i > 0 && marks[i].t > at) i--;
        want = vowelOf(marks[i].char);
      }
      vowel += (want - vowel) * 0.35;
      p.params.mouthOpen = shown < 0.01 ? 0 : shown;
      p.params.vowel = vowel;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      off();
      player.current = null;
      p.dispose({ release: true });
      canvas.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livliv.model, livliv.cover, livliv.follow, interactive, size, canvasKey]);

  // ── the face she rests on (and dozing, thinking) when no reaction holds ──
  const restFace = () => {
    const p = player.current;
    if (!p || status.kind !== "ready" || performance.now() < holdUntil.current) return;
    const m = moodRef.current;
    p.setAway(m === "away");
    p.lookAt(m === "thinking" ? 0.35 : null, m === "thinking" ? 0.45 : undefined);
    const have = p.expressions.map((e) => e.id);
    const rest = lookRef.current && lookRef.current !== "neutral" ? expressionFor(lvRef.current, have, lookRef.current) : null;
    p.setExpression(rest);
    setFace(rest);
  };
  useEffect(() => {
    restFace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood, look, status.kind, livliv.emotions]);

  // ── a one-shot emotion: its expression (and a move), held a while, then back to the face she rests on ──
  const reactAt = react?.at;
  const reactName = react?.name;
  useEffect(() => {
    const p = player.current;
    if (!reactName || !p || status.kind !== "ready" || moodRef.current === "away") return;
    const have = p.expressions.map((e) => e.id);
    const shown = reactName === "neutral" ? null : expressionFor(lvRef.current, have, reactName);
    if (shown && p.setExpression(shown)) setFace(shown);
    const move = MOVES[reactName];
    if (move) p.act(move);
    if (!shown && !move) return;
    holdUntil.current = performance.now() + REACT_HOLD_MS;
    const timer = setTimeout(restFace, REACT_HOLD_MS + 20);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reactAt, reactName, status.kind]);

  const tap = (e: MouseEvent) => {
    const p = player.current;
    if (!p || !interactive || status.kind !== "ready") return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    try {
      const [mx, my] = p.canvasToModel(e.clientX - r.left, e.clientY - r.top);
      p.poke(mx, my);
    } catch {
      /* before the first frame */
    }
    onTap?.(null);
  };

  return (
    <div
      ref={box}
      className="mate-layer"
      role="img"
      aria-label={name}
      data-mate-body="livliv"
      data-mate-status={status.kind}
      data-mate-face={face ?? ""}
      style={{ transform: view && viewTransform(view), transformOrigin: "0 0", cursor: interactive ? "pointer" : undefined }}
      onClick={tap}
    >
      {status.kind === "empty" ? (
        <div className="mate-status" data-testid="mate-livliv-empty">
          <b>{t("mate.lvEmpty")}</b>
          <span>{t("mate.lvEmptyHint")}</span>
        </div>
      ) : status.kind === "no-webgl" ? (
        livliv.cover ? (
          <img src={livliv.cover} alt={name} className="h-full w-full object-contain" draggable={false} />
        ) : (
          <div className="mate-status">
            <b>{t("mate.lvNoWebgl")}</b>
          </div>
        )
      ) : status.kind === "error" ? (
        <div className="mate-status" data-testid="mate-livliv-error">
          <b>{t("mate.lvFailed")}</b>
          <span>{status.message}</span>
        </div>
      ) : null}
    </div>
  );
}
