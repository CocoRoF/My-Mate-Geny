import { migrateDevicePreferences, installDevicePreferences, devicePreferences, patchDevicePreferences } from "./devicePreferences";
import { currentSurface, desktopMate } from "../mate/desktop";
import { create } from "zustand";
import {
  createMate,
  deleteMate,
  getProviders,
  getVoiceSettings,
  listMates,
  putVoiceSettings,
  restoreBuiltins,
  updateMate,
  verifyProvider,
  type Mate,
  type MatePatch,
  type Providers,
  type ProviderStatus,
  type UserLocation,
} from "../api/mates";

/** The mates (default first) and which one the Mate view shows. Per-device
 * prefs (the chosen mate, mute) live in localStorage. Also: the voice
 * providers set up in Settings → Image & voice services (shared by every mate). */
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
  mates: Mate[];
  /** mates being made in the Mate Create studio (never in `mates`: hidden from the picker until Create mate), the
   *  latest copy a settings tab saved */
  drafts: Record<string, Mate>;
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
  /**
   * The server says mates changed (/ws/sessions `mates.changed`, or `mates_version` in hello/pong): refetch, coalesced.
   * Without it a window keeps the mates it loaded at startup — the desktop overlay would go on speaking at the old
   * volume after Settings → Voice → Save.
   */
  remoteChanged: (version: unknown, reason?: string, mateId?: string) => void;
  /** the newest mates version the server announced (null: none yet) */
  syncVersion: number | null;
  /** per mate: bumped when its memories changed elsewhere (the Memory tab refetches) */
  memoryRev: Record<string, number>;
  /** per mate: bumped when its relationship changed elsewhere (the Relationship tab refetches) */
  relationRev: Record<string, number>;
  /** per mate: bumped when her own conversation-style changes changed (chips and the style tab's history refetch) */
  styleRev: Record<string, number>;
  bumpStyle: (mateId: string) => void;
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

/** Keep the objects of mates that did not change: a refetch must not re-render (or restart) every avatar. */
function share(prev: Mate[], next: Mate[]): Mate[] {
  const old = new Map(prev.map((m) => [m.id, m]));
  return next.map((m) => {
    const o = old.get(m.id);
    return o && JSON.stringify(o) === JSON.stringify(m) ? o : m;
  });
}

// Same-browser windows (the desktop app's console, overlay, quick card and chat window; other tabs): a save here is
// announced at once, without waiting for the server's push.
const storeChannel: BroadcastChannel | null = (() => {
  try {
    return typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("hrh-mate-store") : null;
  } catch {
    return null;
  }
})();
const announce = (mateId?: string) => {
  try {
    storeChannel?.postMessage({ type: "changed", mateId: mateId ?? null });
  } catch {
    /* closed */
  }
};

/** this browser's IANA timezone ("" when it can't tell) */
export const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
};

// The mates' clock (the "Now" line, plan dates, relationship days) runs in the user's timezone: when none is set
// yet, the first console (any screen — App.tsx) or Mate window to start sets this browser's (Settings → 언어
// changes it). Until then the server counts in its own zone; setting it recounts the relationships.
let tzChecked = false;
export function fillTimezone() {
  if (tzChecked) return;
  tzChecked = true;
  const tz = browserTimezone();
  if (!tz) return;
  getVoiceSettings()
    .then((s) => (s.timezone ? null : putVoiceSettings({ timezone: tz })))
    .catch(() => {
      /* an older server, or offline: next load */
    });
}

// Her weather and the public holidays need where the user is (life/world.py): when none is set yet, this browser's
// connection says roughly (an open IP-location API, no key); Settings → 언어 picks a city instead.
let locationChecked = false;
export function fillLocation() {
  if (locationChecked) return;
  locationChecked = true;
  getVoiceSettings()
    .then(async (s) => {
      if (s.location || !("location" in s)) return; // (set, or an older server)
      const found = await locateByConnection();
      if (found) await putVoiceSettings({ location: found });
    })
    .catch(() => {
      /* offline: next load */
    });
}

/** roughly where this connection is (city level), from open IP-location APIs; null when none answers */
export async function locateByConnection(): Promise<Omit<UserLocation, "at"> | null> {
  const tries: [string, (d: any) => Omit<UserLocation, "at"> | null][] = [
    ["https://ipwho.is/", (d) => (d && d.success !== false && typeof d.latitude === "number" ? { lat: d.latitude, lon: d.longitude, city: d.city || "", country: d.country_code || "", source: "ip" } : null)],
    ["https://ipapi.co/json/", (d) => (d && typeof d.latitude === "number" ? { lat: d.latitude, lon: d.longitude, city: d.city || "", country: d.country_code || "", source: "ip" } : null)],
  ];
  for (const [url, read] of tries) {
    try {
      const r = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const found = read(await r.json());
      if (found) return found;
    } catch {
      /* the next one */
    }
  }
  return null;
}

/**
 * The mate picked in the Mate view is the one: on the desktop (her window, the quick card, the chat window) and the one
 * who may speak first on this device — there is no "default mate" or "the desktop's mate" to set apart (the first
 * pick is the built-in mate). Only the console picks; the desktop's own windows follow it.
 */
function follow(id: string | null) {
  if (!id || (typeof window !== "undefined" && currentSurface() !== "console")) return;
  const m = desktopMate();
  if (m) void m.getState().then((s) => (s.mateId !== id ? m.setMate(id) : undefined)).catch(() => {});
  if (devicePreferences().screen.proactive_mate !== id) void patchDevicePreferences({ screen: { proactive_mate: id } }).catch(() => {});
}

const RELOAD_MS = 150;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

export const useMateStore = create<MateState>((set, get) => ({
  syncVersion: null,
  memoryRev: {},
  relationRev: {},
  styleRev: {},
  bumpStyle: (mateId) => set((s) => ({ styleRev: { ...s.styleRev, [mateId]: (s.styleRev[mateId] ?? 0) + 1 } })),
  mates: [],
  drafts: {},
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

  load: async () => {
    try {
      const mates = await listMates();
      const { activeId } = get();
      const keep = activeId && mates.some((m) => m.id === activeId) ? activeId : mates[0]?.id ?? null;
      set((s) => ({ mates: share(s.mates, mates), loaded: true, error: null, activeId: keep }));
      installDevicePreferences();
      void migrateDevicePreferences(mates, keep).then(() => follow(keep), () => follow(keep));
      fillTimezone();
      fillLocation();
    } catch (e) {
      set({ loaded: true, error: (e as Error).message });
    }
  },

  setActive: (id) => {
    write(ACTIVE_KEY, id);
    set({ activeId: id });
    follow(id);
  },

  upsert: (m) =>
    set((s) => {
      if (m.draft) return { drafts: { ...s.drafts, [m.id]: m }, mates: s.mates.filter((x) => x.id !== m.id) };
      const i = s.mates.findIndex((x) => x.id === m.id);
      let mates = i >= 0 ? s.mates.map((x) => (x.id === m.id ? m : x)) : [...s.mates, m];
      if (m.is_default) mates = mates.map((x) => (x.id === m.id ? x : { ...x, is_default: false }));
      return { mates };
    }),

  patch: async (id, patch) => {
    const m = await updateMate(id, patch);
    get().upsert(m);
    announce(id);
    return m;
  },

  create: async (name) => {
    const m = await createMate({ name });
    get().upsert(m);
    announce(m.id);
    get().setActive(m.id);
    return m;
  },

  remove: async (id) => {
    await deleteMate(id);
    announce(id);
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
    announce();
    set((s) => ({ mates: share(s.mates, mates) }));
    return mates.filter((m) => !before.has(m.id)).length;
  },

  remoteChanged: (version, reason, mateId) => {
    if (typeof version !== "number") return;
    const seen = get().syncVersion;
    if (seen === version) return;
    set({ syncVersion: version });
    // the first hello only tells where the server is (this window just loaded its mates)
    if (seen === null && !reason) return;
    if (reason === "memory" && mateId) {
      set((s) => ({ memoryRev: { ...s.memoryRev, [mateId]: (s.memoryRev[mateId] ?? 0) + 1 } }));
    }
    if (reason === "relation" && mateId) {
      set((s) => ({ relationRev: { ...s.relationRev, [mateId]: (s.relationRev[mateId] ?? 0) + 1 } }));
    }
    if (reason === "style" && mateId) get().bumpStyle(mateId);
    if (reason === "settings" && get().providers) void get().loadProviders();
    scheduleReload();
  },
}));

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (useMateStore.getState().loaded) void useMateStore.getState().load();
  }, RELOAD_MS);
}

// Another window of this browser (the desktop overlay / chat windows share
// localStorage) muted or picked a mate: follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === MUTE_KEY) useMateStore.setState({ muted: e.newValue === "1" });
  });
  if (storeChannel) {
    storeChannel.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string } | null;
      if (d?.type === "changed") scheduleReload();
    };
  }
}

// Behaviour changes reach a sharing owner even after navigating away from the Mate view.
if(typeof window!=="undefined"){
  const publishPolicies=()=>window.dispatchEvent(new CustomEvent("hrh:mate-policies",{detail:useMateStore.getState().mates.map(m=>({sid:m.session_id,enabled:!!m.prefs?.proactive?.enabled,interval:m.prefs?.proactive?.interval||180}))}));
  useMateStore.subscribe((state,previous)=>{if(state.mates!==previous.mates)publishPolicies();});
  queueMicrotask(publishPolicies);
}
