import { useState } from "react";
import { DEFAULT_MATE_MODEL, type Mate } from "../../../api/mates";
import { useConfigStore } from "../../../stores/configStore";
import { useMateStore } from "../../../stores/mateStore";
import { Field, SaveBar, Section, useSaver } from "./ui";

const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];

export default function ModelTab({ mate }: { mate: Mate }) {
  const claude = useConfigStore((s) => s.catalog.claude);
  // an empty model talks on the mate default (Sonnet 5.5), so show that as selected
  const stored = mate.llm.model || DEFAULT_MATE_MODEL;
  const [model, setModel] = useState(stored);
  const [effort, setEffort] = useState(mate.llm.effort || "low");
  const saver = useSaver();
  const models = claude?.models ?? [];
  const efforts = claude?.effort?.length ? [...new Set(["default", ...claude.effort])] : EFFORTS;
  const dirty = model !== stored || effort !== mate.llm.effort;
  const save = () => saver.run(() => useMateStore.getState().patch(mate.id, { llm: { provider: "claude", model, effort } }));

  return (
    <>
      <Section
        title="Language model"
        hint="The mate thinks with Claude, on the same Claude accounts as your chats (Providers). It can't run code or edit files — it hands work to your chats."
      >
        <Field label="Provider">
          <select className="field" value="claude" disabled>
            <option value="claude">Claude (Claude Code)</option>
          </select>
        </Field>
        <Field
          label="Model"
          hint="Sonnet (the default) or Haiku answer noticeably faster — good for chatting; Opus thinks deeper but is slower. The work itself runs in the chats with their own model."
        >
          <select className="field" value={model} onChange={(e) => setModel(e.target.value)} data-testid="mate-model">
            {!models.some((m) => m.id === DEFAULT_MATE_MODEL) && <option value={DEFAULT_MATE_MODEL}>Claude Sonnet 5.5 (default)</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.id === DEFAULT_MATE_MODEL ? " (default)" : ""}
                {m.description ? ` — ${m.description}` : ""}
              </option>
            ))}
            {model && !models.some((m) => m.id === model) && <option value={model}>{model}</option>}
          </select>
        </Field>
        <Field label="Effort" hint="How much it reasons before answering. Low keeps replies quick.">
          <select className="field" value={effort} onChange={(e) => setEffort(e.target.value)}>
            {efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </Field>
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} />
    </>
  );
}
