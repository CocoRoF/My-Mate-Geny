/**
 * The user's timezone for the times shown in conversations (lib/messageTime.ts): the one set in Settings → 언어 →
 * 시간대 (the mates' clock, /api/mates/settings `timezone` — filled with the first device's own zone), else this
 * device's. Read once; Settings tells it when it changes.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { getVoiceSettings } from "../api/mates";
import { deviceZone, safeZone } from "./messageTime";

export const useUserTz = create<{ tz: string }>(() => ({ tz: safeZone(deviceZone()) }));

let asked = false;

export function loadUserTimezone(): void {
  if (asked) return;
  asked = true;
  getVoiceSettings()
    .then((s) => {
      if (s.timezone) setUserTimezone(s.timezone);
    })
    .catch(() => {
      asked = false; // (signed out, or the server away: asked again by the next conversation shown)
    });
}

/** Settings saved a new one (or it was read): every time on screen follows. */
export function setUserTimezone(tz: string): void {
  const zone = safeZone(tz.trim() || deviceZone());
  if (zone !== useUserTz.getState().tz) useUserTz.setState({ tz: zone });
}

/** the zone the times are shown in (reading the setting the first time it is needed) */
export function useUserTimezone(): string {
  useEffect(loadUserTimezone, []);
  return useUserTz((s) => s.tz);
}
