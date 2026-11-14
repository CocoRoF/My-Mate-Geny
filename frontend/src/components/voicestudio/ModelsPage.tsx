/**
 * Voice Studio → 모델: whether this server can serve local models (and why not), then each model — its page, its
 * license (read, accepted, then downloaded), its install progress, its place on the GPU (load / park / unload), the
 * default model for speech and for recognition, and its default parameters (what every line made with it starts from:
 * a mate's voice, the studio, a batch) — and the engines' environments.
 */
import { useEffect, useMemo, useState } from "react";
import {
  cancelInstall,
  getModelDefaults,
  installModel,
  loadModelFrom,
  putModelDefaults,
  putStudioSettings,
  removeModel,
  unloadModel,
  type VoiceModel,
  type VoiceStatus,
} from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import { confirmDialog } from "../ui/ConfirmDialog";
import Icon from "../ui/Icon";
import { Banner, ErrorLine, ProgressBar, Segmented, StatusBadge } from "../mate/settings/ui";
import { Card, gb, gateText, ParamControls, useStudio } from "./shared";

const short = (sha: string) => (sha && sha.length > 10 ? sha.slice(0, 8) : sha);

type Kind = "all" | "tts" | "stt";

export default function ModelsPage() {
  const t = useT();
  const { status, reloadStatus } = useStudio();
  const [kind, setKind] = useState<Kind>("all");
  if (!status) return null;
  const shown = status.models.filter((m) => kind === "all" || m.kind === kind);
  const installed = status.models.filter((m) => m.installed);
  const disk = installed.reduce((a, m) => a + m.disk_bytes, 0);
  return (
    <div className="space-y-3" data-testid="vs-models">
      <GateCard status={status} />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { id: "all", label: t("voiceStudio.mdAll", { n: status.models.length }) },
            { id: "tts", label: t("localVoice.kind_tts") },
            { id: "stt", label: t("localVoice.kind_stt") },
          ]}
          testId="vs-models-kind"
        />
        <span className="flex-1" />
        <span className="text-[11.5px] text-content-faint">{t("voiceStudio.mdInstalled", { n: installed.length, gb: gb(disk) })}</span>
      </div>
      <p className="text-[11.5px] leading-snug text-content-faint">{t("localVoice.modelsHint", { min: Math.round(status.settings.idle_unload_seconds / 60) })}</p>
      <div className="space-y-3">
        {shown.map((m) => (
          <ModelCard key={m.id} m={m} status={status} onChange={reloadStatus} />
        ))}
      </div>
      <Runtimes status={status} />
    </div>
  );
}

function GateCard({ status }: { status: VoiceStatus }) {
  const t = useT();
  const g = status.gate;
  const gpu = status.system.gpus[0];
  const mem = status.system.memory;
  return (
    <Card
      title={t("localVoice.gpuTitle")}
      testId="local-voice-gate"
      right={<StatusBadge status={g.ok ? "ok" : "off"} testId="local-voice-gate-state">{g.ok ? "GPU" : t("localVoice.notHere")}</StatusBadge>}
    >
      <div className="space-y-1.5 text-[12.5px]">
        {gpu && (
          <p className="text-content" data-testid="local-voice-gpu">
            {t("localVoice.gpuLine", { name: gpu.name, used: gb(gpu.used), total: gb(gpu.total), driver: gpu.driver, cap: gpu.capability || "?" })}
          </p>
        )}
        <p className="text-content-faint">{t("localVoice.hostLine", { free: gb(mem.available), total: gb(mem.total, 0), disk: gb(status.system.disk.models.free, 0) })}</p>
        <p className="break-all font-mono text-[11px] text-content-faint">{t("localVoice.modelsDir", { path: status.settings.models_dir })}</p>
        {g.ok ? (
          <p className="text-success" data-testid="local-voice-gate-ok">{gateText(t, g)}</p>
        ) : (
          <Banner tone="warn" testId="local-voice-gate-why">
            <span>{gateText(t, g)}</span>
            <span className="mt-1 block text-[11.5px] opacity-80">
              {t("localVoice.requirements", { cap: g.requirements.capability, driver: g.requirements.driver, vram: gb(g.requirements.vram, 0), platforms: g.requirements.platforms.join(", ") })}
            </span>
          </Banner>
        )}
      </div>
    </Card>
  );
}

function ModelCard({ m, status, onChange }: { m: VoiceModel; status: VoiceStatus; onChange: () => Promise<void> }) {
  const t = useT();
  const { openInGenerate } = useStudio();
  const ready = status.gate.ok;
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tuning, setTuning] = useState(false);
  const p = m.progress;
  const installing = !!p && ["queued", "runtime", "source", "weights"].includes(p.state);
  const res = m.resident;
  const isDefault = status.defaults[m.kind] === m.id;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      await onChange();
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ body: t("localVoice.removeConfirm", { name: m.name, size: `${gb(m.disk_bytes)} GB` }), confirmLabel: t("localVoice.remove"), danger: true }))) return;
    await act(() => removeModel(m.id));
  };
  return (
    <div className="rounded-xl border border-border/70 bg-surface-2/40 p-3.5" data-testid={`local-model-${m.id}`} data-installed={m.installed}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[14px] font-semibold text-content">{m.name}</span>
        <span className="pill border border-border bg-surface-3/60 text-content-faint">{t(`localVoice.kind_${m.kind}` as MsgKey)}</span>
        {m.installed && <StatusBadge status="ok">{t("localVoice.state_done")}</StatusBadge>}
        {res && (
          <StatusBadge status={res.state === "ready" ? "ok" : res.state === "parked" ? "warn" : "checking"} testId={`local-model-res-${m.id}`}>
            {t(`localVoice.res_${res.state}` as MsgKey)}
          </StatusBadge>
        )}
        {res?.pinned && <span className="pill border border-accent/30 bg-accent-soft text-accent">{t("localVoice.pinned")}</span>}
        {isDefault && <span className="pill border border-accent/30 bg-accent-soft text-accent" data-testid={`vs-model-default-${m.id}`}>{t("voiceStudio.mdDefault")}</span>}
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-content-dim">{m.description}</p>
      <p className="mt-1 text-[11.5px] text-content-faint">
        {t("localVoice.sizes", { dl: m.download_gb.toFixed(1), vram: m.vram_gb.toFixed(1) })}
        {res?.vram_used ? ` · ${t("localVoice.vramUsed", { gb: gb(res.vram_used) })}` : ""}
        {` · ${t("voiceStudio.mdRate", { hz: m.sample_rate })}`}
      </p>
      <div className="mt-1 flex flex-wrap gap-1">
        {m.features.map((f) => (
          <span key={f} className="pill border border-border/70 bg-surface-3/40 text-content-dim">{t(`localVoice.feature_${f}` as MsgKey)}</span>
        ))}
        <span className="pill border border-border/70 bg-surface-3/40 text-content-faint">
          {t("localVoice.languages")}: {m.languages.filter((l) => l !== "auto").join(", ")}
        </span>
      </div>
      {m.notes.length > 0 && (
        <ul className="mt-1.5 list-disc pl-4 text-[11.5px] text-content-faint">
          {m.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}

      {/* the license: what it says, where it lives, accepted before anything is downloaded */}
      <details className="mt-2 rounded-md border border-border/60 bg-surface-2/50 px-2.5 py-1.5" open={!m.installed && !m.license_accepted} data-testid={`local-model-license-${m.id}`}>
        <summary className="cursor-pointer select-none text-[12px] font-medium text-content">
          {t("localVoice.license")}: {m.license.name}
        </summary>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11.5px] leading-relaxed text-content-dim">
          {m.license.summary.map((s) => <li key={s}>{s}</li>)}
        </ul>
        <p className="mt-1 text-[11.5px] text-content-dim">{t("localVoice.commercial", { x: m.license.commercial })}</p>
        {m.license.attribution && (
          <p className="mt-1 rounded bg-surface-3/50 px-2 py-1 text-[11px] leading-snug text-content-faint" data-testid={`local-model-attribution-${m.id}`}>
            <b className="text-content-dim">{t("localVoice.attribution")}:</b> {m.license.attribution}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
          <a className="text-link underline" href={m.license.url} target="_blank" rel="noreferrer">{t("localVoice.licenseText")}</a>
          {m.homepage && <a className="text-link underline" href={m.homepage} target="_blank" rel="noreferrer">{t("localVoice.modelPage")}</a>}
          <span className="text-content-faint">
            {t("localVoice.files")}:{" "}
            {m.repos.map((r, i) => (
              <span key={r.id}>
                {i > 0 && ", "}
                <a className="text-link underline" href={r.url} target="_blank" rel="noreferrer">{r.id}</a>
                {m.revisions[r.id] ? ` (${t("localVoice.revision", { rev: short(m.revisions[r.id]) })})` : ""}
              </span>
            ))}
          </span>
        </div>
        {m.license_accepted && <p className="mt-1 text-[11px] text-content-faint">{t("localVoice.acceptedAt", { at: new Date(m.license_accepted.accepted_at).toLocaleString() })}</p>}
      </details>

      {installing && p && (
        <div className="mt-2 space-y-1" data-testid={`local-model-progress-${m.id}`}>
          <div className="flex items-center gap-2 text-[11.5px] text-content-dim">
            <span className="min-w-0 flex-1 truncate">
              {t(`localVoice.state_${p.state}` as MsgKey)}
              {p.message && p.state === "weights" ? ` · ${p.message}` : ""}
            </span>
            {p.total_bytes > 0 && <span className="shrink-0 tabular-nums">{gb(p.done_bytes, 2)} / {gb(p.total_bytes, 2)} GB</span>}
            <button className="btn-soft !px-2 !py-0.5 text-[11.5px]" onClick={() => act(() => cancelInstall(m.id))} disabled={busy}>{t("localVoice.cancel")}</button>
          </div>
          <ProgressBar value={p.fraction ?? undefined} indeterminate={p.fraction == null} />
          {p.log.length > 0 && (
            <details className="text-[11px] text-content-faint">
              <summary className="cursor-pointer select-none">{t("voiceStudio.mdLog")}</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-3/40 p-2 font-mono text-[10.5px]">{p.log.slice(-40).join("\n")}</pre>
            </details>
          )}
        </div>
      )}
      {p?.state === "error" && <p className="mt-2 break-words text-[12px] text-danger">{t("localVoice.state_error", { error: p.error })}</p>}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {!m.installed && !installing && (
          <>
            {!m.license_accepted && (
              <label className="flex items-center gap-1.5 text-[12px] text-content-dim">
                <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} disabled={!ready} data-testid={`local-model-accept-${m.id}`} />
                {t("localVoice.accept")}
              </label>
            )}
            <button
              className="btn-primary !py-1 text-[12.5px]"
              disabled={!ready || busy || (!accepted && !m.license_accepted)}
              title={!ready ? t("localVoice.notHere") : !accepted && !m.license_accepted ? t("localVoice.acceptFirst") : undefined}
              onClick={() => act(() => installModel(m.id, accepted))}
              data-testid={`local-model-install-${m.id}`}
            >
              <Icon name="download" size={12} /> {t("localVoice.download")}
            </button>
            {m.need_bytes > 0 && <span className="text-[11px] text-content-faint">{t("localVoice.needDisk", { gb: gb(m.need_bytes) })}</span>}
          </>
        )}
        {m.installed && (
          <>
            <span className="text-[11.5px] text-content-faint">{t("localVoice.installed", { size: `${gb(m.disk_bytes)} GB` })}</span>
            <span className="flex-1" />
            {!isDefault && (
              <button
                className="btn-ghost !py-1 text-[12px]"
                disabled={busy}
                onClick={() => act(() => putStudioSettings(m.kind === "tts" ? { default_tts: m.id } : { default_stt: m.id }))}
                data-testid={`vs-model-make-default-${m.id}`}
              >
                {t("voiceStudio.mdMakeDefault")}
              </button>
            )}
            {m.kind === "tts" && ready && (
              <button className="btn-ghost !py-1 text-[12px]" onClick={() => openInGenerate({ model_id: m.id })} data-testid={`vs-model-try-${m.id}`}>
                <Icon name="sparkles" size={12} /> {t("voiceStudio.mdTry")}
              </button>
            )}
            {m.params.length > 0 && (
              <button className="btn-ghost !py-1 text-[12px]" onClick={() => setTuning((v) => !v)} aria-expanded={tuning} data-testid={`vs-model-tune-${m.id}`}>
                <Icon name="sliders" size={12} /> {t("voiceStudio.mdDefaults")}
              </button>
            )}
            {ready && (!res || res.state === "parked") && (
              <button className="btn-soft !py-1 text-[12px]" disabled={busy} onClick={() => act(() => loadModelFrom(m.id, "settings"))} data-testid={`local-model-load-${m.id}`}>
                {busy ? <Icon name="spinner" size={12} spin /> : <Icon name="play" size={12} />} {t("localVoice.load")}
              </button>
            )}
            {res && res.state === "ready" && (
              <button className="btn-soft !py-1 text-[12px]" disabled={busy || res.busy || res.pinned} onClick={() => act(() => unloadModel(m.id))} data-testid={`local-model-unload-${m.id}`}>
                {t("localVoice.unload")}
              </button>
            )}
            <button className="btn-ghost !py-1 text-[12px] text-danger" disabled={busy} onClick={() => void remove()} data-testid={`local-model-remove-${m.id}`}>
              {t("localVoice.remove")}
            </button>
          </>
        )}
      </div>
      {tuning && m.installed && <Defaults m={m} />}
      <ErrorLine text={err} />
    </div>
  );
}

/** what every line made with this model starts from (a request's own parameters go on top) */
function Defaults({ m }: { m: VoiceModel }) {
  const t = useT();
  const [saved, setSaved] = useState<Record<string, unknown> | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let dead = false;
    getModelDefaults(m.id)
      .then((p) => {
        if (dead) return;
        setSaved(p);
        setValues(p);
      })
      .catch((e) => !dead && setErr((e as Error).message));
    return () => {
      dead = true;
    };
  }, [m.id]);
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(saved ?? {}), [values, saved]);
  const save = async (next: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      const p = await putModelDefaults(m.id, next);
      setSaved(p);
      setValues(p);
      setOk(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!saved) return err ? <ErrorLine text={err} /> : <ProgressBar indeterminate />;
  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-surface/40 p-3" data-testid={`vs-model-defaults-${m.id}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-content-dim">{t("voiceStudio.mdDefaultsHint")}</span>
        {m.params.some((p) => p.advanced) && (
          <label className="flex items-center gap-1.5 text-[11.5px] text-content-dim">
            <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
            {t("voiceStudio.advanced")}
          </label>
        )}
      </div>
      <ParamControls params={m.params} values={values} onChange={setValues} showAdvanced={advanced} testId={`vs-model-param-${m.id}`} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-primary !py-1 text-[12.5px]" disabled={busy || !dirty} onClick={() => void save(values)} data-testid={`vs-model-defaults-save-${m.id}`}>
          {busy ? <Icon name="spinner" size={12} spin /> : null} {t("voiceStudio.save")}
        </button>
        <button className="btn-ghost !py-1 text-[12.5px]" disabled={busy || Object.keys(saved).length === 0} onClick={() => void save({})}>
          {t("voiceStudio.mdDefaultsReset")}
        </button>
        {ok && !dirty && <span className="text-[11.5px] text-success">{t("voiceStudio.saved")}</span>}
      </div>
      <ErrorLine text={err} />
    </div>
  );
}

function Runtimes({ status }: { status: VoiceStatus }) {
  const t = useT();
  if (!status.runtimes.length) return null;
  return (
    <Card title={t("voiceStudio.mdRuntimes")} testId="vs-runtimes">
      <p className="mb-2 text-[11.5px] leading-snug text-content-faint">{t("voiceStudio.mdRuntimesHint", { path: status.settings.runtimes_dir })}</p>
      <ul className="space-y-1 text-[12px]">
        {status.runtimes.map((r) => (
          <li key={r.name} className="flex items-center gap-2">
            <StatusBadge status={r.ready ? "ok" : "off"}>{r.ready ? t("voiceStudio.mdRuntimeReady") : t("voiceStudio.mdRuntimeMissing")}</StatusBadge>
            <span className="font-mono text-content">{r.name}</span>
            <span className="text-content-faint">{r.engines.join(", ")}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
