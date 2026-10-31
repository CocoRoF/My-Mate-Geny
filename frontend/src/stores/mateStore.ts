import { create } from "zustand";
import {
  createMate,
  deleteMate,
  getProviders,
  listMates,
  restoreBuiltins,
  updateMate,
  verifyProvider,
  type Mate,
  type MatePatch,
  type Providers,
  type ProviderStatus,
} from "../api/mates";

/** Sections of the Global (app-wide) Mate settings. */
export type GlobalSection = "voice" | "live2d" | "desktop" | "defaults";

/** The mates (default first) and which one the Mate view shows. Per-device
 * prefs (the chosen mate, mute) live in localStorage. Also: the voice
 * providers set up in Global settings (shared by every mate) and whether the
 * Global settings panel is open. */
interface MateState {
  /** voice providers (GET /api/mates/providers); null until loaded */
  providers: Providers | null;
  providersError: string | null;
  providersLoading: boolean;
  /** load (configured ones are verified server-side when stale; `refresh`: all re-checked now) */
  loadProviders: (refresh?: boolean) => Promise<Providers | null>;
  setProviders: (p: Providers) => void;
  /** re-check one provider now */
  verifyProvider: (engine: string) => Promise<ProviderStatus>;
  /** Global settings: open (on a section) / closed. The Mate view and Mate settings both open it. */
  globalOpen: boolean;
  globalSection: GlobalSection;
  openGlobal: (section?: GlobalSection) => void;
  closeGlobal: () => void;
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

  providers: null,
  providersError: null,
  providersLoading: false,
  loadProviders: async (refresh = false) => {
    set({ providersLoading: true });
    try {
      const providers = await getProviders(refresh);
      set({ providers, providersError: null, providersLoading: false });
      return providers;
    } catch (e) {
      set({ providersError: (e as Error).message, providersLoading: false });
      return null;
    }
  },
  setProviders: (providers) => set({ providers, providersError: null }),
  verifyProvider: async (engine) => {
    const st = await verifyProvider(engine);
    set((s) => {
      if (!s.providers) return {};
      // one provider can serve both kinds (OpenAI: TTS + STT)
      const put = (xs: ProviderStatus[]) => xs.map((p) => (p.engine === st.engine ? { ...st, kind: p.kind } : p));
      return { providers: { tts: put(s.providers.tts), stt: put(s.providers.stt) } };
    });
    return st;
  },
  globalOpen: false,
  globalSection: "voice",
  openGlobal: (section) => set((s) => ({ globalOpen: true, globalSection: section ?? s.globalSection })),
  closeGlobal: () => set({ globalOpen: false }),

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
