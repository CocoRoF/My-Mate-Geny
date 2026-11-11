/**
 * Mate settings → 관계와 기억 (docs/settings.md): how the relationship works for her (RelationshipTab), how she keeps
 * and recalls memories, and forgetting everything. Looking at the relationship and the memories themselves: the ♥ panel.
 */
import { prefsOf, type Mate, type RecallLevel } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import { useT } from "../../../i18n";
import { useState } from "react";
import RelationshipTab from "./RelationshipTab";
import { WipeMemory } from "./DangerTab";
import { ErrorLine, Field, Section, Segmented, Toggle } from "./ui";

const RECALL: { id: RecallLevel; label: "mateSettings.memRecallOff" | "mateSettings.memRecallLight" | "mateSettings.styleNormal" | "mateSettings.memRecallRich" }[] = [
  { id: "off", label: "mateSettings.memRecallOff" },
  { id: "light", label: "mateSettings.memRecallLight" },
  { id: "normal", label: "mateSettings.styleNormal" },
  { id: "rich", label: "mateSettings.memRecallRich" },
];

function MemoryOptions({ mate }: { mate: Mate }) {
  const t = useT();
  const memory = prefsOf(mate).memory;
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: { self_save?: boolean; recall?: RecallLevel }) =>
    void useMateStore
      .getState()
      .patch(mate.id, { prefs: { memory: patch } })
      .then(() => setErr(null), (e) => setErr((e as Error).message));
  return (
    <Section title={t("mateSettings.memTitle")} hint={t("mateSettings.bondMemoryHint", { name: mate.name })} testId="mate-memory-options">
      <Toggle on={memory.self_save} onChange={(on) => set({ self_save: on })} label={t("mateSettings.memSelfSave", { name: mate.name })} hint={t("mateSettings.memSelfSaveHint")} testId="mate-memory-self-save" />
      <Field label={t("mateSettings.memRecall")} hint={t("mateSettings.memRecallHint")} as="div">
        <Segmented value={memory.recall} options={RECALL.map((x) => ({ id: x.id, label: t(x.label) }))} onChange={(v) => set({ recall: v })} testId="mate-memory-recall" />
      </Field>
      <ErrorLine text={err} />
    </Section>
  );
}

export default function BondTab({ mate }: { mate: Mate }) {
  return (
    <>
      <RelationshipTab mate={mate} />
      <MemoryOptions mate={mate} />
      <WipeMemory mate={mate} />
    </>
  );
}
