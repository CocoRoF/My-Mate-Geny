/**
 * Her look from a file the user has (docs/avatar-create.md §11 "Her look from a file"), three windows of the studio:
 *
 * - LookChooser (`look`): how her look is made — drawn by AI, from a file, later; and for an existing mate her wardrobe.
 * - FileImport (`import`): the file (a Live2D model in a zip, a LivLiv package, a clip pack), what it has, its size and
 *   place in the frame and what it does while idle. Right after an import her emotions are matched to the model's
 *   expressions and motions by their names (free, at once); the next window shows what was matched.
 * - EmotionMapper (`motions`): for each of her emotions the model's expression and motion (행동), tried on her right
 *   there; matched by name with one press, or by the AI; what a touch on her does.
 *
 * Every change saves itself (the mate's avatar); nothing is generated and nothing costs credits.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { importAvatarZip, type Mate } from "../../../api/mates";
import { MateAvatar } from "../../../mate/avatar/MateAvatar";
import { readLive2DInfo, useLive2DModelInfo } from "../../../mate/avatar/live2dInfo";
import { EMOTIONS, emotionCandidates, lookupEmotion } from "../../../mate/emotion";
import { emotionLabel } from "../../../mate/emotionLabel";
import type { Avatar, Live2D, LivLiv, MateReact } from "../../../mate/types";
import { useMateStore } from "../../../stores/mateStore";
import { useT, type MsgKey } from "../../../i18n";
import { confirmDialog } from "../../ui/ConfirmDialog";
import HelpTip from "../../ui/HelpTip";
import Icon, { type IconName } from "../../ui/Icon";
import { CoreNotice } from "../settings/AvatarTab";
import { suggestMap, type LookPath } from "./guide";

const fileName = (url: string) => decodeURIComponent(url.split("?")[0].split("/").pop() || url);
/** the stand-in emotion a motion is tried with in the preview (never saved) */
const TRY = "__try";

/** the avatar saved a moment after the last change (a slider dragged saves once) */
function useAvatarSaver(mate: Mate) {
  const timer = useRef<number | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const next = useRef<Avatar | null>(null);
  const flush = async () => {
    timer.current = null;
    const a = next.current;
    if (!a) return;
    next.current = null;
    setState("saving");
    try {
      await useMateStore.getState().patch(mate.id, { avatar: a });
      setState("saved");
      setErr(null);
    } catch (e) {
      setState("error");
      setErr((e as Error).message);
    }
  };
  useEffect(
    () => () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        void flush();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const save = (a: Avatar, now = false) => {
    next.current = a;
    if (timer.current) window.clearTimeout(timer.current);
    if (now) void flush();
    else timer.current = window.setTimeout(() => void flush(), 450);
  };
  return { save, state, err };
}

function SaveState({ state, err }: { state: "idle" | "saving" | "saved" | "error"; err: string | null }) {
  const t = useT();
  if (state === "idle") return null;
  return (
    <span className={`inline-flex items-center gap-1 text-[11.5px] ${state === "error" ? "text-danger" : "text-content-faint"}`} data-testid="look-save-state" aria-live="polite">
      <Icon name={state === "saving" ? "spinner" : state === "error" ? "warning" : "check"} size={11} spin={state === "saving"} className={state === "saved" ? "text-success" : ""} />
      {state === "saving" ? t("studio.saving") : state === "error" ? err : t("studio.savedAuto")}
    </span>
  );
}

// ── how her look is made ──

function Option({ icon, title, sub, onClick, active, testId, tone }: { icon: IconName; title: string; sub: string; onClick: () => void; active?: boolean; testId: string; tone?: "accent" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition ${active ? "border-accent/70 bg-accent-soft/60" : "border-border hover:border-border-strong hover:bg-surface-3/50"}`}
      aria-pressed={active}
      data-testid={testId}
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${tone === "accent" || active ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-dim"}`}>
        <Icon name={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-semibold text-content">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-content-dim">{sub}</span>
      </span>
      {active && <Icon name="check" size={14} className="mt-1 shrink-0 text-accent" />}
    </button>
  );
}

export function LookChooser({ path, creating, onPick, onWardrobe }: { path: LookPath | null; creating: boolean; onPick: (p: LookPath) => void; onWardrobe?: () => void }) {
  const t = useT();
  return (
    <div className="space-y-2" data-testid="look-chooser">
      <Option icon="sparkles" title={t("studio.lookDraw")} sub={t("studio.lookDrawSub")} onClick={() => onPick("draw")} active={path === "draw"} testId="look-draw" tone="accent" />
      <Option icon="upload" title={t("studio.lookFile")} sub={t("studio.lookFileSub")} onClick={() => onPick("file")} active={path === "file"} testId="look-file" />
      {creating && <Option icon="clock" title={t("studio.lookLater")} sub={t("studio.lookLaterSub")} onClick={() => onPick("later")} active={path === "later"} testId="look-later" />}
      {onWardrobe && <Option icon="shirt" title={t("studio.lookWardrobe")} sub={t("studio.lookWardrobeSub")} onClick={onWardrobe} testId="look-wardrobe" />}
    </div>
  );
}

// ── the file ──

const KIND_LABEL: Partial<Record<Avatar["kind"], MsgKey>> = {
  live2d: "studio.fileKindLive2d",
  livliv: "studio.fileKindLivliv",
  video: "studio.fileKindVideo",
  photo: "studio.fileKindPhoto",
};

/** her emotions matched to a model by name, over what is mapped already (an import's first guess) */
export async function matchedByName(a: Avatar): Promise<{ avatar: Avatar; n: number } | null> {
  if (a.kind === "live2d" && a.live2d.model) {
    const info = await readLive2DInfo(a.live2d.model).catch(() => null);
    if (!info) return null;
    const exp = suggestMap(EMOTIONS, info.expressions, a.live2d.emotions ?? {});
    // (a motion only where its group's name says so: a model's Idle/Tap groups are left to the user)
    const mot = suggestMap(EMOTIONS.filter((e) => e !== "neutral"), info.motions.filter((m) => !/^(idle|tap)/i.test(m)), a.live2d.emotion_motions ?? {});
    const n = Object.keys(exp).length + Object.keys(mot).length;
    if (!n) return { avatar: a, n: 0 };
    return { avatar: { kind: "live2d", live2d: { ...a.live2d, emotions: { ...(a.live2d.emotions ?? {}), ...exp }, emotion_motions: { ...(a.live2d.emotion_motions ?? {}), ...mot } } }, n };
  }
  return null;
}

function Slider({ label, value, min, max, step, onChange, fmt, testId }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt: (v: number) => string; testId: string }) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-[12px] text-content-dim">
        <span>{label}</span>
        <span className="tabular-nums text-content-faint">{fmt(value)}</span>
      </span>
      <input type="range" className="mt-1 w-full accent-[rgb(var(--c-accent))]" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testId} />
    </label>
  );
}

function Stage({ avatar, name, react, children, className = "" }: { avatar: Avatar; name: string; react?: MateReact; children?: ReactNode; className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-xl border border-border bg-[radial-gradient(ellipse_at_50%_100%,rgb(var(--c-surface-3)),transparent_75%)] ${className}`} data-testid="look-stage">
      <MateAvatar avatar={avatar} name={name || "?"} size="sm" mood="idle" react={react ?? null} className="h-full w-full" />
      {children}
    </div>
  );
}

export function FileImport({ mate, onNext, onImported }: { mate: Mate; onNext: () => void; /** a file came in (its kind) */ onImported?: (kind: Avatar["kind"]) => void }) {
  const t = useT();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ n: number } | null>(null);
  const saver = useAvatarSaver(mate);
  const a = mate.avatar;
  const has = a.kind === "live2d" || a.kind === "livliv" || ((a.kind === "video" || a.kind === "photo") && !!a.rig.home);
  const { info } = useLive2DModelInfo(a.kind === "live2d" ? a.live2d.model : "");
  const [l2d, setL2d] = useState<Live2D | null>(a.kind === "live2d" ? a.live2d : null);
  const serverL2d = a.kind === "live2d" ? JSON.stringify(a.live2d) : "";
  useEffect(() => setL2d(serverL2d ? (JSON.parse(serverL2d) as Live2D) : null), [serverL2d]);
  const setFrame = (patch: Partial<Live2D>) => {
    if (!l2d) return;
    const next = { ...l2d, ...patch };
    setL2d(next);
    saver.save({ kind: "live2d", live2d: next });
  };

  const take = async (f: File) => {
    // (a look she already has — drawn, or another file — is replaced: asked first)
    if (a.kind !== "none" && !(await confirmDialog({ body: t("studio.fileReplaceConfirm", { name: mate.name || t("studio.untitled") }), confirmLabel: t("studio.fileReplace") }))) {
      if (file.current) file.current.value = "";
      return;
    }
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await importAvatarZip(mate.id, f);
      let m = r.mate;
      const matched = await matchedByName(r.mate.avatar);
      if (matched && matched.n > 0) m = await useMateStore.getState().patch(mate.id, { avatar: matched.avatar });
      useMateStore.getState().upsert(m);
      setDone({ n: matched?.n ?? 0 });
      onImported?.(m.avatar.kind);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  const picker = (
    <input ref={file} type="file" accept=".zip,.livliv,application/zip" hidden onChange={(e) => e.target.files?.[0] && void take(e.target.files[0])} data-testid="look-file-input" />
  );

  if (!has || busy)
    return (
      <div className="space-y-3" data-testid="look-import">
        {picker}
        <button
          type="button"
          disabled={busy}
          onClick={() => file.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void take(f);
          }}
          className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border px-4 py-8 text-center transition hover:border-accent/60 hover:bg-accent-soft/20"
          data-testid="look-file-drop"
        >
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent-soft text-accent">
            <Icon name={busy ? "spinner" : "upload"} size={20} spin={busy} />
          </span>
          <span className="text-[14px] font-semibold text-content">{busy ? t("studio.fileReading") : t("studio.fileDrop")}</span>
          <span className="text-[12px] text-content-dim">{t("studio.fileDropSub")}</span>
        </button>
        <div className="flex items-center gap-1.5 text-[12px] text-content-faint">
          <span>{t("studio.fileWhat")}</span>
          <HelpTip>{t("studio.fileWhatHelp")}</HelpTip>
        </div>
        {err && <p className="break-words rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger" data-testid="look-file-error">{err}</p>}
      </div>
    );

  const kind = KIND_LABEL[a.kind];
  const model = a.kind === "live2d" ? a.live2d.model : a.kind === "livliv" ? a.livliv.model : "";
  const exprN = a.kind === "live2d" ? info?.expressions.length : a.kind === "livliv" ? a.livliv.expressions?.length ?? 0 : undefined;
  return (
    <div className="space-y-4" data-testid="look-import" data-kind={a.kind}>
      {picker}
      {done && (
        <p className="flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2 text-[12.5px] text-success" data-testid="look-import-done">
          <Icon name="check" size={13} className="mt-0.5 shrink-0" />
          <span>{done.n ? t("studio.fileImportedMatched", { n: done.n }) : t("studio.fileImported")}</span>
        </p>
      )}
      {a.kind === "live2d" && <CoreNotice />}
      <div className="grid gap-4 sm:grid-cols-[220px,1fr]">
        <Stage avatar={l2d ? { kind: "live2d", live2d: l2d } : a} name={mate.name} className="h-[280px] sm:h-[300px]" />
        <div className="min-w-0 space-y-3">
          <div className="rounded-xl border border-border/70 px-3 py-2.5">
            <p className="text-[13px] font-semibold text-content">{kind ? t(kind) : a.kind}</p>
            {model && <p className="truncate font-mono text-[11px] text-content-faint" title={model}>{fileName(model)}</p>}
            {a.kind === "live2d" && info && (
              <p className="mt-1 text-[12px] text-content-dim" data-testid="look-import-counts">{t("studio.fileCounts", { expressions: info.expressions.length, motions: info.motions.length })}</p>
            )}
            {a.kind === "livliv" && <p className="mt-1 text-[12px] text-content-dim">{t("studio.fileCountsLv", { expressions: exprN ?? 0 })}</p>}
          </div>
          {l2d && (
            <div className="space-y-2.5" data-testid="look-frame">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-content-dim">
                {t("studio.fileFrame")}
                <HelpTip>{t("studio.fileFrameHelp")}</HelpTip>
              </p>
              <Slider label={t("studio.fileSize")} value={l2d.scale ?? 0.85} min={0.3} max={2} step={0.05} onChange={(v) => setFrame({ scale: v })} fmt={(v) => `${Math.round(v * 100)}%`} testId="look-scale" />
              <Slider label={t("studio.fileX")} value={l2d.x ?? 0} min={-200} max={200} step={2} onChange={(v) => setFrame({ x: v })} fmt={(v) => `${v > 0 ? "+" : ""}${v}`} testId="look-x" />
              <Slider label={t("studio.fileY")} value={l2d.y ?? 0} min={-200} max={200} step={2} onChange={(v) => setFrame({ y: v })} fmt={(v) => `${v > 0 ? "+" : ""}${v}`} testId="look-y" />
              <label className="block">
                <span className="text-[12px] text-content-dim">{t("studio.fileIdle")}</span>
                <select className="field mt-1 !py-1.5 text-[12.5px]" value={l2d.idle_group || ""} onChange={(e) => setFrame({ idle_group: e.target.value || undefined })} data-testid="look-idle">
                  <option value="">{t("studio.fileIdleDefault")}</option>
                  {(info?.motions || []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              {(l2d.scale !== undefined || l2d.x !== undefined || l2d.y !== undefined) && (
                <button type="button" className="btn-ghost !px-2 !py-1 text-[12px]" onClick={() => setFrame({ scale: undefined, x: undefined, y: undefined })} data-testid="look-frame-reset">
                  <Icon name="rotate" size={12} /> {t("studio.fileFrameReset")}
                </button>
              )}
            </div>
          )}
          <SaveState state={saver.state} err={saver.err} />
        </div>
      </div>
      {err && <p className="break-words rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{err}</p>}
      <div className="sticky -bottom-4 z-[1] -mx-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-surface px-4 py-3 sm:-mx-5 sm:px-5">
        <button type="button" className="btn-ghost text-[12.5px]" onClick={() => file.current?.click()} data-testid="look-file-replace">
          <Icon name="upload" size={13} /> {t("studio.fileOther")}
        </button>
        {(a.kind === "live2d" || a.kind === "livliv") && (
          <button type="button" className="btn-primary" onClick={onNext} data-testid="look-import-next">
            {t("studio.fileNext")} <Icon name="chevron" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── her emotions → the model's expressions and motions ──

/** what plays for an emotion the user left on 자동: a near emotion's choice, else an expression of that name */
function autoExpression(map: Record<string, string | number> | undefined, e: string, names: string[]): string {
  const near = lookupEmotion(map, e);
  if (near !== undefined) return String(near);
  const cands = emotionCandidates(e);
  return names.find((n) => cands.includes(n.toLowerCase())) ?? "";
}

export function EmotionMapper({ mate, onAi, onDone }: { mate: Mate; onAi?: (text: string) => void; onDone: () => void }) {
  const t = useT();
  const a = mate.avatar;
  const saver = useAvatarSaver(mate);
  const [react, setReact] = useState<MateReact>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const live2d = a.kind === "live2d" ? a.live2d : null;
  const livliv = a.kind === "livliv" ? a.livliv : null;
  const { info, err } = useLive2DModelInfo(live2d?.model ?? "");
  // (the user's choices, shown at once; the server's copy wins when it changes underneath)
  const serverKey = JSON.stringify(a);
  const [draft, setDraft] = useState<Avatar>(a);
  useEffect(() => setDraft(JSON.parse(serverKey) as Avatar), [serverKey]);
  const l2d = draft.kind === "live2d" ? draft.live2d : null;
  const lv = draft.kind === "livliv" ? draft.livliv : null;

  const expressions: string[] = useMemo(() => (live2d ? info?.expressions ?? [] : livliv?.expressions ?? []), [live2d, info, livliv]);
  const motions: string[] = useMemo(() => info?.motions ?? [], [info]);
  const emotions = useMemo(() => (lv ? EMOTIONS.filter((e) => e !== "neutral") : [...EMOTIONS]), [lv]);
  // (a motion tried on its own: shown on her through a stand-in emotion only the preview has)
  const [trying, setTrying] = useState<{ label: string; motion?: string } | null>(null);
  const play = (e: string) => {
    setTrying(null);
    setFocus(e);
    setReact({ name: e, at: Date.now() });
  };
  /** one of the model's own expressions or motions, before it goes with any emotion */
  const browse = (kind: "face" | "motion", name: string) => {
    setFocus(null);
    setTrying({ label: name, motion: kind === "motion" ? name : undefined });
    // (an expression answers to its own name; a motion to the stand-in)
    window.setTimeout(() => setReact({ name: kind === "motion" ? TRY : name, at: Date.now() }), 30);
  };

  const shown = useMemo<Avatar>(
    () => (draft.kind === "live2d" && trying?.motion ? { kind: "live2d", live2d: { ...draft.live2d, emotion_motions: { ...(draft.live2d.emotion_motions ?? {}), [TRY]: trying.motion } } } : draft),
    [draft, trying],
  );

  if (!live2d && !livliv)
    return (
      <div className="space-y-3" data-testid="look-mapper-none">
        <p className="rounded-lg bg-surface-3/50 px-3 py-2 text-[12.5px] text-content-dim">{t("studio.mapNone")}</p>
      </div>
    );

  const put = (next: Avatar, e?: string) => {
    setDraft(next);
    saver.save(next);
    if (e) window.setTimeout(() => play(e), 60);
  };
  const setExpr = (e: string, v: string) => {
    if (l2d) {
      const map = { ...(l2d.emotions ?? {}) } as Record<string, string | number>;
      if (v === "__auto") delete map[e];
      else map[e] = v === "__none" ? "" : v;
      put({ kind: "live2d", live2d: { ...l2d, emotions: map } }, e);
    } else if (lv) {
      const map = { ...(lv.emotions ?? {}) };
      if (v === "__auto") delete map[e];
      else map[e] = v === "__none" ? "" : v;
      put({ kind: "livliv", livliv: { ...lv, emotions: map } as LivLiv }, e);
    }
  };
  const setMotion = (e: string, v: string) => {
    if (!l2d) return;
    const map = { ...(l2d.emotion_motions ?? {}) };
    if (!v) delete map[e];
    else map[e] = v;
    put({ kind: "live2d", live2d: { ...l2d, emotion_motions: map } }, e);
  };
  const setTap = (area: string, group: string) => {
    if (!l2d) return;
    const map = { ...(l2d.tap_motions ?? {}) };
    if (!group) delete map[area];
    else map[area] = { group };
    put({ kind: "live2d", live2d: { ...l2d, tap_motions: map } });
  };
  const byName = () => {
    if (l2d) {
      const exp = suggestMap(emotions, expressions, l2d.emotions ?? {});
      const mot = suggestMap(emotions.filter((e) => e !== "neutral"), motions.filter((m) => !/^(idle|tap)/i.test(m)), l2d.emotion_motions ?? {});
      put({ kind: "live2d", live2d: { ...l2d, emotions: { ...(l2d.emotions ?? {}), ...exp }, emotion_motions: { ...(l2d.emotion_motions ?? {}), ...mot } } });
    } else if (lv) {
      const exp = suggestMap(emotions, expressions, lv.emotions ?? {});
      put({ kind: "livliv", livliv: { ...lv, emotions: { ...(lv.emotions ?? {}), ...exp } } as LivLiv });
    }
  };
  const clearAll = async () => {
    if (!(await confirmDialog({ body: t("studio.mapClearConfirm"), confirmLabel: t("studio.mapClear"), danger: true }))) return;
    if (l2d) put({ kind: "live2d", live2d: { ...l2d, emotions: {}, emotion_motions: {} } });
    else if (lv) put({ kind: "livliv", livliv: { ...lv, emotions: {} } as LivLiv });
  };

  const map = (l2d?.emotions ?? lv?.emotions ?? {}) as Record<string, string | number>;
  const motMap = l2d?.emotion_motions ?? {};

  const linked = emotions.filter((e) => (map[e] !== undefined && map[e] !== "") || !!motMap[e] || !!autoExpression(map, e, expressions)).length;
  const loading = !!live2d && !info && !err;

  return (
    <div className="space-y-4" data-testid="look-mapper" data-kind={draft.kind}>
      <div className="grid gap-4 md:grid-cols-[240px,1fr]">
        {/* her, trying each emotion (sticky beside the list on a wide window) */}
        <div className="md:sticky md:top-0 md:self-start">
          <Stage avatar={shown} name={mate.name} react={react} className="h-[260px] md:h-[340px]">
            {(focus || trying) && (
              <span className="absolute inset-x-0 bottom-2 mx-auto w-max max-w-[90%] truncate rounded-full bg-surface-2/90 px-2.5 py-0.5 text-[11.5px] text-content shadow-card" data-testid="look-mapper-now">
                {focus ? emotionLabel(t, focus) : trying!.label}
              </span>
            )}
          </Stage>
          <p className="mt-2 text-center text-[11.5px] text-content-faint">{t("studio.mapTryHint")}</p>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="pill bg-accent-soft tabular-nums text-content" data-testid="look-mapper-count">
              {t("studio.mapCount", { n: linked, total: emotions.length })}
            </span>
            <span className="flex-1" />
            <button type="button" className="btn-soft !px-2.5 !py-1 text-[12px]" onClick={byName} disabled={loading} data-testid="look-mapper-byname">
              <Icon name="wand" size={12} /> {t("studio.mapByName")}
            </button>
            {onAi && (
              <button type="button" className="btn-ghost !px-2.5 !py-1 text-[12px]" onClick={() => onAi(t("studio.aiAskMap"))} data-testid="look-mapper-ai">
                <Icon name="sparkles" size={12} /> {t("studio.askAi")}
              </button>
            )}
          </div>
          {err && <p className="break-words text-[12px] text-danger">{err}</p>}
          {loading ? (
            <p className="flex items-center gap-2 text-[12px] text-content-faint">
              <Icon name="spinner" size={13} spin /> {t("common.loading")}
            </p>
          ) : !expressions.length && !motions.length ? (
            <p className="rounded-lg bg-surface-3/50 px-3 py-2 text-[12.5px] text-content-dim" data-testid="look-mapper-empty">{t("studio.mapEmpty")}</p>
          ) : (
            <>
              {/* the model's own expressions and motions, tried one by one (names like exp_03 say nothing) */}
              <div className="space-y-1.5 rounded-xl border border-border/70 bg-surface-2/40 px-3 py-2.5" data-testid="look-browse">
                <p className="flex items-center gap-1 text-[12px] font-medium text-content-dim">
                  {t("studio.mapBrowse")}
                  <HelpTip>{t("studio.mapBrowseHelp")}</HelpTip>
                </p>
                {expressions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-[11px] text-content-faint">{t("studio.mapColFace")}</span>
                    {expressions.map((x) => (
                      <button key={x} type="button" className={`rounded-full border px-2 py-[1px] text-[11.5px] ${trying && !trying.motion && trying.label === x ? "border-accent bg-accent-soft text-content" : "border-border text-content-dim hover:bg-surface-3"}`} onClick={() => browse("face", x)} data-testid="look-browse-face">
                        {x}
                      </button>
                    ))}
                  </div>
                )}
                {l2d && motions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-[11px] text-content-faint">{t("studio.mapColMotion")}</span>
                    {motions.map((x) => (
                      <button key={x} type="button" className={`rounded-full border px-2 py-[1px] text-[11.5px] ${trying?.motion === x ? "border-accent bg-accent-soft text-content" : "border-border text-content-dim hover:bg-surface-3"}`} onClick={() => browse("motion", x)} data-testid="look-browse-motion">
                        <Icon name="play" size={9} className="mr-0.5 inline" />
                        {x}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className={`grid items-center gap-x-2 px-1 text-[11px] font-medium text-content-faint ${l2d ? "grid-cols-[minmax(64px,88px),1fr,1fr,28px]" : "grid-cols-[minmax(64px,88px),1fr,28px]"}`}>
                <span>{t("studio.mapColEmotion")}</span>
                <span>{t("studio.mapColFace")}</span>
                {l2d && <span>{t("studio.mapColMotion")}</span>}
                <span />
              </div>
              <ul className="space-y-1" data-testid="look-mapper-rows">
                {emotions.map((e) => {
                  const v = map[e];
                  const auto = autoExpression(map, e, expressions);
                  const exprValue = v === undefined ? "__auto" : v === "" ? "__none" : String(v);
                  return (
                    <li
                      key={e}
                      className={`grid items-center gap-x-2 rounded-lg px-1 py-0.5 ${focus === e ? "bg-accent-soft/40" : ""} ${l2d ? "grid-cols-[minmax(64px,88px),1fr,1fr,28px]" : "grid-cols-[minmax(64px,88px),1fr,28px]"}`}
                      data-testid={`look-map-${e}`}
                    >
                      <span className="truncate text-[12.5px] text-content" title={e}>
                        {emotionLabel(t, e)}
                      </span>
                      <select className="field min-w-0 !py-1 text-[12px]" value={exprValue} onChange={(ev) => setExpr(e, ev.target.value)} aria-label={`${emotionLabel(t, e)} · ${t("studio.mapColFace")}`} data-testid={`look-map-${e}-face`}>
                        <option value="__auto">{auto ? t("studio.mapAutoIs", { name: auto }) : t("studio.mapAutoNone")}</option>
                        <option value="__none">{t("studio.mapNoFace")}</option>
                        {expressions.map((x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ))}
                        {exprValue !== "__auto" && exprValue !== "__none" && !expressions.includes(exprValue) && <option value={exprValue}>{exprValue}</option>}
                      </select>
                      {l2d && (
                        <select className="field min-w-0 !py-1 text-[12px]" value={motMap[e] ?? ""} onChange={(ev) => setMotion(e, ev.target.value)} aria-label={`${emotionLabel(t, e)} · ${t("studio.mapColMotion")}`} data-testid={`look-map-${e}-motion`}>
                          <option value="">{t("studio.mapNoMotion")}</option>
                          {motions.map((x) => (
                            <option key={x} value={x}>
                              {x}
                            </option>
                          ))}
                          {motMap[e] && !motions.includes(motMap[e]) && <option value={motMap[e]}>{motMap[e]}</option>}
                        </select>
                      )}
                      <button type="button" className="grid h-7 w-7 place-items-center rounded-md text-content-dim hover:bg-surface-3 hover:text-content" onClick={() => play(e)} aria-label={t("studio.mapTry", { emotion: emotionLabel(t, e) })} title={t("studio.mapTry", { emotion: emotionLabel(t, e) })} data-testid={`look-map-${e}-try`}>
                        <Icon name="play" size={12} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {l2d && (info?.hitAreas.length ?? 0) > 0 && motions.length > 0 && (
            <details className="rounded-xl border border-border/70 px-3 py-2" data-testid="look-taps">
              <summary className="cursor-pointer text-[12.5px] font-medium text-content-dim">
                {t("studio.mapTaps")} <HelpTip>{t("studio.mapTapsHelp")}</HelpTip>
              </summary>
              <div className="mt-2 space-y-1">
                {info!.hitAreas.map((h) => (
                  <label key={h} className="grid grid-cols-[minmax(64px,120px),1fr] items-center gap-2">
                    <span className="truncate text-[12px] text-content-dim">{h}</span>
                    <select className="field !py-1 text-[12px]" value={l2d.tap_motions?.[h]?.group ?? ""} onChange={(ev) => setTap(h, ev.target.value)} data-testid={`look-tap-${h}`}>
                      <option value="">{t("studio.mapTapDefault")}</option>
                      {motions.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
      <div className="sticky -bottom-4 z-[1] -mx-4 flex flex-wrap items-center gap-2 border-t border-border/60 bg-surface px-4 py-3 sm:-mx-5 sm:px-5">
        <button type="button" className="btn-ghost !px-2 text-[12px] text-content-faint" onClick={() => void clearAll()} data-testid="look-mapper-clear">
          {t("studio.mapClear")}
        </button>
        <SaveState state={saver.state} err={saver.err} />
        <span className="flex-1" />
        <button type="button" className="btn-primary" onClick={onDone} data-testid="look-mapper-done">
          <Icon name="check" size={13} /> {t("studio.mapDone")}
        </button>
      </div>
    </div>
  );
}

