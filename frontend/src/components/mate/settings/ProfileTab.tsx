/** Profile (this mate): name, who they are, how they talk. Changes reach the mate at its next message. */
import { useState } from "react";
import type { Mate, Persona } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import { Field, SaveBar, Section, Toggle, useFollowSaved, useSaver } from "./ui";
import { useT } from "../../../i18n";

const LANGS = [
  ["ko", "한국어"],
  ["en", "English"],
  ["ja", "日本語"],
  ["zh", "中文"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["it", "Italiano"],
  ["pt", "Português"],
  ["vi", "Tiếng Việt"],
];

export default function ProfileTab({ mate }: { mate: Mate }) {
  const t = useT();
  const [name, setName] = useState(mate.name);
  const [p, setP] = useState<Persona>(mate.persona);
  const [isDefault, setDefault] = useState(mate.is_default);
  const saver = useSaver();
  const set = (k: keyof Persona) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setP((x) => ({ ...x, [k]: e.target.value }));
  const dirty =
    name !== mate.name || isDefault !== mate.is_default || (Object.keys(p) as (keyof Persona)[]).some((k) => p[k] !== mate.persona[k]);
  const known = LANGS.some(([c]) => c === p.language);

  const save = () =>
    saver.run(async () => {
      const m = await useMateStore.getState().patch(mate.id, {
        name: name.trim(),
        persona: p,
        ...(isDefault && !mate.is_default ? { is_default: true } : {}),
      });
      // the server may adjust what was sent (a new reply language swaps a bundled name/greeting)
      setName(m.name);
      setP(m.persona);
      setDefault(m.is_default);
    });
  const reset = () => {
    setName(mate.name);
    setP(mate.persona);
    setDefault(mate.is_default);
  };

  useFollowSaved([mate.name, mate.persona, mate.is_default], dirty, reset);

  const area = (k: keyof Persona, rows = 3, placeholder = "") => (
    <textarea className="field resize-y leading-relaxed" rows={rows} value={p[k]} onChange={set(k)} placeholder={placeholder} data-testid={`mate-persona-${k}`} />
  );

  return (
    <>
      {mate.builtin && !mate.customized && (
        <p className="rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-[11.5px] leading-relaxed text-content-faint">
          {t("mateSettings.profBuiltinNote", { name: mate.name })}
        </p>
      )}
      <Section title={t("mateSettings.profIdentity")}>
        <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
          <Field label={t("mateSettings.profName")}>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid="mate-name" />
          </Field>
          <Field label={t("mateSettings.profReplyLang")}>
            <select className="field" value={known ? p.language : "__other"} onChange={(e) => e.target.value !== "__other" && setP((x) => ({ ...x, language: e.target.value }))} data-testid="mate-language">
              {LANGS.map(([c, l]) => (
                <option key={c} value={c}>
                  {l}
                </option>
              ))}
              {!known && <option value="__other">{p.language || "—"}</option>}
            </select>
          </Field>
        </div>
        <Field label={t("mateSettings.profCallsYou")} hint={t("mateSettings.profCallsYouHint")}>
          <input className="field" value={p.address} onChange={set("address")} placeholder={t("mateSettings.profCallsYouPh")} />
        </Field>
        <Toggle on={isDefault} onChange={setDefault} disabled={mate.is_default} label={mate.is_default ? t("mateSettings.profIsDefault") : t("mateSettings.profMakeDefault")} hint={t("mateSettings.profDefaultHint")} />
      </Section>
      <Section title={t("mateSettings.profWho")} hint={t("mateSettings.profWhoHint")}>
        <Field label={t("mateSettings.profDescription")}>{area("description", 4, t("mateSettings.profDescriptionPh"))}</Field>
        <Field label={t("mateSettings.profPersonality")}>{area("personality", 2, t("mateSettings.profPersonalityPh"))}</Field>
        <Field label={t("mateSettings.profSpeech")} hint={t("mateSettings.profSpeechHint")}>
          {area("speech", 3, t("mateSettings.profSpeechPh"))}
        </Field>
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
