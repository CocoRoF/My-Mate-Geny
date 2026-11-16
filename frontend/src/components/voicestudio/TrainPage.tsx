/**
 * Voice Studio → 학습 (docs/local-voice.md "Training a voice"): the recordings of one person → each chosen model
 * (OmniVoice, Qwen3-TTS, CosyVoice3) learns her voice (a LoRA adapter). Only recordings are asked for: they are cut
 * into utterances, transcribed and kept to her voice once, then each model is trained on them, measured against the
 * voice without it (with a long clip, a short one and — where the model can — none), and the result, when it is
 * better, is put on the voice for that model. Runs one at a time, pausing while a mate speaks and stepping off the GPU
 * when it is needed; each run's report, A/B samples, and on / off / remove.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyTraining,
  cancelTraining,
  createLocalVoice,
  createTraining,
  deleteTraining,
  listTrainings,
  TRAINING_STAGES,
  trainingSampleUrl,
  type TrainingCondition,
  type TrainingConditions,
  type TrainingKit,
  type TrainingRun,
  type TrainingState,
} from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import { relTime } from "../../i18n/format";
import { confirmDialog } from "../ui/ConfirmDialog";
import Icon from "../ui/Icon";
import { Banner, ErrorLine, Field, ProgressBar, Segmented, StatusBadge, type Status } from "../mate/settings/ui";
import { Card, PlayButton, useStudio } from "./shared";

const ACTIVE: TrainingState[] = ["queued", "waiting", "running", "released"];
const LANGS = ["auto", "ko", "en", "ja", "zh"] as const;
const TONE: Record<TrainingState, Status> = {
  queued: "checking", waiting: "checking", running: "checking", released: "warn", done: "ok", failed: "error",
  canceled: "off", interrupted: "warn",
};
const NEW = "__new";

const pct = (x: number | undefined) => (x == null ? "–" : `${Math.round(x * 100)}`);
const mins = (s: number | undefined) => {
  if (s == null) return "–";
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.round(s)}s`;
};

export default function TrainPage() {
  const t = useT();
  const { voices, reloadVoices, go } = useStudio();
  const [runs, setRuns] = useState<TrainingRun[] | null>(null);
  const [kit, setKit] = useState<TrainingKit | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await listTrainings();
      setRuns(r.runs);
      setKit(r.kit);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  const active = runs?.some((r) => ACTIVE.includes(r.state)) ?? false;
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), active ? 2000 : 10000);
    return () => clearInterval(timer);
  }, [load, active]);
  const mine = useMemo(() => voices.filter((v) => !v.builtin), [voices]);
  return (
    <div className="space-y-4" data-testid="vs-train">
      <p className="text-[13px] leading-relaxed text-content-dim">{t("voiceStudio.trHint")}</p>
      {kit && !kit.models.some((m) => m.installed) && (
        <Banner tone="warn" action={<button className="btn-soft !py-1 text-[12.5px]" onClick={() => go("models")}>{t("voiceStudio.trToModels")}</button>} testId="vs-train-needs-model">
          {t("voiceStudio.trNeedsModel")}
        </Banner>
      )}
      <NewRun kit={kit} voices={mine} onStarted={async () => { await reloadVoices(); await load(); }} busy={new Set((runs ?? []).filter((r) => ACTIVE.includes(r.state)).map((r) => `${r.voice_id}|${r.model_id}`))} />
      <ErrorLine text={err} />
      {!runs ? (
        <ProgressBar indeterminate />
      ) : runs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-content-faint">{t("voiceStudio.trNone")}</p>
      ) : (
        <div className="space-y-3">
          {runs.map((r) => <RunCard key={r.id} run={r} onChanged={async () => { await load(); await reloadVoices(); }} />)}
        </div>
      )}
    </div>
  );
}

function NewRun({ kit, voices, onStarted, busy }: { kit: TrainingKit | null; voices: { id: string; name: string; language: string }[]; onStarted: () => Promise<void>; busy: Set<string> }) {
  const t = useT();
  const [voice, setVoice] = useState<string>("");
  const installed = useMemo(() => (kit?.models ?? []).filter((m) => m.installed), [kit]);
  const [models, setModels] = useState<string[] | null>(null); // (null: every installed one, until one is unticked)
  const chosen = models ?? installed.map((m) => m.id);
  const busyVoice = (id: string) => installed.some((m) => busy.has(`${id}|${m.id}`));
  const clash = chosen.some((m) => busy.has(`${voice}|${m}`));
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [lang, setLang] = useState<(typeof LANGS)[number]>("auto");
  const [accept, setAccept] = useState(false);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!voice && voices.length) setVoice(voices[0].id);
    if (!voice && !voices.length) setVoice(NEW);
  }, [voices, voice]);
  const fetches = kit ? [!kit.stt.ready && `Whisper large-v3-turbo (${kit.stt.gb.toFixed(1)} GB, ${kit.stt.license})`, !kit.speaker.ready && `CAM++ (${Math.max(0.03, kit.speaker.gb).toFixed(2)} GB, ${kit.speaker.license})`].filter(Boolean) as string[] : [];
  const totalMb = files.reduce((n, f) => n + f.size, 0) / 1024 ** 2;
  const add = (list: FileList | null) => {
    // (taken now: the input is cleared right after, which empties its FileList)
    const picked = Array.from(list ?? []).filter((f) => f.type.startsWith("audio") || f.type.startsWith("video") || /\.(wav|mp3|m4a|flac|ogg|opus|aac|webm|mp4|mov|mkv)$/i.test(f.name));
    if (picked.length) setFiles((old) => [...old, ...picked].slice(0, 12));
  };
  const can = !working && files.length > 0 && (voice !== NEW || name.trim()) && (!fetches.length || accept) && chosen.length > 0 && !clash;
  const needGb = Math.max(0, ...installed.filter((m) => chosen.includes(m.id)).map((m) => m.need_gb));
  const start = async () => {
    setWorking(true);
    setErr(null);
    try {
      let vid = voice;
      if (vid === NEW) vid = (await createLocalVoice(name.trim(), lang === "auto" ? "auto" : lang)).id;
      await createTraining(vid, files, { language: lang === "auto" ? "" : lang, acceptLicenses: accept, models: chosen });
      setFiles([]);
      setName("");
      if (voice === NEW) setVoice(vid);
      await onStarted();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <Card title={<span className="flex items-center gap-1.5"><Icon name="sparkles" size={14} /> {t("voiceStudio.trNew")}</span>} testId="vs-train-new">
      <div className="space-y-3">
        <Field label={t("voiceStudio.trVoice")} as="div">
          <div className="flex flex-wrap items-center gap-2">
            <select className="field !w-auto min-w-[12rem]" value={voice} onChange={(e) => setVoice(e.target.value)} data-testid="vs-train-voice">
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{busyVoice(v.id) ? ` · ${t("voiceStudio.trBusyVoice")}` : ""}</option>)}
              <option value={NEW}>{t("voiceStudio.trNewVoice")}</option>
            </select>
            {voice === NEW && <input className="field !w-auto min-w-[12rem]" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("voiceStudio.trNewVoicePh")} data-testid="vs-train-name" />}
          </div>
          {clash && <p className="mt-1 text-[11.5px] text-content-faint" data-testid="vs-train-busy">{t("voiceStudio.trBusyHint")}</p>}
        </Field>
        <div
          className={`rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors ${drag ? "border-accent bg-accent-soft/30" : "border-border hover:border-accent/50"}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
          data-testid="vs-train-drop"
        >
          <Icon name="upload" size={20} className="mx-auto text-content-faint" />
          <p className="mt-1.5 text-[13px] text-content">{t("voiceStudio.trDrop")}</p>
          <p className="mt-0.5 text-[11.5px] text-content-faint">{t("voiceStudio.trDropHint")}</p>
          <button type="button" className="btn-soft mt-2.5 !py-1 text-[12.5px]" onClick={() => input.current?.click()}>{t("voiceStudio.trPick")}</button>
          <input ref={input} type="file" multiple accept="audio/*,video/*" className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ""; }} data-testid="vs-train-files" />
        </div>
        {files.length > 0 && (
          <ul className="space-y-1 text-[12.5px]" data-testid="vs-train-list">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5">
                <Icon name={f.type.startsWith("video") ? "film" : "music"} size={13} className="shrink-0 text-content-faint" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="shrink-0 text-[11.5px] text-content-faint">{(f.size / 1024 ** 2).toFixed(1)} MB</span>
                <button type="button" className="btn-ghost !p-1" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={t("common.remove")}><Icon name="x" size={12} /></button>
              </li>
            ))}
            <li className="px-1 text-[11.5px] text-content-faint">{t("voiceStudio.trFilesTotal", { n: files.length, mb: totalMb.toFixed(0) })}</li>
          </ul>
        )}
        {installed.length > 0 && (
          <Field label={t("voiceStudio.trModels")} as="div">
            <div className="flex flex-wrap gap-x-4 gap-y-1.5" data-testid="vs-train-models">
              {installed.map((m) => (
                <label key={m.id} className="flex items-center gap-1.5 text-[12.5px] text-content">
                  <input type="checkbox" checked={chosen.includes(m.id)} data-testid={`vs-train-model-${m.id}`}
                    onChange={(e) => setModels(e.target.checked ? [...chosen, m.id] : chosen.filter((x) => x !== m.id))} />
                  {m.name}
                </label>
              ))}
            </div>
            {kit && kit.models.some((m) => !m.installed) && (
              <p className="mt-1 text-[11.5px] text-content-faint">{t("voiceStudio.trModelsMore", { names: kit.models.filter((m) => !m.installed).map((m) => m.name).join(", ") })}</p>
            )}
          </Field>
        )}
        <Field label={t("voiceStudio.trLanguage")} as="div">
          <Segmented value={lang} onChange={setLang} options={LANGS.map((l) => ({ id: l, label: t(`voiceStudio.trLang_${l}` as MsgKey) }))} testId="vs-train-lang" />
        </Field>
        {fetches.length > 0 && (
          <label className="flex items-start gap-2 rounded-lg border border-border/70 bg-surface-2/40 px-3 py-2 text-[12px] text-content-dim">
            <input type="checkbox" className="mt-0.5" checked={accept} onChange={(e) => setAccept(e.target.checked)} data-testid="vs-train-accept" />
            <span>{t("voiceStudio.trFetches", { what: fetches.join(" · ") })}</span>
          </label>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="min-w-0 flex-1 text-[11.5px] text-content-faint">{t(chosen.length > 1 ? "voiceStudio.trCostMany" : "voiceStudio.trCost", { gb: needGb || 6, n: chosen.length })}</span>
          <button className="btn-primary !py-1.5 text-[13px]" disabled={!can} onClick={() => void start()} data-testid="vs-train-start">
            {working ? <Icon name="spinner" size={13} spin /> : <Icon name="sparkles" size={13} />} {t("voiceStudio.trStart")}
          </button>
        </div>
        <ErrorLine text={err} />
      </div>
    </Card>
  );
}

function RunCard({ run, onChanged }: { run: TrainingRun; onChanged: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = ACTIVE.includes(run.state);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stage = run.state === "done" ? "done" : run.stage === "eval" ? "train" : run.stage;
  const at = TRAINING_STAGES.indexOf(stage as (typeof TRAINING_STAGES)[number]);
  return (
    <Card
      testId="vs-train-run"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-content">{run.voice_name || run.voice_id}</span>
          <span className="pill border border-border bg-surface-3/50 text-content-dim" data-testid="vs-train-model" data-model={run.model_id}>{run.model_name || run.model_id}</span>
          <StatusBadge status={TONE[run.state]} testId="vs-train-state">{t(`voiceStudio.trState_${run.state}` as MsgKey)}</StatusBadge>
          {run.applied && <span className="pill border border-accent/40 bg-accent-soft text-accent" data-testid="vs-train-applied">{t("voiceStudio.trApplied")}</span>}
          <span className="text-[11.5px] font-normal text-content-faint">{relTime(run.created_at)}</span>
        </span>
      }
      right={
        live ? (
          <button className="btn-ghost !py-1 text-[12px]" disabled={busy} onClick={() => void act(() => cancelTraining(run.id))} data-testid="vs-train-cancel">{t("common.cancel")}</button>
        ) : (
          <button className="btn-ghost !py-1 text-[12px] text-content-faint" disabled={busy} data-testid="vs-train-delete"
            onClick={async () => { if (await confirmDialog({ body: t("voiceStudio.trDeleteConfirm"), confirmLabel: t("common.delete"), danger: true })) void act(() => deleteTraining(run.id)); }}>
            <Icon name="trash" size={12} /> {t("common.delete")}
          </button>
        )
      }
    >
      <div className="space-y-3" data-run={run.id} data-state={run.state}>
        {run.state !== "failed" && run.state !== "canceled" && (
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[11.5px]" data-testid="vs-train-steps">
            {TRAINING_STAGES.map((s, i) => {
              const doneStep = run.state === "done" || i < at;
              const now = i === at && run.state !== "done";
              return (
                <li key={s} className={`flex items-center gap-1 rounded-full px-2 py-0.5 ${now ? "bg-accent-soft text-accent" : doneStep ? "text-content-dim" : "text-content-faint"}`}>
                  {doneStep ? <Icon name="check" size={11} /> : now ? <Icon name="spinner" size={11} spin /> : <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-50" />}
                  {t(`voiceStudio.trStage_${s}` as MsgKey)}
                </li>
              );
            })}
          </ol>
        )}
        {live && <Live run={run} />}
        {(run.data.kept_s != null || run.state === "done") && <DataLine run={run} />}
        {run.state === "done" && <Result run={run} busy={busy} onApply={(on) => act(() => applyTraining(run.id, on))} />}
        {run.state === "failed" && <ErrorLine text={failText(t, run)} />}
        <ErrorLine text={err} />
      </div>
    </Card>
  );
}

function failText(t: ReturnType<typeof useT>, run: TrainingRun): string {
  const known = ["too_little", "no_speech", "oom", "download", "runtime", "needs_model", "license"];
  if (known.includes(run.code)) return t(`voiceStudio.trFail_${run.code}` as MsgKey, { s: Math.round(run.data.kept_s ?? 0) });
  return t("voiceStudio.trFailed", { error: run.error || run.code });
}

function Live({ run }: { run: TrainingRun }) {
  const t = useT();
  const p = run.progress || {};
  if (run.state === "queued") return <p className="text-[12.5px] text-content-dim">{t("voiceStudio.trQueued")}</p>;
  if (run.state === "waiting") return <p className="text-[12.5px] text-content-dim" data-testid="vs-train-waiting">{t(`voiceStudio.trWait_${p.waiting_for === "a call" ? "call" : p.waiting_for === "speaking" ? "speaking" : "gpu"}` as MsgKey)}</p>;
  if (run.state === "released") return <p className="text-[12.5px] text-content-dim">{t("voiceStudio.trReleased", { step: p.step ?? 0 })}</p>;
  const stage = run.stage;
  const paused = p.stage === "paused";
  if (stage === "kit") {
    const of = p.total_bytes ?? 0;
    return (
      <div className="space-y-1.5" data-testid="vs-train-kit">
        {of > 0 ? <ProgressBar value={(p.done_bytes ?? 0) / of} /> : <ProgressBar indeterminate />}
        <p className="flex flex-wrap gap-x-3 text-[12px] text-content-dim">
          <span>{t(`voiceStudio.trKit_${p.what === "runtime" ? "runtime" : p.what === "stt" ? "stt" : "speaker"}` as MsgKey)}</span>
          {of > 0 && <span className="tabular-nums">{t("voiceStudio.trKitBytes", { done: ((p.done_bytes ?? 0) / 1024 ** 3).toFixed(2), of: (of / 1024 ** 3).toFixed(2) })}</span>}
        </p>
      </div>
    );
  }
  if (stage === "train" || stage === "eval") {
    const step = p.step ?? 0;
    const steps = p.steps ?? 0;
    return (
      <div className="space-y-1.5" data-testid="vs-train-progress">
        <ProgressBar value={steps ? step / steps : 0} />
        <p className="flex flex-wrap gap-x-3 text-[12px] text-content-dim">
          <span>{t("voiceStudio.trSteps", { step, steps })}</span>
          {p.eta_s != null && p.eta_s > 0 && <span>{t("voiceStudio.trEta", { m: Math.max(1, Math.round(p.eta_s / 60)) })}</span>}
          {stage === "eval" && <span>{t("voiceStudio.trMeasuring")}</span>}
          {paused && <span className="text-warning">{t("voiceStudio.trPaused")}</span>}
        </p>
      </div>
    );
  }
  const n = p.done ?? 0;
  const of = p.total ?? 0;
  const line =
    stage === "prepare" ? t("voiceStudio.trPrepare", { n, of, found: p.found ?? 0, s: mins(p.found_s) })
    : stage === "transcribe" ? t("voiceStudio.trTranscribe", { n, of })
    : stage === "tokens" ? t("voiceStudio.trTokens", { n, of })
    : stage === "baseline" || stage === "screen" ? t("voiceStudio.trBaseline")
    : t("voiceStudio.trStarting");
  return (
    <div className="space-y-1.5">
      {of > 0 ? <ProgressBar value={n / of} /> : <ProgressBar indeterminate />}
      <p className="text-[12px] text-content-dim">{line}</p>
    </div>
  );
}

function DataLine({ run }: { run: TrainingRun }) {
  const t = useT();
  const d = run.data;
  const dr = d.dropped;
  const recorded = run.inputs.reduce((n, i) => n + (i.seconds || 0), 0);
  return (
    <p className="text-[12px] text-content-dim" data-testid="vs-train-data">
      {t("voiceStudio.trData", { kept: d.kept ?? 0, s: mins(d.kept_s), of: mins(recorded) })}
      {dr && dr.speaker + dr.words + dr.sound > 0 && <> {t("voiceStudio.trDropped", { speaker: dr.speaker, words: dr.words, sound: dr.sound })}</>}
    </p>
  );
}

function Result({ run, busy, onApply }: { run: TrainingRun; busy: boolean; onApply: (on: boolean) => Promise<void> }) {
  const t = useT();
  const [want, setWant] = useState<boolean | null>(null); // (shown as asked until the server has it)
  const r = run.result;
  const base = r.base as TrainingConditions | undefined;
  const tuned = r.tuned as TrainingConditions | undefined;
  const has = (n: string) => run.samples.includes(n);
  // (what it was measured with — a model that can't speak without a clip has no "none")
  const conds = (r.conditions ?? (["long", "short", "none"] as const).filter((c) => base?.[c] && tuned?.[c])) as TrainingCondition[];
  const shown = conds.filter((c) => run.samples.some((n) => n.startsWith(`base-${c}-`)));
  return (
    <div className="space-y-3" data-testid="vs-train-result">
      <p className={`text-[13px] ${r.improved ? "text-success" : "text-content-dim"}`}>
        {r.improved ? (run.applied ? t("voiceStudio.trDoneApplied") : t("voiceStudio.trDoneOff")) : t("voiceStudio.trNoGain")}
      </p>
      {base && tuned && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[22rem] text-[12.5px]" data-testid="vs-train-table">
            <thead>
              <tr className="text-left text-[11.5px] text-content-faint">
                <th className="py-1 pr-2 font-medium">{t("voiceStudio.trWith")}</th>
                <th className="py-1 pr-2 font-medium">{t("voiceStudio.trBefore")}</th>
                <th className="py-1 pr-2 font-medium">{t("voiceStudio.trAfter")}</th>
                <th className="py-1 font-medium">{t("voiceStudio.trWords")}</th>
              </tr>
            </thead>
            <tbody>
              {conds.filter((c) => base[c] && tuned[c]).map((c) => {
                const [b0, t0] = [base[c]!, tuned[c]!];
                const d = Math.round((t0.similarity - b0.similarity) * 100);
                return (
                  <tr key={c} className="border-t border-border/50">
                    <td className="py-1.5 pr-2 text-content">{t(`voiceStudio.trCond_${c}` as MsgKey)}</td>
                    <td className="py-1.5 pr-2 text-content-dim">{pct(b0.similarity)}</td>
                    <td className="py-1.5 pr-2 font-medium text-content">
                      {pct(t0.similarity)} <span className={`text-[11px] ${d > 0 ? "text-success" : d < 0 ? "text-danger" : "text-content-faint"}`}>{d > 0 ? `+${d}` : d}</span>
                    </td>
                    <td className="py-1.5 text-content-dim">{pct(1 - t0.cer)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-content-faint">{t("voiceStudio.trTableHint")}</p>
        </div>
      )}
      {run.samples.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2" data-testid="vs-train-samples">
          {shown.map((c) => (
            <div key={c} className="rounded-lg border border-border/60 px-3 py-2">
              <p className="mb-1.5 text-[12px] font-medium text-content">{t(`voiceStudio.trCond_${c}` as MsgKey)}</p>
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-2 py-0.5 text-[12px] text-content-dim">
                  <span className="w-16 shrink-0">{t("voiceStudio.trLine", { n: i + 1 })}</span>
                  {has(`base-${c}-${i}.wav`) && <span className="flex items-center gap-1">{t("voiceStudio.trBefore")} <PlayButton small url={trainingSampleUrl(run.id, `base-${c}-${i}.wav`)} testId={`vs-train-play-base-${c}-${i}`} /></span>}
                  {has(`tuned-${c}-${i}.wav`) && <span className="flex items-center gap-1">{t("voiceStudio.trAfter")} <PlayButton small url={trainingSampleUrl(run.id, `tuned-${c}-${i}.wav`)} testId={`vs-train-play-tuned-${c}-${i}`} /></span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-content-dim">
        {r.improved && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={want ?? run.applied} disabled={busy} data-testid="vs-train-apply"
              onChange={(e) => { setWant(e.target.checked); void onApply(e.target.checked).finally(() => setWant(null)); }} />
            {t("voiceStudio.trApply")}
          </label>
        )}
        <span className="text-content-faint">{t("voiceStudio.trStats", { step: r.best_step ?? 0, steps: r.steps ?? 0, m: r.minutes ?? 0 })}</span>
      </div>
    </div>
  );
}
