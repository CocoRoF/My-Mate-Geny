/**
 * Settings → 이미지 및 음성 공급자 → 로컬 음성 모델 (docs/local-voice.md): this server's GPU and whether it can serve local
 * models at all (and why not), the models — each with its page, its license (read, accepted, then downloaded), its
 * install progress, its place on the GPU — the voices they speak with (built in: 한채린, 메스가키; the user's own: clips
 * by feeling), and a line to hear / a file to transcribe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addVoiceReference,
  cancelInstall,
  createLocalVoice,
  deleteLocalVoice,
  deleteVoiceReference,
  FEELINGS,
  getVoiceStatus,
  installModel,
  listLocalVoices,
  loadModel,
  previewVoice,
  referenceAudioUrl,
  removeModel,
  transcribeLocal,
  unloadModel,
  type Feeling,
  type Gate,
  type LocalVoice,
  type VoiceModel,
  type VoiceStatus,
} from "../../api/voice";
import { useLang, useT, type MsgKey } from "../../i18n";
import { confirmDialog } from "../ui/ConfirmDialog";
import Icon from "../ui/Icon";
import { Banner, ErrorLine, Field, ProgressBar, Section, StatusBadge } from "../mate/settings/ui";
import { playPreview } from "../mate/settings/engines";

const GiB = 1024 ** 3;
const gb = (n: number | null | undefined, digits = 1) => (n == null || !Number.isFinite(n) ? "?" : (n / GiB).toFixed(digits));
const short = (sha: string) => (sha && sha.length > 10 ? sha.slice(0, 8) : sha);

function gateText(t: ReturnType<typeof useT>, g: Gate): string {
  const gpu = g.gpu;
  switch (g.code) {
    case "ok":
      return t("localVoice.gateOk");
    case "old_driver":
      return t("localVoice.gate_old_driver", { driver: gpu?.driver ?? "?", min: g.requirements.driver });
    case "old_gpu":
      return t("localVoice.gate_old_gpu", { gpu: gpu?.name ?? "GPU", cap: gpu?.capability ?? "?" });
    case "small_gpu":
      return t("localVoice.gate_small_gpu", { gpu: gpu?.name ?? "GPU", gb: gb(gpu?.total), min: gb(g.requirements.vram, 0) });
    case "platform":
      return t("localVoice.gate_platform", { platform: String(g.detail.platform ?? "?") });
    case "python":
      return t("localVoice.gate_python", { python: String(g.detail.python ?? "?"), need: g.requirements.python });
    case "packages":
      return t("localVoice.gate_packages", { list: ((g.detail.missing as string[]) ?? []).join(", ") });
    default:
      return t(`localVoice.gate_${g.code}` as MsgKey);
  }
}

function useVoiceStatus() {
  const lang = useLang();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setStatus(await getVoiceStatus(lang));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [lang]);
  // (often while something moves — an install, a model loading; otherwise now and then, and when the window comes back)
  const busy = !!status?.models.some((m) => (m.progress && ["queued", "runtime", "source", "weights"].includes(m.progress.state)) ||
    (m.resident && ["starting", "loading", "stopping"].includes(m.resident.state)));
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), busy ? 1500 : 8000);
    const back = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [reload, busy]);
  return { status, err, reload };
}

export default function LocalVoiceView() {
  const t = useT();
  const { status, err, reload } = useVoiceStatus();
  const [voices, setVoices] = useState<LocalVoice[] | null>(null);
  const reloadVoices = useCallback(() => void listLocalVoices().then(setVoices).catch(() => {}), []);
  useEffect(() => reloadVoices(), [reloadVoices]);

  if (!status) {
    return (
      <div className="space-y-3" data-testid="local-voice">
        <p className="text-[13px] leading-relaxed text-content-dim">{t("localVoice.intro")}</p>
        {err ? <ErrorLine text={err} /> : <ProgressBar indeterminate />}
      </div>
    );
  }
  const ready = status.gate.ok;
  return (
    <div className="space-y-4" data-testid="local-voice">
      <p className="text-[13px] leading-relaxed text-content-dim">{t("localVoice.intro")}</p>
      <GateCard status={status} />
      <Section title={t("localVoice.modelsTitle")} hint={t("localVoice.modelsHint", { min: Math.round(status.settings.idle_unload_seconds / 60) })} testId="local-voice-models">
        <div className="space-y-3">
          {status.models.map((m) => (
            <ModelCard key={m.id} m={m} ready={ready} onChange={reload} />
          ))}
        </div>
      </Section>
      <VoicesSection voices={voices} onChange={reloadVoices} sttReady={ready && status.models.some((m) => m.kind === "stt" && m.installed)} />
      {ready && <TrySection status={status} voices={voices ?? []} />}
      {status.events.length > 0 && (
        <details className="rounded-lg border border-border/70 bg-surface/40 px-3 py-2 text-[12px] text-content-faint">
          <summary className="cursor-pointer select-none">{t("localVoice.events")}</summary>
          <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
            {status.events.slice().reverse().map((e, i) => (
              <li key={i}>
                {new Date(e.t * 1000).toLocaleTimeString()} {t("localVoice.event", { model: e.model_id, what: e.what })}
                {e.why ? ` (${e.why})` : ""}
                {e.seconds != null ? ` · ${e.seconds}s` : ""}
                {e.error ? ` · ${e.error}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function GateCard({ status }: { status: VoiceStatus }) {
  const t = useT();
  const g = status.gate;
  const gpu = status.system.gpus[0];
  const mem = status.system.memory;
  return (
    <Section title={t("localVoice.gpuTitle")} testId="local-voice-gate" right={<StatusBadge status={g.ok ? "ok" : "off"} testId="local-voice-gate-state">{g.ok ? "GPU" : t("localVoice.notHere")}</StatusBadge>}>
      <div className="space-y-2 text-[12.5px]">
        {gpu && (
          <p className="text-content" data-testid="local-voice-gpu">
            {t("localVoice.gpuLine", { name: gpu.name, used: gb(gpu.used), total: gb(gpu.total), driver: gpu.driver, cap: gpu.capability || "?" })}
          </p>
        )}
        <p className="text-content-faint">
          {t("localVoice.hostLine", { free: gb(mem.available), total: gb(mem.total, 0), disk: gb(status.system.disk.models.free, 0) })}
        </p>
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
    </Section>
  );
}

function ModelCard({ m, ready, onChange }: { m: VoiceModel; ready: boolean; onChange: () => Promise<void> | void }) {
  const t = useT();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const p = m.progress;
  const installing = !!p && ["queued", "runtime", "source", "weights"].includes(p.state);
  const res = m.resident;
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
    <div className="rounded-lg border border-border/70 bg-surface/40 p-3" data-testid={`local-model-${m.id}`} data-installed={m.installed}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13.5px] font-semibold text-content">{m.name}</span>
            <span className="pill border border-border bg-surface-3/60 text-content-faint">{t(`localVoice.kind_${m.kind}` as MsgKey)}</span>
            {m.installed && <StatusBadge status="ok">{t("localVoice.state_done")}</StatusBadge>}
            {res && (
              <StatusBadge status={res.state === "ready" ? "ok" : res.state === "parked" ? "warn" : "checking"} testId={`local-model-res-${m.id}`}>
                {t(`localVoice.res_${res.state}` as MsgKey)}
              </StatusBadge>
            )}
            {res?.pinned && <span className="pill border border-accent/30 bg-accent-soft text-accent">{t("localVoice.pinned")}</span>}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-content-dim">{m.description}</p>
          <p className="mt-1 text-[11.5px] text-content-faint">
            {t("localVoice.sizes", { dl: m.download_gb.toFixed(1), vram: m.vram_gb.toFixed(1) })}
            {res?.vram_used ? ` · ${t("localVoice.vramUsed", { gb: gb(res.vram_used) })}` : ""}
          </p>
          <p className="mt-0.5 text-[11.5px] text-content-faint">
            {m.features.map((f) => t(`localVoice.feature_${f}` as MsgKey)).join(" · ")} · {t("localVoice.languages")}: {m.languages.filter((l) => l !== "auto").join(", ")}
          </p>
          {m.notes.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-[11.5px] text-content-faint">
              {m.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
        </div>
      </div>

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
              {t(`localVoice.state_${p.state}` as MsgKey)}{p.message && p.state === "weights" ? ` · ${p.message}` : ""}
            </span>
            {p.total_bytes > 0 && <span className="shrink-0 tabular-nums">{gb(p.done_bytes, 2)} / {gb(p.total_bytes, 2)} GB</span>}
            <button className="btn-soft !px-2 !py-0.5 text-[11.5px]" onClick={() => act(() => cancelInstall(m.id))} disabled={busy}>{t("localVoice.cancel")}</button>
          </div>
          <ProgressBar value={p.fraction ?? undefined} indeterminate={p.fraction == null} />
        </div>
      )}
      {p?.state === "error" && <p className="mt-2 text-[12px] text-danger break-words">{t("localVoice.state_error", { error: p.error })}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-2">
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
            {ready && (!res || res.state === "parked") && (
              <button className="btn-soft !py-1 text-[12px]" disabled={busy} onClick={() => act(() => loadModel(m.id))} data-testid={`local-model-load-${m.id}`}>
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
      <ErrorLine text={err} />
    </div>
  );
}

function VoicesSection({ voices, onChange, sttReady }: { voices: LocalVoice[] | null; onChange: () => void; sttReady: boolean }) {
  const t = useT();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    if (!name.trim()) return;
    setErr(null);
    try {
      await createLocalVoice(name.trim(), "auto");
      setName("");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Section title={t("localVoice.voicesTitle")} hint={t("localVoice.voicesHint")} testId="local-voice-voices">
      <div className="space-y-3">
        {(voices ?? []).map((v) => (
          <VoiceCard key={v.id} v={v} onChange={onChange} sttReady={sttReady} />
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("localVoice.newVoice")}>
            <input className="field !w-56" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("localVoice.voiceName")} data-testid="local-voice-new-name" />
          </Field>
          <button className="btn-soft !py-1.5 text-[12.5px]" disabled={!name.trim()} onClick={() => void create()} data-testid="local-voice-create">
            <Icon name="plus" size={12} /> {t("localVoice.create")}
          </button>
        </div>
        <ErrorLine text={err} />
      </div>
    </Section>
  );
}

function VoiceCard({ v, onChange, sttReady }: { v: LocalVoice; onChange: () => void; sttReady: boolean }) {
  const t = useT();
  const [label, setLabel] = useState<Feeling>("neutral");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    setBusy(true);
    setErr(null);
    try {
      await addVoiceReference(v.id, f, label, text, f.name);
      setText("");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ body: t("localVoice.deleteVoiceConfirm", { name: v.name }), confirmLabel: t("localVoice.deleteVoice"), danger: true }))) return;
    await deleteLocalVoice(v.id).catch(() => {});
    onChange();
  };
  return (
    <div className="rounded-lg border border-border/70 bg-surface/40 p-3" data-testid={`local-voice-${v.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold text-content">{v.name}</span>
        {v.builtin && <span className="pill border border-accent/30 bg-accent-soft text-accent">{t("localVoice.builtin")}</span>}
        <span className="flex-1" />
        {!v.builtin && (
          <button className="btn-ghost !py-0.5 text-[12px] text-danger" onClick={() => void remove()} data-testid={`local-voice-delete-${v.id}`}>
            {t("localVoice.deleteVoice")}
          </button>
        )}
      </div>
      {v.rights && <p className="mt-0.5 text-[11px] text-content-faint">{t("localVoice.rights", { x: v.rights })}</p>}
      {v.references.length === 0 ? (
        <p className="mt-2 text-[12px] text-content-faint">{t("localVoice.noClips")}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {v.references.map((r) => (
            <li key={r.id} className="flex items-start gap-2 text-[12px]" data-testid={`local-voice-ref-${r.id}`}>
              <button
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border hover:bg-surface-3"
                onClick={() => void fetch(referenceAudioUrl(v.id, r.id)).then((x) => x.blob()).then((b) => playPreview(`ref:${r.id}`, b))}
                title={t(`localVoice.feeling_${r.label}` as MsgKey)}
              >
                <Icon name="play" size={10} />
              </button>
              <span className="w-14 shrink-0 pt-0.5 font-medium text-content-dim">{t(`localVoice.feeling_${r.label}` as MsgKey)}</span>
              <span className="min-w-0 flex-1 pt-0.5 leading-snug text-content">
                {r.transcript || "—"}
                <span className="ml-1 text-content-faint">· {r.duration.toFixed(1)}s</span>
                {(r.stats?.warnings ?? []).map((w) => (
                  <span key={w} className="ml-1 text-warning">· {t(`localVoice.warn_${w}` as MsgKey)}</span>
                ))}
              </span>
              {!v.builtin && (
                <button className="btn-ghost !px-1 !py-0 text-[11px] text-content-faint hover:text-danger" onClick={() => void deleteVoiceReference(r.id).then(onChange)} title={t("localVoice.deleteClip")}>
                  <Icon name="x" size={11} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!v.builtin && (
        <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-border/60 pt-2">
          <Field label={t("localVoice.clipFeeling")}>
            <select className="field !w-28" value={label} onChange={(e) => setLabel(e.target.value as Feeling)} data-testid={`local-voice-clip-label-${v.id}`}>
              {FEELINGS.map((f) => <option key={f} value={f}>{t(`localVoice.feeling_${f}` as MsgKey)}</option>)}
            </select>
          </Field>
          <Field label={t("localVoice.clipText")}>
            <input className="field !w-64" value={text} onChange={(e) => setText(e.target.value)} placeholder={sttReady ? t("localVoice.clipTextPh") : ""} />
          </Field>
          <input ref={file} type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} data-testid={`local-voice-clip-file-${v.id}`} />
          <button className="btn-soft !py-1.5 text-[12.5px]" disabled={busy} onClick={() => file.current?.click()} title={t("localVoice.chooseFile")}>
            {busy ? <Icon name="spinner" size={12} spin /> : <Icon name="upload" size={12} />} {t("localVoice.addClip")}
          </button>
        </div>
      )}
      <ErrorLine text={err} />
    </div>
  );
}

function TrySection({ status, voices }: { status: VoiceStatus; voices: LocalVoice[] }) {
  const t = useT();
  const tts = useMemo(() => status.models.filter((m) => m.kind === "tts" && m.installed), [status.models]);
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("builtin:chaerin");
  const [feeling, setFeeling] = useState<Feeling>("neutral");
  const [text, setText] = useState(t("localVoice.trySample"));
  const [instruct, setInstruct] = useState("");
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const m = tts.find((x) => x.id === model) ?? tts.find((x) => x.id === status.defaults.tts) ?? tts[0];
  const canDesign = !!m && (m.features.includes("design") || m.features.includes("instruct"));
  const speak = async () => {
    if (!m) return;
    setBusy(true);
    setErr(null);
    setStats(null);
    try {
      const { blob, info } = await previewVoice({ model_id: m.id, voice_id: voice || undefined, text, emotion: feeling, instruct: canDesign ? instruct : undefined });
      setStats(t("localVoice.tryStats", { seconds: info.seconds ?? "?", ready: info.ready_seconds ?? "?", gen: info.generate_seconds ?? "?", rtf: info.rtf ?? "?" }));
      await playPreview(`local:${m.id}:${voice}:${feeling}:${text}`, blob);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const hear = async (f: File) => {
    setHeard(null);
    setErr(null);
    try {
      const r = await transcribeLocal(f, "auto", f.name);
      setHeard(t("localVoice.sttHeard", { seconds: r.seconds, text: r.text || "—" }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      if (file.current) file.current.value = "";
    }
  };
  const sttInstalled = status.models.some((x) => x.kind === "stt" && x.installed);
  return (
    <Section title={t("localVoice.tryTitle")} testId="local-voice-try">
      {!m ? (
        <p className="text-[12px] text-content-faint">{t(status.models.some((x) => x.installed) ? "localVoice.noTts" : "localVoice.noModels")}</p>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label={t("localVoice.tryModel")}>
              <select className="field" value={m.id} onChange={(e) => setModel(e.target.value)} data-testid="local-try-model">
                {tts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
            <Field label={t("localVoice.tryVoice")}>
              <select className="field" value={voice} onChange={(e) => setVoice(e.target.value)} data-testid="local-try-voice">
                {voices.filter((v) => v.references.length).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                {m.features.includes("auto_voice") && <option value="">{t("localVoice.tryOwnVoice")}</option>}
              </select>
            </Field>
            <Field label={t("localVoice.tryFeeling")}>
              <select className="field" value={feeling} onChange={(e) => setFeeling(e.target.value as Feeling)} data-testid="local-try-feeling">
                {FEELINGS.map((f) => <option key={f} value={f}>{t(`localVoice.feeling_${f}` as MsgKey)}</option>)}
              </select>
            </Field>
          </div>
          <Field label={t("localVoice.tryText")}>
            <textarea className="field min-h-[64px]" value={text} onChange={(e) => setText(e.target.value)} data-testid="local-try-text" />
          </Field>
          {canDesign && (
            <Field label={t("localVoice.tryInstruct")}>
              <input className="field" value={instruct} onChange={(e) => setInstruct(e.target.value)} placeholder={t("localVoice.tryInstructPh")} />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary !py-1.5 text-[12.5px]" disabled={busy || !text.trim()} onClick={() => void speak()} data-testid="local-try-speak">
              {busy ? <Icon name="spinner" size={12} spin /> : <Icon name="volume" size={12} />} {t("localVoice.trySpeak")}
            </button>
            {sttInstalled && (
              <>
                <input ref={file} type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && void hear(e.target.files[0])} />
                <button className="btn-soft !py-1.5 text-[12.5px]" onClick={() => file.current?.click()} data-testid="local-try-stt">
                  <Icon name="mic" size={12} /> {t("localVoice.sttTry")}
                </button>
              </>
            )}
          </div>
          {stats && <p className="text-[11.5px] text-content-faint" data-testid="local-try-stats">{stats}</p>}
          {heard && <p className="text-[12px] text-content" data-testid="local-try-heard">{heard}</p>}
          <ErrorLine text={err} />
        </div>
      )}
    </Section>
  );
}
