/**
 * The Mate Create studio's canvas (docs/avatar-create.md §11 "The canvas"): the making of a mate as a graph — who she
 * is → what she will look like and what it costs → the design candidates → the base picture every clip starts from →
 * the sets (faces, idle, talk, reactions, away) and every picture and clip of each, made at the same time → the
 * checks → the mate. It pans and zooms (useCanvas); a click on a node or a tile opens its sheet (NodeSheet) — the
 * same settings and controls the studio always had, one node at a time. What the agent does lands where it belongs:
 * a node it is writing glows, words it wrote type themselves in, a picture being drawn is blurred until it develops,
 * the lines run while something flows along them, and what waits for the user (an estimate, a pick, an approval) is
 * marked and brought into view. No graph library: the nodes are plain elements in a CSS grid, the lines one SVG
 * measured from them (graph.ts linesOf), so words of any length just fit.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AvatarProject } from "../../../../api/avatar";
import { prefsOf, type Mate } from "../../../../api/mates";
import { MateAvatar } from "../../../../mate/avatar/MateAvatar";
import { useT, type MsgKey } from "../../../../i18n";
import Icon from "../../../ui/Icon";
import { swatchesOf } from "../fields";
import {
  candidatesOf,
  checksOf,
  fileLinesOf,
  going,
  homeState,
  linesOf,
  rowsOf,
  SETS,
  waitingFor,
  type Box,
  type InputKey,
  type Line,
  type NodeKey,
  type Row,
  type SetKey,
  type SlotState,
  type Tile,
} from "./graph";
import { useCanvas } from "./useCanvas";
import "./canvas.css";

const LIT_MS = 2600;
/** a message by a key put together at run time, or the fallback when there is none (an id the catalog doesn't know) */
export const labelOr = (t: ReturnType<typeof useT>, key: string, fallback: string) => {
  const v = t(key as MsgKey);
  return v === key ? fallback : v;
};
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : Number(n.toFixed(1)).toLocaleString());

export interface CanvasActivity {
  /** nodes the agent's running tools work on */
  working: Set<NodeKey>;
  /** the agent is thinking (a turn with no tool going) */
  thinking: boolean;
}

export interface StudioCanvasProps {
  project: AvatarProject;
  mate: Mate;
  /** a new mate still being made (else: an existing mate's avatar, or an outfit) */
  creating: boolean;
  activity: CanvasActivity;
  /** the node or tile whose sheet is open */
  open: string | null;
  busy: boolean;
  onOpen: (key: string) => void;
  /** approve the base picture / the faces at their checkpoint, right on the canvas */
  onApprove: () => void;
  /** Create mate (a new one, when nothing is missing) */
  onCreate?: () => void;
  /** her look comes from a file the user has (a Live2D model, …): the file and her emotions matched to it, nothing drawn */
  fileMode?: boolean;
}

// ── words that land ──

/** text that types itself in when it changes while lit, else just shows */
function Reveal({ text, lit }: { text: string; lit: boolean }) {
  const [shown, setShown] = useState(text);
  const last = useRef(text);
  useEffect(() => {
    if (last.current === text) return;
    const from = last.current;
    last.current = text;
    if (!lit || reduced()) {
      setShown(text);
      return;
    }
    let same = 0;
    while (same < from.length && same < text.length && from[same] === text[same]) same++;
    const start = performance.now();
    const span = Math.min(1100, 240 + (text.length - same) * 16);
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / span);
      setShown(text.slice(0, same + Math.ceil((text.length - same) * k)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, lit]);
  return <span className={shown !== text ? "sc-typing" : undefined}>{shown}</span>;
}

/** which keys changed a moment ago (their signatures differ from the last ones seen) */
function useLit(sig: Record<string, string>): Record<string, boolean> {
  const [lit, setLit] = useState<Record<string, boolean>>({});
  const prev = useRef<Record<string, string> | null>(null);
  const timers = useRef(new Map<string, number>());
  const key = JSON.stringify(sig);
  useEffect(() => {
    const before = prev.current;
    prev.current = sig;
    if (!before) return;
    const changed = Object.keys(sig).filter((k) => before[k] !== undefined && before[k] !== sig[k]);
    if (!changed.length) return;
    setLit((l) => ({ ...l, ...Object.fromEntries(changed.map((k) => [k, true])) }));
    for (const k of changed) {
      window.clearTimeout(timers.current.get(k));
      timers.current.set(
        k,
        window.setTimeout(() => {
          timers.current.delete(k);
          setLit((l) => {
            const rest = { ...l };
            delete rest[k];
            return rest;
          });
        }, LIT_MS),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((id) => window.clearTimeout(id));
  }, []);
  return lit;
}

// ── pieces ──

function Node({ g, title, side, sideTone, onOpen, working, lit, wait, off, open, className, children }: {
  g: string;
  title: string;
  side?: ReactNode;
  sideTone?: "ok" | "warn" | "accent";
  onOpen?: () => void;
  working?: boolean;
  lit?: boolean;
  wait?: boolean;
  off?: boolean;
  open?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const cls = ["scn", working && "is-working", lit && !working && "is-lit", wait && "is-wait", off && "is-off", open && "is-open", className].filter(Boolean).join(" ");
  return (
    <article data-g={g} className={cls} data-testid={`sc-node-${g}`}>
      {onOpen ? <button type="button" className="scn-hit" onClick={onOpen} aria-label={title} /> : null}
      <header className="scn-h">
        <b>{title}</b>
        {side !== undefined && side !== null && side !== "" ? <span className={`scn-side${sideTone ? ` is-${sideTone}` : ""}`}>{side}</span> : null}
      </header>
      {children}
    </article>
  );
}

function Row({ k, v, lit, empty }: { k: string; v: string; lit: boolean; empty: string }) {
  return (
    <div className="scn-row">
      <span className="scn-k">{k}</span>
      <span className={v ? "scn-v" : "scn-v is-empty"}>{v ? <Reveal text={v} lit={lit} /> : empty}</span>
    </div>
  );
}

/** one picture or clip of a set: blurred while it is made, developing when it lands; a clip plays while hovered */
const TileView = memo(function TileView({ t, lit, open, onOpen }: { t: Tile; lit: boolean; open: boolean; onOpen: () => void }) {
  const tr = useT();
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const label = labelOr(tr, t.kind === "still" ? `studio.still_${t.id}` : `studio.clip_${t.id}`, t.id);
  const bad = t.state === "done" && t.check && !t.check.missing && t.check.ok === false;
  const status =
    t.state === "done" ? (bad ? tr("studio.cvCheckRedo") : tr("studio.cvDone")) : t.state === "queued" ? tr("studio.cvQueued") : t.state === "running" ? tr("studio.cvMaking") : t.state === "processing" ? tr("studio.cvProcessing") : t.state === "failed" ? tr("studio.cvFailed") : tr("studio.cvPlanned");
  const play = (on: boolean) => {
    const v = video.current;
    if (!v) return;
    if (on) {
      v.currentTime = 0;
      void v.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      v.pause();
      setPlaying(false);
    }
  };
  return (
    <button
      type="button"
      data-g={`tile:${t.key}`}
      className={`sct is-${t.state}${bad ? " is-checkbad" : ""}${lit && t.state === "done" ? " is-new" : ""}${playing ? " is-playing" : ""}${open ? " is-open" : ""}`}
      onClick={onOpen}
      onMouseEnter={() => t.video && play(true)}
      onMouseLeave={() => t.video && play(false)}
      onFocus={() => t.video && play(true)}
      onBlur={() => t.video && play(false)}
      aria-label={`${label} · ${status}`}
      data-testid={`sc-tile-${t.key}`}
      data-state={t.state}
    >
      <span className="sct-pic">
        {t.src ? <img src={t.src} alt="" draggable={false} loading="lazy" /> : null}
        {t.video ? <video ref={video} src={t.video} muted loop playsInline preload="none" /> : null}
        {t.video && !playing && t.state === "done" ? (
          <span className="sct-play" aria-hidden>
            <Icon name="play" size={8} />
          </span>
        ) : null}
        {bad ? <span className="sct-badge">{tr("studio.cvRedoBadge")}</span> : null}
        {t.state === "running" || t.state === "processing" ? <i className="sct-sweep" /> : null}
      </span>
      <span className="sct-l">
        <b>{label}</b>
        <i>{status}</i>
      </span>
    </button>
  );
});

function Zoom({ onFit, onZoom }: { onFit: () => void; onZoom: (k: number) => void }) {
  const t = useT();
  return (
    <div className="sc-zoom" data-nodrag data-testid="sc-zoom">
      <button type="button" onClick={() => onZoom(1 / 1.2)} aria-label={t("studio.cvZoomOut")}>
        −
      </button>
      <button type="button" onClick={onFit} data-testid="sc-fit">
        {t("studio.cvFit")}
      </button>
      <button type="button" onClick={() => onZoom(1.2)} aria-label={t("studio.cvZoomIn")}>
        +
      </button>
    </div>
  );
}

const SET_TITLE: Record<SetKey, MsgKey> = { faces: "studio.setFaces", idle: "studio.setIdle", talk: "studio.setTalk", react: "studio.setReact", away: "studio.setAway" };
const SET_WHEN: Record<SetKey, MsgKey> = { faces: "studio.setFacesWhen", idle: "studio.setIdleWhen", talk: "studio.setTalkWhen", react: "studio.setReactWhen", away: "studio.setAwayWhen" };
const SET_RULE: Record<SetKey, MsgKey> = { faces: "studio.setFacesRule", idle: "studio.setIdleRule", talk: "studio.setTalkRule", react: "studio.setReactRule", away: "studio.setAwayRule" };

/** the voice's engine and voice in a few words */
export function voiceLine(m: Mate, t: ReturnType<typeof useT>): string {
  const v = m.voice.tts;
  if (!v.engine || v.engine === "off") return t("studio.cvVoiceOff");
  if (v.engine === "browser") return t("studio.cvVoiceBrowser");
  const who = v.voice?.startsWith("builtin:") ? v.voice.slice(8) : v.voice || v.profile || "";
  return [labelOr(t, `studio.engine_${v.engine}`, v.engine), who].filter(Boolean).join(" · ");
}

// ── the canvas ──

export default function StudioCanvas({ project: p, mate, creating, activity, open, busy, onOpen, onApprove, onCreate, fileMode = false }: StudioCanvasProps) {
  const t = useT();
  const view = useCanvas();
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [worldH, setWorldH] = useState(0);
  const studio = p.studio;
  const outfit = !!p.outfit;
  const skipped = !!studio?.avatar_skipped;
  const rows = useMemo(() => rowsOf(p), [p]);
  const shownRows: Row[] = rows.length ? rows : SETS.map((key) => ({ key, tiles: [] }));
  const cands = useMemo(() => candidatesOf(p), [p]);
  const home = homeState(p);
  const wait = waitingFor(p);
  const checks = checksOf(p);
  const concept = studio?.concept ?? {};
  const prefs = prefsOf(mate);
  const plan = p.plan;
  const confirmed = !!p.confirmation;

  // what changed a moment ago glows (the agent wrote it, or it landed)
  const sig = useMemo(() => {
    const s: Record<string, string> = {
      concept: JSON.stringify(concept),
      profile: [mate.name, mate.persona.personality, mate.persona.greeting, mate.persona.description].join("|"),
      style: [prefs.formality, prefs.speech_style, prefs.address, mate.persona.language].join("|"),
      temperament: JSON.stringify(prefs.temperament ?? null),
      import: JSON.stringify(mate.avatar.kind === "live2d" ? [mate.avatar.live2d.model, mate.avatar.live2d.scale, mate.avatar.live2d.x, mate.avatar.live2d.y] : mate.avatar.kind),
      motions: JSON.stringify(mate.avatar.kind === "live2d" ? [mate.avatar.live2d.emotions, mate.avatar.live2d.emotion_motions] : mate.avatar.kind === "livliv" ? mate.avatar.livliv.emotions : null),
      refs: p.files.refs.map((r) => r.name).join("|") + p.brief.reference.mode,
      voice: voiceLine(mate, t),
      model: `${mate.llm.provider}/${mate.llm.model}`,
      brief: [p.brief.design.prompt, p.brief.preset, p.brief.tier, p.brief.aspect, p.brief.clips.length, p.brief.stills.length].join("|"),
      estimate: `${plan?.id ?? ""}|${p.confirmation?.plan_id ?? ""}`,
      candidates: cands.map((c) => c.state + c.picked).join(","),
      home: `${home}|${p.files.home ?? ""}`,
      check: JSON.stringify(checks ?? {}),
      mate: `${p.status}|${p.preview ? 1 : 0}`,
    };
    for (const r of rows) for (const tl of r.tiles) s[tl.key] = tl.state;
    return s;
  }, [concept, mate, prefs, p, plan, cands, home, checks, rows, t]);
  const lit = useLit(sig);

  // ── measuring: every node and tile, in world units ──
  const measure = useCallback(() => {
    const w = view.world.current;
    if (!w) return;
    const z = view.scale() || 1;
    const wr = w.getBoundingClientRect();
    const out: Record<string, Box> = {};
    w.querySelectorAll<HTMLElement>("[data-g]").forEach((el) => {
      const r = el.getBoundingClientRect();
      out[el.dataset.g!] = { x: (r.left - wr.left) / z, y: (r.top - wr.top) / z, w: r.width / z, h: r.height / z };
    });
    setBoxes((old) => (JSON.stringify(old) === JSON.stringify(out) ? old : out));
    setWorldH(w.offsetHeight);
  }, [view]);
  useLayoutEffect(() => {
    const w = view.world.current;
    if (!w) return;
    let raf = 0;
    const again = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    again();
    const ro = new ResizeObserver(again);
    w.querySelectorAll("[data-g]").forEach((el) => ro.observe(el));
    ro.observe(w);
    const imgs = [...w.querySelectorAll("img")];
    imgs.forEach((i) => i.addEventListener("load", again));
    void document.fonts?.ready.then(again);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      imgs.forEach((i) => i.removeEventListener("load", again));
    };
  }, [p, mate, rows, cands, measure, view, fileMode]);

  const direct: InputKey[] = outfit ? [] : ["profile", "style", "temperament", "voice", "model"];
  const av = mate.avatar;
  const fileHas = av.kind === "live2d" || av.kind === "livliv" || ((av.kind === "video" || av.kind === "photo") && !!av.rig.home);
  const fileMap = av.kind === "live2d" ? { ...(av.live2d.emotions ?? {}), ...(av.live2d.emotion_motions ?? {}) } : av.kind === "livliv" ? av.livliv.emotions ?? {} : {};
  const fileMapped = Object.values(fileMap).filter((v) => v !== "" && v !== undefined).length;
  const lines: Line[] = useMemo(
    () =>
      fileMode ? fileLinesOf(boxes, { worldH, has: fileHas, mapped: fileMapped > 0, direct }) :
      linesOf(boxes, shownRows, {
        worldH,
        looks: { concept: !!(concept.look || concept.style || concept.pitch), refs: p.files.refs.length > 0 },
        briefReady: !!p.brief.design.prompt || p.brief.clips.length > 0,
        estimate: confirmed ? "confirmed" : plan ? "waiting" : "none",
        candidates: cands.some((c) => going(c.state)) ? "busy" : cands.some((c) => c.state === "done") ? "done" : "empty",
        home,
        ready: p.status === "ready" || p.status === "applied",
        direct,
        hasCheck: !!checks,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boxes, shownRows, worldH, concept, p, confirmed, plan, cands, home, checks, outfit, fileMode, fileHas, fileMapped],
  );

  // ── the camera follows what matters: what waits for the user, else what the agent works on, else what is drawn ──
  const target = useMemo(() => {
    if (fileMode) return fileHas ? null : "import";
    if (wait === "estimate" || wait === "extra" || wait === "cap") return "estimate";
    if (wait === "pick") return "candidates";
    if (wait === "home") return "home";
    if (wait === "stills") return "set:faces";
    const w = [...activity.working][0];
    if (w) return w;
    const running = rows.flatMap((r) => r.tiles).find((tl) => tl.state === "running");
    if (running) return `tile:${running.key}`;
    if (cands.some((c) => c.state === "running")) return "candidates";
    if (home === "running") return "home";
    // all made: the mate at the end, playing
    if (p.status === "ready" || p.status === "applied") return "mate";
    return null;
  }, [wait, activity.working, rows, cands, home, p.status, fileMode, fileHas]);
  useEffect(() => {
    if (!target) return;
    const id = window.setTimeout(() => view.focus(target), 120);
    return () => window.clearTimeout(id);
  }, [target, view]);

  const empty = t("studio.cvEmpty");
  const work = (k: NodeKey) => activity.working.has(k);
  const isOpen = (k: string) => open === k;
  const nRows = shownRows.length;
  const span = { gridRow: `2 / span ${nRows}` };

  // the required fields, the faces and clips, counted for the check node
  const missing = studio?.missing ?? [];
  const needs = creating ? 2 : 0;
  const tiles = rows.flatMap((r) => r.tiles);
  const facesDone = tiles.filter((x) => x.kind === "still" && x.state === "done").length;
  const faces = tiles.filter((x) => x.kind === "still").length;
  const clipsDone = tiles.filter((x) => x.kind === "clip" && x.state === "done").length;
  const clips = tiles.filter((x) => x.kind === "clip").length;
  const ready = p.status === "ready" || p.status === "applied";
  const hasAvatar = mate.avatar.kind !== "none";
  const avatar = ready && p.preview ? p.preview : hasAvatar ? mate.avatar : null;

  const candTitle = p.brief.reference.mode === "as_base" ? t("studio.cvBaseFromRef") : t("studio.cvCandidates");
  const picked = cands.find((c) => c.picked);

  return (
    <div className="relative min-h-0 min-w-0 flex-1" data-testid="studio-canvas">
      <div ref={view.canvas} className="sc-canvas" tabIndex={0} aria-label={t("studio.cvLabel")}>
        <div ref={view.world} className={`sc-world${fileMode ? " is-file" : ""}`}>
          <svg className="sc-lines" aria-hidden="true">
            {lines.map((l) => (
              <path key={l.id} d={l.d} className={`scl scl-${l.tone}${l.flow ? " is-flow" : ""}${l.thick ? " is-thick" : ""}`} />
            ))}
          </svg>

          {/* the column heads */}
          {(fileMode ? (["cvColInput", "cvColFile", "cvColMap", "cvColDone"] as const) : (["cvColInput", "cvColLook", "cvColBase", "cvColSets", "cvColMake", "cvColCheck", "cvColDone"] as const)).map((k, i) => (
            <div key={k} className="sc-col-h" style={{ gridColumn: i + 1 }}>
              <b>{t(`studio.${k}` as MsgKey)}</b>
              <small>{t(`studio.${k}Sub` as MsgKey)}</small>
            </div>
          ))}

          {/* 1 · who she is */}
          <div className="sc-stack" style={{ gridColumn: 1, ...span }}>
            {outfit ? (
              <Node g="outfit" title={t("studio.cvOutfit")} onOpen={() => onOpen("brief")}>
                <p className="scn-text">{p.outfit?.name || empty}</p>
                <p className="scn-note">{t("studio.cvOutfitNote")}</p>
              </Node>
            ) : (
              <>
                <Node g="concept" title={t("studio.secConcept")} onOpen={() => onOpen("concept")} working={work("concept")} lit={lit.concept} open={isOpen("concept")}>
                  <Row k={t("studio.cvPitch")} v={concept.pitch ?? ""} lit={!!lit.concept} empty={empty} />
                  <Row k={t("studio.cvStyleLook")} v={[concept.style, concept.mood].filter(Boolean).join(" · ")} lit={!!lit.concept} empty={empty} />
                  {swatchesOf(concept.palette ?? "").length > 0 && (
                    <div className="scn-swatches" aria-hidden>
                      {swatchesOf(concept.palette ?? "").map((c) => (
                        <i key={c} style={{ background: c }} />
                      ))}
                    </div>
                  )}
                </Node>
                <Node g="profile" title={t("studio.gProfile")} onOpen={() => onOpen("profile")} working={work("profile")} lit={lit.profile} open={isOpen("profile")}>
                  <Row k={t("studio.cvName")} v={mate.name} lit={!!lit.profile} empty={empty} />
                  <Row k={t("studio.cvPersonality")} v={mate.persona.personality} lit={!!lit.profile} empty={empty} />
                </Node>
                <Node g="style" title={t("studio.secStyle")} onOpen={() => onOpen("style")} working={work("style")} lit={lit.style} open={isOpen("style")}>
                  <Row k={t("studio.cvFormality")} v={t(`studio.formality_${prefs.formality}` as MsgKey)} lit={!!lit.style} empty={empty} />
                  <Row k={t("studio.cvHabits")} v={prefs.speech_style} lit={!!lit.style} empty={empty} />
                </Node>
                <Node g="temperament" title={t("studio.secTemperament")} onOpen={() => onOpen("temperament")} lit={lit.temperament} open={isOpen("temperament")}>
                  <p className="scn-text">{prefs.temperament ? t("studio.gTemperamentOwn") : t("studio.gTemperamentAuto")}</p>
                </Node>
              </>
            )}
            {!fileMode && <Node g="refs" title={t("studio.cvRefs")} side={p.files.refs.length ? String(p.files.refs.length) : undefined} onOpen={() => onOpen("refs")} working={work("refs")} lit={lit.refs} open={isOpen("refs")}>
              {p.files.refs.length ? (
                <div className="scn-cands">
                  {p.files.refs.slice(0, 4).map((r) => (
                    <span key={r.name} className="scn-cand">
                      <img src={r.url} alt="" draggable={false} />
                    </span>
                  ))}
                </div>
              ) : (
                <p className="scn-text is-empty">{t("studio.cvRefsEmpty")}</p>
              )}
              {p.brief.reference.mode !== "none" && <p className="scn-note">{t(`studio.cvRefMode_${p.brief.reference.mode}` as MsgKey)}</p>}
            </Node>}
            {!outfit && (
              <>
                <Node g="voice" title={t("studio.secVoice")} side={studio?.voice_ok ? <Icon name="check" size={11} /> : undefined} sideTone="ok" onOpen={() => onOpen("voice")} working={work("voice")} lit={lit.voice} open={isOpen("voice")}>
                  <p className="scn-text">{voiceLine(mate, t)}</p>
                </Node>
                <Node g="model" title={t("studio.secModel")} onOpen={() => onOpen("model")} working={work("model")} lit={lit.model} open={isOpen("model")}>
                  <p className="scn-text">{mate.llm.model || empty}</p>
                </Node>
              </>
            )}
          </div>

          {fileMode ? (
            <>
              {/* 2 · the file she comes from */}
              <div className="sc-cell" style={{ gridColumn: 2, ...span }}>
                <Node g="import" title={t("studio.cvFile")} side={fileHas ? <Icon name="check" size={11} /> : undefined} sideTone="ok" onOpen={() => onOpen("import")} lit={lit.import} open={isOpen("import")} wait={!fileHas}>
                  {fileHas ? (
                    <>
                      <p className="scn-text">{t(av.kind === "live2d" ? "studio.fileKindLive2d" : av.kind === "livliv" ? "studio.fileKindLivliv" : av.kind === "video" ? "studio.fileKindVideo" : "studio.fileKindPhoto")}</p>
                      {av.kind === "live2d" && <p className="scn-note">{decodeURIComponent(av.live2d.model.split("/").pop() || "")}</p>}
                    </>
                  ) : (
                    <>
                      <p className="scn-text is-empty">{t("studio.cvFileEmpty")}</p>
                      <div className="scn-act">
                        <button type="button" className="scn-btn is-primary" onClick={() => onOpen("import")} data-testid="sc-file-open">
                          <Icon name="upload" size={11} /> {t("studio.gFileUploadOpen")}
                        </button>
                      </div>
                    </>
                  )}
                </Node>
              </div>
              {/* 3 · her emotions → its expressions and motions */}
              <div className="sc-cell" style={{ gridColumn: 3, ...span }}>
                <Node g="motions" title={t("studio.cvMap")} side={fileMapped ? String(fileMapped) : undefined} sideTone="ok" onOpen={() => onOpen("motions")} working={work("motions")} lit={lit.motions} open={isOpen("motions")} off={!fileHas || (av.kind !== "live2d" && av.kind !== "livliv")}>
                  {av.kind === "live2d" || av.kind === "livliv" ? (
                    fileMapped ? (
                      <div className="scn-chips">
                        {Object.entries(av.kind === "live2d" ? av.live2d.emotions ?? {} : av.livliv.emotions ?? {})
                          .filter(([, v]) => v !== "")
                          .slice(0, 6)
                          .map(([e]) => (
                            <span key={e}>{labelOr(t, `mate.emotion_${e}`, e)}</span>
                          ))}
                      </div>
                    ) : (
                      <p className="scn-text is-empty">{t("studio.cvMapEmpty")}</p>
                    )
                  ) : (
                    <p className="scn-text is-empty">{fileHas ? t("studio.cvMapClips") : t("studio.cvMapLater")}</p>
                  )}
                </Node>
              </div>
            </>
          ) : (
            <>
          {/* 2 · what she will look like, and what it costs */}
              <div className="sc-stack" style={{ gridColumn: 2, ...span }}>
                <Node g="brief" title={t("studio.cvBrief")} onOpen={() => onOpen("brief")} working={work("brief")} lit={lit.brief} open={isOpen("brief")} off={skipped}>
                  <p className={`scn-text${p.brief.design.prompt || concept.look ? "" : " is-empty"}`}>
                    <Reveal text={p.brief.design.prompt || concept.look || t("studio.cvBriefEmpty")} lit={!!lit.brief} />
                  </p>
                  {(p.brief.clips.length > 0 || p.status !== "interview") && (
                    <div className="scn-chips">
                      <span>{p.brief.aspect === "9:16" ? t("studio.cvAspectTall") : t("studio.cvAspectSquare")}</span>
                      <span>{t(`studio.cvTier_${p.brief.tier}` as MsgKey)}</span>
                      <span>{t("studio.cvCounts", { clips: p.brief.clips.length, stills: p.brief.stills.length })}</span>
                    </div>
                  )}
                  {skipped && <p className="scn-note is-warn">{t("studio.avatarSkipped")}</p>}
                </Node>
                <Node
                  g="estimate"
                  title={t("studio.cvEstimate")}
                  side={confirmed ? t("studio.cvConfirmed") : plan ? t("studio.cvToConfirm") : undefined}
                  sideTone={confirmed ? "ok" : plan ? "warn" : undefined}
                  onOpen={() => onOpen("estimate")}
                  working={work("estimate")}
                  lit={lit.estimate}
                  wait={wait === "estimate" || wait === "extra" || wait === "cap"}
                  open={isOpen("estimate")}
                  off={skipped}
                >
                  {confirmed ? (
                    <>
                      <div className="scn-count">
                        <span>{t("studio.cvSpent")}</span>
                        <b>
                          {fmt(p.credits.committed)} / {fmt(p.credits.cap)}
                        </b>
                      </div>
                      <div className="scn-bar">
                        <i style={{ width: `${p.credits.cap ? Math.min(100, (p.credits.committed / p.credits.cap) * 100) : 0}%` }} />
                      </div>
                    </>
                  ) : plan ? (
                    <>
                      <div className="scn-count">
                        <span>{t("studio.cvTotal")}</span>
                        <b>{t("studio.cvCredits", { n: fmt(plan.total) })}</b>
                      </div>
                      <div className="scn-count">
                        <span>{t("studio.cvMinutes")}</span>
                        <b>{t("studio.cvAbout", { n: Math.max(1, Math.round(plan.minutes)) })}</b>
                      </div>
                      <div className="scn-act">
                        <button type="button" className="scn-btn is-primary" onClick={() => onOpen("estimate")} data-testid="sc-estimate-open">
                          <Icon name="check" size={11} /> {t("studio.cvReview")}
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="scn-text is-empty">{t("studio.cvEstimateEmpty")}</p>
                  )}
                  {plan?.engines && Object.values(plan.engines).includes("local") && (
                    <p className="scn-note" data-testid="sc-estimate-local">
                      <Icon name="cpu" size={10} /> {t("studio.cvLocal", { n: Object.values(plan.engines).filter((e) => e === "local").length })}
                    </p>
                  )}
                  {p.extras.some((x) => x.status === "pending") && <p className="scn-note is-warn">{t("studio.wait_extra")}</p>}
                </Node>
              </div>

              {/* 3 · the candidates, then the base picture every clip starts and ends on */}
              <div className="sc-stack" style={{ gridColumn: 3, ...span }}>
                {p.brief.reference.mode !== "as_base" && (
                  <Node
                    g="candidates"
                    title={candTitle}
                    side={picked ? t("studio.cvPicked") : cands.some((c) => c.state === "done") ? `${cands.filter((c) => c.state === "done").length}/${cands.length}` : undefined}
                    sideTone={picked ? "ok" : undefined}
                    onOpen={() => onOpen("candidates")}
                    lit={lit.candidates}
                    wait={wait === "pick"}
                    open={isOpen("candidates")}
                    off={skipped}
                  >
                    <div className="scn-cands">
                      {cands.map((c) => (
                        <span key={c.id} data-g={`cand:${c.id}`} className={`scn-cand is-${c.state}${c.picked ? " is-picked" : ""}${wait === "pick" && c.src ? " is-pickable" : ""}`}>
                          {c.src ? <img src={c.src} alt="" draggable={false} /> : null}
                          {c.state === "running" ? <i className="sct-sweep" /> : null}
                          {c.picked ? <i>{t("studio.cvPickedTag")}</i> : null}
                        </span>
                      ))}
                    </div>
                    {wait === "pick" && (
                      <div className="scn-act">
                        <button type="button" className="scn-btn is-warn" onClick={() => onOpen("candidates")} data-testid="sc-pick-open">
                          {t("studio.cvPickOne")}
                        </button>
                      </div>
                    )}
                  </Node>
                )}
                <Node
                  g="home"
                  title={t("studio.cvHome")}
                  side={home === "done" ? t("studio.cvFixed") : home === "waiting" ? t("studio.cvApproveNeeded") : home === "running" ? t("studio.cvMaking") : home === "failed" ? t("studio.cvFailed") : undefined}
                  sideTone={home === "done" ? "ok" : home === "waiting" ? "warn" : home === "running" ? "accent" : undefined}
                  onOpen={() => onOpen("home")}
                  lit={lit.home}
                  wait={wait === "home"}
                  open={isOpen("home")}
                  off={skipped}
                >
                  <span className={`scn-pic is-${home === "waiting" ? "waiting" : home}`}>
                    {p.files.home ? <img src={p.files.home} alt="" draggable={false} /> : picked?.src ? <img src={picked.src} alt="" draggable={false} /> : <em>{t("studio.cvHomeEmpty")}</em>}
                    {home === "running" ? <i className="sct-sweep" /> : null}
                  </span>
                  <div className="scn-chips">
                    <span>{t("studio.cvRuleWaist")}</span>
                    <span>{t("studio.cvRuleCamera")}</span>
                    <span>{t("studio.cvRuleBg")}</span>
                  </div>
                  {wait === "home" && (
                    <div className="scn-act">
                      <button type="button" className="scn-btn is-primary" disabled={busy} onClick={onApprove} data-testid="sc-approve-home">
                        <Icon name="check" size={11} /> {t("avatar.approve")}
                      </button>
                      <button type="button" className="scn-btn" onClick={() => onOpen("home")}>
                        {t("studio.cvLook")}
                      </button>
                    </div>
                  )}
                </Node>
              </div>

              {/* 4 · 5 · each set: its rule, and every picture or clip of it made at the same time */}
              {shownRows.map((row, i) => {
                const key = `set:${row.key}` as NodeKey;
                const n = row.tiles.length;
                const done = row.tiles.filter((x) => x.state === "done").length;
                const making = row.tiles.filter((x) => going(x.state)).length;
                const failed = row.tiles.filter((x) => x.state === "failed").length;
                const isFaces = row.key === "faces";
                const waitHere = isFaces && wait === "stills";
                return (
                  <SetRow key={row.key} i={i}>
                    <div className="sc-cell" style={{ gridColumn: 4, gridRow: i + 2 }}>
                      <Node g={key} title={t(SET_TITLE[row.key])} side={n ? t("studio.cvN", { n }) : undefined} onOpen={() => onOpen(key)} wait={waitHere} open={isOpen(key)} off={skipped} lit={lit[key]}>
                        <Row k={t("studio.cvWhen")} v={t(SET_WHEN[row.key])} lit={false} empty={empty} />
                        <Row k={t("studio.cvRule")} v={t(SET_RULE[row.key])} lit={false} empty={empty} />
                        <p className={`scn-note${failed ? " is-bad" : ""}`}>
                          {!n ? t("studio.cvNotPlanned") : failed ? t("studio.cvFailedN", { n: failed }) : making ? t("studio.cvMakingN", { n: making }) : done === n ? t("studio.cvAllDone") : confirmed ? t("studio.cvDoneOf", { done, n }) : t("studio.cvPlannedN", { n })}
                        </p>
                        {waitHere && (
                          <div className="scn-act">
                            <button type="button" className="scn-btn is-primary" disabled={busy} onClick={onApprove} data-testid="sc-approve-stills">
                              <Icon name="check" size={11} /> {t("studio.cvApproveFaces")}
                            </button>
                          </div>
                        )}
                      </Node>
                    </div>
                    <div className="sc-tiles" style={{ gridColumn: 5, gridRow: i + 2 }} data-testid={`sc-tiles-${row.key}`}>
                      {row.tiles.length ? (
                        row.tiles.map((tl) => <TileView key={tl.key} t={tl} lit={!!lit[tl.key]} open={isOpen(tl.key)} onOpen={() => onOpen(tl.key)} />)
                      ) : (
                        <span className="scn-note" style={{ gridColumn: "1 / -1" }}>
                          {t("studio.cvTilesEmpty")}
                        </span>
                      )}
                    </div>
                  </SetRow>
                );
              })}

              {/* 6 · the checks */}
              <div className="sc-cell" style={{ gridColumn: 6, ...span }}>
                <Node g="check" title={t("studio.cvCheck")} onOpen={() => onOpen("check")} lit={lit.check} open={isOpen("check")}>
                  {creating && (
                    <div className="scn-count">
                      <span>{t("studio.cvNeeds")}</span>
                      <b className={missing.length ? "" : "is-ok"}>
                        {needs - Math.min(needs, missing.length)}/{needs}
                      </b>
                    </div>
                  )}
                  {!skipped && (
                    <>
                      <div className="scn-count">
                        <span>{t("studio.cvHome")}</span>
                        <b className={home === "done" ? "is-ok" : ""}>{home === "done" ? 1 : 0}/1</b>
                      </div>
                      {faces > 0 && (
                        <div className="scn-count">
                          <span>{t("studio.setFaces")}</span>
                          <b className={facesDone === faces ? "is-ok" : ""}>
                            {facesDone}/{faces}
                          </b>
                        </div>
                      )}
                      {clips > 0 && (
                        <div className="scn-count">
                          <span>{t("studio.cvClips")}</span>
                          <b className={clipsDone === clips ? "is-ok" : ""}>
                            {clipsDone}/{clips}
                          </b>
                        </div>
                      )}
                    </>
                  )}
                  {checks && (
                    <>
                      <div className="scn-count">
                        <span>{t("studio.cvSeam")}</span>
                        <b className={checks.seam[0] === checks.seam[1] ? "is-ok" : "is-bad"}>
                          {checks.seam[0]}/{checks.seam[1]}
                        </b>
                      </div>
                      <div className="scn-count">
                        <span>{t("studio.cvStart")}</span>
                        <b className={checks.start[0] === checks.start[1] ? "is-ok" : "is-bad"}>
                          {checks.start[0]}/{checks.start[1]}
                        </b>
                      </div>
                      <div className="scn-count">
                        <span>{t("studio.cvClean")}</span>
                        <b className={checks.clean[0] === checks.clean[1] ? "is-ok" : "is-bad"}>
                          {checks.clean[0]}/{checks.clean[1]}
                        </b>
                      </div>
                      {checks.failed.length > 0 && <p className="scn-note is-warn">{t("studio.cvCheckFailed", { n: checks.failed.length })}</p>}
                    </>
                  )}
                  {p.error && <p className="scn-note is-bad">{p.error}</p>}
                </Node>
              </div>

            </>
          )}

          {/* 7 · the mate */}
          <div className="sc-cell" style={{ gridColumn: fileMode ? 4 : 7, ...span }}>
            <Node
              g="mate"
              title={mate.name || t("studio.untitled")}
              side={ready ? t("studio.cvReady") : p.status === "applied" ? t("studio.cvApplied") : undefined}
              sideTone={ready ? "ok" : undefined}
              onOpen={() => onOpen("mate")}
              lit={lit.mate}
              open={isOpen("mate")}
              className={`scn-mate${ready ? " is-ready" : ""}`}
            >
              <div className={`scn-stage${avatar ? "" : " is-dim"}`}>
                {avatar ? (
                  <MateAvatar avatar={avatar} name={mate.name || "?"} size="sm" mood="idle" className="h-full w-full" />
                ) : p.files.home ? (
                  <img src={p.files.home} alt="" className="h-full w-full object-cover object-top" draggable={false} />
                ) : (
                  <div className="grid h-full w-full place-items-center text-content-faint">
                    <Icon name="user" size={28} />
                  </div>
                )}
              </div>
              <p className="scn-text">{mate.persona.description || concept.pitch || t("studio.cvMateEmpty")}</p>
              {creating && onCreate && (
                <div className="scn-act">
                  <button type="button" className="scn-btn is-primary" disabled={busy || missing.length > 0} onClick={onCreate} data-testid="sc-create">
                    <Icon name="check" size={11} /> {t("studio.create")}
                  </button>
                </div>
              )}
              {!creating && ready && (
                <div className="scn-act">
                  <button type="button" className="scn-btn is-primary" onClick={() => onOpen("mate")} data-testid="sc-apply-open">
                    {p.outfit ? t("studio.cvWearIt") : t("studio.cvApplyIt")}
                  </button>
                </div>
              )}
            </Node>
          </div>
        </div>
      </div>
      <Zoom onFit={view.fit} onZoom={view.zoomBy} />
      {activity.thinking && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-[5] -translate-x-1/2 rounded-full border border-border bg-surface-2/90 px-3 py-1 text-[11.5px] text-content-dim shadow-card backdrop-blur" data-testid="sc-thinking">
          <Icon name="spinner" size={11} spin className="mr-1 inline text-accent" />
          {t("studio.cvThinking")}
        </div>
      )}
    </div>
  );
}

/** (a fragment that keeps a set's two cells together in the grid) */
function SetRow({ children }: { i: number; children: ReactNode }) {
  return <>{children}</>;
}

export type { SlotState };
