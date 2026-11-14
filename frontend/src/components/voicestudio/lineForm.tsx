/**
 * How a line is made (Voice Studio → 생성, 일괄 생성, 도구): the profile, the model, the mode (복제: the profile's clip of
 * the feeling; 설계: a described voice; 자동: the clip when there is one, else the model's own voice), the feeling, the
 * language, the description and the model's parameters.
 */
import { useMemo, useState } from "react";
import { FEELINGS, type Feeling, type LocalVoice, type Mode, type VoiceModel } from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import { Field, Segmented } from "../mate/settings/ui";
import { FEELING_COLOR, ParamControls, useLanguages, useStudio } from "./shared";

export interface LineSettings {
  model_id: string;
  voice_id: string;
  feeling: Feeling;
  mode: Mode;
  language: string;
  instruct: string;
  params: Record<string, unknown>;
}

/** the voice descriptions offered (what the models read: English) */
export const PRESETS: { id: string; prompt: string }[] = [
  { id: "warm", prompt: "warm, gentle, friendly" },
  { id: "calm", prompt: "calm, soft, slow" },
  { id: "bright", prompt: "bright, energetic, cheerful" },
  { id: "cold", prompt: "cold, flat, serious" },
  { id: "young", prompt: "young, high pitch" },
  { id: "old", prompt: "elderly, low pitch, raspy" },
  { id: "whisper", prompt: "whisper" },
];

export function useTts(): VoiceModel[] {
  const { status } = useStudio();
  return useMemo(() => (status?.models ?? []).filter((m) => m.kind === "tts" && m.installed), [status]);
}

export function useDefaultLine(): () => LineSettings {
  const { status, voices } = useStudio();
  const tts = useTts();
  return () => {
    const v = voices.find((x) => x.id === status?.defaults.voice) ?? voices.find((x) => x.references.length) ?? null;
    const model = (v?.default_model && tts.find((m) => m.id === v.default_model)?.id) || status?.defaults.tts || tts[0]?.id || "";
    return { model_id: model, voice_id: v?.id ?? "", feeling: "neutral", mode: "auto", language: "auto", instruct: "", params: {} };
  };
}

/** which modes a model and a profile allow */
export function modesFor(m: VoiceModel | undefined, v: LocalVoice | null): { mode: Mode; ok: boolean }[] {
  const f = new Set(m?.features ?? []);
  return [
    { mode: "auto", ok: true },
    { mode: "clone", ok: f.has("clone") && !!v?.references.length },
    { mode: "design", ok: f.has("design") || f.has("instruct") },
  ];
}

/** a feeling's clip in a profile, or the one it falls back to (backend voicehost/voices.py) */
export function clipFor(v: LocalVoice | null, f: Feeling): { has: boolean; from: Feeling | null } {
  if (!v) return { has: false, from: null };
  const labels = new Set(v.references.map((r) => r.label));
  if (labels.has(f)) return { has: true, from: f };
  const near: Partial<Record<Feeling, Feeling>> = { smile: "joy", fear: "sadness", disgust: "anger" };
  if (near[f] && labels.has(near[f]!)) return { has: false, from: near[f]! };
  if (labels.has("neutral")) return { has: false, from: "neutral" };
  return { has: false, from: v.references[0]?.label ?? null };
}

export function LineForm({
  value,
  onChange,
  showParams = true,
  testId = "vs-line",
}: {
  value: LineSettings;
  onChange: (next: LineSettings) => void;
  showParams?: boolean;
  testId?: string;
}) {
  const t = useT();
  const { voices } = useStudio();
  const tts = useTts();
  const languages = useLanguages();
  const [advanced, setAdvanced] = useState(false);
  const model = tts.find((m) => m.id === value.model_id) ?? tts[0];
  const voice = voices.find((v) => v.id === value.voice_id) ?? null;
  const modes = modesFor(model, voice);
  const set = (p: Partial<LineSettings>) => onChange({ ...value, ...p });
  const pickVoice = (id: string) => {
    const v = voices.find((x) => x.id === id) ?? null;
    const m = v?.default_model && tts.some((x) => x.id === v.default_model) ? v.default_model : value.model_id;
    set({ voice_id: id, model_id: m, params: v?.default_model === m ? { ...(v?.default_params ?? {}) } : value.params, mode: value.mode === "clone" && !v?.references.length ? "auto" : value.mode });
  };
  const showInstruct = value.mode === "design" || (!!model && (model.features.includes("instruct") || (model.features.includes("design") && !voice?.references.length)));
  return (
    <div className="space-y-3" data-testid={testId}>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={t("voiceStudio.gnProfile")}>
          <select className="field" value={value.voice_id} onChange={(e) => pickVoice(e.target.value)} data-testid={`${testId}-voice`}>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.starred ? "★ " : ""}
                {v.name}
                {v.references.length ? "" : ` (${t("voiceStudio.gnNoClips")})`}
              </option>
            ))}
            <option value="">{t("voiceStudio.gnNoProfile")}</option>
          </select>
        </Field>
        <Field label={t("voiceStudio.gnModel")}>
          <select className="field" value={model?.id ?? ""} onChange={(e) => set({ model_id: e.target.value, params: voice?.default_model === e.target.value ? { ...(voice?.default_params ?? {}) } : {} })} data-testid={`${testId}-model`}>
            {tts.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-content-dim">{t("voiceStudio.gnMode")}</span>
        <Segmented
          value={value.mode}
          onChange={(mode) => set({ mode })}
          options={modes.map((x) => ({ id: x.mode, label: t(`voiceStudio.mode_${x.mode}` as MsgKey), disabled: !x.ok, title: t(`voiceStudio.modeHint_${x.mode}` as MsgKey) }))}
          testId={`${testId}-mode`}
        />
      </div>
      {value.mode !== "design" && voice && (
        <div>
          <span className="text-[12px] font-medium text-content-dim">{t("voiceStudio.gnFeeling")}</span>
          <div className="mt-1 flex flex-wrap gap-1.5" data-testid={`${testId}-feelings`}>
            {FEELINGS.map((f) => {
              const c = clipFor(voice, f);
              const on = value.feeling === f;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => set({ feeling: f })}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${on ? "border-accent bg-accent-soft text-content" : "border-border bg-surface-3/40 text-content-dim hover:text-content"}`}
                  title={c.has ? t("voiceStudio.gnHasClip") : c.from ? t("voiceStudio.pfFallback", { feeling: t(`localVoice.feeling_${c.from}` as MsgKey) }) : t("voiceStudio.pfEmpty")}
                  data-testid={`${testId}-feeling-${f}`}
                  data-has={c.has}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: FEELING_COLOR[f], opacity: c.has ? 1 : 0.25 }} />
                  {t(`localVoice.feeling_${f}` as MsgKey)}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
        <Field label={t("voiceStudio.language")}>
          <select className="field" value={value.language} onChange={(e) => set({ language: e.target.value })} data-testid={`${testId}-language`}>
            {languages
              .filter((l) => !model || l === "auto" || model.languages.includes(l) || model.languages.includes("auto"))
              .map((l) => <option key={l} value={l}>{l === "auto" ? t("voiceStudio.langAuto") : l}</option>)}
          </select>
        </Field>
        {showInstruct && (
          <Field label={value.mode === "design" ? t("voiceStudio.gnDesign") : t("voiceStudio.gnInstruct")}>
            <input className="field" value={value.instruct} onChange={(e) => set({ instruct: e.target.value })} placeholder={voice?.instruct || t("localVoice.tryInstructPh")} data-testid={`${testId}-instruct`} />
          </Field>
        )}
      </div>
      {showInstruct && (
        <div className="-mt-1 flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="rounded-md border border-border/70 bg-surface-3/30 px-2 py-0.5 text-[11.5px] text-content-dim hover:text-content" onClick={() => set({ instruct: value.instruct ? `${value.instruct}, ${p.prompt}` : p.prompt })}>
              {t(`voiceStudio.preset_${p.id}` as MsgKey)}
            </button>
          ))}
        </div>
      )}
      {showParams && model && model.params.length > 0 && (
        <details className="rounded-lg border border-border/60 bg-surface/40 px-3 py-2" data-testid={`${testId}-params`}>
          <summary className="cursor-pointer select-none text-[12px] font-medium text-content-dim">
            {t("voiceStudio.gnParams")}
            {Object.keys(value.params).length > 0 && <span className="ml-1.5 text-accent">· {t("voiceStudio.gnParamsChanged", { n: Object.keys(value.params).length })}</span>}
          </summary>
          <div className="mt-2">
            {model.params.some((p) => p.advanced) && (
              <label className="mb-2 flex items-center gap-1.5 text-[11.5px] text-content-dim">
                <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
                {t("voiceStudio.advanced")}
              </label>
            )}
            <ParamControls params={model.params} values={value.params} onChange={(params) => set({ params })} showAdvanced={advanced} testId={`${testId}-param`} />
            <p className="mt-2 text-[11px] text-content-faint">{t("voiceStudio.gnParamsHint")}</p>
          </div>
        </details>
      )}
    </div>
  );
}

/** about how long a line will be (Korean, Japanese, Chinese: ~6.5 characters a second; else ~14) */
export function estimateSeconds(text: string, language: string): number {
  const n = text.replace(/\s+/g, " ").trim().length;
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  const dense = language === "ko" || language === "ja" || language === "zh" || cjk > n / 3;
  return n / (dense ? 6.5 : 14);
}
