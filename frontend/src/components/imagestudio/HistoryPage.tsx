/**
 * Image Studio → 기록: every picture and clip made on this machine — tried here or made for the avatar maker — with
 * what it was made from (the words, the input picture), on which model, how long it took. Look, download, star,
 * delete, or use one as the next step's input.
 */
import { useEffect, useState } from "react";
import { deleteImageJobs, imageJobFileUrl, listImageJobs, starImageJob, type ImageJob, type ImageUse, type JobKind } from "../../api/image";
import { useT, type MsgKey } from "../../i18n";
import { confirmDialog } from "../ui/ConfirmDialog";
import Icon from "../ui/Icon";
import { ErrorLine, ProgressBar, Segmented } from "../mate/settings/ui";
import { ago, duration, KIND_ICON, Modal, Preview, sourceLabel, useImageStudio } from "./shared";

const KINDS: (JobKind | "")[] = ["", "draft", "edit", "loop", "cutout", "matte"];
const PAGE = 48;

export default function HistoryPage() {
  const t = useT();
  const { status, tick } = useImageStudio();
  const [kind, setKind] = useState<JobKind | "">("");
  const [source, setSource] = useState<"" | "studio" | "avatar:">("");
  const [starred, setStarred] = useState(false);
  const [items, setItems] = useState<ImageJob[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<ImageJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    listImageJobs({ kind, source, starred, limit })
      .then((r) => {
        if (dead) return;
        setItems(r.items);
        setTotal(r.total);
        setOpen((o) => (o ? r.items.find((j) => j.id === o.id) ?? o : o));
      })
      .catch((e) => !dead && setErr((e as Error).message));
    return () => {
      dead = true;
    };
  }, [kind, source, starred, limit, tick]);
  const name = (id: string) => status?.models.find((m) => m.id === id)?.name ?? id;
  return (
    <div className="space-y-3" data-testid="is-history">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={kind} onChange={setKind} options={KINDS.map((k) => ({ id: k, label: k ? t(`imageStudio.kind_${k}` as MsgKey) : t("imageStudio.all") }))} testId="is-history-kind" />
        <Segmented
          value={source}
          onChange={setSource}
          options={[
            { id: "" as const, label: t("imageStudio.all") },
            { id: "studio" as const, label: t("imageStudio.src_studio") },
            { id: "avatar:" as const, label: t("imageStudio.src_avatar") },
          ]}
          testId="is-history-source"
        />
        <label className="flex items-center gap-1.5 text-[12px] text-content-dim">
          <input type="checkbox" checked={starred} onChange={(e) => setStarred(e.target.checked)} /> {t("imageStudio.starredOnly")}
        </label>
        <span className="flex-1" />
        <span className="text-[11.5px] text-content-faint">{t("imageStudio.historyCount", { n: total })}</span>
      </div>
      <ErrorLine text={err} />
      {!items ? (
        <ProgressBar indeterminate />
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-[12.5px] text-content-faint">{t("imageStudio.noJobs")}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {items.map((j) => (
            <button key={j.id} className="is-tile overflow-hidden rounded-xl border border-border/60 bg-surface-2/40 text-left" onClick={() => setOpen(j)} data-testid={`is-job-${j.id}`} data-state={j.state}>
              <div className="relative">
                <Preview job={j} className="aspect-square w-full" />
                {j.starred && <span className="absolute left-1.5 top-1.5 text-warning"><Icon name="star" size={13} /></span>}
                {j.state !== "done" && (
                  <span className={`absolute inset-x-0 bottom-0 px-1.5 py-0.5 text-[10.5px] text-white ${j.state === "failed" ? "bg-danger/80" : "bg-black/60"}`}>
                    {t(`imageStudio.state_${j.state}` as MsgKey)}
                  </span>
                )}
              </div>
              <div className="space-y-0.5 px-2 py-1.5">
                <div className="flex items-center gap-1 text-[11.5px] text-content">
                  <Icon name={KIND_ICON[j.kind]} size={11} />
                  <span className="min-w-0 flex-1 truncate">{t(`imageStudio.kind_${j.kind}` as MsgKey)}</span>
                  <span className="text-content-faint">{ago(j.created_at)}</span>
                </div>
                <p className="truncate text-[10.5px] text-content-faint">{name(j.model_id)} · {sourceLabel(t, j.source)}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      {items && items.length < total && (
        <div className="text-center">
          <button className="btn-soft !py-1 text-[12px]" onClick={() => setLimit((l) => l + PAGE)}>{t("imageStudio.more")}</button>
        </div>
      )}
      {open && <Detail job={open} model={name(open.model_id)} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Detail({ job, model, onClose }: { job: ImageJob; model: string; onClose: () => void }) {
  const t = useT();
  const { tryWith } = useImageStudio();
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const outs = job.outputs.filter((o) => o.kind !== "file");
  const name = shown ?? outs.find((o) => o.name !== "mask.png" && o.name !== "poster.jpg")?.name ?? outs[0]?.name;
  const inputs = ["image", "end_image", "clip"].flatMap((k) => {
    const v = job.inputs[k as "image"];
    return v ? [{ key: k, file: `in-${k}${v.slice(v.lastIndexOf(".")).toLowerCase()}` }] : [];
  });
  const remove = async () => {
    if (!(await confirmDialog({ body: t("imageStudio.deleteConfirm"), confirmLabel: t("imageStudio.delete"), danger: true }))) return;
    setBusy(true);
    try {
      await deleteImageJobs([job.id]);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`${t(`imageStudio.kind_${job.kind}` as MsgKey)} · ${model}`} onClose={onClose} wide testId="is-job-detail">
      <div className="space-y-3">
        {job.state === "failed" && <p className="break-words rounded-md bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">{job.error}</p>}
        {name && <Preview job={job} name={name} controls className="max-h-[56vh] w-full rounded-lg" />}
        {outs.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {outs.map((o) => (
              <button key={o.name} className={`rounded-md border px-2 py-0.5 text-[11.5px] ${o.name === name ? "border-accent text-content" : "border-border text-content-dim"}`} onClick={() => setShown(o.name)}>
                {o.name}
              </button>
            ))}
          </div>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          {job.inputs.prompt && (
            <>
              <dt className="text-content-faint">{t("imageStudio.prompt")}</dt>
              <dd className="whitespace-pre-wrap break-words text-content">{job.inputs.prompt}</dd>
            </>
          )}
          <dt className="text-content-faint">{t("imageStudio.madeFor")}</dt>
          <dd className="text-content-dim">{sourceLabel(t, job.source)}</dd>
          <dt className="text-content-faint">{t("imageStudio.took")}</dt>
          <dd className="text-content-dim">{job.seconds ? duration(job.seconds) : "–"} · {new Date(job.created_at).toLocaleString()}</dd>
          {inputs.length > 0 && (
            <>
              <dt className="text-content-faint">{t("imageStudio.madeFrom")}</dt>
              <dd className="flex gap-1.5">
                {inputs.map((i) =>
                  i.key === "clip" ? (
                    <span key={i.key} className="text-content-dim">{t("imageStudio.aClip")}</span>
                  ) : (
                    <img key={i.key} src={imageJobFileUrl(job.id, i.file)} alt="" className="h-16 w-16 rounded border border-border/60 object-contain" />
                  ),
                )}
              </dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap items-center gap-1.5">
          {name && (
            <a className="btn-soft !py-1 text-[12px]" href={imageJobFileUrl(job.id, name, true)}>
              <Icon name="download" size={12} /> {t("imageStudio.downloadFile")}
            </a>
          )}
          {name && !name.endsWith(".mp4") && job.state === "done" &&
            (["edit", "loop", "cutout"] as ImageUse[]).map((u) => (
              <button key={u} className="btn-ghost !py-1 text-[12px]" onClick={() => tryWith(u, `${job.id}/${name}`)}>
                <Icon name={KIND_ICON[u]} size={12} /> {t(`imageStudio.next_${u}` as MsgKey)}
              </button>
            ))}
          <span className="flex-1" />
          <button className="btn-ghost !py-1 text-[12px]" onClick={() => void starImageJob(job.id, !job.starred)} data-testid="is-job-star">
            <Icon name="star" size={12} /> {job.starred ? t("imageStudio.unstar") : t("imageStudio.star")}
          </button>
          {!["queued", "running"].includes(job.state) && (
            <button className="btn-ghost !py-1 text-[12px] text-danger" disabled={busy} onClick={() => void remove()} data-testid="is-job-delete">
              {t("imageStudio.delete")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
