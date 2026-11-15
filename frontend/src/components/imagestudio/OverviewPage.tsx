/**
 * Image Studio → 개요: the engine and the GPU (is ComfyUI running, how much of the card it holds, stop it now), the
 * job running and those waiting, what the avatar maker can run on this machine stage by stage, the latest results.
 */
import { useEffect, useState } from "react";
import { AVATAR_STAGES, cancelImageJob, listImageJobs, stopImageEngine, type ImageJob } from "../../api/image";
import { useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";
import { ErrorLine, ProgressBar, StatusBadge } from "../mate/settings/ui";
import { ago, Card, duration, gateText, gb, KIND_ICON, LiveLine, Preview, sourceLabel, useImageStudio } from "./shared";

export default function OverviewPage() {
  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="is-overview">
      <EngineCard />
      <QueueCard />
      <AvatarCard />
      <RecentCard />
    </div>
  );
}

function EngineCard() {
  const t = useT();
  const { status, reload } = useImageStudio();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!status) return null;
  const gpu = status.system.gpus[0];
  const e = status.engine;
  const state = !status.gate.ok ? "off" : e.busy ? "working" : e.running ? "idle" : "stopped";
  const stop = async () => {
    setBusy(true);
    setErr(null);
    try {
      await stopImageEngine();
      await reload();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={t("imageStudio.ovEngine")}
      testId="is-engine"
      right={
        <StatusBadge status={state === "working" ? "checking" : state === "idle" ? "ok" : "off"} testId="is-engine-state">
          {t(`imageStudio.engine_${state}` as MsgKey)}
        </StatusBadge>
      }
    >
      <div className="space-y-2 text-[12.5px]">
        {!status.gate.ok && <p className="text-warning">{gateText(t, status.gate)}</p>}
        {gpu && (
          <div>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-content">{gpu.name}</span>
              <span className="shrink-0 tabular-nums text-content-dim">{gb(gpu.used)} / {gb(gpu.total)} GB</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full bg-accent" style={{ width: `${Math.min(100, (gpu.used / Math.max(1, gpu.total)) * 100)}%` }} />
            </div>
          </div>
        )}
        <p className="text-content-dim">
          {e.installed ? e.version : t("imageStudio.engineMissing")}
          {e.vram != null ? ` · ${t("imageStudio.engineHolds", { gb: gb(e.vram) })}` : ""}
          {status.system.memory ? ` · ${t("imageStudio.ramFree", { gb: gb(status.system.memory.available) })}` : ""}
        </p>
        <p className="text-[11.5px] leading-snug text-content-faint">{t("imageStudio.engineHint")}</p>
        {e.running && !e.busy && (
          <button className="btn-soft !py-1 text-[12px]" onClick={() => void stop()} disabled={busy} data-testid="is-engine-stop">
            {busy ? <Icon name="spinner" size={12} spin /> : <Icon name="stop" size={12} />} {t("imageStudio.engineStop")}
          </button>
        )}
        <ErrorLine text={err} />
      </div>
    </Card>
  );
}

function QueueCard() {
  const t = useT();
  const { status } = useImageStudio();
  if (!status) return null;
  const run = status.queue.running;
  const model = run ? status.models.find((m) => m.id === run.model_id) : null;
  return (
    <Card title={t("imageStudio.ovQueue")} testId="is-queue" right={<span className="text-[11.5px] text-content-faint">{t("imageStudio.waiting", { n: status.queue.waiting })}</span>}>
      {!run ? (
        <p className="text-[12.5px] text-content-faint" data-testid="is-queue-idle">{t("imageStudio.queueIdle")}</p>
      ) : (
        <div className="space-y-1.5 text-[12.5px]" data-testid="is-queue-running">
          <div className="flex items-center gap-2">
            <Icon name={KIND_ICON[run.kind]} size={14} />
            <span className="font-medium text-content">{t(`imageStudio.kind_${run.kind}` as MsgKey)}</span>
            <span className="text-content-faint">· {model?.name ?? run.model_id} · {sourceLabel(t, run.source)}</span>
            <span className="flex-1" />
            <button className="btn-ghost !px-2 !py-0.5 text-[11.5px]" onClick={() => void cancelImageJob(run.id)} data-testid="is-queue-cancel">
              {t("imageStudio.cancel")}
            </button>
          </div>
          <ProgressBar value={run.max ? run.value / run.max : undefined} indeterminate={!run.max} />
          <p className="text-[11.5px] text-content-dim"><LiveLine live={run} /></p>
        </div>
      )}
    </Card>
  );
}

function AvatarCard() {
  const t = useT();
  const { status, go } = useImageStudio();
  if (!status) return null;
  const av = status.avatar;
  return (
    <Card title={t("imageStudio.ovAvatar")} testId="is-avatar">
      <p className="mb-2 text-[11.5px] leading-snug text-content-faint">{t("imageStudio.ovAvatarHint")}</p>
      <ul className="divide-y divide-border/50 text-[12.5px]">
        {AVATAR_STAGES.map((st) => {
          const s = av.stages[st];
          return (
            <li key={st} className="flex items-center gap-2 py-1.5" data-testid={`is-avatar-${st}`} data-ready={!!s?.ready}>
              <span className="w-24 shrink-0 font-medium text-content">{t(`imageStudio.stage_${st}` as MsgKey)}</span>
              {s?.ready ? (
                <>
                  <StatusBadge status="ok">{s.model_name}</StatusBadge>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-content-faint">{s.seconds}</span>
                  <span className="text-[11px] text-content-dim">{t(s.default === "local" ? "imageStudio.engLocal" : "imageStudio.engHosted")}</span>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 text-[11.5px] text-content-faint">{t("imageStudio.stageNoModel", { use: t(`imageStudio.use_${s?.use ?? "draft"}` as MsgKey) })}</span>
                  <button className="btn-ghost !px-2 !py-0.5 text-[11.5px]" onClick={() => go("models")}>{t("imageStudio.getModels")}</button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function RecentCard() {
  const t = useT();
  const { go, tick } = useImageStudio();
  const [jobs, setJobs] = useState<ImageJob[] | null>(null);
  useEffect(() => {
    let dead = false;
    listImageJobs({ limit: 8 })
      .then((r) => !dead && setJobs(r.items))
      .catch(() => !dead && setJobs([]));
    return () => {
      dead = true;
    };
  }, [tick]);
  return (
    <Card title={t("imageStudio.ovRecent")} testId="is-recent" right={<button className="btn-ghost !px-2 !py-0.5 text-[11.5px]" onClick={() => go("history")}>{t("imageStudio.seeAll")}</button>}>
      {!jobs ? (
        <ProgressBar indeterminate />
      ) : jobs.length === 0 ? (
        <p className="text-[12.5px] text-content-faint">{t("imageStudio.noJobs")}</p>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {jobs.map((j) => (
            <button key={j.id} className="is-tile group relative overflow-hidden rounded-lg border border-border/60 text-left" onClick={() => go("history")} title={j.inputs.prompt ?? ""}>
              <Preview job={j} className="aspect-square w-full" />
              <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/55 px-1.5 py-0.5 text-[10.5px] text-white">
                <Icon name={KIND_ICON[j.kind]} size={10} />
                <span className="min-w-0 flex-1 truncate">{t(`imageStudio.kind_${j.kind}` as MsgKey)}</span>
                <span className="opacity-80">{j.state === "done" ? duration(j.seconds) : t(`imageStudio.state_${j.state}` as MsgKey)}</span>
              </span>
              <span className="absolute right-1 top-1 rounded bg-black/45 px-1 text-[10px] text-white">{ago(j.created_at)}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
