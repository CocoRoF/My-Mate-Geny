import { create } from "zustand";

export type View = "chat" | "providers" | "connections" | "usage";

interface UIState {
  view: View;
  setView: (v: View) => void;
}

export const useUIStore = create<UIState>((set) => ({
  view: "chat",
  setView: (v) => set({ view: v }),
}));
