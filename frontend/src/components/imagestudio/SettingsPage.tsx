/**
 * Image Studio → 설정: what the avatar maker (and 시험) uses — the model each use takes, each recipe's knobs, the
 * engine each avatar stage starts on (this computer or Higgsfield: the user can still switch a stage on the estimate),
 * how long the engine stays up without a job, how many results the history keeps, and where things are.
 */
import { useEffect, useState } from "react";
import { AVATAR_STAGES, getImageSettings, putImageSettings, USES, type AvatarStage, type ImageSettings, type ImageUse } from "../../api/image";
import { useT, type MsgKey } from "../../i18n";
import HelpTip from "../ui/HelpTip";
import Icon from "../ui/Icon";
import { ErrorLine, ProgressBar, Segmented } from "../mate/settings/ui";
import { Card, ParamControls, useImageStudio } from "./shared";

export default function SettingsPage() {
  const t = useT();
  const { status, reload, tick } = useImageStudio();
  const [doc, setDoc] = useState<ImageSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    getImageSettings()
      .then(setDoc)
      .catch((e) => setErr((e as Error).message));
  }, [tick]);
  const save = async (patch: Parameters<typeof putImageSettings>[0], what: string) => {
    setErr(null);
    try {
      setDoc(await putImageSettings(patch));
      setSaved(what);
      void reload();
      setTimeout(() => setSaved((s) => (s === what ? null : s)), 1600);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (!doc || !status) return err ? <ErrorLine text={err} /> : <ProgressBar indeterminate />;
  const ok = (what: string) => saved === what && <span className="text-[11.5px] text-success"><Icon name="check" size={11} /> {t("imageStudio.saved")}</span>;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-testid="is-settings">
      <Card title={t("imageStudio.setModels")} help={t("imageStudio.setModelsHint")} right={ok("models")} testId="is-set-models">
        <div className="space-y-2">
          {USES.map((u) => {
            const have = status.models.filter((m) => m.installed && m.uses.includes(u));
            return (
              <label key={u} className="flex items-center gap-2 text-[12.5px]">
                <span className="w-28 shrink-0 text-content">{t(`imageStudio.use_${u}` as MsgKey)}</span>
                <select
                  className="field !py-1 text-[12.5px]"
                  value={doc.models[u] || ""}
                  disabled={have.length === 0}
                  onChange={(e) => void save({ models: { [u]: e.target.value } }, "models")}
                  data-testid={`is-set-model-${u}`}
                >
                  <option value="">{have.length ? t("imageStudio.setAuto", { name: status.models.find((m) => m.id === status.defaults[u])?.name ?? "" }) : t("imageStudio.setNone")}</option>
                  {have.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
            );
          })}
        </div>
      </Card>

      <Card title={t("imageStudio.setAvatar")} help={t("imageStudio.setAvatarHint")} right={ok("avatar")} testId="is-set-avatar">
        <div className="space-y-1.5">
          {AVATAR_STAGES.map((st) => {
            const s = status.avatar.stages[st];
            const value = (doc.avatar[st] ?? s?.default ?? "higgsfield") as "local" | "higgsfield";
            return (
              <div key={st} className="flex items-center gap-2 text-[12.5px]" data-testid={`is-set-avatar-${st}`}>
                <span className="w-24 shrink-0 text-content">{t(`imageStudio.stage_${st}` as MsgKey)}</span>
                <Segmented
                  value={s?.ready ? value : "higgsfield"}
                  onChange={(v) => void save({ avatar: { ...doc.avatar, [st]: v } as Record<AvatarStage, "local" | "higgsfield"> }, "avatar")}
                  options={[
                    { id: "local" as const, label: t("imageStudio.engLocal"), disabled: !s?.ready, title: s?.ready ? s.model_name : t("imageStudio.stageNoModel", { use: t(`imageStudio.use_${s?.use ?? "draft"}` as MsgKey) }) },
                    { id: "higgsfield" as const, label: t("imageStudio.engHosted") },
                  ]}
                />
                {s?.ready && <span className="min-w-0 flex-1 truncate text-[11px] text-content-faint">{s.model_name}</span>}
              </div>
            );
          })}
        </div>
      </Card>

      {status.recipes.filter((r) => r.params.length > 0).map((r) => (
        <RecipeCard key={r.id} use={r.use} doc={doc} onSave={(v) => save({ recipes: { [r.use]: v } }, `recipe:${r.use}`)} saved={saved === `recipe:${r.use}`} />
      ))}

      <Card title={t("imageStudio.setEngine")} right={ok("engine")} testId="is-set-engine">
        <div className="space-y-2.5 text-[12.5px]">
          <NumberRow
            label={t("imageStudio.setIdle")}
            hint={t("imageStudio.setIdleHint")}
            value={Math.round(doc.values.idle_stop_seconds / 60)}
            unit={t("imageStudio.minutes")}
            min={0}
            max={1440}
            onSave={(v) => save({ idle_stop_seconds: v * 60 }, "engine")}
            testId="is-set-idle"
          />
          <div data-testid="is-set-voice-room">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-content">{t("imageStudio.setVoiceRoom")}<HelpTip>{t("imageStudio.setVoiceRoomHint")}</HelpTip></span>
              <select
                className="field !w-auto !py-1 text-[12.5px]"
                value={String(doc.values.voice_room_gb)}
                onChange={(e) => void save({ voice_room_gb: Number(e.target.value) }, "engine")}
              >
                <option value="-1">{t("imageStudio.setVoiceRoomAuto", { gb: Math.max(0, (status.engine.reserve_gb ?? 1) - 1).toFixed(1) })}</option>
                {[0, 2, 3, 4, 6].map((g) => <option key={g} value={String(g)}>{g} GB</option>)}
              </select>
            </div>
          </div>
          <NumberRow
            label={t("imageStudio.setHistory")}
            hint={t("imageStudio.setHistoryHint")}
            value={doc.values.history_max_entries}
            min={doc.bounds.history_max_entries[0]}
            max={doc.bounds.history_max_entries[1]}
            onSave={(v) => save({ history_max_entries: v }, "engine")}
            testId="is-set-history"
          />
        </div>
      </Card>

      <Card title={t("imageStudio.setPaths")} help={t("imageStudio.setPathsHint")} testId="is-set-paths">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
          {(Object.keys(doc.paths) as (keyof ImageSettings["paths"])[]).map((k) => (
            <div key={k} className="contents">
              <dt className="text-content-faint">{t(`imageStudio.path_${k}` as MsgKey)}</dt>
              <dd className="break-all font-mono text-content-dim">{doc.paths[k]}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <ErrorLine text={err} />
    </div>
  );
}

function RecipeCard({ use, doc, onSave, saved }: { use: ImageUse; doc: ImageSettings; onSave: (v: Record<string, unknown> | null) => Promise<void>; saved: boolean }) {
  const t = useT();
  const { status } = useImageStudio();
  const recipe = status?.recipes.find((r) => r.use === use);
  const [values, setValues] = useState<Record<string, unknown>>(doc.recipes[use] ?? {});
  useEffect(() => setValues(doc.recipes[use] ?? {}), [doc, use]);
  if (!recipe) return null;
  const dirty = JSON.stringify(values) !== JSON.stringify(doc.recipes[use] ?? {});
  return (
    <Card title={t("imageStudio.setRecipe", { name: recipe.label })} right={saved && <span className="text-[11.5px] text-success">{t("imageStudio.saved")}</span>} testId={`is-set-recipe-${use}`}>
      <ParamControls params={recipe.params} values={values} onChange={setValues} showAdvanced testId={`is-set-recipe-${use}`} />
      <div className="mt-2.5 flex gap-2">
        <button className="btn-primary !py-1 text-[12.5px]" disabled={!dirty} onClick={() => void onSave(values)}>{t("imageStudio.save")}</button>
        <button className="btn-ghost !py-1 text-[12.5px]" onClick={() => void onSave(null)}>{t("imageStudio.reset")}</button>
      </div>
    </Card>
  );
}

function NumberRow({ label, hint, value, unit, min, max, onSave, testId }: { label: string; hint: string; value: number; unit?: string; min: number; max: number; onSave: (v: number) => Promise<void>; testId: string }) {
  const t = useT();
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const n = Number(v);
  const valid = v.trim() !== "" && Number.isFinite(n) && n >= min && n <= max;
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-content">{label}{hint && <HelpTip>{hint}</HelpTip>}</span>
        <input className="field !w-24 !py-1 text-right text-[12.5px]" value={v} onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ""))} data-testid={testId} />
        {unit && <span className="text-content-faint">{unit}</span>}
        <button className="btn-soft !px-2 !py-1 text-[12px]" disabled={!valid || n === value} onClick={() => void onSave(n)}>{t("imageStudio.save")}</button>
      </div>
    </div>
  );
}
