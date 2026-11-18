/**
 * Image Studio → 모델: the engine (ComfyUI, installed from upstream with the first model) and each model by what it is
 * for — what it takes on the GPU and in memory and how long a job took (measured), its license (read, accepted, then
 * downloaded; the files and their pinned revisions linked), its install progress, the model a use takes.
 */
import { useState } from "react";
import { cancelImageInstall, installImageModel, putImageSettings, removeImageModel, USES, type ImageModel, type ImageStatus, type ImageUse } from "../../api/image";
import { useT, type MsgKey } from "../../i18n";
import { confirmDialog } from "../ui/ConfirmDialog";
import HelpTip from "../ui/HelpTip";
import Icon from "../ui/Icon";
import { ErrorLine, ProgressBar, Segmented, StatusBadge } from "../mate/settings/ui";
import { Card, gateText, gb, useImageStudio } from "./shared";

const short = (sha: string) => (sha && sha.length > 10 ? sha.slice(0, 8) : sha);
const GB = (n: number) => (n / 1e9).toFixed(n >= 1e10 ? 0 : 1);

export default function ModelsPage() {
  const t = useT();
  const { status } = useImageStudio();
  const [use, setUse] = useState<ImageUse | "all">("all");
  if (!status) return null;
  const shown = status.models.filter((m) => use === "all" || m.uses.includes(use));
  const installed = status.models.filter((m) => m.installed);
  return (
    <div className="space-y-3" data-testid="is-models">
      <EngineCard status={status} />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={use}
          onChange={setUse}
          options={[{ id: "all" as const, label: t("imageStudio.mdAll", { n: status.models.length }) }, ...USES.map((u) => ({ id: u, label: t(`imageStudio.use_${u}` as MsgKey) }))]}
          testId="is-models-use"
        />
        <span className="flex-1" />
        <span className="text-[11.5px] text-content-faint">
          {t("imageStudio.mdInstalled", { n: installed.length })} · {t("imageStudio.diskFree", { gb: gb(status.system.disk.models.free, 0) })}
          <HelpTip>{t("imageStudio.mdHint")}</HelpTip>
        </span>
      </div>
      <div className="space-y-3">
        {shown.map((m) => (
          <ModelCard key={m.id} m={m} status={status} />
        ))}
      </div>
    </div>
  );
}

function EngineCard({ status }: { status: ImageStatus }) {
  const t = useT();
  const e = status.engine;
  return (
    <Card
      title={t("imageStudio.mdEngine")}
      help={t("imageStudio.mdEngineHint")}
      testId="is-engine-card"
      right={<StatusBadge status={e.installed ? "ok" : "off"}>{e.installed ? t("imageStudio.installedShort") : t("imageStudio.notInstalled")}</StatusBadge>}
    >
      <div className="space-y-1.5 text-[12.5px]">
        {!status.gate.ok && <p className="text-warning" data-testid="is-gate-text">{gateText(t, status.gate)}</p>}
        <p className="text-content">{e.version}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
          <a className="text-link underline" href="https://github.com/Comfy-Org/ComfyUI" target="_blank" rel="noreferrer">{t("imageStudio.mdEngineLink")}</a>
          <span className="text-content-faint">{t("imageStudio.mdEngineReq", { driver: status.gate.requirements.driver, cap: status.gate.requirements.capability })}</span>
        </div>
      </div>
    </Card>
  );
}

function ModelCard({ m, status }: { m: ImageModel; status: ImageStatus }) {
  const t = useT();
  const { reload } = useImageStudio();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = status.gate.ok;
  const p = m.progress;
  const installing = m.busy || (!!p && ["queued", "engine", "weights"].includes(p.state));
  const defaultFor = m.uses.filter((u) => status.defaults[u] === m.id);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
      await reload();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ body: t("imageStudio.removeConfirm", { name: m.name }), confirmLabel: t("imageStudio.remove"), danger: true }))) return;
    await act(() => removeImageModel(m.id));
  };
  const repos = [...new Map(m.files.map((f) => [f.repo, f])).values()];
  return (
    <div className="rounded-xl border border-border/70 bg-surface-2/40 p-3.5" data-testid={`is-model-${m.id}`} data-installed={m.installed}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[14px] font-semibold text-content">
          {m.name}
          {m.notes.length > 0 && (
            <HelpTip testId={`is-model-notes-${m.id}`}>
              <ul className="list-disc space-y-1 pl-4">{m.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </HelpTip>
          )}
        </span>
        {m.uses.map((u) => (
          <span key={u} className="pill border border-border bg-surface-3/60 text-content-faint">{t(`imageStudio.use_${u}` as MsgKey)}</span>
        ))}
        {m.license.noncommercial && <span className="pill border border-warning/40 bg-warning/10 text-warning" title={m.license.commercial} data-testid={`is-model-nc-${m.id}`}>{t("localVoice.nonCommercial")}</span>}
        {m.installed && <StatusBadge status="ok">{t("imageStudio.installedShort")}</StatusBadge>}
        {defaultFor.length > 0 && m.installed && (
          <span className="pill border border-accent/30 bg-accent-soft text-accent" data-testid={`is-model-default-${m.id}`}>{t("imageStudio.mdDefault")}</span>
        )}
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-content-dim">{m.description}</p>
      <div className="mt-1.5 flex flex-wrap gap-1 text-[11px]">
        <span className="pill border border-border/70 bg-surface-3/40 text-content-dim">{t("imageStudio.mdDownload", { gb: m.download_gb.toFixed(1) })}</span>
        <span className="pill border border-border/70 bg-surface-3/40 text-content-dim" title={t("imageStudio.mdMeasuredHint")}>{t("imageStudio.mdVram", { gb: m.vram_gb.toFixed(1) })}</span>
        <span className="pill border border-border/70 bg-surface-3/40 text-content-dim">{t("imageStudio.mdRam", { gb: m.ram_gb.toFixed(1) })}</span>
        {m.seconds && <span className="pill border border-border/70 bg-surface-3/40 text-content-dim">{m.seconds}</span>}
      </div>

      {/* the license: what it says, where it lives, accepted before anything is downloaded */}
      <details className="mt-2 rounded-md border border-border/60 bg-surface-2/50 px-2.5 py-1.5" open={!m.installed && !m.license_accepted} data-testid={`is-model-license-${m.id}`}>
        <summary className="cursor-pointer select-none text-[12px] font-medium text-content">
          {t("imageStudio.license")}: {m.license.name}
        </summary>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11.5px] leading-relaxed text-content-dim">
          {m.license.summary.map((s) => <li key={s}>{s}</li>)}
        </ul>
        <p className="mt-1 text-[11.5px] text-content-dim">{t("imageStudio.commercial", { x: m.license.commercial || t("imageStudio.allowed") })}</p>
        {m.license.attribution && (
          <p className="mt-1 rounded bg-surface-3/50 px-2 py-1 text-[11px] leading-snug text-content-faint">
            <b className="text-content-dim">{t("imageStudio.attribution")}:</b> {m.license.attribution}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
          <a className="text-link underline" href={m.license.url} target="_blank" rel="noreferrer">{t("imageStudio.licenseText")}</a>
          {m.homepage && <a className="text-link underline" href={m.homepage} target="_blank" rel="noreferrer">{t("imageStudio.modelPage")}</a>}
          <span className="text-content-faint">
            {t("imageStudio.repos")}:{" "}
            {repos.map((f, i) => (
              <span key={f.repo}>
                {i > 0 && ", "}
                <a className="text-link underline" href={`https://huggingface.co/${f.repo}/tree/${f.revision}`} target="_blank" rel="noreferrer">{f.repo}</a> ({short(f.revision)})
              </span>
            ))}
          </span>
        </div>
        <ul className="mt-1.5 space-y-0.5 text-[11px] text-content-faint" data-testid={`is-model-files-${m.id}`}>
          {m.files.map((f) => (
            <li key={f.name} className="flex gap-2">
              <a className="min-w-0 flex-1 truncate font-mono text-link underline" href={f.url} target="_blank" rel="noreferrer">{f.name}</a>
              <span className="shrink-0">{t(`imageStudio.role_${f.role}` as MsgKey)}</span>
              <span className="shrink-0 tabular-nums">{GB(f.size)} GB</span>
            </li>
          ))}
        </ul>
        {m.license_accepted && <p className="mt-1 text-[11px] text-content-faint">{t("imageStudio.acceptedAt", { at: new Date(m.license_accepted.accepted_at).toLocaleString() })}</p>}
      </details>

      {installing && p && (
        <div className="mt-2 space-y-1" data-testid={`is-model-progress-${m.id}`}>
          <div className="flex items-center gap-2 text-[11.5px] text-content-dim">
            <span className="min-w-0 flex-1 truncate">
              {t(`imageStudio.inst_${p.state}` as MsgKey)}
              {p.message && p.state !== "queued" ? ` · ${p.message}` : ""}
            </span>
            {p.total_bytes > 0 && <span className="shrink-0 tabular-nums">{gb(p.done_bytes, 2)} / {gb(p.total_bytes, 2)} GB</span>}
            <button className="btn-soft !px-2 !py-0.5 text-[11.5px]" onClick={() => act(() => cancelImageInstall(m.id))} disabled={busy}>{t("imageStudio.cancel")}</button>
          </div>
          <ProgressBar value={p.fraction ?? undefined} indeterminate={p.fraction == null} />
          {p.log.length > 0 && (
            <details className="text-[11px] text-content-faint">
              <summary className="cursor-pointer select-none">{t("imageStudio.log")}</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-3/40 p-2 font-mono text-[10.5px]">{p.log.join("\n")}</pre>
            </details>
          )}
        </div>
      )}
      {p?.state === "error" && <p className="mt-2 break-words text-[12px] text-danger">{t("imageStudio.instError", { error: p.error })}</p>}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {!m.installed && !installing && (
          <>
            {!m.license_accepted && (
              <label className="flex items-center gap-1.5 text-[12px] text-content-dim">
                <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} disabled={!ready} data-testid={`is-model-accept-${m.id}`} />
                {t("imageStudio.accept")}
              </label>
            )}
            <button
              className="btn-primary !py-1 text-[12.5px]"
              disabled={!ready || busy || (!accepted && !m.license_accepted)}
              title={!ready ? gateText(t, status.gate) : !accepted && !m.license_accepted ? t("imageStudio.acceptFirst") : undefined}
              onClick={() => act(() => installImageModel(m.id, accepted))}
              data-testid={`is-model-install-${m.id}`}
            >
              <Icon name="download" size={12} /> {t("imageStudio.download")}
            </button>
            {m.missing_bytes > 0 && (
              <span className="text-[11px] text-content-faint">
                {t("imageStudio.needDisk", { gb: GB(m.missing_bytes) })}
                {!m.engine ? ` · ${t("imageStudio.plusEngine")}` : ""}
              </span>
            )}
          </>
        )}
        {m.installed && (
          <>
            <span className="flex-1" />
            {m.uses
              .filter((u) => status.defaults[u] !== m.id)
              .map((u) => (
                <button key={u} className="btn-ghost !py-1 text-[12px]" disabled={busy} onClick={() => act(() => putImageSettings({ models: { [u]: m.id } }))} data-testid={`is-model-make-default-${m.id}-${u}`}>
                  {t("imageStudio.makeDefault", { use: t(`imageStudio.use_${u}` as MsgKey) })}
                </button>
              ))}
            <button className="btn-ghost !py-1 text-[12px] text-danger" disabled={busy} onClick={() => void remove()} data-testid={`is-model-remove-${m.id}`}>
              {t("imageStudio.remove")}
            </button>
          </>
        )}
      </div>
      <ErrorLine text={err} />
    </div>
  );
}
