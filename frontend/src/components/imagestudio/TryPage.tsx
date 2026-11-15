/**
 * Image Studio → 시험: each recipe tried by hand, with the settings the avatar maker uses — a draft from words, a
 * picture changed by words, a loop that starts and ends on a picture, a cut-out. A result can go straight on as the
 * next step's input (a draft → change it → animate it), and everything made here stays in 기록.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cancelImageJob, getImageJob, imageJobFileUrl, listImageJobs, submitImageJob, USES, type ImageJob, type ImageUse, type MediaInput } from "../../api/image";
import { useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";
import { Banner, ErrorLine, Field, ProgressBar, Segmented } from "../mate/settings/ui";
import { Card, duration, KIND_ICON, LiveLine, mainOutput, Preview, useImageStudio } from "./shared";

const SIZES = {
  portrait: [864, 1152],
  square: [1024, 1024],
  wide: [1152, 864],
} as const;
type Size = keyof typeof SIZES;

export default function TryPage() {
  const t = useT();
  const { status, handoff } = useImageStudio();
  const [use, setUse] = useState<ImageUse>(handoff?.use ?? "draft");
  const [job, setJob] = useState<ImageJob | null>(null);
  useEffect(() => {
    if (handoff) setUse(handoff.use);
  }, [handoff]);
  if (!status) return null;
  const recipe = status.recipes.find((r) => r.use === use);
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-testid="is-try">
      <div className="space-y-3">
        <Segmented
          value={use}
          onChange={(u) => setUse(u)}
          options={USES.map((u) => ({ id: u, label: t(`imageStudio.use_${u}` as MsgKey) }))}
          testId="is-try-use"
        />
        {recipe && <p className="text-[12px] leading-snug text-content-dim">{recipe.description}</p>}
        {recipe && !recipe.ready && (
          <Banner tone="warn" testId="is-try-no-model">
            {t("imageStudio.tryNoModel", { use: t(`imageStudio.use_${use}` as MsgKey) })}
          </Banner>
        )}
        <Form key={use} use={use} disabled={!recipe?.ready} onJob={setJob} />
      </div>
      <Result job={job} onJob={setJob} />
    </div>
  );
}

function Form({ use, disabled, onJob }: { use: ImageUse; disabled: boolean; onJob: (j: ImageJob) => void }) {
  const t = useT();
  const { status, handoff } = useImageStudio();
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [image, setImage] = useState<MediaInput | null>(handoff && handoff.use === use ? { from: handoff.from } : null);
  const [refs, setRefs] = useState<MediaInput[]>([]);
  const [size, setSize] = useState<Size>("portrait");
  const [count, setCount] = useState(2);
  const [seconds, setSeconds] = useState(4);
  const [seed, setSeed] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (handoff && handoff.use === use) setImage({ from: handoff.from });
  }, [handoff, use]);
  const models = (status?.models ?? []).filter((m) => m.installed && m.uses.includes(use));
  const needsImage = use !== "draft";
  const needsPrompt = use !== "cutout";
  const can = !disabled && !busy && (!needsImage || !!image) && (!needsPrompt || prompt.trim().length > 0);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const params: Record<string, unknown> = {};
      if (seed.trim() && Number.isFinite(Number(seed))) params.seed = Number(seed);
      if (use === "draft") {
        params.width = SIZES[size][0];
        params.height = SIZES[size][1];
        params.count = count;
      }
      if (use === "loop") params.seconds = seconds;
      const j = await submitImageJob({
        kind: use,
        prompt: needsPrompt ? prompt : undefined,
        negative: use === "draft" ? negative : undefined,
        params,
        model_id: model || undefined,
        image: needsImage ? image : null,
        refs: use === "edit" ? refs : undefined,
      });
      onJob(j);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testId={`is-try-form-${use}`}>
      <div className="space-y-3">
        {needsImage && (
          <Field label={t(use === "loop" ? "imageStudio.tryBase" : "imageStudio.tryPicture")} as="div">
            <MediaPick value={image} onChange={setImage} testId={`is-try-image-${use}`} />
          </Field>
        )}
        {needsPrompt && (
          <Field label={t(`imageStudio.tryPrompt_${use}` as MsgKey)} hint={t(`imageStudio.tryPromptHint_${use}` as MsgKey)}>
            <textarea
              className="field min-h-[84px] text-[13px]"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t(`imageStudio.tryPlaceholder_${use}` as MsgKey)}
              data-testid={`is-try-prompt-${use}`}
            />
          </Field>
        )}
        {use === "edit" && (
          <Field label={t("imageStudio.tryRefs")} hint={t("imageStudio.tryRefsHint")} as="div">
            <div className="flex flex-wrap gap-2">
              {refs.map((r, i) => (
                <MediaPick key={i} value={r} onChange={(v) => setRefs((rs) => (v ? rs.map((x, k) => (k === i ? v : x)) : rs.filter((_, k) => k !== i)))} small />
              ))}
              {refs.length < 3 && <MediaPick value={null} onChange={(v) => v && setRefs((rs) => [...rs, v])} small testId="is-try-ref-add" />}
            </div>
          </Field>
        )}
        <div className="flex flex-wrap items-end gap-3">
          {use === "draft" && (
            <>
              <Field label={t("imageStudio.trySize")} as="div">
                <Segmented value={size} onChange={setSize} options={(Object.keys(SIZES) as Size[]).map((s) => ({ id: s, label: t(`imageStudio.size_${s}` as MsgKey) }))} />
              </Field>
              <Field label={t("imageStudio.tryCount")} as="div">
                <Segmented value={String(count)} onChange={(v) => setCount(Number(v))} options={["1", "2", "4"].map((n) => ({ id: n, label: n }))} />
              </Field>
            </>
          )}
          {use === "loop" && (
            <Field label={t("imageStudio.trySeconds")} as="div">
              <Segmented value={String(seconds)} onChange={(v) => setSeconds(Number(v))} options={["3", "4", "5"].map((n) => ({ id: n, label: `${n}s` }))} />
            </Field>
          )}
          {models.length > 1 && (
            <Field label={t("imageStudio.tryModel")}>
              <select className="field !w-auto !py-1 text-[12.5px]" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">{t("imageStudio.tryModelDefault")}</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
          )}
          {use !== "cutout" && (
            <Field label={t("imageStudio.trySeed")}>
              <input className="field !w-28 !py-1 text-[12.5px]" value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))} placeholder={t("imageStudio.trySeedRandom")} />
            </Field>
          )}
        </div>
        {use === "draft" && (
          <details className="text-[12px]">
            <summary className="cursor-pointer select-none text-content-dim">{t("imageStudio.tryNegative")}</summary>
            <textarea className="field mt-1.5 min-h-[56px] text-[12.5px]" value={negative} onChange={(e) => setNegative(e.target.value)} placeholder={t("imageStudio.tryNegativeHint")} />
          </details>
        )}
        {use === "loop" && <p className="text-[11.5px] leading-snug text-content-faint">{t("imageStudio.tryLoopHint")}</p>}
        <div className="flex items-center gap-2">
          <button className="btn-primary !py-1.5 text-[13px]" disabled={!can} onClick={() => void submit()} data-testid={`is-try-run-${use}`}>
            {busy ? <Icon name="spinner" size={13} spin /> : <Icon name={KIND_ICON[use]} size={13} />} {t(`imageStudio.tryRun_${use}` as MsgKey)}
          </button>
          {status?.queue.running && <span className="text-[11.5px] text-content-faint">{t("imageStudio.tryQueued")}</span>}
        </div>
        <ErrorLine text={err} />
      </div>
    </Card>
  );
}

/** a picture: one the user picks (drop or browse), or a result from 기록 */
function MediaPick({ value, onChange, small, testId }: { value: MediaInput | null; onChange: (v: MediaInput | null) => void; small?: boolean; testId?: string }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<{ job: ImageJob; name: string }[] | null>(null);
  const [open, setOpen] = useState(false);
  const url = useMemo(() => (!value ? null : value instanceof File ? URL.createObjectURL(value) : imageJobFileUrl(...(value.from.split("/") as [string, string]))), [value]);
  useEffect(() => () => void (url && value instanceof File && URL.revokeObjectURL(url)), [url, value]);
  useEffect(() => {
    if (!open || recent) return;
    listImageJobs({ limit: 40 })
      .then((r) =>
        setRecent(
          r.items
            .filter((j) => j.state === "done")
            .flatMap((j) => j.outputs.filter((o) => o.kind === "image" && o.name !== "mask.png").map((o) => ({ job: j, name: o.name })))
            .slice(0, 24),
        ),
      )
      .catch(() => setRecent([]));
  }, [open, recent]);
  const box = small ? "h-20 w-20" : "h-40 w-full max-w-[16rem]";
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div
        className={`relative grid place-items-center overflow-hidden rounded-lg border border-dashed border-border bg-surface-3/30 ${box}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f && f.type.startsWith("image/")) onChange(f);
        }}
      >
        {url ? (
          <>
            <img src={url} alt="" className="h-full w-full object-contain" />
            <button className="absolute right-1 top-1 rounded bg-black/55 p-0.5 text-white" onClick={() => onChange(null)} aria-label={t("imageStudio.remove")}>
              <Icon name="x" size={11} />
            </button>
          </>
        ) : (
          <button className="flex flex-col items-center gap-1 p-2 text-[11.5px] text-content-faint" onClick={() => input.current?.click()}>
            <Icon name="upload" size={small ? 14 : 18} />
            {!small && t("imageStudio.pickDrop")}
          </button>
        )}
      </div>
      {!small && (
        <div className="flex gap-2">
          <button className="btn-ghost !px-2 !py-0.5 text-[11.5px]" onClick={() => input.current?.click()}>{t("imageStudio.pickFile")}</button>
          <button className="btn-ghost !px-2 !py-0.5 text-[11.5px]" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid={testId ? `${testId}-recent` : undefined}>
            {t("imageStudio.pickRecent")}
          </button>
        </div>
      )}
      {open && (
        <div className="grid max-h-56 grid-cols-6 gap-1.5 overflow-y-auto rounded-lg border border-border/60 p-1.5">
          {!recent ? (
            <div className="col-span-6"><ProgressBar indeterminate /></div>
          ) : recent.length === 0 ? (
            <p className="col-span-6 p-1 text-[11.5px] text-content-faint">{t("imageStudio.noJobs")}</p>
          ) : (
            recent.map(({ job, name }) => (
              <button
                key={`${job.id}/${name}`}
                className="is-tile overflow-hidden rounded border border-border/60"
                onClick={() => {
                  onChange({ from: `${job.id}/${name}` });
                  setOpen(false);
                }}
              >
                <img src={imageJobFileUrl(job.id, name)} alt="" className={`aspect-square w-full object-cover ${name === "cut.png" ? "is-checker" : ""}`} loading="lazy" />
              </button>
            ))
          )}
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onChange(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** the job just sent: its progress, then what it made and where it can go next */
function Result({ job, onJob }: { job: ImageJob | null; onJob: (j: ImageJob) => void }) {
  const t = useT();
  const { tick, tryWith } = useImageStudio();
  const [pick, setPick] = useState(0);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.state)) return;
    let dead = false;
    const poll = () =>
      getImageJob(job.id)
        .then((j) => !dead && onJob(j))
        .catch(() => {});
    const i = setInterval(poll, 1500);
    void poll();
    return () => {
      dead = true;
      clearInterval(i);
    };
  }, [job?.id, job?.state, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!job)
    return (
      <Card testId="is-try-result">
        <div className="grid min-h-[260px] place-items-center text-center text-[12.5px] text-content-faint">
          <div className="space-y-2">
            <Icon name="sparkles" size={22} />
            <p>{t("imageStudio.tryEmpty")}</p>
          </div>
        </div>
      </Card>
    );
  const pics = job.outputs.filter((o) => o.kind === "image" && o.name !== "mask.png" && o.name !== "poster.jpg");
  const main = mainOutput(job);
  const shown = job.kind === "draft" && pics[pick] ? pics[pick].name : main?.name;
  const isPic = shown && !shown.endsWith(".mp4");
  return (
    <Card
      testId="is-try-result"
      title={t(`imageStudio.kind_${job.kind}` as MsgKey)}
      right={<span className="text-[11.5px] text-content-faint" data-testid="is-try-state" data-state={job.state} data-job={job.id}>{t(`imageStudio.state_${job.state}` as MsgKey)}{job.state === "done" ? ` · ${duration(job.seconds)}` : ""}</span>}
    >
      {["queued", "running"].includes(job.state) && (
        <div className="space-y-1.5">
          <ProgressBar value={job.live?.max ? job.live.value / job.live.max : undefined} indeterminate={!job.live?.max} />
          <p className="text-[11.5px] text-content-dim">{job.live ? <LiveLine live={job.live} /> : t("imageStudio.state_queued")}</p>
          <p className="text-[11px] text-content-faint">{t("imageStudio.firstLoadHint")}</p>
          <button className="btn-ghost !px-2 !py-0.5 text-[11.5px]" onClick={() => void cancelImageJob(job.id)}>{t("imageStudio.cancel")}</button>
        </div>
      )}
      {job.state === "failed" && <p className="break-words text-[12.5px] text-danger" data-testid="is-try-error">{job.error}</p>}
      {job.state === "done" && shown && (
        <div className="space-y-2">
          <Preview job={job} name={shown} controls className="max-h-[60vh] w-full rounded-lg" />
          {job.kind === "draft" && pics.length > 1 && (
            <div className="flex gap-1.5">
              {pics.map((p, i) => (
                <button key={p.name} className={`overflow-hidden rounded border ${i === pick ? "border-accent" : "border-border/60"}`} onClick={() => setPick(i)}>
                  <img src={imageJobFileUrl(job.id, p.name)} alt="" className="h-14 w-14 object-cover" />
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            <a className="btn-soft !py-1 text-[12px]" href={imageJobFileUrl(job.id, shown, true)} data-testid="is-try-download">
              <Icon name="download" size={12} /> {t("imageStudio.downloadFile")}
            </a>
            {isPic &&
              (["edit", "loop", "cutout"] as ImageUse[]).map((u) => (
                <button key={u} className="btn-ghost !py-1 text-[12px]" onClick={() => tryWith(u, `${job.id}/${shown}`)} data-testid={`is-try-next-${u}`}>
                  <Icon name={KIND_ICON[u]} size={12} /> {t(`imageStudio.next_${u}` as MsgKey)}
                </button>
              ))}
          </div>
          {job.params.result && typeof job.params.result === "object" && "seam" in job.params.result && (
            <p className="text-[11px] text-content-faint">{t("imageStudio.loopSeam")}</p>
          )}
        </div>
      )}
    </Card>
  );
}
