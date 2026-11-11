/**
 * Profile (this mate): who she is — the character only (docs/mate.md "Prompt composition"). How she talks (speech
 * level, what she calls you, speech habits, reply language…) is the Conversation style tab. Changes reach the mate at
 * its next message.
 */
import { useState } from "react";
import type { Mate, Persona } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { Field, SaveBar, Section, useFollowSaved, useSaver } from "./ui";
import { useT } from "../../../i18n";

type Draft = Pick<Persona, "description" | "personality" | "greeting" | "instructions">;
const KEYS: (keyof Draft)[] = ["description", "personality", "greeting", "instructions"];
const draftOf = (p: Persona): Draft => ({ description: p.description, personality: p.personality, greeting: p.greeting, instructions: p.instructions });

export default function ProfileTab({ mate, onOpenStyle }: { mate: Mate; onOpenStyle?: () => void }) {
  const t = useT();
  const [name, setName] = useState(mate.name);
  const [p, setP] = useState<Draft>(draftOf(mate.persona));
  const saver = useSaver();
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLTextAreaElement>) => setP((x) => ({ ...x, [k]: e.target.value }));
  const dirty = name !== mate.name || KEYS.some((k) => p[k] !== mate.persona[k]);

  const save = () =>
    saver.run(async () => {
      // (only the character's fields: the reply language and everything about how she talks are the style tab's)
      const m = await useMateStore.getState().patch(mate.id, {
        name: name.trim(),
        persona: p,
      });
      setName(m.name);
      setP(draftOf(m.persona));
    });
  const reset = () => {
    setName(mate.name);
    setP(draftOf(mate.persona));
  };

  useFollowSaved([mate.name, mate.persona], dirty, reset);

  const area = (k: keyof Draft, rows = 3, placeholder = "") => (
    <textarea className="field resize-y leading-relaxed" rows={rows} value={p[k]} onChange={set(k)} placeholder={placeholder} data-testid={`mate-persona-${k}`} />
  );

  return (
    <>
      {mate.builtin && !mate.customized && (
        <p className="rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-[11.5px] leading-relaxed text-content-faint">
          {t("mateSettings.profBuiltinNote", { name: mate.name })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/25 bg-accent-soft/40 px-3 py-2 text-[11.5px] leading-relaxed text-content-dim" data-testid="mate-profile-character-note">
        <span className="min-w-0 flex-1">{t("mateSettings.profCharacterNote", { name: mate.name })}</span>
        {onOpenStyle && (
          <button type="button" className="btn-ghost shrink-0 !px-2 !py-0.5 text-[11.5px]" onClick={onOpenStyle} data-testid="mate-profile-open-style">
            <Icon name="sliders" size={12} /> {t("mateSettings.profToStyle")}
          </button>
        )}
      </div>
      <Section title={t("mateSettings.profIdentity")}>
        <Field label={t("mateSettings.profName")}>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid="mate-name" />
        </Field>
      </Section>
      <Section title={t("mateSettings.profWho")} hint={t("mateSettings.profWhoHint")}>
        <Field label={t("mateSettings.profDescription")}>{area("description", 4, t("mateSettings.profDescriptionPh"))}</Field>
        <Field label={t("mateSettings.profPersonality")}>{area("personality", 2, t("mateSettings.profPersonalityPh"))}</Field>
      </Section>
      <Section title={t("mateSettings.profConversation")}>
        <Field label={t("mateSettings.profGreeting")} hint={t("mateSettings.profGreetingHint")}>
          {area("greeting", 2)}
        </Field>
        <Field label={t("mateSettings.profInstructions")} hint={t("mateSettings.profInstructionsHint")}>
          {area("instructions", 3, t("mateSettings.profInstructionsPh"))}
        </Field>
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={reset} />
    </>
  );
}
