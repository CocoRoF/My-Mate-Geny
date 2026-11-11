/**
 * Settings → 메이트 (docs/settings.md): what holds for every mate, set once — the default mate, reading replies aloud
 * and the volume on this device, which mate may speak first on this device, the Live2D runtime her avatar may need,
 * the bundled mates. Her own settings are in
 * Mate settings; the voice and transcription services in Image & voice services.
 */
import { useEffect, useState } from "react";
import { useMateStore } from "../../stores/mateStore";
import { patchDevicePreferences, useDevicePreferences } from "../../stores/devicePreferences";
import { openSettings } from "../../stores/uiStore";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";
import { ErrorLine, Field, Section, Toggle } from "../mate/settings/ui";
import { VolumeField } from "../mate/settings/VoiceTab";
import Live2DPanel from "../mate/settings/global/Live2DPanel";

/** the characters bundled with the app (backend/app/mate/builtin) */
const BUILTINS: Record<string, string> = { chaerin: "Chaerin" };

function DefaultMate() {
  const t = useT();
  const mates = useMateStore((s) => s.mates);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const def = mates.find((m) => m.is_default) ?? mates[0];
  const pick = async (id: string) => {
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
    <Section title={t("mateSettings.defTitle")} hint={t("mateSettings.defHint")} testId="settings-default-mate">
      <select className="field" value={def?.id ?? ""} disabled={busy || !mates.length} onChange={(e) => void pick(e.target.value)} aria-label={t("mateSettings.defTitle")} data-testid="mate-default-select">
          {mates.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.builtin ? ` · ${t("mateSettings.defBuiltin")}` : ""}
            </option>
          ))}
      </select>
      <ErrorLine text={err} />
      {ok && <p className="text-[12px] text-success">{ok}</p>}
    </Section>
  );
}

function DeviceSound() {
  const t = useT();
  const muted = useMateStore((s) => s.muted);
  const volume = useDevicePreferences().volume;
  return (
    <Section title={t("mateSettings.defDevice")} hint={t("mateSettings.defDeviceHint")} testId="settings-mate-sound">
      <Toggle on={!muted} onChange={(on) => useMateStore.getState().setMuted(!on)} label={t("mateSettings.defReadHere")} hint={t("mateSettings.defReadHereHint")} testId="mate-device-voice" />
      <VolumeField value={volume} onChange={(x) => void patchDevicePreferences({ volume: x })} />
    </Section>
  );
}

/** speaking first on this device (startup, coming back, while you share): one mate, this device only */
function SpeakFirst() {
  const t = useT();
  const mates = useMateStore((s) => s.mates);
  const screen = useDevicePreferences().screen;
  const on = !!screen.proactive_enabled;
  const who = mates.find((m) => m.id === screen.proactive_mate) ?? mates.find((m) => m.is_default) ?? mates[0];
  const set = (enabled: boolean, mateId = who?.id) =>
    void patchDevicePreferences({ screen: { proactive_enabled: enabled, proactive_mate: mateId, proactive_interval: 60 } });
  return (
    <Section title={t("screen.simpleReachOut")} hint={t("screen.fixedReachOutHint")} testId="mate-proactive">
      <Toggle on={on} onChange={(x) => set(x)} label={t("settings.speakFirstOn")} testId="proactive-enabled" />
      {on && mates.length > 1 && (
        <Field label={t("settings.speakFirstWho")}>
          <select className="field" value={who?.id ?? ""} onChange={(e) => set(true, e.target.value)} data-testid="proactive-mate">
            {mates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Section>
  );
}

function Builtins() {
  const t = useT();
  const mates = useMateStore((s) => s.mates);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const present = new Set(mates.map((m) => m.builtin).filter(Boolean));
  const missing = Object.entries(BUILTINS).filter(([k]) => !present.has(k)).map(([, n]) => n);
  const restore = async () => {
    setErr(null);
    try {
      const n = await useMateStore.getState().restoreBuiltins();
      setMsg(n ? t("mateSettings.dangerRestored", { count: n }) : t("mateSettings.dangerAllHere"));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Section title={t("mateSettings.dangerBuiltins")} hint={t("mateSettings.dangerBuiltinsHint")} testId="settings-builtins">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="min-w-0 flex-1 text-[12px] text-content-faint" data-testid="mate-builtins-missing">
          {msg ? <span className="text-success">{msg}</span> : missing.length ? t("mateSettings.dangerMissing", { list: missing.join(", ") }) : t("mateSettings.dangerAllOfThem")}
        </span>
        <button className="btn-soft" onClick={() => void restore()} data-testid="mate-restore-builtins-settings">
          <Icon name="rotate" size={13} /> {t("mateSettings.dangerRestoreBtn")}
        </button>
      </div>
      <ErrorLine text={err} />
    </Section>
  );
}

export default function MateTab() {
  const t = useT();
  useEffect(() => {
    const st = useMateStore.getState();
    if (!st.loaded) void st.load().catch(() => {});
  }, []);
  return (
    <div className="space-y-4" data-testid="settings-mate">
      <DefaultMate />
      <DeviceSound />
      <SpeakFirst />
      <Live2DPanel />
      <Builtins />
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={() => openSettings("media")} data-testid="settings-mate-services">
          <Icon name="volume" size={13} /> {t("settings.mateServices")}
        </button>
        <button className="btn-ghost !py-1.5 text-[12.5px]" onClick={() => openSettings("screen")}>
          <Icon name="monitor" size={13} /> {t("settings.secScreen")}
        </button>
      </div>
    </div>
  );
}
