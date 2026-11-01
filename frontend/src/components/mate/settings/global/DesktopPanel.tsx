/**
 * Desktop app (Global settings, this computer only): the avatar window, click-through, the quick-chat shortcut,
 * start at login and which mate the desktop shows. Only inside the desktop app (`window.hrhNative.mate`).
 */
import { useEffect, useState } from "react";
import { desktopMate, useDesktopMate } from "../../../../mate/desktop";
import { useMateStore } from "../../../../stores/mateStore";
import { useUIStore } from "../../../../stores/uiStore";
import Icon from "../../../ui/Icon";
import { Banner, ErrorLine, Field, Section, Toggle } from "../ui";
import { useT } from "../../../../i18n";

const DEFAULT_HOTKEY = "CommandOrControl+Shift+G";

/** a KeyboardEvent → an Electron accelerator ("CommandOrControl+Shift+G"); null while only modifiers are down */
function accelOf(e: React.KeyboardEvent): string | null {
  const k = e.key;
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(k)) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (!mods.length) return null;
  let key = k.length === 1 ? k.toUpperCase() : k;
  if (e.code.startsWith("Key")) key = e.code.slice(3);
  else if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (key === " ") key = "Space";
  return [...mods, key].join("+");
}

const pretty = (accel: string) =>
  accel
    .replace("CommandOrControl", /Mac/.test(navigator.platform) ? "⌘" : "Ctrl")
    .split("+")
    .join(" + ");

export default function DesktopPanel() {
  const t = useT();
  const m = desktopMate();
  const state = useDesktopMate();
  const mates = useMateStore((s) => s.mates);
  const [hotkey, setHotkey] = useState("");
  const [recording, setRecording] = useState(false);
  const [hkMsg, setHkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (state) setHotkey(state.hotkey);
  }, [state?.hotkey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!m) {
    return (
      <Section title={t("mateSettings.deskTitle")} hint={t("mateSettings.deskHint")}>
        <Banner
          tone="info"
          action={
            <button className="btn-soft !px-2.5 !py-1 text-[12px]" onClick={() => useUIStore.getState().setView("downloads")}>
              <Icon name="download" size={12} /> {t("mateSettings.deskGetApp")}
            </button>
          }
        >
          {t("mateSettings.deskNoApp")}
        </Banner>
      </Section>
    );
  }
  if (!state) return <p className="text-[12px] text-content-faint">{t("common.loading")}</p>;
  const desktopMateId = state.mateId || mates.find((x) => x.is_default)?.id || mates[0]?.id || null;
  const act = (p: Promise<unknown>) => p.then(() => setErr(null)).catch((e) => setErr((e as Error).message));

  const saveHotkey = async (accel: string) => {
    setHkMsg(null);
    try {
      const ok = await m.setHotkey(accel);
      setHkMsg(
        ok
          ? { ok: true, text: accel ? t("mateSettings.deskHotkeyOk", { key: pretty(accel) }) : t("mateSettings.deskHotkeyOff") }
          : { ok: false, text: t("mateSettings.deskHotkeyTaken", { key: pretty(accel) }) },
      );
    } catch (e) {
      setHkMsg({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <>
      <Section title={t("mateSettings.deskOnDesktop")} hint={t("mateSettings.deskOnDesktopHint")}>
        <Toggle on={state.visible} onChange={(on) => act(on ? m.showAvatar(desktopMateId || undefined) : m.hideAvatar())} label={t("mateSettings.deskShowAvatar")} testId="mate-desktop-visible" />
        <Toggle on={state.clickThrough} onChange={(on) => act(m.setClickThrough(on))} label={t("mateSettings.deskClickThrough")} hint={t("mateSettings.deskClickThroughHint")} />
        <Field label={t("mateSettings.deskMate")} hint={t("mateSettings.deskMateHint")}>
          <select className="field" value={desktopMateId || ""} onChange={(e) => act(m.setMate(e.target.value))} data-testid="mate-desktop-mate">
            {mates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
                {x.is_default ? ` ${t("mateSettings.defaultSuffix")}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost border border-border" onClick={() => act(m.setMoveMode(true))}>
            <Icon name="move" size={14} /> {t("mateSettings.deskMove")}
          </button>
          <button className="btn-ghost border border-border" onClick={() => act(m.openChat())}>
            <Icon name="chat" size={14} /> {t("mateSettings.deskOpenChat")}
          </button>
        </div>
      </Section>
      <Section title={t("mateSettings.deskQuick")} hint={t("mateSettings.deskQuickHint")}>
        <Field label={t("mateSettings.deskShortcut")} hint={recording ? t("mateSettings.deskRecording") : t("mateSettings.deskClickField")} as="div">
          <div className="flex flex-wrap gap-2">
            <input
              className={`field min-w-0 flex-1 font-mono ${recording ? "!border-accent/70 ring-2 ring-accent/20" : ""}`}
              value={recording && hotkey === state.hotkey ? t("mateSettings.deskPressKeys") : hotkey ? pretty(hotkey) : t("mateSettings.deskOffValue")}
              readOnly
              onFocus={() => setRecording(true)}
              onBlur={() => setRecording(false)}
              onKeyDown={(e) => {
                e.preventDefault();
                if (e.key === "Escape") {
                  setHotkey(state.hotkey);
                  (e.target as HTMLInputElement).blur();
                  return;
                }
                const a = accelOf(e);
                if (a) setHotkey(a);
              }}
              data-testid="mate-desktop-hotkey"
            />
            <button className="btn-soft shrink-0" onClick={() => saveHotkey(hotkey)} disabled={hotkey === state.hotkey && state.hotkeyBound !== false}>
              {t("common.save")}
            </button>
            {hotkey !== DEFAULT_HOTKEY && (
              <button className="btn-ghost shrink-0" onClick={() => (setHotkey(DEFAULT_HOTKEY), saveHotkey(DEFAULT_HOTKEY))} title={pretty(DEFAULT_HOTKEY)}>
                {t("common.default")}
              </button>
            )}
            <button className="btn-ghost shrink-0" onClick={() => (setHotkey(""), saveHotkey(""))} title={t("mateSettings.deskNoShortcut")}>
              {t("mateSettings.deskOffBtn")}
            </button>
          </div>
        </Field>
        {state.hotkeyBound === false && !hkMsg && <Banner tone="warn">{t("mateSettings.deskHotkeyUnbound", { key: pretty(state.hotkey) })}</Banner>}
        {hkMsg && <Banner tone={hkMsg.ok ? "ok" : "error"}>{hkMsg.text}</Banner>}
      </Section>
      <Section title={t("mateSettings.deskStart")}>
        <Toggle on={state.autostart} onChange={(on) => act(m.setAutostart(on))} label={t("mateSettings.deskAutostart")} hint={t("mateSettings.deskAutostartHint")} />
      </Section>
      <ErrorLine text={err} />
    </>
  );
}
