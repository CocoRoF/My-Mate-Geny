/**
 * The user's own picture (Settings → 계정; the sidebar's footer and rail show it instead of their initial): one for the
 * app, kept on the server (`user_icon` of /api/mates/settings). Loaded once, again when the mate settings change —
 * here, in another window or on another device (mateStore's `settings` push).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { getVoiceSettings } from "../api/mates";

interface UserIconState {
  /** its URL, "" none */
  url: string;
  loaded: boolean;
  load: () => Promise<void>;
  set: (url: string) => void;
}

let loading: Promise<void> | null = null;

export const useUserIcon = create<UserIconState>((set) => ({
  url: "",
  loaded: false,
  load: () =>
    (loading ??= getVoiceSettings()
      .then((s) => set({ url: s.user_icon ?? "", loaded: true }))
      .catch(() => {
        /* signed out, offline, an older server: as it was */
      })
      .finally(() => {
        loading = null;
      })),
  set: (url) => set({ url, loaded: true }),
}));

/** the picture's URL ("" none), loaded the first time it is asked for */
export function useUserIconUrl(): string {
  const url = useUserIcon((s) => s.url);
  const loaded = useUserIcon((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useUserIcon.getState().load();
  }, [loaded]);
  return url;
}
