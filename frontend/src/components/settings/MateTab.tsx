/**
 * Settings → 메이트, and the Mate panel's 공통 tab (the same, docs/settings.md): what holds for every mate. Who does it
 * is never asked — the mate picked in the Mate view is the one on the desktop, who speaks and who speaks first (the
 * built-in mate until another is picked). Here: her on this desktop (the desktop app), reading replies aloud and the
 * volume on this device, speaking first, her calls on this phone (the Android app), this device's screen sharing, the
 * Live2D runtime, the built-in mates.
 */
import { useEffect, useState } from "react";
import { listBuiltins, type BuiltinInfo } from "../../api/mates";
import { useMateStore } from "../../stores/mateStore";
import { patchDevicePreferences, useDevicePreferences } from "../../stores/devicePreferences";
import { openSettings } from "../../stores/uiStore";
import { useLang, useT } from "../../i18n";
import Icon from "../ui/Icon";
import { ErrorLine, Section, Toggle } from "../mate/settings/ui";
import { VolumeField } from "../mate/settings/VoiceTab";
import Live2DPanel from "../mate/settings/global/Live2DPanel";
import DesktopPanel from "../mate/settings/global/DesktopPanel";
import DeviceCaptureSettings from "../composer/DeviceCaptureSettings";
import { canShareScreen } from "../../mate/screenCapture";
import { callNative, onAndroid, type PhoneLink } from "../../mate/call/native";
import { linkPhone } from "../../stores/callStore";

/** the characters bundled with the app (backend/app/mate/builtin). Which of them ship, the server says (GET /api/mates/builtin:
 * one whose pack isn't complete yet doesn't); these are their names when it can't */
const BUILTINS: Record<string, string> = { chaerin: "Chaerin", seoa: "Seoa" };

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

/**
 * Her calls on this phone (the Android app, docs/mate-calls.md "On Android"): it stays reachable with the app closed
 * (on unless switched off), what the line is doing, and what the phone still has to allow for a call to ring like one.
 */
function PhoneCalls() {
  const t = useT();
  const [link, setLink] = useState<PhoneLink | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = () => void callNative.linkStatus().then((s) => alive && setLink(s));
    linkPhone();
    read();
    // (it changes on its own: connecting, a permission granted in the phone's settings and back)
    const timer = setInterval(read, 2500);
    const back = () => document.visibilityState === "visible" && read();
    document.addEventListener("visibilitychange", back);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);
  if (!link) return null; // (an app without the background link)
  const state = !link.background
    ? t("settings.phoneStateOff")
    : link.state === "connected"
      ? link.calls
        ? link.mate
          ? t("settings.phoneStateOn", { name: link.mate })
          : t("settings.phoneStateOnAny")
        : t("settings.phoneStateNoCalls")
      : link.state === "signed_out"
        ? t("settings.phoneStateSignedOut")
        : link.state === "offline"
          ? t("settings.phoneStateOffline")
          : t("settings.phoneStateConnecting");
  const good = link.background && link.state === "connected" && link.calls;
  const needs: { key: string; text: string; what: "notifications" | "fullscreen" | "battery" }[] = [
    ...(!link.notifications ? [{ key: "n", text: t("settings.phoneNeedNotifications"), what: "notifications" as const }] : []),
    ...(!link.fullScreen ? [{ key: "f", text: t("settings.phoneNeedFullScreen"), what: "fullscreen" as const }] : []),
    ...(link.background && !link.batteryExempt ? [{ key: "b", text: t("settings.phoneNeedBattery"), what: "battery" as const }] : []),
  ];
  return (
    <Section title={t("settings.phoneTitle")} hint={t("settings.phoneHint")} testId="settings-phone-calls">
      <Toggle
        on={link.background}
        disabled={busy}
        onChange={(on) => {
          setBusy(true);
          void callNative.setBackground(on).then((s) => {
            if (s) setLink(s);
            setBusy(false);
          });
        }}
        label={t("settings.phoneBackground")}
        hint={t("settings.phoneBackgroundHint")}
        testId="phone-background"
      />
      <p className={`mt-3 flex items-center gap-1.5 text-[12px] ${good ? "text-success" : "text-content-faint"}`} data-testid="phone-link-state">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${good ? "bg-success" : "bg-content-faint"}`} />
        {state}
      </p>
      {needs.map((n) => (
        <div key={n.key} className="mt-2 flex flex-wrap items-center justify-end gap-2 rounded-lg border border-border bg-surface-1/60 px-3 py-2" data-testid={`phone-need-${n.what}`}>
          <span className="min-w-0 flex-1 text-[12px] text-content-dim">{n.text}</span>
          <button className="btn-soft !py-1 text-[12px]" onClick={() => void callNative.openSettings(n.what)}>
            {t("settings.phoneAllow")}
          </button>
        </div>
      ))}
    </Section>
  );
}

function Builtins() {
  const t = useT();
  const lang = useLang();
  const mates = useMateStore((s) => s.mates);
  const [shipped, setShipped] = useState<BuiltinInfo[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    listBuiltins()
      .then(setShipped)
      .catch(() => setShipped(Object.entries(BUILTINS).map(([key, en]) => ({ key, names: { en } }))));
  }, []);
  const present = new Set(mates.map((m) => m.builtin).filter(Boolean));
  const missing = (shipped ?? [])
    .filter((b) => !present.has(b.key))
    .map((b) => b.names[lang] || b.names.en || BUILTINS[b.key] || b.key);
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
      {onAndroid() && <PhoneCalls />}
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
