import { create } from "zustand";
import { createMate, deleteMate, listMates, restoreBuiltins, updateMate, type Mate, type MatePatch } from "../api/mates";

/** The mates (default first) and which one the Mate view shows. Per-device
 * prefs (the chosen mate, mute) live in localStorage. */
interface MateState {
  mates: Mate[];
  loaded: boolean;
  error: string | null;
  activeId: string | null;
  muted: boolean; // this device: never read aloud (per-mate auto_read is on the server)
  load: () => Promise<void>;
  setActive: (id: string) => void;
  upsert: (m: Mate) => void;
  patch: (id: string, patch: MatePatch) => Promise<Mate>;
  create: (name: string) => Promise<Mate>;
  remove: (id: string) => Promise<void>;
  setMuted: (on: boolean) => void;
  /** bring back deleted built-in mates; returns how many came back */
  restoreBuiltins: () => Promise<number>;
}

const ACTIVE_KEY = "hrh_mate_active";
const MUTE_KEY = "hrh_mate_muted";

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

export const useMateStore = create<MateState>((set, get) => ({
  mates: [],
  loaded: false,
  error: null,
  activeId: read(ACTIVE_KEY),
  muted: read(MUTE_KEY) === "1",

  load: async () => {
    try {
      const mates = await listMates();
      const { activeId } = get();
      const keep = activeId && mates.some((m) => m.id === activeId) ? activeId : mates[0]?.id ?? null;
      set({ mates, loaded: true, error: null, activeId: keep });
    } catch (e) {
      set({ loaded: true, error: (e as Error).message });
    }
  },

  setActive: (id) => {
    write(ACTIVE_KEY, id);
    set({ activeId: id });
  },

  upsert: (m) =>
    set((s) => {
      const i = s.mates.findIndex((x) => x.id === m.id);
      let mates = i >= 0 ? s.mates.map((x) => (x.id === m.id ? m : x)) : [...s.mates, m];
      if (m.is_default) mates = mates.map((x) => (x.id === m.id ? x : { ...x, is_default: false }));
      return { mates };
    }),

  patch: async (id, patch) => {
    const m = await updateMate(id, patch);
    get().upsert(m);
    return m;
  },

  create: async (name) => {
    const m = await createMate({ name });
    get().upsert(m);
    get().setActive(m.id);
    return m;
  },

  remove: async (id) => {
    await deleteMate(id);
    set((s) => ({ mates: s.mates.filter((m) => m.id !== id) }));
    if (get().activeId === id) {
      const next = get().mates[0]?.id ?? null;
      write(ACTIVE_KEY, next);
      set({ activeId: next });
    }
  },

  setMuted: (on) => {
    write(MUTE_KEY, on ? "1" : null);
    set({ muted: on });
  },

  restoreBuiltins: async () => {
    const before = new Set(get().mates.map((m) => m.id));
    const mates = await restoreBuiltins();
    set({ mates });
    return mates.filter((m) => !before.has(m.id)).length;
  },
}));

// Another window of this browser (the desktop overlay / chat windows share
// localStorage) muted or picked a mate: follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === MUTE_KEY) useMateStore.setState({ muted: e.newValue === "1" });
  });
}
