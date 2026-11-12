/**
 * Settings → 메이트, and the Mate panel's 공통 tab (the same, docs/settings.md): what holds for every mate. Who does it
 * is never asked — the mate picked in the Mate view is the one on the desktop, who speaks and who speaks first (the
 * built-in mate until another is picked). Here: her on this desktop (the desktop app), reading replies aloud and the
 * volume on this device, speaking first, this device's screen sharing, the Live2D runtime, the built-in mates.
 */
import { useEffect, useState } from "react";
import { useMateStore } from "../../stores/mateStore";
import { patchDevicePreferences, useDevicePreferences } from "../../stores/devicePreferences";
import { openSettings } from "../../stores/uiStore";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";
import { ErrorLine, Section, Toggle } from "../mate/settings/ui";
import { VolumeField } from "../mate/settings/VoiceTab";
import Live2DPanel from "../mate/settings/global/Live2DPanel";
import DesktopPanel from "../mate/settings/global/DesktopPanel";
import DeviceCaptureSettings from "../composer/DeviceCaptureSettings";
import { canShareScreen } from "../../mate/screenCapture";

/** the characters bundled with the app (backend/app/mate/builtin) */
const BUILTINS: Record<string, string> = { chaerin: "Chaerin" };

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

/** speaking first on this device (startup, coming back, while you share): the picked mate, this device only */
function SpeakFirst() {
  const t = useT();
  const activeId = useMateStore((s) => s.activeId);
  const on = !!useDevicePreferences().screen.proactive_enabled;
  return (
    <Section title={t("screen.simpleReachOut")} hint={t("screen.fixedReachOutHint")} testId="mate-proactive">
      <Toggle
        on={on}
        onChange={(x) => void patchDevicePreferences({ screen: { proactive_enabled: x, proactive_mate: activeId || undefined, proactive_interval: 60 } })}
        label={t("settings.speakFirstOn")}
        testId="proactive-enabled"
      />
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
      <DesktopPanel />
      <DeviceSound />
      <SpeakFirst />
      {canShareScreen() && (
        <div data-testid="settings-screen">
          <DeviceCaptureSettings />
        </div>
      )}
      <Live2DPanel />
      <Builtins />
      <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={() => openSettings("media")} data-testid="settings-mate-services">
        <Icon name="volume" size={13} /> {t("settings.mateServices")}
      </button>
    </div>
  );
}
