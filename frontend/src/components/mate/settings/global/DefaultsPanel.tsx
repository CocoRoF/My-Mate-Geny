/** Defaults (Global settings): the default mate (app-wide), the mates' timezone and this device's voice preference. */
import { useEffect, useState } from "react";
import { getVoiceSettings, putVoiceSettings } from "../../../../api/mates";
import { browserTimezone, useMateStore } from "../../../../stores/mateStore";
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
  const [tz, setTz] = useState<string | null>(null);
  const [tzDraft, setTzDraft] = useState("");
  const [tzErr, setTzErr] = useState<string | null>(null);
  const [tzOk, setTzOk] = useState(false);
  useEffect(() => {
    getVoiceSettings()
      .then((s) => {
        setTz(s.timezone ?? "");
        setTzDraft(s.timezone ?? "");
      })
      .catch((e) => setTzErr((e as Error).message));
  }, []);
  const saveTz = async (value: string) => {
    setTzErr(null);
    setTzOk(false);
    try {
      const s = await putVoiceSettings({ timezone: value.trim() });
      setTz(s.timezone ?? "");
      setTzDraft(s.timezone ?? "");
      setTzOk(true);
    } catch (e) {
      setTzErr((e as Error).message);
    }
  };
  const here = browserTimezone();

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
      <Section title={t("mateSettings.defTimezone")} hint={t("mateSettings.defTimezoneHint")} testId="mate-timezone">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveTz(tzDraft);
          }}
        >
          <input className="field min-w-[12rem] flex-1" value={tzDraft} onChange={(e) => setTzDraft(e.target.value)} placeholder={here || "Asia/Seoul"} disabled={tz === null} data-testid="mate-timezone-input" />
          <button className="btn-soft shrink-0" disabled={tz === null || tzDraft.trim() === tz}>
            {t("common.save")}
          </button>
          {here && here !== tz && (
            <button type="button" className="btn-ghost shrink-0" onClick={() => void saveTz(here)}>
              {t("mateSettings.defTimezoneUse", { tz: here })}
            </button>
          )}
        </form>
        <ErrorLine text={tzErr} />
        {tzOk && <p className="text-[12px] text-success">{t("mateSettings.defTimezoneSaved")}</p>}
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
