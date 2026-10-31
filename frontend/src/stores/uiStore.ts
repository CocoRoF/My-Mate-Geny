import { create } from "zustand";

export type View = "mate" | "chat" | "providers" | "connections" | "usage" | "admin" | "downloads";

interface UIState {
  view: View;
  sidebarOpen: boolean; // mobile drawer
  setView: (v: View) => void;
  setSidebar: (open: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  view: "chat",
  sidebarOpen: false,
  setView: (v) => set({ view: v, sidebarOpen: false }),
  setSidebar: (open) => set({ sidebarOpen: open }),
}));
