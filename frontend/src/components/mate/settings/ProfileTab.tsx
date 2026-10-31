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

  const save = () =>
    saver.run(() =>
      useMateStore.getState().patch(mate.id, {
        name: name.trim(),
        persona: p,
        ...(isDefault && !mate.is_default ? { is_default: true } : {}),
      }),
    );

  const area = (k: keyof Persona, rows = 3, placeholder = "") => (
    <textarea className="field resize-y leading-relaxed" rows={rows} value={p[k]} onChange={set(k)} placeholder={placeholder} />
  );

  return (
    <>
      <Section title="Who they are" hint="Changes reach the mate at the next message (same conversation).">
        <Field label="Name">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} data-testid="mate-name" />
        </Field>
        <Field label="Description">{area("description", 3, "Who the mate is, in a few lines")}</Field>
        <Field label="Personality">{area("personality", 2, "Warm, curious, a little teasing…")}</Field>
        <Field label="Speaking style" hint="Honorifics, catchphrases, example lines.">
          {area("speech", 3)}
        </Field>
      </Section>
      <Section title="Conversation">
        <Field label="Greeting" hint="The first line of a new conversation.">
          {area("greeting", 2)}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Calls you">
            <input className="field" value={p.address} onChange={set("address")} placeholder="e.g. 주인님, boss, your name" />
          </Field>
          <Field label="Reply language">
            <select className="field" value={LANGS.some(([c]) => c === p.language) ? p.language : "__other"} onChange={(e) => e.target.value !== "__other" && setP((x) => ({ ...x, language: e.target.value }))}>
              {LANGS.map(([c, l]) => (
                <option key={c} value={c}>
                  {l}
                </option>
              ))}
              {!LANGS.some(([c]) => c === p.language) && <option value="__other">{p.language || "—"}</option>}
            </select>
          </Field>
        </div>
        <Field label="Standing instructions" hint="Anything the mate should always keep in mind.">
          {area("instructions", 3)}
        </Field>
        <Toggle on={isDefault} onChange={setDefault} disabled={mate.is_default} label="Default mate" hint="The one the desktop app and new devices start with." />
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} />
    </>
  );
}
