/**
 * The Live2D body (lazy chunk: pixi.js 7 + pixi-live2d-display 0.5 cubism4, loaded only when a Live2D mate shows).
 * Ported from Geny `Live2DCanvas.tsx` + `lib/live2d/**` (auto-blink, eye saccade, RMS lip-sync), with:
 *
 * - the Cubism Core loaded from a configurable URL (default `/api/mates/live2d/core.js`), and a clear
 *   "runtime not installed" state when it is missing;
 * - emotions → expression (name or index) and/or motion group; the expression holds ~6 s, then the mood's face;
 * - tap motions by hit area (Id or Name, from `tap_motions`; fixes Geny's hard-coded TapBody);
 * - she looks at the pointer anywhere on the page (on the desktop: the whole screen, desktopCursor.ts), idle saccades
 *   otherwise;
 * - lip-sync from the voice bridge (smoothing 0.3, threshold 0.015, scale 1.8 as in Geny) written to
 *   `ParamMouthOpenY` and the model's LipSync group (e.g. mao_pro's `ParamA`) every frame;
 * - transparent background, resize to the container, paused while hidden, everything destroyed on unmount.
 */
import { followDesktopCursor } from "./desktopCursor";
import { useEffect, useRef, useState } from "react";
import { emotionCandidates, lookupEmotion } from "../emotion";
import type { BodyMood, Live2D, MateReact } from "../types";
import { subscribe as subscribeVoice, voiceBridge } from "../voiceBridge";
import { getLive2DCoreUrl, loadCubismCore, openLive2DSettings, useLive2DCoreInstalls } from "../live2dCore";
import { VIEW_HOME, type AvatarViewT } from "./view";
import { tr, useT } from "../../i18n";

export interface Live2DBodyProps {
  live2d: Live2D;
  mood: BodyMood;
  react: MateReact;
  /** how she feels, as the face she rests on */
  look?: string;
  name: string;
  size?: "lg" | "sm";
  /** Cubism Core script URL (default: setLive2DCoreUrl / `/api/mates/live2d/core.js`) */
  coreUrl?: string;
  /** a tap on the model: the hit area's Id (or Name), null when no area was hit */
  onTap?: (area: string | null) => void;
  /** pointer focus + taps (default true) */
  interactive?: boolean;
  /** the user's pan / zoom (mate/avatar/view.ts), applied in the renderer so the model stays crisp */
  view?: AvatarViewT;
}

type Status = { kind: "loading" } | { kind: "ready" } | { kind: "no-runtime" } | { kind: "error"; message: string };

// pixi-live2d-display's internals we touch, loosely typed (the published types are not precise for cubism4)
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyModel = any;
type AnyApp = any;

const SMOOTHING = 0.3;
const THRESHOLD = 0.015;
const MOUTH_SCALE = 1.8;
const REACT_HOLD_MS = 6000;
const DRAG_PX = 6;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// saccade interval distribution (Geny eyeSaccade.ts, from AIRI eye-motions.ts)
const SACCADE_STEP = 400;
const SACCADE_P: [number, number][] = (() => {
  const p: [number, number][] = [
    [0.075, 800],
    [0.11, 0],
    [0.125, 0],
    [0.14, 0],
    [0.125, 0],
    [0.05, 0],
    [0.04, 0],
    [0.03, 0],
    [0.02, 0],
    [1, 0],
  ];
  for (let i = 1; i < p.length; i++) {
    p[i][0] += p[i - 1][0];
    p[i][1] = p[i - 1][1] + SACCADE_STEP;
  }
  return p;
})();
function saccadeInterval(): number {
  const r = Math.random();
  for (const [p, ms] of SACCADE_P) if (r <= p) return ms + Math.random() * SACCADE_STEP;
  return SACCADE_P[SACCADE_P.length - 1][1] + Math.random() * SACCADE_STEP;
}

export default function Live2DBody({ live2d, mood, react, look, name, coreUrl, onTap, interactive = true, view }: Live2DBodyProps) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const viewRef = useRef<AvatarViewT>(view ?? VIEW_HOME);
  viewRef.current = view ?? VIEW_HOME;
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  // the core was just installed (settings, another window): load now, no reload needed
  const installs = useLive2DCoreInstalls();
  /** set once the model is up: the imperative handles the other effects use */
  const api = useRef<{
    model: AnyModel;
    app: AnyApp;
    priority: { IDLE: number; NORMAL: number; FORCE: number };
    layout: () => void;
  } | null>(null);
  const cfg = useRef(live2d);
  cfg.current = live2d;
  const tapRef = useRef(onTap);
  tapRef.current = onTap;
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const lookRef = useRef(look);
  lookRef.current = look;
  /** the expression the mood asks for is shown after a reaction's hold ends */
  const holdUntil = useRef(0);

  const url = coreUrl ?? getLive2DCoreUrl();
  const hiddenKey = (live2d.hidden_parts ?? []).join("|");
  const idleGroup = live2d.idle_group || "Idle";

  // ── load core + pixi + model ──
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let alive = true;
    let app: AnyApp = null;
    let model: AnyModel = null;
    const cleanups: (() => void)[] = [];
    setStatus({ kind: "loading" });

    void (async () => {
      const ok = await loadCubismCore(url);
      if (!alive) return;
      if (!ok) {
        setStatus({ kind: "no-runtime" });
        return;
      }
      let PIXI: typeof import("pixi.js");
      let L2D: typeof import("pixi-live2d-display/cubism4");
      try {
        PIXI = await import("pixi.js");
        L2D = await import("pixi-live2d-display/cubism4");
      } catch (err) {
        if (alive) setStatus({ kind: "error", message: tr("mate.l2dNoRenderer", { error: String(err) }) });
        return;
      }
      if (!alive) return;
      const { Live2DModel, MotionPriority } = L2D;
      Live2DModel.registerTicker(PIXI.Ticker);
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      try {
        app = new PIXI.Application({
          width: w,
          height: h,
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          // fixed density captured at init (Geny: changing resolution on a live renderer can blank the model)
          resolution: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
          powerPreference: "default",
        });
      } catch (err) {
        if (alive) setStatus({ kind: "error", message: tr("mate.l2dNoWebgl", { error: String(err) }) });
        return;
      }
      const canvas = app.view as HTMLCanvasElement;
      canvas.className = "mate-canvas";
      canvas.style.objectFit = "fill";
      canvas.setAttribute("aria-hidden", "true");
      el.appendChild(canvas);
      try {
        model = await Live2DModel.from(cfg.current.model, {
          autoHitTest: false,
          autoFocus: false,
          idleMotionGroup: idleGroup,
          ticker: app.ticker,
        } as any);
      } catch (err) {
        if (alive) setStatus({ kind: "error", message: tr("mate.l2dNoModel", { error: String((err as Error)?.message ?? err) }) });
        return;
      }
      if (!alive) {
        try {
          model.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      const internal = model.internalModel;
      const core = internal.coreModel;
      model.anchor.set(0.5, 0.5);
      const natW = model.width || 1;
      const natH = model.height || 1;
      const layout = () => {
        if (!app || !model) return;
        const sw = app.screen.width;
        const sh = app.screen.height;
        const c = cfg.current;
        // the view maps a point q of the box to t + z·q (the same as the other bodies' CSS transform)
        const v = viewRef.current;
        model.scale.set(Math.min(sw / natW, sh / natH) * (c.scale ?? 0.85) * v.z);
        model.x = v.x * sw + v.z * (sw / 2 + (c.x ?? 0));
        model.y = v.y * sh + v.z * (sh / 2 + (c.y ?? 0));
      };
      layout();
      app.stage.addChild(model);

      // which parameters exist (writing an unknown id makes the SDK invent one)
      const paramIds: string[] = (() => {
        try {
          return Array.from(core.getModel?.().parameters?.ids ?? core._parameterIds ?? []) as string[];
        } catch {
          return [];
        }
      })();
      const has = (id: string) => !paramIds.length || paramIds.includes(id);
      const lipIds = [...new Set(["ParamMouthOpenY", ...((internal.motionManager?.lipSyncIds as string[]) ?? [])])].filter(has);
      const hiddenIdx: number[] = [];
      for (const id of cfg.current.hidden_parts ?? []) {
        try {
          const i = core.getPartIndex?.(id);
          if (typeof i === "number" && i >= 0) hiddenIdx.push(i);
        } catch {
          /* unknown part */
        }
      }

      // ── per-frame: lip-sync, blink, saccade, hidden parts (after motions/expressions/physics, before drawing) ──
      let smooth = 0;
      let mouth = 0;
      const onLevel = (v: number) => {
        smooth = SMOOTHING * smooth + (1 - SMOOTHING) * v;
        mouth = smooth > THRESHOLD ? Math.min(smooth * MOUTH_SCALE, 1) : 0;
      };
      cleanups.push(
        subscribeVoice((e) => {
          if (e.type === "level") onLevel(e.level);
          else if (e.type === "end") {
            smooth = 0;
            mouth = 0;
          }
        }),
      );
      let shownMouth = 0;
      const blink = { phase: 0 as 0 | 1 | 2, t: 0, wait: 3000 + Math.random() * 5000 };
      let lastNow = performance.now();
      let pointerAt = 0;
      let nextSaccade = 0;
      const eye = { x: 0, y: 0, tx: 0, ty: 0 };
      const beforeUpdate = () => {
        const now = performance.now();
        const dt = Math.min(100, now - lastNow);
        lastNow = now;
        // mouth: a light per-frame ease on top of Geny's 30 Hz mapping, so it never jumps a whole step
        shownMouth += (mouth - shownMouth) * 0.5;
        if (lipIds.length && (shownMouth > 0.001 || voiceBridge.speaking)) {
          for (const id of lipIds) core.setParameterValueById(id, shownMouth);
          if (has("ParamAngleY")) core.addParameterValueById("ParamAngleY", shownMouth * 3);
        }
        // blink: 75 ms close + 75 ms open every 3–8 s, multiplying whatever the motion/expression set
        let f = 1;
        if (blink.phase === 0) {
          blink.wait -= dt;
          if (blink.wait <= 0) {
            blink.phase = 1;
            blink.t = 0;
          }
        } else {
          blink.t += dt;
          const p = clamp01(blink.t / 75);
          if (blink.phase === 1) {
            f = 1 - (1 - (1 - p) * (1 - p));
            if (p >= 1) {
              blink.phase = 2;
              blink.t = 0;
            }
          } else {
            f = p * p;
            if (p >= 1) {
              blink.phase = 0;
              blink.wait = 3000 + Math.random() * 5000;
            }
          }
        }
        if (f < 1) {
          for (const id of ["ParamEyeLOpen", "ParamEyeROpen"]) {
            if (!has(id)) continue;
            core.setParameterValueById(id, clamp01(core.getParameterValueById(id) * f));
          }
        }
        // saccades while the pointer is not leading her eyes
        if (now - pointerAt > 2500) {
          if (now >= nextSaccade) {
            eye.tx = (Math.random() * 2 - 1) * 0.6;
            eye.ty = (Math.random() * 1.7 - 1) * 0.5;
            nextSaccade = now + saccadeInterval();
            internal.focusController?.focus(eye.tx * 0.35, eye.ty * 0.3, false);
          }
          eye.x += (eye.tx - eye.x) * 0.3;
          eye.y += (eye.ty - eye.y) * 0.3;
          if (has("ParamEyeBallX")) core.addParameterValueById("ParamEyeBallX", eye.x * 0.5);
          if (has("ParamEyeBallY")) core.addParameterValueById("ParamEyeBallY", eye.y * 0.5);
        }
        for (const i of hiddenIdx) core.setPartOpacityByIndex?.(i, 0);
      };
      internal.on("beforeModelUpdate", beforeUpdate);
      cleanups.push(() => internal.off?.("beforeModelUpdate", beforeUpdate));

      // ── pointer: she looks at it anywhere on the page (on the desktop: the whole screen, desktopCursor.ts); taps by
      // hit area on her ──
      const toLocal = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect();
        return { x: ((ev.clientX - r.left) / (r.width || 1)) * app.screen.width, y: ((ev.clientY - r.top) / (r.height || 1)) * app.screen.height };
      };
      let down: { x: number; y: number; id: number } | null = null;
      const move = (ev: PointerEvent) => {
        if (!interactive) return;
        const p = toLocal(ev);
        pointerAt = performance.now();
        model.focus(p.x, p.y);
        if (down && down.id === ev.pointerId && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > DRAG_PX) down = null;
      };
      const leave = () => {
        pointerAt = 0;
        internal.focusController?.focus(0, 0, false);
      };
      const unfollow = interactive ? followDesktopCursor() : () => {};
      const pdown = (ev: PointerEvent) => {
        if (!interactive || ev.button > 0) return;
        down = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
      };
      const pup = (ev: PointerEvent) => {
        if (!interactive || !down || down.id !== ev.pointerId) return;
        down = null;
        const p = toLocal(ev);
        const area = hitArea(model, p.x, p.y, PIXI);
        const taps = cfg.current.tap_motions ?? {};
        const motion = (area && (taps[area.id] ?? taps[area.name])) || taps["*"] || null;
        if (motion) void model.motion(motion.group, motion.index, MotionPriority.NORMAL).catch(() => {});
        tapRef.current?.(area ? area.id || area.name : null);
      };
      window.addEventListener("pointermove", move);
      document.addEventListener("pointerleave", leave);
      el.addEventListener("pointerdown", pdown);
      el.addEventListener("pointerup", pup);
      cleanups.push(() => {
        unfollow();
        window.removeEventListener("pointermove", move);
        document.removeEventListener("pointerleave", leave);
        el.removeEventListener("pointerdown", pdown);
        el.removeEventListener("pointerup", pup);
      });

      // ── resize to the container ──
      const ro = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (!app || width < 1 || height < 1) return;
        app.renderer.resize(width, height);
        layout();
      });
      ro.observe(el);
      cleanups.push(() => ro.disconnect());

      // ── asleep while nobody can see it ──
      let hidden = document.hidden;
      let off = false;
      const sync = () => {
        if (hidden || off) app.ticker.stop();
        else app.ticker.start();
      };
      const vis = () => {
        hidden = document.hidden;
        sync();
      };
      document.addEventListener("visibilitychange", vis);
      const io = new IntersectionObserver(([e]) => {
        off = !e.isIntersecting;
        sync();
      });
      io.observe(el);
      cleanups.push(() => {
        document.removeEventListener("visibilitychange", vis);
        io.disconnect();
      });

      api.current = { model, app, priority: MotionPriority as any, layout };
      try {
        await model.motion(idleGroup, undefined, MotionPriority.IDLE);
      } catch {
        /* no idle group */
      }
      if (alive) setStatus({ kind: "ready" });
    })();

    return () => {
      alive = false;
      api.current = null;
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
      if (model) {
        try {
          model.parent?.removeChild(model);
          model.destroy({ children: true, texture: true, baseTexture: true });
        } catch {
          /* ignore */
        }
      }
      if (app) {
        try {
          app.destroy(true, { children: true, texture: true, baseTexture: true });
        } catch {
          /* ignore */
        }
      }
      el.querySelectorAll("canvas").forEach((c) => c.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live2d.model, url, hiddenKey, idleGroup, retry, installs, interactive]);

  // framing changes without a reload
  useEffect(() => {
    api.current?.layout();
  }, [live2d.scale, live2d.x, live2d.y, status.kind, view?.x, view?.y, view?.z]);

  // ── mood face (thinking / away) when no reaction holds ──
  const applyMood = () => {
    const a = api.current;
    if (!a || performance.now() < holdUntil.current) return;
    const m = moodRef.current;
    const name = m === "thinking" ? "thinking" : m === "away" ? "sleepy" : lookRef.current ?? "neutral";
    if (!applyEmotion(a.model, cfg.current, name, a.priority, name !== "neutral")) resetExpression(a.model, cfg.current);
  };
  useEffect(() => {
    if (status.kind === "ready") applyMood();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood, look, status.kind]);

  // ── a one-shot emotion: expression (+ motion), held a while, then back to the mood's face ──
  const reactAt = react?.at;
  const reactName = react?.name;
  useEffect(() => {
    const a = api.current;
    if (!reactName || !a || status.kind !== "ready") return;
    applyEmotion(a.model, cfg.current, reactName, a.priority, true);
    holdUntil.current = performance.now() + REACT_HOLD_MS;
    const t = setTimeout(applyMood, REACT_HOLD_MS + 20);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reactAt, reactName, status.kind]);

  return (
    <div
      ref={box}
      className="mate-layer"
      role="img"
      aria-label={name}
      data-mate-body="live2d"
      data-mate-status={status.kind}
      style={{ touchAction: interactive ? "none" : undefined, cursor: interactive ? "pointer" : undefined }}
    >
      {status.kind === "no-runtime" ? (
        <div className="mate-status" data-testid="mate-live2d-no-runtime">
          <b>{t("mate.l2dNoRuntime")}</b>
          <span>{t("mate.l2dNoRuntimeHint")}</span>
          <span className="mt-1 flex flex-wrap justify-center gap-1.5">
            <button
              type="button"
              className="rounded-md bg-accent/90 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-accent"
              onClick={openLive2DSettings}
              data-testid="mate-live2d-open-settings"
            >
              {t("mate.openLive2DSettings")}
            </button>
            <button
              type="button"
              className="rounded-md border border-border-strong px-2 py-1 text-[11.5px] text-content-dim hover:text-content"
              onClick={() => setRetry((n) => n + 1)}
            >
              {t("common.retry")}
            </button>
          </span>
        </div>
      ) : status.kind === "error" ? (
        <div className="mate-status">
          <b>{t("mate.l2dFailed")}</b>
          <span>{status.message}</span>
        </div>
      ) : null}
    </div>
  );
}

/** expression (name/index) and motion for an emotion; true when the model had something for it */
function applyEmotion(model: AnyModel, c: Live2D, name: string, prio: { NORMAL: number }, withMotion: boolean): boolean {
  let did = false;
  let exp: string | number | undefined = lookupEmotion(c.emotions, name);
  if (exp === undefined) {
    // no mapping: an expression whose own name is the emotion (models often name them "smile", "sad", …)
    const defs: { Name?: string; name?: string }[] = model.internalModel?.motionManager?.expressionManager?.definitions ?? [];
    for (const cand of emotionCandidates(name)) {
      const d = defs.find((x) => (x.Name ?? x.name ?? "").toLowerCase() === cand);
      if (d) {
        exp = d.Name ?? d.name;
        break;
      }
    }
  }
  if (exp !== undefined && exp !== "") {
    void Promise.resolve(model.expression(exp)).catch(() => {});
    did = true;
  }
  const group = withMotion ? lookupEmotion(c.emotion_motions, name) : undefined;
  if (group !== undefined) {
    void Promise.resolve(model.motion(group, undefined, prio.NORMAL)).catch(() => {});
    did = true;
  }
  return did;
}

function resetExpression(model: AnyModel, c: Live2D): void {
  const neutral = lookupEmotion(c.emotions, "neutral");
  if (neutral !== undefined) void Promise.resolve(model.expression(neutral)).catch(() => {});
  else model.internalModel?.motionManager?.expressionManager?.resetExpression?.();
}

/** the hit area under a point (canvas px), by the drawable's bounds in model space */
function hitArea(model: AnyModel, x: number, y: number, PIXI: typeof import("pixi.js")): { id: string; name: string } | null {
  try {
    const internal = model.internalModel;
    const p = model.toModelPosition(new PIXI.Point(x, y));
    const defs: { id: string; name: string; index: number }[] = internal.getHitAreaDefs?.() ?? [];
    for (const d of defs) {
      if (d.index < 0) continue;
      const b = internal.getDrawableBounds(d.index, { x: 0, y: 0, width: 0, height: 0 });
      if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) return { id: d.id, name: d.name };
    }
  } catch {
    /* no hit areas */
  }
  return null;
}
