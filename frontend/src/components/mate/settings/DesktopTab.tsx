/** Desktop app only: the avatar window, click-through, quick-chat shortcut, start at login, which mate it shows. */
import { useEffect, useState } from "react";
import type { Mate } from "../../../api/mates";
import { desktopMate, useDesktopMate } from "../../../mate/desktop";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { ErrorLine, Field, Section, Toggle } from "./ui";

/** a KeyboardEvent → an Electron accelerator ("CommandOrControl+Shift+G") */
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
  else if (key === "/") key = "/";
  return [...mods, key].join("+");
}

export default function DesktopTab({ mate }: { mate: Mate }) {
  const m = desktopMate();
  const state = useDesktopMate();
  const mates = useMateStore((s) => s.mates);
  const [hotkey, setHotkey] = useState("");
  const [hkMsg, setHkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (state) setHotkey(state.hotkey);
  }, [state?.hotkey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!m) return null;
  if (!state) return <p className="text-[12px] text-content-faint">Loading…</p>;
  const desktopMateId = state.mateId || mates.find((x) => x.is_default)?.id || null;
  const act = (p: Promise<unknown>) => p.then(() => setErr(null)).catch((e) => setErr((e as Error).message));

  const saveHotkey = async (accel: string) => {
    setHkMsg(null);
    try {
      const ok = await m.setHotkey(accel);
      setHkMsg(ok ? { ok: true, text: accel ? `Quick chat: ${accel}` : "Shortcut turned off" } : { ok: false, text: `${accel} is taken by another app — pick another.` });
    } catch (e) {
      setHkMsg({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <>
      <Section title="On your desktop" hint="The mate sits on top of your windows; clicks pass through it unless you turn that off.">
        <Toggle
          on={state.visible}
          onChange={(on) => act(on ? m.showAvatar(desktopMateId || mate.id) : m.hideAvatar())}
          label="Show the avatar"
        />
        <Toggle on={state.clickThrough} onChange={(on) => act(m.setClickThrough(on))} label="Clicks pass through" hint="Off: you can click and drag the avatar." />
        <Field label="Mate on the desktop">
          <div className="flex gap-2">
            <select className="field" value={desktopMateId || ""} onChange={(e) => act(m.setMate(e.target.value))}>
              {mates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            {desktopMateId !== mate.id && (
              <button className="btn-soft shrink-0" onClick={() => act(m.setMate(mate.id))}>
                Use {mate.name}
              </button>
            )}
          </div>
        </Field>
        <div className="flex gap-2">
          <button className="btn-ghost border border-border" onClick={() => act(m.setMoveMode(true))}>
            <Icon name="move" size={14} /> Move the avatar
          </button>
          <button className="btn-ghost border border-border" onClick={() => act(m.openChat())}>
            <Icon name="chat" size={14} /> Open the chat window
          </button>
        </div>
      </Section>
      <Section title="Quick chat" hint="A one-line card over everything. Press the shortcut, type, Enter.">
        <Field label="Shortcut" hint="Click the field and press the keys (with Ctrl/⌘, Alt or Shift).">
          <div className="flex gap-2">
            <input
              className="field font-mono"
              value={hotkey}
              readOnly
              onKeyDown={(e) => {
                e.preventDefault();
                const a = accelOf(e);
                if (a) setHotkey(a);
              }}
              placeholder="press keys…"
            />
            <button className="btn-soft shrink-0" onClick={() => saveHotkey(hotkey)} disabled={hotkey === state.hotkey && state.hotkeyBound !== false}>
              Save
            </button>
            <button className="btn-ghost shrink-0" onClick={() => saveHotkey("")} title="No shortcut">
              Off
            </button>
          </div>
        </Field>
        {state.hotkeyBound === false && !hkMsg && <p className="text-[12px] text-warning">{state.hotkey} couldn't be registered (taken by another app).</p>}
        {hkMsg && <p className={`text-[12px] ${hkMsg.ok ? "text-success" : "text-danger"}`}>{hkMsg.text}</p>}
      </Section>
      <Section title="Start">
        <Toggle on={state.autostart} onChange={(on) => act(m.setAutostart(on))} label="Start at login" />
      </Section>
      <ErrorLine text={err} />
    </>
  );
}
