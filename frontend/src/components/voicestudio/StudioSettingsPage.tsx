/**
 * Voice Studio → 설정: how local models share this machine — the GPU share they may take, how long an idle model stays
 * on the GPU and in RAM, how much RAM parked models may hold — the history's limits, the models used when none is named
 * (a mate's voice, recognition) and the profile the studio starts from; where things live and how the engines run.
 * Each value can go back to the server's own (VOICE_* in the environment).
 */
import { useEffect, useState } from "react";
import { getStudioSettings, putStudioSettings, type RuntimeKey, type StudioSettings } from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";
import { ErrorLine, Field, ProgressBar } from "../mate/settings/ui";
import { Card, useStudio } from "./shared";

/** how a value is shown and edited: seconds as minutes, a fraction as a percent */
const UNIT: Record<RuntimeKey, { scale: number; step: number; unit: "pct" | "min" | "gb" | "n" }> = {
  vram_budget_fraction: { scale: 100, step: 1, unit: "pct" },
  idle_unload_seconds: { scale: 1 / 60, step: 1, unit: "min" },
  parked_ttl_seconds: { scale: 1 / 60, step: 1, unit: "min" },
  park_ram_gb: { scale: 1, step: 0.5, unit: "gb" },
  history_max_entries: { scale: 1, step: 50, unit: "n" },
  history_max_gb: { scale: 1, step: 0.5, unit: "gb" },
};
const ENGINE: RuntimeKey[] = ["vram_budget_fraction", "idle_unload_seconds", "parked_ttl_seconds", "park_ram_gb"];
const HISTORY: RuntimeKey[] = ["history_max_entries", "history_max_gb"];

export default function StudioSettingsPage() {
  const t = useT();
  const { status, voices, reloadStatus } = useStudio();
  const [doc, setDoc] = useState<StudioSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    getStudioSettings().then(setDoc).catch((e) => setErr((e as Error).message));
  }, []);
  const put = async (key: string, patch: Parameters<typeof putStudioSettings>[0]) => {
    setBusy(key);
    setErr(null);
    try {
      setDoc(await putStudioSettings(patch));
      await reloadStatus();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!doc) return err ? <ErrorLine text={err} /> : <ProgressBar indeterminate />;
  const models = status?.models.filter((m) => m.installed) ?? [];
  const changed = (Object.keys(doc.values) as RuntimeKey[]).filter((k) => doc.values[k] !== doc.defaults[k]);
  return (
    <div className="space-y-3" data-testid="vs-settings">
      <Card title={t("voiceStudio.stEngine")} testId="vs-settings-engine">
        <div className="space-y-3">
          {ENGINE.map((k) => (
            <Runtime key={k} k={k} doc={doc} busy={busy === k} onSave={(v) => void put(k, { [k]: v })} />
          ))}
        </div>
      </Card>
      <Card title={t("voiceStudio.stHistory")} testId="vs-settings-history">
        <div className="space-y-3">
          {HISTORY.map((k) => (
            <Runtime key={k} k={k} doc={doc} busy={busy === k} onSave={(v) => void put(k, { [k]: v })} />
          ))}
        </div>
      </Card>
      <Card title={t("voiceStudio.stDefaults")} testId="vs-settings-defaults">
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label={t("voiceStudio.stDefaultTts")} hint={t("voiceStudio.stDefaultTtsHint")}>
            <select className="field" value={doc.default_tts} onChange={(e) => void put("tts", { default_tts: e.target.value })} data-testid="vs-settings-default-tts">
              <option value="">{t("voiceStudio.stAutomatic", { model: status?.defaults.tts || "–" })}</option>
              {models.filter((m) => m.kind === "tts").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label={t("voiceStudio.stDefaultStt")}>
            <select className="field" value={doc.default_stt} onChange={(e) => void put("stt", { default_stt: e.target.value })} data-testid="vs-settings-default-stt">
              <option value="">{t("voiceStudio.stAutomatic", { model: status?.defaults.stt || "–" })}</option>
              {models.filter((m) => m.kind === "stt").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label={t("voiceStudio.stDefaultVoice")} hint={t("voiceStudio.stDefaultVoiceHint")}>
            <select className="field" value={doc.default_voice} onChange={(e) => void put("voice", { default_voice: e.target.value })} data-testid="vs-settings-default-voice">
              <option value="">{t("voiceStudio.stFirstVoice")}</option>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Field>
        </div>
      </Card>
      <Card title={t("voiceStudio.stWhere")} testId="vs-settings-paths">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          {(Object.keys(doc.paths) as (keyof StudioSettings["paths"])[]).map((k) => (
            <div key={k} className="contents">
              <dt className="text-content-faint">{t(`voiceStudio.path_${k}` as MsgKey)}</dt>
              <dd className="break-all font-mono text-[11.5px] text-content-dim">{doc.paths[k]}</dd>
            </div>
          ))}
          <dt className="text-content-faint">{t("voiceStudio.stEngineMode")}</dt>
          <dd className="font-mono text-[11.5px] text-content-dim">{doc.engine_mode}</dd>
          <dt className="text-content-faint">{t("voiceStudio.stDevice")}</dt>
          <dd className="font-mono text-[11.5px] text-content-dim">{doc.device}</dd>
          {doc.hf_endpoint && (
            <>
              <dt className="text-content-faint">{t("voiceStudio.stHf")}</dt>
              <dd className="break-all font-mono text-[11.5px] text-content-dim">{doc.hf_endpoint}</dd>
            </>
          )}
        </dl>
        <p className="mt-2 text-[11px] leading-snug text-content-faint">{t("voiceStudio.stEnvHint")}</p>
      </Card>
      {changed.length > 0 && (
        <button
          className="btn-ghost !py-1 text-[12px]"
          disabled={!!busy}
          onClick={() => void put("all", Object.fromEntries(changed.map((k) => [k, null])))}
          data-testid="vs-settings-reset-all"
        >
          <Icon name="refresh" size={12} /> {t("voiceStudio.stResetAll", { n: changed.length })}
        </button>
      )}
      <ErrorLine text={err} />
    </div>
  );
}

function Runtime({ k, doc, busy, onSave }: { k: RuntimeKey; doc: StudioSettings; busy: boolean; onSave: (v: number | null) => void }) {
  const t = useT();
  const u = UNIT[k];
  const [lo, hi] = doc.bounds[k];
  const shown = (v: number) => Math.round(v * u.scale * 100) / 100;
  const [draft, setDraft] = useState(shown(doc.values[k]));
  useEffect(() => setDraft(shown(doc.values[k])), [doc.values[k]]); // (saved elsewhere, or put back)
  const dirty = draft !== shown(doc.values[k]);
  const isDefault = doc.values[k] === doc.defaults[k];
  const unit = (v: number) =>
    u.unit === "pct" ? `${v}%` : u.unit === "min" ? (v === 0 ? t("voiceStudio.stNever") : t("voiceStudio.stMinutes", { n: v })) : u.unit === "gb" ? `${v} GB` : String(v);
  return (
    <div data-testid={`vs-setting-${k}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] font-medium text-content">{t(`voiceStudio.rt_${k}` as MsgKey)}</span>
        <span className="text-[12px] tabular-nums text-content">{unit(draft)}</span>
        {!isDefault && <span className="text-[11px] text-content-faint">{t("voiceStudio.stDefaultIs", { v: unit(shown(doc.defaults[k])) })}</span>}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          className="min-w-0 flex-1 accent-[rgb(var(--c-accent))]"
          min={shown(lo)}
          max={u.unit === "min" ? Math.min(shown(hi), 240) : u.unit === "n" ? Math.min(hi, 20000) : u.unit === "gb" && k === "history_max_gb" ? Math.min(hi, 100) : shown(hi)}
          step={u.step}
          value={draft}
          onChange={(e) => setDraft(parseFloat(e.target.value))}
          data-testid={`vs-setting-${k}-range`}
        />
        <input className="field !w-24 !py-1 text-right text-[12px] tabular-nums" type="number" min={shown(lo)} max={shown(hi)} step={u.step} value={draft} onChange={(e) => setDraft(Number(e.target.value))} />
        <button className="btn-primary !px-2.5 !py-1 text-[12px]" disabled={!dirty || busy} onClick={() => onSave(draft / u.scale)} data-testid={`vs-setting-${k}-save`}>
          {busy ? <Icon name="spinner" size={11} spin /> : t("voiceStudio.save")}
        </button>
        <button className="btn-ghost !px-2 !py-1 text-[12px]" disabled={isDefault || busy} onClick={() => onSave(null)} title={t("voiceStudio.stReset")}>
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-content-faint">{t(`voiceStudio.rtHint_${k}` as MsgKey)}</p>
    </div>
  );
}
