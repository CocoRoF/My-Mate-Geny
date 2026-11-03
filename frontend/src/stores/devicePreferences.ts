/** One device store for app capture options and output volume. Other voice settings remain untouched. */
import { useSyncExternalStore } from "react";
import type { CaptureSource } from "../mate/screenCapture";
export interface DeviceScreen {
  source: CaptureSource | null;
  approval: "ask" | "allow";
  max_edge: number;
  format: "png" | "jpeg";
  quality: number;
  hide_avatar: boolean;
}
export interface DevicePreferences {
  version: 1;
  revision: number;
  screen: DeviceScreen;
  volume: number;
  migration: {
    imported: boolean;
    screenEdited: boolean;
    volumeEdited: boolean;
    mates: Record<string, unknown>;
    [key: string]: unknown;
  };
}
export interface DeviceBridge {
  get(): Promise<DevicePreferences>;
  patch(p: {
    screen?: Partial<DeviceScreen>;
    volume?: number;
  }): Promise<DevicePreferences>;
  migrate(p: unknown): Promise<DevicePreferences>;
  onChanged(cb: (v: DevicePreferences) => void): () => void;
}
const KEY = "hrh_device_preferences_v1";
const defaults: DevicePreferences = {
  version: 1,
  revision: 0,
  screen: {
    source: null,
    approval: "ask",
    max_edge: 1920,
    format: "png",
    quality: 85,
    hide_avatar: false,
  },
  volume: 1,
  migration: {
    imported: false,
    screenEdited: false,
    volumeEdited: false,
    mates: {},
  },
};
const native = (): DeviceBridge | undefined =>
  typeof window !== "undefined" ? window.hrhNative?.device : undefined;
const listeners = new Set<() => void>();
const read = (): DevicePreferences => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null") || defaults;
  } catch {
    return defaults;
  }
};
let current = read();
let loaded = false;
const receive = (v: DevicePreferences) => {
  // Legacy app versions also stop hiding windows once the new UI loads. Preserve migration of other options first.
  current = { ...v, screen: { ...v.screen, hide_avatar: false } };
  if (v.screen.hide_avatar && v.migration.imported)
    void native()
      ?.patch({ screen: { hide_avatar: false } })
      .catch(() => {});
  loaded = true;
  listeners.forEach((f) => f());
};
const channel =
  typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("hrh-device-preferences")
    : null;
channel?.addEventListener("message", () => {
  if (!native()) receive(read());
});
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === KEY && !native()) receive(read());
  });
function save(v: DevicePreferences) {
  localStorage.setItem(KEY, JSON.stringify(v));
  receive(v);
  channel?.postMessage({ changed: true });
  return v;
}
export async function loadDevicePreferences() {
  const b = native();
  if (b) {
    receive(await b.get());
  } else {
    receive(read());
  }
  return current;
}
let subscribed = false;
export function installDevicePreferences() {
  if (subscribed) return;
  subscribed = true;
  native()?.onChanged(receive);
  void loadDevicePreferences();
}
export function useDevicePreferences() {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      installDevicePreferences();
      return () => {
        listeners.delete(cb);
      };
    },
    () => current,
  );
  return current;
}
export const devicePreferences = () => current;
export const subscribeDevicePreferences = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};
export async function patchDevicePreferences(p: {
  screen?: Partial<DeviceScreen>;
  volume?: number;
}) {
  const b = native();
  if (b) {
    const v = await b.patch(p);
    receive(v);
    return v;
  }
  const run = () => {
    const prev = read();
    const next = {
      ...prev,
      revision: prev.revision + 1,
      migration: { ...prev.migration },
    };
    if (p.screen) {
      next.screen = { ...prev.screen, ...p.screen };
      next.migration.screenEdited = true;
    }
    if (typeof p.volume === "number" && Number.isFinite(p.volume)) {
      next.volume = Math.max(0, Math.min(3, p.volume));
      next.migration.volumeEdited = true;
    }
    return save(next);
  };
  return navigator.locks ? navigator.locks.request(KEY, run) : run();
}
export async function migrateDevicePreferences(
  mates: {
    id: string;
    voice?: { volume?: number };
    screen?: unknown;
    updated_at?: string;
  }[],
  activeId: string | null,
) {
  if (!mates.length) return;
  const payload = {
    origin: location.origin,
    activeId,
    mates: mates.map((m) => ({
      id: m.id,
      volume: m.voice?.volume ?? 1,
      screen: m.screen,
      updated_at: m.updated_at,
    })),
  };
  const b = native();
  if (b) {
    receive(await b.migrate(payload));
    return;
  }
  const prev = read();
  const records = { ...prev.migration.mates };
  for (const m of payload.mates) records[`${payload.origin}:${m.id}`] = m;
  const chosen =
    payload.mates.find((m) => m.id === activeId) || payload.mates[0];
  const migration = { ...prev.migration, mates: records };
  let volume = prev.volume,
    screen = prev.screen;
  if (!migration.imported) {
    if (!migration.volumeEdited)
      volume = Math.max(0, Math.min(3, chosen.volume));
    if (!migration.screenEdited && chosen.screen)
      screen = { ...screen, ...(chosen.screen as Partial<DeviceScreen>) };
    migration.imported = true;
  }
  save({ ...prev, revision: prev.revision + 1, volume, screen, migration });
}
export const devicePreferencesLoaded = () => loaded;
