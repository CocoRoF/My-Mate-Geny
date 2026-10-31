/** Profile (this mate): name, who they are, how they talk. Changes reach the mate at its next message. */
import { useState } from "react";
import type { Mate, Persona } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import { Field, SaveBar, Section, Toggle, useSaver } from "./ui";

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
    saver.run(() =>
      useMateStore.getState().patch(mate.id, {
        name: name.trim(),
        persona: p,
        ...(isDefault && !mate.is_default ? { is_default: true } : {}),
      }),
    );
  const reset = () => {
    setName(mate.name);
    setP(mate.persona);
    setDefault(mate.is_default);
  };

  const area = (k: keyof Persona, rows = 3, placeholder = "") => (
    <textarea className="field resize-y leading-relaxed" rows={rows} value={p[k]} onChange={set(k)} placeholder={placeholder} data-testid={`mate-persona-${k}`} />
  );

  return (
    <>
      {mate.builtin && !mate.customized && (
        <p className="rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-[11.5px] leading-relaxed text-content-faint">
          {mate.name} ships with the app and gets updated with it. Once you edit the profile or avatar, it's yours — updates leave it alone.
        </p>
      )}
      <Section title="Identity">
        <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
          <Field label="Name">
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid="mate-name" />
          </Field>
          <Field label="Reply language">
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
        <Field label="Calls you" hint="How the mate addresses you.">
          <input className="field" value={p.address} onChange={set("address")} placeholder="e.g. 주인님, boss, your name" />
        </Field>
        <Toggle on={isDefault} onChange={setDefault} disabled={mate.is_default} label={mate.is_default ? "This is the default mate" : "Make this the default mate"} hint="Shown first, on new devices and in the desktop app." />
      </Section>
      <Section title="Who they are" hint="Free text — write it the way you'd brief an actor.">
        <Field label="Description">{area("description", 4, "Who the mate is, their background, what they know")}</Field>
        <Field label="Personality">{area("personality", 2, "Warm, curious, a little teasing…")}</Field>
        <Field label="Speaking style" hint="Honorifics, catchphrases, example lines.">
          {area("speech", 3, "Short sentences, polite 해요체, says “음…” when thinking")}
        </Field>
      </Section>
      <Section title="Conversation">
        <Field label="Greeting" hint="The first line of a new conversation.">
          {area("greeting", 2)}
        </Field>
        <Field label="Standing instructions" hint="Anything the mate should always keep in mind.">
          {area("instructions", 3, "e.g. Remind me to take a break every two hours.")}
        </Field>
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={reset} />
    </>
  );
}
