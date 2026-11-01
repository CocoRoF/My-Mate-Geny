/** Defaults (Global settings): the default mate (app-wide) and this device's voice preference. */
import { useState } from "react";
import { useMateStore } from "../../../../stores/mateStore";
import { ErrorLine, Field, Section, Toggle } from "../ui";
import { useT } from "../../../../i18n";

export default function DefaultsPanel() {
  const t = useT();
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
      setOk(t("mateSettings.defNowDefault", { name: m.name }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section title={t("mateSettings.defTitle")} hint={t("mateSettings.defHint")}>
        <Field label={t("mateSettings.defTitle")}>
          <select className="field" value={def?.id ?? ""} disabled={busy || !mates.length} onChange={(e) => setDefault(e.target.value)} data-testid="mate-default-select">
            {mates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.builtin ? ` · ${t("mateSettings.defBuiltin")}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <ErrorLine text={err} />
        {ok && <p className="text-[12px] text-success">{ok}</p>}
      </Section>
      <Section title={t("mateSettings.defDevice")} hint={t("mateSettings.defDeviceHint")}>
        <Toggle
          on={!muted}
          onChange={(on) => useMateStore.getState().setMuted(!on)}
          label={t("mateSettings.defReadHere")}
          hint={t("mateSettings.defReadHereHint")}
          testId="mate-device-voice"
        />
      </Section>
    </>
  );
}
