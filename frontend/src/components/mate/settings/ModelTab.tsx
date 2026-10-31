/** Language model (this mate): which Claude model it thinks with and how much it reasons. Sonnet 5.5 is the default. */
import { useEffect, useState } from "react";
import { DEFAULT_MATE_MODEL, type Mate } from "../../../api/mates";
import { useConfigStore } from "../../../stores/configStore";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { Field, SaveBar, Section, Segmented, useSaver } from "./ui";

const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];
const EFFORT_HINT: Record<string, string> = {
  default: "Claude Code's own default.",
  low: "Quick replies — best for conversation (recommended).",
  medium: "A little more thought before answering.",
  high: "Thinks things through; slower replies.",
  xhigh: "Deep reasoning; noticeably slower.",
  max: "As much reasoning as it takes; slowest.",
};

/** a line about what a Claude model is like for a mate */
function blurb(id: string, label: string): string {
  const s = `${id} ${label}`.toLowerCase();
  if (s.includes("sonnet")) return "Fast, natural conversation — the right balance for a mate.";
  if (s.includes("haiku")) return "The fastest and lightest; fine for short chats.";
  if (s.includes("opus")) return "Thinks deepest, answers slower and costs more.";
  if (s.includes("fable")) return "Creative, story-like replies.";
  return "";
}

export default function ModelTab({ mate }: { mate: Mate }) {
  const claude = useConfigStore((s) => s.catalog.claude);
  useEffect(() => {
    if (!claude) void useConfigStore.getState().load().catch(() => {});
  }, [claude]);
  // an empty model talks on the mate default (Sonnet 5.5), so show that as selected
  const stored = mate.llm.model || DEFAULT_MATE_MODEL;
  const [model, setModel] = useState(stored);
  const [effort, setEffort] = useState(mate.llm.effort || "low");
  const saver = useSaver();
  const catalog = claude?.models ?? [];
  const models = [
    ...(catalog.some((m) => m.id === DEFAULT_MATE_MODEL) ? [] : [{ id: DEFAULT_MATE_MODEL, label: "Claude Sonnet 5.5" }]),
    ...catalog,
    ...(model && !catalog.some((m) => m.id === model) && model !== DEFAULT_MATE_MODEL ? [{ id: model, label: model }] : []),
  ].sort((a, b) => Number(b.id === DEFAULT_MATE_MODEL) - Number(a.id === DEFAULT_MATE_MODEL));
  const efforts = claude?.effort?.length ? [...new Set(["default", ...claude.effort])] : EFFORTS;
  const dirty = model !== stored || effort !== (mate.llm.effort || "low");
  const save = () => saver.run(() => useMateStore.getState().patch(mate.id, { llm: { provider: "claude", model, effort } }));
  const reset = () => {
    setModel(stored);
    setEffort(mate.llm.effort || "low");
  };

  return (
    <>
      <Section
        title="Language model"
        hint="The mate thinks with Claude, on the same Claude accounts as your chats (Providers). It can't run code or edit files itself — it hands work to your chats, which use their own model."
      >
        <Field label="Provider">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface/60 px-3 py-2 text-[13px] text-content-dim">
            <Icon name="brain" size={14} className="text-accent" /> Claude (Claude Code)
            <span className="ml-auto text-[11px] text-content-faint">the only engine that can run a mate</span>
          </div>
        </Field>
        <Field label="Model" as="div">
          <div className="space-y-1.5" role="radiogroup" data-testid="mate-model">
            {models.map((m) => {
              const on = model === m.id;
              const desc = ("description" in m && typeof m.description === "string" && m.description) || blurb(m.id, m.label);
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setModel(m.id)}
                  data-value={m.id}
                  className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition ${on ? "border-accent/60 bg-accent-soft" : "border-border hover:border-border-strong hover:bg-surface-3/40"}`}
                >
                  <span className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${on ? "border-accent" : "border-border-strong"}`}>
                    {on && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-content">
                      {m.label}
                      {m.id === DEFAULT_MATE_MODEL && <span className="rounded bg-success/15 px-1.5 py-px text-[10px] font-medium text-success">Recommended · default</span>}
                    </span>
                    {desc && <span className="block text-[11.5px] text-content-faint">{desc}</span>}
                    <span className="block font-mono text-[10.5px] text-content-faint/80">{m.id}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="Effort" hint={EFFORT_HINT[effort] ?? "How much it reasons before answering."} as="div">
          <Segmented value={effort} onChange={setEffort} options={efforts.map((e) => ({ id: e, label: e === "default" ? "Default" : e === "xhigh" ? "X-High" : e[0].toUpperCase() + e.slice(1) }))} testId="mate-effort" />
        </Field>
        <p className="text-[11.5px] text-content-faint">A model change applies from the next message; an effort change restarts the mate's engine (same conversation).</p>
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={reset} />
    </>
  );
}
