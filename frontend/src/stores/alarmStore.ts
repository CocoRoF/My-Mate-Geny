/**
 * Her alarms waiting (backend app/mate/alarms.py, docs/mate-calls.md "Alarms"): she phones them at the time they set with
 * her. Kept fresh by the server's `alarms.changed` (hooks/useSessionSync.ts); the Android app is handed the moments to
 * wake itself (a little before each, to be on the line when she calls — its page closed or not).
 */
import { create } from "zustand";
import { cancelAlarm, listAlarms, type MateAlarm } from "../api/calls";
import { callNative, onAndroid } from "../mate/call/native";

interface AlarmState {
  alarms: MateAlarm[];
  loaded: boolean;
  load: () => Promise<void>;
  cancel: (id: string) => Promise<void>;
}

let wakesSent = "";

/** the phone wakes itself for them (only when they changed: the app keeps what it was given) */
export function handWakes(wakes: string[]): void {
  if (!onAndroid()) return;
  const key = wakes.join(",");
  if (key === wakesSent) return;
  wakesSent = key;
  void callNative.setWakes(wakes);
}

export const useAlarmStore = create<AlarmState>((set, get) => ({
  alarms: [],
  loaded: false,
  load: async () => {
    try {
      const { alarms, wakes } = await listAlarms();
      set({ alarms, loaded: true });
      handWakes(wakes);
    } catch {
      /* the next change says it again */
    }
  },
  cancel: async (id) => {
    set({ alarms: get().alarms.filter((a) => a.id !== id) });
    await cancelAlarm(id).catch(() => {});
    await get().load();
  },
}));
