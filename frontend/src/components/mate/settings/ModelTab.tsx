/**
 * Language model (this mate): which engine it thinks with (Claude Code or Codex), which of that engine's models and
 * how much it reasons. Defaults: Claude Sonnet 5.5 / GPT-6.1-Sol, low effort.
 */
import { useEffect, useState } from "react";
import { DEFAULT_MATE_MODELS, MATE_EFFORTS, type Mate, type MateEngine } from "../../../api/mates";
import { currentSurface, desktopMate } from "../../../mate/desktop";
import { useConfigStore } from "../../../stores/configStore";
import { useMateStore } from "../../../stores/mateStore";
import { useProviderStore } from "../../../stores/providerStore";
import { useUIStore } from "../../../stores/uiStore";
import type { CatalogModel } from "../../../types";
import Icon from "../../ui/Icon";
import { Banner, Field, LinkButton, SaveBar, Section, Segmented, useFollowSaved, useSaver } from "./ui";

const ENGINES: { id: MateEngine; label: string; hint: string; fallback: string }[] = [
  {
    id: "claude",
    label: "Claude Code",
    hint: "Anthropic's Claude, on the Claude accounts of your chats.",
    fallback: "Claude Sonnet 5.5",
  },
  {
    id: "codex",
    label: "Codex",
    hint: "OpenAI's GPT models, on your Codex (ChatGPT) login.",
    fallback: "GPT-6.1-Sol",
  },
];

const EFFORT_HINT: Record<string, string> = {
  default: "The engine's own default for the model.",
  low: "Quick replies — best for conversation (recommended).",
  medium: "A little more thought before answering.",
  high: "Thinks things through; slower replies.",
  xhigh: "Deep reasoning; noticeably slower.",
  max: "As much reasoning as it takes; slowest.",
};

/** a line about what a model is like for a mate (when the catalog has no description) */
function blurb(id: string, label: string): string {
  const s = `${id} ${label}`.toLowerCase();
  if (s.includes("sonnet")) return "Fast, natural conversation — the right balance for a mate.";
  if (s.includes("haiku")) return "The fastest and lightest; fine for short chats.";
  if (s.includes("opus")) return "Thinks deepest, answers slower and costs more.";
  if (s.includes("fable")) return "Creative, story-like replies.";
  if (s.includes("sol")) return "Fast, capable everyday model — the right balance for a mate.";
  return "";
}

/** the Providers screen: in this window, or (desktop Mate windows / extra surfaces) in the console */
function openProviders() {
  if (currentSurface() === "console" || !desktopMate()) {
    if (new URLSearchParams(window.location.search).get("surface")) {
      window.open("/?view=providers", "_blank");
      return;
    }
    useUIStore.getState().setView("providers");
    return;
  }
  void desktopMate()!.openConsole(`${window.location.origin}/?view=providers`);
}

export default function ModelTab({ mate }: { mate: Mate }) {
  const catalog = useConfigStore((s) => s.catalog);
  const providers = useProviderStore((s) => s.providers);
  useEffect(() => {
    if (!catalog.claude) void useConfigStore.getState().load().catch(() => {});
    if (!providers.length) void useProviderStore.getState().load().catch(() => {});
  }, [catalog.claude, providers.length]);

  const storedEngine: MateEngine = mate.llm.provider === "codex" ? "codex" : "claude";
  // an empty model talks on the engine's mate default, so show that as selected
  const storedModel = mate.llm.model || DEFAULT_MATE_MODELS[storedEngine];
  const storedEffort = mate.llm.effort || "low";
  const [engine, setEngine] = useState<MateEngine>(storedEngine);
  const [model, setModel] = useState(storedModel);
  const [effort, setEffort] = useState(storedEffort);
  const saver = useSaver();

  const def = DEFAULT_MATE_MODELS[engine];
  const entry = catalog[engine];
  const listed: CatalogModel[] = (entry?.models ?? []).filter((m) => !(engine === "codex" && m.id === "default"));
  const models: CatalogModel[] = [
    ...(listed.some((m) => m.id === def) ? [] : [{ id: def, label: ENGINES.find((e) => e.id === engine)!.fallback }]),
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
      setModel(DEFAULT_MATE_MODELS[id]);
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
        title="Language model"
        hint="The engine and model the mate thinks with. Either way it is the same secretary: its own persona and memory, no shell, no file access — it hands work to your chats, which use their own engine and model."
      >
        <Field label="Engine" as="div">
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
                      <Icon name={e.id === "codex" ? "terminal" : "brain"} size={13} className="text-accent" /> {e.label}
                      {st && !st.connected && <span className="rounded bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning">not connected</span>}
                    </span>
                    <span className="block text-[11.5px] text-content-faint">{e.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
        {!connected && (
          <Banner
            testId="mate-engine-disconnected"
            action={<LinkButton onClick={openProviders} testId="mate-engine-providers">Open Providers</LinkButton>}
          >
            {engine === "codex" ? "Codex" : "Claude Code"} isn't connected{status?.detail ? ` (${status.detail})` : ""}. Sign
            in under Providers — until then the mate can't answer on this engine.
          </Banner>
        )}
        {engine !== storedEngine && (
          <Banner tone="info" testId="mate-engine-switch">
            The conversation stays. From your next message {engine === "codex" ? "Codex" : "Claude Code"} is handed the
            conversation so far (like switching engine in a chat); switching back later catches the previous engine up on
            what it missed. Persona and memories are the same on both.
          </Banner>
        )}
        <Field label="Model" as="div">
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
                      {m.id === def && <span className="rounded bg-success/15 px-1.5 py-px text-[10px] font-medium text-success">Recommended · default</span>}
                    </span>
                    {desc && <span className="block text-[11.5px] text-content-faint">{desc}</span>}
                    <span className="block font-mono text-[10.5px] text-content-faint/80">{m.id}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
        {efforts.length > 1 && (
          <Field label={engine === "codex" ? "Reasoning" : "Effort"} hint={EFFORT_HINT[effort] ?? "How much it reasons before answering."} as="div">
            <Segmented
              value={effort}
              onChange={setEffort}
              options={efforts.map((e) => ({ id: e, label: e === "default" ? "Default" : e === "xhigh" ? "X-High" : e[0].toUpperCase() + e.slice(1) }))}
              testId="mate-effort"
            />
          </Field>
        )}
        <p className="text-[11.5px] text-content-faint">
          {engine === "codex"
            ? "Model and reasoning changes apply from the next message (Codex runs each message on its own, resuming the same conversation)."
            : "A model change applies from the next message; an effort change restarts the mate's engine (same conversation)."}
        </p>
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={reset} />
    </>
  );
}
