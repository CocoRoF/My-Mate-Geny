import { create } from "zustand";
import type { SettingsAnchor, SettingsTab, View } from "../lib/navUrl";

export type { SettingsTab, View } from "../lib/navUrl";

interface UIState {
  view: View;
  /** Settings: the open tab (null: none picked — the list on a phone, the first tab on a wide screen) */
  settingsTab: SettingsTab | null;
  /** a part of the tab to scroll to once shown (consumed by Settings) */
  settingsAnchor: SettingsAnchor | null;
  sidebarOpen: boolean; // mobile drawer
  setView: (v: View) => void;
  /** Settings at a tab (one history entry — lib/nav.ts); also what the screens that became tabs open */
  openSettings: (tab?: SettingsTab | null, anchor?: SettingsAnchor | null) => void;
  setSidebar: (open: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  view: "chat",
  settingsTab: null,
  settingsAnchor: null,
  sidebarOpen: false,
  setView: (v) => set({ view: v, sidebarOpen: false }),
  openSettings: (tab = null, anchor = null) =>
    set({ view: "settings", settingsTab: tab, settingsAnchor: anchor, sidebarOpen: false }),
  setSidebar: (open) => set({ sidebarOpen: open }),
}));

/** Settings at a tab, from anywhere (no hook) */
export const openSettings = (tab: SettingsTab | null = null, anchor: SettingsAnchor | null = null) =>
  useUIStore.getState().openSettings(tab, anchor);
