/**
 * The clip / trigger editor of a video or photo avatar (Mate settings → Avatar):
 *
 * - ClipLibrary: every clip of the rig as a card (a thumbnail; hover / tap plays it with the stage's own stacked-alpha
 *   player), what makes it play in plain words ("while talking", "when she feels joy"), and an editor for the selected
 *   clip: on/off (`disabled`), situation (kind), feelings (the rig's `emotions` map), its own feeling, loop.
 * - TriggerPreview: a button per situation (mood) and feeling (emotion) that plays exactly what the renderer would pick
 *   (same functions as the video body: moodPool / clipsFor), and edits which clips a feeling plays.
 * - StillTriggers: which still shows for which feeling (`emotion_stills`; blink / mouth stills are mechanics).
 * - BundledReset: a built-in mate goes back to its bundled avatar (POST /api/mates/{id}/avatar/reset).
 *
 * Nothing is saved until the Avatar tab's Save; the Preview above shows the unsaved rig on the real renderer.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { resetBuiltinAvatar, uploadAsset, type Mate } from "../../../api/mates";
import { PlainPlayer, StackedPlayer, type ClipPlayer } from "../../../mate/avatar/player";
import { clipsFor, clipUrl, MECHANIC_STILLS, moodPool, stillNameFor } from "../../../mate/avatar/shared";
import { EMOTIONS } from "../../../mate/emotion";
import type { BodyMood, ClipKind, Rig, RigClip } from "../../../mate/types";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { tr, useT, type MsgKey } from "../../../i18n";
import { ErrorLine, Field, Section, Toggle } from "./ui";

// ── words ──

export const KIND_WORDS: Record<ClipKind, MsgKey> = {
  idle: "mateSettings.clipKindIdle",
  talk: "mateSettings.clipKindTalk",
  listen: "mateSettings.clipKindListen",
  think: "mateSettings.clipKindThink",
  react: "mateSettings.clipKindReact",
  away: "mateSettings.clipKindAway",
};
const KINDS: ClipKind[] = ["idle", "talk", "listen", "think", "react", "away"];

export const MOOD_WORDS: Record<BodyMood, MsgKey> = {
  idle: "mateSettings.clipKindIdle",
  listening: "mateSettings.clipKindListen",
  thinking: "mateSettings.clipKindThink",
  talking: "mateSettings.clipKindTalk",
  away: "mateSettings.clipKindAway",
};
const MOODS: BodyMood[] = ["idle", "listening", "thinking", "talking", "away"];
const MOOD_LABEL: Record<BodyMood, MsgKey> = {
  idle: "mateSettings.clipMoodIdle",
  listening: "mateSettings.clipMoodListening",
  thinking: "mateSettings.clipMoodThinking",
  talking: "mateSettings.clipMoodTalking",
  away: "mateSettings.clipMoodAway",
};

const VOCAB = EMOTIONS as readonly string[];

/** the rig's own emotion words (map keys, clip feelings) that aren't in the mate's vocabulary */
function rigWords(rig: Rig): string[] {
  const out = new Set<string>();
  for (const k of Object.keys(rig.emotions ?? {})) out.add(k.toLowerCase());
  for (const c of rig.clips) if (c.emotion) out.add(c.emotion.toLowerCase());
  return [...out].filter((w) => !VOCAB.includes(w)).sort();
}

const ids = (cs: RigClip[]) => cs.map((c) => c.id);
const uniq = (xs: string[]) => [...new Set(xs)];

/** the rig with emotion `e`'s clip list set (null: the key goes — automatic again) */
function withEmotion(rig: Rig, e: string, list: string[] | null): Rig {
  const emotions = { ...(rig.emotions ?? {}) };
  // the key as the rig writes it (case-insensitively), else the word itself
  const key = Object.keys(emotions).find((k) => k.toLowerCase() === e) ?? e;
  if (list === null) delete emotions[key];
  else emotions[key] = uniq(list);
  return { ...rig, emotions };
}

/** clip `id` plays for emotion `e` (on) or not (off), keeping whatever else that emotion plays now */
function toggleEmotion(rig: Rig, id: string, e: string, on: boolean): Rig {
  const now = ids(clipsFor(rig, e).clips);
  return withEmotion(rig, e, on ? [...now, id] : now.filter((x) => x !== id));
}

/** what makes a clip play, in plain words (exactly the renderer's choices; in the UI's language — call while rendering) */
function triggersOf(rig: Rig, clip: RigClip): string[] {
  if (clip.disabled) return [];
  const out: string[] = [];
  for (const m of MOODS) {
    const pool = moodPool(rig.clips, m);
    if (pool.clips.some((c) => c.id === clip.id)) out.push(tr(MOOD_WORDS[m]) + (pool.clips.length > 1 ? ` ${tr("mateSettings.clipOneOf", { n: pool.clips.length })}` : ""));
  }
  for (const e of VOCAB) {
    const r = clipsFor(rig, e);
    if (r.clips.some((c) => c.id === clip.id)) out.push(tr("mateSettings.clipWhenFeels", { e }) + (r.clips.length > 1 ? ` ${tr("mateSettings.clipOneOf", { n: r.clips.length })}` : ""));
  }
  return out;
}

const fileName = (url: string) => url.split("/").pop()?.split("?")[0] ?? "";
const extOf = (f: File, fallback: string) => (f.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] || fallback).toLowerCase();

// ── thumbnails: one frame (mid-clip) of the small clip, its alpha applied, made one at a time ──

const thumbs = new Map<string, Promise<string | null>>();
let thumbChain: Promise<unknown> = Promise.resolve();

function once(el: HTMLMediaElement, ev: string, ms = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    el.addEventListener(
      ev,
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
    el.addEventListener("error", () => (clearTimeout(t), reject(new Error("media error"))), { once: true }); // i18n-ignore
  });
}

async function makeThumb(url: string, stacked: boolean): Promise<string | null> {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = url;
  try {
    await once(v, "loadeddata");
    v.currentTime = Math.max(0, (v.duration || 0) * 0.5);
    await once(v, "seeked");
    const vw = v.videoWidth;
    const half = stacked ? Math.floor(v.videoHeight / 2) : v.videoHeight;
    if (!vw || !half) return null;
    const W = 200;
    const H = Math.round((W * half) / vw);
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, vw, half, 0, 0, W, H);
    if (stacked) {
      // colour on top, alpha below (the stage's shader does the same: straight colour, alpha from the red channel)
      const col = ctx.getImageData(0, 0, W, H);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(v, 0, v.videoHeight - half, vw, half, 0, 0, W, H);
      const al = ctx.getImageData(0, 0, W, H);
      for (let i = 0; i < col.data.length; i += 4) {
        const a = Math.max(0, Math.min(1, (al.data[i] / 255 - 0.03) / 0.94));
        col.data[i + 3] = Math.round(a * 255);
      }
      ctx.putImageData(col, 0, 0);
    }
    return cv.toDataURL("image/webp", 0.85);
  } catch {
    return null;
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

function thumbOf(url: string, stacked: boolean): Promise<string | null> {
  const key = `${stacked ? "s" : "p"}|${url}`;
  let p = thumbs.get(key);
  if (!p) {
    p = thumbChain.then(() => makeThumb(url, stacked));
    thumbChain = p.catch(() => null);
    thumbs.set(key, p);
  }
  return p;
}

function useThumb(url: string, stacked: boolean): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!url) return;
    let alive = true;
    void thumbOf(url, stacked).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [url, stacked]);
  return src;
}

// ── a clip player: the stage's own (StackedPlayer / PlainPlayer), playing a list of clips in turn ──

export function ClipStage({ rig, clips, className = "", testId, label }: { rig: Rig; clips: RigClip[]; className?: string; testId?: string; label?: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const packing = rig.packing ?? "stacked-alpha";
  const aw = rig.aspect?.[0] > 0 ? rig.aspect[0] : 3;
  const ah = rig.aspect?.[1] > 0 ? rig.aspect[1] : 4;
  const key = clips.map((c) => `${c.id}=${clipUrl(c, "sm")}`).join("|");
  useEffect(() => {
    const el = box.current;
    const list = clips.filter((c) => clipUrl(c, "sm"));
    setNow(null);
    setShown(false);
    setFailed(false);
    if (!el || !list.length) return;
    let p: ClipPlayer;
    let node: HTMLElement;
    if (packing === "plain") {
      const frame = document.createElement("div");
      frame.className = "mate-plain-frame";
      frame.style.height = "100%";
      frame.style.maxWidth = "100%";
      frame.style.aspectRatio = `${aw} / ${ah}`;
      el.appendChild(frame);
      node = frame;
      p = new PlainPlayer(frame);
    } else {
      const canvas = document.createElement("canvas");
      canvas.className = "mate-canvas";
      el.appendChild(canvas);
      node = canvas;
      try {
        p = new StackedPlayer(canvas);
      } catch {
        canvas.remove();
        setFailed(true);
        return;
      }
    }
    let i = 0;
    const play = () => {
      const c = list[i % list.length];
      setNow(c.id);
      el.dataset.clip = c.id;
      p.show(clipUrl(c, "sm"), { loop: list.length === 1 });
      if (list.length > 1) p.prepare(clipUrl(list[(i + 1) % list.length], "sm"));
    };
    p.onFirstFrame = () => setShown(true);
    p.onEnded = () => {
      i++;
      play();
    };
    play();
    // asleep while scrolled out of view (settings scroll a lot) or the tab is hidden
    let off = false;
    const sync = () => p.setPaused(off || document.hidden);
    const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(([e]) => ((off = !e.isIntersecting), sync())) : null;
    io?.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      p.onEnded = null;
      p.onFirstFrame = null;
      p.dispose();
      node.remove();
      delete el.dataset.clip;
    };
  }, [key, packing, aw, ah]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`relative ${className}`} data-testid={testId} data-playing={now ?? ""}>
      <div ref={box} className="mate-avatar" style={{ aspectRatio: `${aw} / ${ah}` }}>
        {!shown && rig.home && !failed ? <img className="mate-fit opacity-60" src={rig.home} alt="" /> : null}
        {failed && <div className="mate-status">{t("mateSettings.clipNoWebgl")}</div>}
        {!clips.length && <div className="mate-status">{label ?? t("mateSettings.clipNoClip")}</div>}
      </div>
      {now && clips.length > 1 && (
        <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-px font-mono text-[10.5px] text-white">{now}</span>
      )}
    </div>
  );
}

// ── the library ──

export function ClipLibrary({ mate, rig, onChange, folder = "" }: { mate: Mate; rig: Rig; onChange: (r: Rig) => void; folder?: string }) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClipKind | "all" | "off">("all");
  const stacked = (rig.packing ?? "stacked-alpha") === "stacked-alpha";
  const sel = rig.clips.find((c) => c.id === selected) ?? null;
  const shown = rig.clips.filter((c) => (filter === "all" ? true : filter === "off" ? c.disabled : c.kind === filter));
  const off = rig.clips.filter((c) => c.disabled).length;
  const add = () => {
    let n = rig.clips.length + 1;
    while (rig.clips.some((c) => c.id === `clip${n}`)) n++;
    onChange({ ...rig, clips: [...rig.clips, { id: `clip${n}`, kind: "idle", src: "" }] });
    setSelected(`clip${n}`);
  };
  return (
    <Section
      title={t("mateSettings.clipLibrary")}
      testId="mate-clip-library"
      hint={t("mateSettings.clipLibraryHint")}
      right={<span className="pill shrink-0 border border-border text-content-faint">{t("mateSettings.clipCount", { count: rig.clips.length })}{off ? ` · ${t("mateSettings.clipOffCount", { n: off })}` : ""}</span>}
    >
      <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1" role="tablist">
        {(["all", ...KINDS, ...(off ? ["off" as const] : [])] as const).map((k) => {
          const n = k === "all" ? rig.clips.length : k === "off" ? off : rig.clips.filter((c) => c.kind === k).length;
          if (k !== "all" && k !== "off" && !n) return null;
          return (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`pill shrink-0 border ${filter === k ? "border-accent/50 bg-accent-soft text-accent" : "border-border text-content-dim hover:text-content"}`}
            >
              {k === "all" ? t("mateSettings.clipAll") : k === "off" ? t("common.off") : t(KIND_WORDS[k]).replace("…", "")} · {n}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-2 min-[480px]:grid-cols-3">
        {shown.map((c) => (
          <ClipCard
            key={c.id}
            rig={rig}
            clip={c}
            stacked={stacked}
            playing={hover === c.id || selected === c.id}
            selected={selected === c.id}
            onHover={(on) => setHover((h) => (on ? c.id : h === c.id ? null : h))}
            onPick={() => setSelected((s) => (s === c.id ? null : c.id))}
          />
        ))}
      </div>
      {sel && <ClipEditor key={sel.id} mate={mate} rig={rig} clip={sel} folder={folder} onChange={onChange} onRenamed={setSelected} onRemoved={() => setSelected(null)} />}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-ghost border border-border" onClick={add}>
          <Icon name="plus" size={14} /> {t("mateSettings.clipAdd")}
        </button>
        <Field label={t("mateSettings.clipPacking")} as="div">
          <select className="field !py-1 text-[12px]" value={rig.packing || "stacked-alpha"} onChange={(e) => onChange({ ...rig, packing: e.target.value as Rig["packing"] })}>
            <option value="stacked-alpha">{t("mateSettings.clipPackStacked")}</option>
            <option value="plain">plain</option>
          </select>
        </Field>
      </div>
    </Section>
  );
}

function ClipCard({
  rig,
  clip,
  stacked,
  playing,
  selected,
  onHover,
  onPick,
}: {
  rig: Rig;
  clip: RigClip;
  stacked: boolean;
  playing: boolean;
  selected: boolean;
  onHover: (on: boolean) => void;
  onPick: () => void;
}) {
  const t = useT();
  const thumb = useThumb(clipUrl(clip, "sm"), stacked);
  const triggers = triggersOf(rig, clip);
  const hoverable = typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover)").matches;
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={hoverable ? () => onHover(true) : undefined}
      onMouseLeave={hoverable ? () => onHover(false) : undefined}
      className={`group relative flex min-w-0 flex-col overflow-hidden rounded-lg border text-left transition ${
        selected ? "border-accent/70 ring-1 ring-accent/40" : "border-border hover:border-border-strong"
      } ${clip.disabled ? "opacity-55" : ""}`}
      data-testid={`mate-clip-card-${clip.id}`}
      data-clip-id={clip.id}
      data-disabled={clip.disabled ? "1" : "0"}
      aria-pressed={selected}
    >
      <div className="relative h-36 w-full bg-[repeating-conic-gradient(#161a22_0%_25%,#11141b_0%_50%)] [background-size:16px_16px]">
        {playing && clipUrl(clip, "sm") ? (
          <ClipStage rig={rig} clips={[clip]} className="absolute inset-0 [&_.mate-avatar]:!h-full" />
        ) : thumb ? (
          <img src={thumb} alt="" className={`absolute inset-0 h-full w-full object-contain object-bottom ${clip.disabled ? "grayscale" : ""}`} draggable={false} />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-content-faint">
            {clipUrl(clip, "sm") ? <Icon name="spinner" size={14} spin /> : <span className="text-[11px]">{t("mateSettings.clipNoVideoYet")}</span>}
          </div>
        )}
        {!playing && clipUrl(clip, "sm") && (
          <span className="absolute bottom-1.5 right-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white opacity-80 group-hover:opacity-100">
            <Icon name="play" size={10} />
          </span>
        )}
        {clip.disabled && <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-px text-[10.5px] font-medium text-white">{t("common.off")}</span>}
      </div>
      <div className="min-w-0 space-y-0.5 border-t border-border px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-[12px] text-content">{clip.id}</span>
          {clip.loop && <Icon name="refresh" size={10} className="shrink-0 text-content-faint" />}
          {clip.emotion && <span className="ml-auto shrink-0 rounded bg-surface-3 px-1 text-[10px] text-content-dim">{clip.emotion}</span>}
        </div>
        <div className="line-clamp-2 text-[11px] leading-snug text-content-faint" data-testid={`mate-clip-triggers-${clip.id}`}>
          {clip.disabled ? t("mateSettings.clipSwitchedOff") : triggers.length ? triggers.join(" · ") : t("mateSettings.clipNeverPlays")}
        </div>
      </div>
    </button>
  );
}

function ClipEditor({
  mate,
  rig,
  clip,
  folder,
  onChange,
  onRenamed,
  onRemoved,
}: {
  mate: Mate;
  rig: Rig;
  clip: RigClip;
  /** an outfit's own folder for its uploads ("" for her default set) */
  folder: string;
  onChange: (r: Rig) => void;
  onRenamed: (id: string) => void;
  onRemoved: () => void;
}) {
  const t = useT();
  const [idDraft, setIdDraft] = useState(clip.id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setClip = (patch: Partial<RigClip>) => {
    const next = { ...clip, ...patch };
    for (const k of ["disabled", "loop", "emotion"] as const) if (!next[k]) delete next[k];
    onChange({ ...rig, clips: rig.clips.map((c) => (c.id === clip.id ? next : c)) });
  };
  const words = useMemo(() => [...VOCAB, ...rigWords(rig)], [rig]);
  const triggers = triggersOf(rig, clip);
  const rename = () => {
    const id = idDraft.trim();
    if (!id || id === clip.id) return setIdDraft(clip.id);
    if (rig.clips.some((c) => c.id === id)) {
      setErr(t("mateSettings.clipDupId", { id }));
      return;
    }
    setErr(null);
    const emotions = Object.fromEntries(Object.entries(rig.emotions ?? {}).map(([k, l]) => [k, l.map((x) => (x === clip.id ? id : x))]));
    onChange({ ...rig, clips: rig.clips.map((c) => (c.id === clip.id ? { ...c, id } : c)), emotions });
    onRenamed(id);
  };
  const remove = () => {
    const emotions = Object.fromEntries(Object.entries(rig.emotions ?? {}).map(([k, l]) => [k, l.filter((x) => x !== clip.id)]));
    onChange({ ...rig, clips: rig.clips.filter((c) => c.id !== clip.id), emotions });
    onRemoved();
  };
  const upload = async (f: File) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await uploadAsset(mate.id, f, `${folder}clips/${clip.id.replace(/[^\w-]/g, "_") || "clip"}.${extOf(f, "mp4")}`);
      setClip({ src: r.url, small: undefined });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg border border-accent/30 bg-surface/50 p-3" data-testid="mate-clip-editor" data-clip-id={clip.id}>
      <div className="grid gap-3 min-[480px]:grid-cols-[150px_1fr]">
        <div className="mx-auto h-48 w-full max-w-[180px] overflow-hidden rounded-lg border border-border bg-[repeating-conic-gradient(#161a22_0%_25%,#11141b_0%_50%)] [background-size:16px_16px]">
          <ClipStage rig={rig} clips={clipUrl(clip, "sm") ? [clip] : []} className="h-full [&_.mate-avatar]:!h-full" label={t("mateSettings.clipNoVideo")} testId="mate-clip-editor-stage" />
        </div>
        <div className="min-w-0 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-mono text-[13px] font-semibold text-content">{clip.id}</span>
            <span className="ml-auto" />
            <Toggle on={!clip.disabled} onChange={(on) => setClip({ disabled: !on })} label={clip.disabled ? t("common.off") : t("common.on")} testId="mate-clip-enabled" />
          </div>
          <p className="text-[12px] leading-relaxed text-content-dim" data-testid="mate-clip-editor-triggers">
            {clip.disabled ? (
              <>{t("mateSettings.clipOffLong")}</>
            ) : triggers.length ? (
              <>{t("mateSettings.clipPlays", { list: triggers.join(", ") })}</>
            ) : (
              <>{t("mateSettings.clipNothingPlays")}</>
            )}
          </p>
          <Field label={t("mateSettings.clipWhenPlays")}>
            <select className="field !py-1.5 text-[12.5px]" value={clip.kind} onChange={(e) => setClip({ kind: e.target.value as ClipKind })} data-testid="mate-clip-kind">
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === "react" ? t("mateSettings.clipKindReactLong") : t(KIND_WORDS[k])} — {k}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <Field label={t("mateSettings.clipFeelings")} as="div" hint={t("mateSettings.clipFeelingsHint")}>
        <div className="flex flex-wrap gap-1" data-testid="mate-clip-feelings">
          {VOCAB.map((e) => {
            const on = clipsFor(rig, e).clips.some((c) => c.id === clip.id);
            return (
              <button
                key={e}
                type="button"
                disabled={clip.disabled}
                onClick={() => onChange(toggleEmotion(rig, clip.id, e, !on))}
                className={`pill border transition disabled:opacity-40 ${on ? "border-accent/60 bg-accent-soft text-accent" : "border-border text-content-faint hover:text-content"}`}
                aria-pressed={on}
                data-emotion={e}
              >
                {on && <Icon name="check" size={10} />} {e}
              </button>
            );
          })}
        </div>
      </Field>
      <div className="grid gap-3 min-[480px]:grid-cols-2">
        <Field label={t("mateSettings.clipOwnFeeling")} hint={t("mateSettings.clipOwnFeelingHint")}>
          <select className="field !py-1.5 text-[12.5px]" value={clip.emotion ?? ""} onChange={(e) => setClip({ emotion: e.target.value || undefined })} data-testid="mate-clip-emotion">
            <option value="">{t("mateSettings.clipNoneOpt")}</option>
            {words.map((w) => (
              <option key={w} value={w}>
                {w}
                {VOCAB.includes(w) ? "" : ` ${t("mateSettings.clipRigWord")}`}
              </option>
            ))}
            {clip.emotion && !words.includes(clip.emotion.toLowerCase()) && <option value={clip.emotion}>{clip.emotion}</option>}
          </select>
        </Field>
        <div className="pt-5">
          <Toggle on={!!clip.loop} onChange={(on) => setClip({ loop: on })} label={t("mateSettings.clipLoop")} hint={t("mateSettings.clipLoopHint")} />
        </div>
      </div>
      <details className="rounded-lg border border-border/70 px-3 py-2 text-[12px]">
        <summary className="cursor-pointer text-content-dim">{t("mateSettings.clipMore")}</summary>
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <input className="field !py-1 font-mono text-[12px]" value={idDraft} onChange={(e) => setIdDraft(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && rename()} aria-label={t("mateSettings.clipId")} />
            <label className="btn-ghost shrink-0 cursor-pointer border border-border !px-2 !py-1 text-[12px]">
              <input type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              {busy ? <Icon name="spinner" size={12} spin /> : <Icon name="upload" size={12} />} {t("mateSettings.clipVideoBtn")}
            </label>
            <button className="btn-ghost shrink-0 border border-border !px-2 !py-1 text-[12px] hover:!text-danger" onClick={remove} aria-label={t("mateSettings.clipRemove")}>
              <Icon name="trash" size={12} />
            </button>
          </div>
          <p className="truncate text-[11px] text-content-faint">{clip.src ? fileName(clip.src) : t("mateSettings.clipNoFile")}</p>
        </div>
      </details>
      <ErrorLine text={err} />
    </div>
  );
}

// ── trigger preview: what plays when ──

type Pick = { type: "mood"; mood: BodyMood } | { type: "emotion"; name: string };

export function TriggerPreview({ rig, onChange, onPoke }: { rig: Rig; onChange: (r: Rig) => void; onPoke: (p: Pick) => void }) {
  const t = useT();
  const [pick, setPick] = useState<Pick>({ type: "emotion", name: "joy" });
  const [n, setN] = useState(0); // a click on the same button replays
  const res = pick.type === "mood" ? moodPool(rig.clips, pick.mood) : null;
  const emo = pick.type === "emotion" ? clipsFor(rig, pick.name) : null;
  const clips = res ? res.clips : emo!.clips;
  const btn = (active: boolean) =>
    `pill border ${active ? "border-accent/50 bg-accent-soft text-accent" : "border-border text-content-dim hover:text-content"}`;
  const choose = (p: Pick) => {
    setPick(p);
    setN((x) => x + 1);
  };
  return (
    <Section title={t("mateSettings.trigTitle")} testId="mate-trigger-preview" hint={t("mateSettings.trigHint")}>
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-content-faint">{t("mateSettings.trigSituations")}</div>
        <div className="flex flex-wrap gap-1">
          {MOODS.map((m) => (
            <button key={m} className={btn(pick.type === "mood" && pick.mood === m)} onClick={() => choose({ type: "mood", mood: m })} data-testid={`mate-trigger-mood-${m}`}>
              {t(MOOD_LABEL[m])}
            </button>
          ))}
        </div>
        <div className="pt-1 text-[11px] font-medium uppercase tracking-wide text-content-faint">{t("mateSettings.trigFeelings")}</div>
        <div className="flex flex-wrap gap-1">
          {VOCAB.map((e) => {
            const r = clipsFor(rig, e);
            return (
              <button key={e} className={btn(pick.type === "emotion" && pick.name === e)} onClick={() => choose({ type: "emotion", name: e })} data-testid={`mate-trigger-emotion-${e}`} title={r.clips.length ? ids(r.clips).join(", ") : t("mateSettings.clipNoClip")}>
                {e}
                {!r.clips.length && <span className="text-content-faint">·–</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid gap-3 min-[480px]:grid-cols-[160px_1fr]">
        <div className="mx-auto h-52 w-full max-w-[200px] overflow-hidden rounded-lg border border-border bg-[repeating-conic-gradient(#161a22_0%_25%,#11141b_0%_50%)] [background-size:16px_16px]">
          <ClipStage
            key={n}
            rig={rig}
            clips={clips}
            className="h-full [&_.mate-avatar]:!h-full"
            label={pick.type === "emotion" ? t("mateSettings.trigNoClipGoesOn") : t("mateSettings.clipNoClip")}
            testId="mate-trigger-stage"
          />
        </div>
        <div className="min-w-0 space-y-2 text-[12.5px] leading-relaxed text-content-dim" data-testid="mate-trigger-result" data-clips={ids(clips).join(",")}>
          {res && pick.type === "mood" && (
            <p>
              <b className="text-content">{cap(t(MOOD_WORDS[pick.mood]))}</b>{" "}
              {res.clips.length ? (
                <>
                  {t.rich(res.clips.length > 1 ? "mateSettings.trigMoodMany" : "mateSettings.trigOne", { clips: <ClipNames clips={res.clips} /> })}
                  {res.fallback && (
                    <span className="block text-[11.5px] text-content-faint">
                      {t(res.kind === "idle" ? "mateSettings.trigFallbackIdle" : "mateSettings.trigFallbackFirst", { kind: moodKind(pick.mood) })}
                    </span>
                  )}
                </>
              ) : (
                t("mateSettings.trigNoneOn")
              )}
            </p>
          )}
          {emo && pick.type === "emotion" && (
            <>
              <p>
                <b className="text-content">{cap(t("mateSettings.clipWhenFeels", { e: pick.name }))}</b>{" "}
                {emo.clips.length ? (
                  <>
                    {t.rich(emo.clips.length > 1 ? "mateSettings.trigEmoMany" : "mateSettings.trigEmoOne", { clips: <ClipNames clips={emo.clips} /> })}
                    <span className="block text-[11.5px] text-content-faint">
                      {emo.via === "map"
                        ? emo.key && emo.key.toLowerCase() !== pick.name
                          ? t("mateSettings.trigFromMapKey", { key: emo.key, name: pick.name })
                          : t("mateSettings.trigFromMap")
                        : t("mateSettings.trigFromClip", { key: emo.key ?? "" })}
                    </span>
                  </>
                ) : emo.via === "map" ? (
                  t("mateSettings.trigMapOff")
                ) : (
                  t("mateSettings.trigNoClipFor")
                )}
              </p>
              <EmotionClipsEditor rig={rig} name={pick.name} onChange={onChange} />
            </>
          )}
          <button className="btn-ghost border border-border !px-2.5 !py-1 text-[12px]" onClick={() => onPoke(pick)} data-testid="mate-trigger-on-avatar">
            <Icon name="play" size={11} /> {t("mateSettings.trigShowOnAvatar")}
          </button>
        </div>
      </div>
    </Section>
  );
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const moodKind = (m: BodyMood): ClipKind =>
  m === "talking" ? "talk" : m === "thinking" ? "think" : m === "listening" ? "listen" : m === "away" ? "away" : "idle";

function ClipNames({ clips }: { clips: RigClip[] }) {
  const t = useT();
  return (
    <>
      {clips.map((c, i) => (
        <span key={c.id}>
          {i > 0 && (i === clips.length - 1 ? t("mateSettings.clipOr") : ", ")}
          <code className="rounded bg-surface-3 px-1 font-mono text-[11.5px] text-content">{c.id}</code>
        </span>
      ))}
    </>
  );
}

/** which clips a feeling plays: add / remove, "automatic" (no map entry), "nothing" */
function EmotionClipsEditor({ rig, name, onChange }: { rig: Rig; name: string; onChange: (r: Rig) => void }) {
  const t = useT();
  const now = clipsFor(rig, name);
  const own = Object.keys(rig.emotions ?? {}).find((k) => k.toLowerCase() === name);
  const options = rig.clips.filter((c) => !c.disabled && !now.clips.some((x) => x.id === c.id));
  options.sort((a, b) => Number(b.kind === "react") - Number(a.kind === "react"));
  return (
    <div className="space-y-1.5 rounded-lg border border-border/70 bg-surface/40 p-2" data-testid="mate-emotion-editor">
      <div className="flex flex-wrap items-center gap-1">
        {now.clips.map((c) => (
          <span key={c.id} className="pill border border-border bg-surface-2 text-content">
            <span className="font-mono">{c.id}</span>
            <button
              onClick={() => onChange(withEmotion(rig, name, ids(now.clips).filter((x) => x !== c.id)))}
              className="text-content-faint hover:text-danger min-w-[32px]"
              aria-label={t("mateSettings.clipDontPlay", { id: c.id, name })}
              data-testid={`mate-emotion-remove-${c.id}`}
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        ))}
        <select
          className="field !w-auto !py-0.5 text-[12px]"
          value=""
          onChange={(e) => e.target.value && onChange(withEmotion(rig, name, [...ids(now.clips), e.target.value]))}
          data-testid="mate-emotion-add"
        >
          <option value="">{t("mateSettings.clipAddOpt")}</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} ({c.kind})
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-1.5 text-[11.5px]">
        <button className="btn-ghost !px-2 !py-0.5 text-[11.5px]" disabled={!now.clips.length && now.via === "map"} onClick={() => onChange(withEmotion(rig, name, []))} data-testid="mate-emotion-none">
          {t("mateSettings.clipNoneFor", { name })}
        </button>
        {own !== undefined && (
          <button className="btn-ghost !px-2 !py-0.5 text-[11.5px]" onClick={() => onChange(withEmotion(rig, name, null))} data-testid="mate-emotion-auto">
            {t("mateSettings.clipAutomatic")}
          </button>
        )}
      </div>
    </div>
  );
}

// ── stills: which picture for which feeling ──

export function StillTriggers({ rig, onChange, onPoke, video }: { rig: Rig; onChange: (r: Rig) => void; onPoke: (p: Pick) => void; video: boolean }) {
  const t = useT();
  const names = Object.keys(rig.stills).filter((n) => !MECHANIC_STILLS.includes(n));
  if (!names.length) return null;
  const map = rig.emotion_stills ?? {};
  const set = (e: string, v: string | null) => {
    const next = { ...map };
    if (v === null) delete next[e];
    else next[e] = v;
    onChange({ ...rig, emotion_stills: next });
  };
  return (
    <Section
      title={t("mateSettings.stillTitle")}
      testId="mate-still-triggers"
      hint={video ? t("mateSettings.stillHintVideo") : t("mateSettings.stillHintPhoto")}
    >
      <div className="grid gap-1.5 min-[480px]:grid-cols-2">
        {VOCAB.map((e) => {
          const cur = map[e] ?? Object.entries(map).find(([k]) => k.toLowerCase() === e)?.[1];
          const value = cur === undefined ? "__auto" : cur === "" ? "__none" : cur;
          const rest = { ...map };
          delete rest[e];
          const auto = stillNameFor(rig.stills, e, rest);
          const shown = stillNameFor(rig.stills, e, map);
          return (
            <div key={e} className="flex items-center gap-2 rounded-lg border border-border/70 px-2 py-1.5" data-testid={`mate-still-row-${e}`}>
              <button
                className="h-10 w-8 shrink-0 overflow-hidden rounded border border-border bg-surface-3"
                onClick={() => onPoke({ type: "emotion", name: e })}
                title={t("mateSettings.trigShowOnAvatar")}
              >
                {shown ? <img src={rig.stills[shown]} alt="" className="h-full w-full object-cover object-top" /> : <span className="text-[10px] text-content-faint">–</span>}
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-content">
                  {e}
                  {e === "thinking" && <span className="text-content-faint"> · {t("mateSettings.stillAlsoThinking")}</span>}
                  {e === "sleepy" && <span className="text-content-faint"> · {t("mateSettings.stillAlsoAway")}</span>}
                </div>
                <select className="field mt-0.5 !py-0.5 text-[12px]" value={value} onChange={(ev) => set(e, ev.target.value === "__auto" ? null : ev.target.value === "__none" ? "" : ev.target.value)}>
                  <option value="__auto">{t("mateSettings.stillAuto", { x: auto ?? t("mateSettings.stillNone") })}</option>
                  <option value="__none">{t("mateSettings.stillNoStill")}</option>
                  {names.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ── back to the bundled avatar ──

export function BundledReset({ mate, dirty }: { mate: Mate; dirty: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const t = useT();
  if (!mate.builtin) return null;
  const reset = async () => {
    const msg = t(dirty ? "mateSettings.bundledConfirmDirty" : "mateSettings.bundledConfirm", { name: mate.name });
    if (!window.confirm(msg)) return;
    setBusy(true);
    setErr(null);
    setDone(false);
    try {
      useMateStore.getState().upsert(await resetBuiltinAvatar(mate.id));
      setDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title={t("mateSettings.bundledTitle")}
      testId="mate-avatar-bundled"
      hint={t("mateSettings.bundledHint", { name: mate.name })}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-soft" onClick={reset} disabled={busy} data-testid="mate-avatar-reset">
          {busy ? <Icon name="spinner" size={13} spin /> : <Icon name="rotate" size={13} />} {t("mateSettings.bundledReset")}
        </button>
        {done && (
          <span className="inline-flex items-center gap-1 text-[12px] text-success">
            <Icon name="check" size={12} /> {t("mateSettings.bundledRestored")}
          </span>
        )}
      </div>
      <ErrorLine text={err} />
    </Section>
  );
}

export type TriggerPick = Pick;
