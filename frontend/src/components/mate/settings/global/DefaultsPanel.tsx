/** Defaults (Global settings): the default mate (app-wide) and this device's voice preference. */
import { useState } from "react";
import { useMateStore } from "../../../../stores/mateStore";
import { ErrorLine, Field, Section, Toggle } from "../ui";

export default function DefaultsPanel() {
  const mates = useMateStore((s) => s.mates);
  const muted = useMateStore((s) => s.muted);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const def = mates.find((m) => m.is_default) ?? mates[0];

  const setDefault = async (id: string) => {
    if (!id || id === def?.id) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const m = await useMateStore.getState().patch(id, { is_default: true });
      setOk(`${m.name} is now the default mate.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section title="Default mate" hint="Shown first in the switcher, on a new device and in the desktop app until you pick another there.">
        <Field label="Default mate">
          <select className="field" value={def?.id ?? ""} disabled={busy || !mates.length} onChange={(e) => setDefault(e.target.value)} data-testid="mate-default-select">
            {mates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.builtin ? " · built-in" : ""}
              </option>
            ))}
          </select>
        </Field>
        <ErrorLine text={err} />
        {ok && <p className="text-[12px] text-success">{ok}</p>}
      </Section>
      <Section title="This device" hint="Stored in this browser / app only.">
        <Toggle
          on={!muted}
          onChange={(on) => useMateStore.getState().setMuted(!on)}
          label="Read replies aloud here"
          hint="Off mutes every mate on this device (each mate's own “Read replies aloud” still applies elsewhere). Same as the speaker button by the message box."
          testId="mate-device-voice"
        />
      </Section>
    </>
  );
}
