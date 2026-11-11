/**
 * Language model (this mate): which engine it thinks with (Claude Code, Codex, or an API key run by the app's own
 * engine: Anthropic, OpenAI, Google), which of that engine's models and
 * how much it reasons. Defaults: Claude Sonnet 5.5 / GPT-6.1-Sol, low effort.
 */
import { useEffect, useState } from "react";
import { DEFAULT_MATE_MODELS, MATE_EFFORTS, type Mate, type MateEngine } from "../../../api/mates";
import { API_PROVIDERS, isApiProvider } from "../../../api/apiProviders";
import { useConfigStore } from "../../../stores/configStore";
import { useMateStore } from "../../../stores/mateStore";
import { useProviderStore } from "../../../stores/providerStore";
import { openAppSettings } from "../../../lib/openAppSettings";
import type { CatalogModel } from "../../../types";
import Icon from "../../ui/Icon";
import { tr, useT, type MsgKey } from "../../../i18n";
import { Banner, Field, LinkButton, SaveBar, Section, Segmented, useFollowSaved, useSaver } from "./ui";

const CLI_ENGINES: { id: MateEngine; label: string; hint: MsgKey; fallback: string }[] = [
  {
    id: "claude",
    label: "Claude Code",
    hint: "mateSettings.modelClaudeHint",
    fallback: "Claude Sonnet 5.5",
  },
  {
    id: "codex",
    label: "Codex",
    hint: "mateSettings.modelCodexHint",
    fallback: "GPT-6.1-Sol",
  },
];

const EFFORT_HINT: Record<string, MsgKey> = {
  default: "mateSettings.effortDefaultHint",
  low: "mateSettings.effortLowHint",
  medium: "mateSettings.effortMediumHint",
  high: "mateSettings.effortHighHint",
  xhigh: "mateSettings.effortXhighHint",
  max: "mateSettings.effortMaxHint",
};
const EFFORT_LABEL: Record<string, MsgKey> = {
  default: "common.default",
  low: "mateSettings.effortLow",
  medium: "mateSettings.effortMedium",
  high: "mateSettings.effortHigh",
  xhigh: "mateSettings.effortXhigh",
  max: "mateSettings.effortMax",
};

/** a line about what a model is like for a mate (when the catalog has no description; call while rendering) */
function blurb(id: string, label: string): string {
  const s = `${id} ${label}`.toLowerCase();
  if (s.includes("sonnet")) return tr("mateSettings.blurbSonnet");
  if (s.includes("haiku")) return tr("mateSettings.blurbHaiku");
  if (s.includes("opus")) return tr("mateSettings.blurbOpus");
  if (s.includes("fable")) return tr("mateSettings.blurbFable");
  if (s.includes("sol")) return tr("mateSettings.blurbSol");
  return "";
}

const openProviders = () => openAppSettings("providers");

export default function ModelTab({ mate }: { mate: Mate }) {
  const t = useT();
  const catalog = useConfigStore((s) => s.catalog);
  const providers = useProviderStore((s) => s.providers);
  // Claude Code and Codex, then each API-key provider (the app's own engine) that has a model switched on
  const ENGINES = [
    ...CLI_ENGINES,
    ...API_PROVIDERS.filter((id) => catalog[id]?.models.length).map((id) => ({
      id: id as MateEngine,
      label: `${catalog[id]?.label || id} API`,
      hint: "mateSettings.modelApiHint" as MsgKey,
      fallback: catalog[id]?.default_model || DEFAULT_MATE_MODELS[id as MateEngine],
    })),
  ];
  const engineName = (id: string) => ENGINES.find((e) => e.id === id)?.label || id;
  const mateDefault = (id: MateEngine): string => {
    if (!isApiProvider(id)) return DEFAULT_MATE_MODELS[id];
    const on = catalog[id]?.models || [];
    return on.some((m) => m.id === DEFAULT_MATE_MODELS[id]) ? DEFAULT_MATE_MODELS[id] : catalog[id]?.default_model || DEFAULT_MATE_MODELS[id];
  };
  useEffect(() => {
    if (!catalog.claude) void useConfigStore.getState().load().catch(() => {});
    if (!providers.length) void useProviderStore.getState().load().catch(() => {});
  }, [catalog.claude, providers.length]);

  const storedEngine: MateEngine = mate.llm.provider === "codex" || isApiProvider(mate.llm.provider) ? mate.llm.provider : "claude";
  // an empty model talks on the engine's mate default, so show that as selected
  const storedModel = mate.llm.model || mateDefault(storedEngine);
  const storedEffort = mate.llm.effort || "low";
  const [engine, setEngine] = useState<MateEngine>(storedEngine);
  const [model, setModel] = useState(storedModel);
  const [effort, setEffort] = useState(storedEffort);
  const saver = useSaver();

  const def = mateDefault(engine);
  const entry = catalog[engine];
  const listed: CatalogModel[] = (entry?.models ?? []).filter((m) => !(engine === "codex" && m.id === "default"));
  const models: CatalogModel[] = [
    ...(listed.some((m) => m.id === def) ? [] : [{ id: def, label: ENGINES.find((e) => e.id === engine)?.fallback || def }]),
    ...listed,
    ...(model && !listed.some((m) => m.id === model) && model !== def ? [{ id: model, label: model }] : []),
  ].sort((a, b) => Number(b.id === def) - Number(a.id === def));
  const cur = models.find((m) => m.id === model);
  // Codex models have their own reasoning levels; only those a mate can store (no "ultra": that one delegates)
  const offered = cur?.effort?.length ? cur.effort : entry?.effort?.length ? entry.effort : MATE_EFFORTS;
  const efforts = MATE_EFFORTS.filter((e) => e === "default" || offered.includes(e));
  const status = providers.find((p) => p.provider === engine);
  const connected = status ? status.connected : true; // (unknown until loaded: don't cry wolf)

  const pickEngine = (id: MateEngine) => {
    if (id === engine) return;
    setEngine(id);
    if (id === storedEngine) {
      setModel(storedModel);
      setEffort(storedEffort);
    } else {
      setModel(mateDefault(id));
      setEffort("low");
    }
  };
  const pickModel = (id: string) => {
    setModel(id);
    const m = models.find((x) => x.id === id);
    if (m?.effort?.length && effort !== "default" && !m.effort.includes(effort)) setEffort("default");
  };

  const dirty = engine !== storedEngine || model !== storedModel || effort !== storedEffort;
  const save = () => saver.run(() => useMateStore.getState().patch(mate.id, { llm: { provider: engine, model, effort } }));
  const reset = () => {
    setEngine(storedEngine);
    setModel(storedModel);
    setEffort(storedEffort);
  };
  useFollowSaved([storedEngine, storedModel, storedEffort], dirty, reset);

  return (
    <>
      <Section
        title={t("mateSettings.modelTitle")}
        hint={t("mateSettings.modelHint")}
      >
        <Field label={t("mateSettings.modelEngine")} as="div">
          <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" data-testid="mate-engine">
            {ENGINES.map((e) => {
              const on = engine === e.id;
              const st = providers.find((p) => p.provider === e.id);
              return (
                <button
                  key={e.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pickEngine(e.id)}
                  data-value={e.id}
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition ${on ? "border-accent/60 bg-accent-soft" : "border-border hover:border-border-strong hover:bg-surface-3/40"}`}
                >
                  <span className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${on ? "border-accent" : "border-border-strong"}`}>
                    {on && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-content">
                      <Icon name={e.id === "codex" ? "terminal" : isApiProvider(e.id) ? "key" : "brain"} size={13} className="text-accent" /> {e.label}
                      {st && !st.connected && <span className="rounded bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning">{t("mateSettings.modelNotConnected")}</span>}
                    </span>
                    <span className="block text-[11.5px] text-content-faint">{t(e.hint, { vendor: catalog[e.id]?.label || e.id })}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
        {!connected && (
          <Banner
            testId="mate-engine-disconnected"
            action={<LinkButton onClick={openProviders} testId="mate-engine-providers">{t("mateSettings.modelOpenProviders")}</LinkButton>}
          >
            {t(status?.detail ? "mateSettings.modelDisconnectedDetail" : "mateSettings.modelDisconnected", { engine: engineName(engine), detail: status?.detail ?? "" })}
          </Banner>
        )}
        {engine !== storedEngine && (
          <Banner tone="info" testId="mate-engine-switch">
            {t("mateSettings.modelSwitchNote", { engine: engineName(engine) })}
          </Banner>
        )}
        <Field label={t("mateSettings.voiceModel")} as="div">
          <div className="space-y-1.5" role="radiogroup" data-testid="mate-model">
            {models.map((m) => {
              const on = model === m.id;
              const desc = m.description || blurb(m.id, m.label);
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pickModel(m.id)}
                  data-value={m.id}
                  className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition ${on ? "border-accent/60 bg-accent-soft" : "border-border hover:border-border-strong hover:bg-surface-3/40"}`}
                >
                  <span className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${on ? "border-accent" : "border-border-strong"}`}>
                    {on && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-content">
                      {m.label}
                      {m.id === def && <span className="rounded bg-success/15 px-1.5 py-px text-[10px] font-medium text-success">{t("mateSettings.modelRecommended")}</span>}
                    </span>
                    {desc && <span className="block text-[11.5px] text-content-faint">{desc}</span>}
                    <span className="block font-mono text-[10.5px] text-content-faint/80 light:text-content-faint">{m.id}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
        {efforts.length > 1 && (
          <Field label={engine === "codex" ? t("mateSettings.modelReasoning") : t("mateSettings.modelEffort")} hint={EFFORT_HINT[effort] ? t(EFFORT_HINT[effort]) : t("mateSettings.effortHint")} as="div">
            <Segmented
              value={effort}
              onChange={setEffort}
              options={efforts.map((e) => ({ id: e, label: EFFORT_LABEL[e] ? t(EFFORT_LABEL[e]) : e[0].toUpperCase() + e.slice(1) }))}
              testId="mate-effort"
            />
          </Field>
        )}
        <p className="text-[11.5px] text-content-faint">
          {engine === "codex" ? t("mateSettings.modelApplyCodex") : isApiProvider(engine) ? t("mateSettings.modelApplyApi") : t("mateSettings.modelApplyClaude")}
        </p>
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={reset} />
    </>
  );
}
