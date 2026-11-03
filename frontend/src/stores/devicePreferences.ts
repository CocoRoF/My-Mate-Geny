import {queueBrowserEnabled} from "../mate/deviceEvents";
/** One device store for app capture options and output volume. Other voice settings remain untouched. */
import { useSyncExternalStore } from "react";
import type { CaptureSource } from "../mate/screenCapture";
export interface DeviceScreen {
  source: CaptureSource | null;
  source_invalid?: boolean;
  approval: "ask" | "allow";
  max_edge: number;
  format: "png" | "jpeg";
  quality: number;
  hide_avatar: boolean;
  proactive_enabled: boolean | null;
  proactive_mate?: string;
  proactive_interval: number;
}
export interface SharingIntent {
  enabled:boolean; origin:string; sid:string; name:string; mate_id?:string; mode:"ask"|"on_turn"|"observe"; interval:number;
}
export interface DevicePreferences {
  version: 1;
  revision: number;
  screen: DeviceScreen;
  volume: number;
  sharing: SharingIntent;
  migration: {
    imported: boolean;
    screenEdited: boolean;
    volumeEdited: boolean;
    mates: Record<string, unknown>;
    [key: string]: unknown;
  };
}
export interface DeviceBridge {
  context?():Promise<{deviceId:string;bootId:string;startReason:string;mateId:string|null}>;
  events?(mateId:string):Promise<{id:string;type:string;mate_id:string;boot_id:string;start_reason:string}[]>;
  ackEvents?(ids:string[]):Promise<void>;
  get(): Promise<DevicePreferences>;
  patch(p: {
    screen?: Partial<DeviceScreen>;
    volume?: number;
    sharing?: Partial<SharingIntent>;
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
    proactive_enabled: null,
    proactive_interval: 180,
  },
  sharing: {enabled:false,origin:"",sid:"",name:"",mode:"ask",interval:180},
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
function normalize(raw: unknown): DevicePreferences {
  const v = raw && typeof raw === "object" ? raw as Partial<DevicePreferences> : {};
  const r = v.screen || {}, q = v.sharing || {};
  const screen = {...defaults.screen,...r,hide_avatar:false};
  if (!["ask","allow"].includes(screen.approval)) screen.approval="ask";
  if (![0,1280,1920,2560].includes(screen.max_edge)) screen.max_edge=1920;
  if (!["png","jpeg"].includes(screen.format)) screen.format="png";
  screen.quality=Number.isFinite(screen.quality)?Math.max(40,Math.min(100,screen.quality)):85;
  screen.proactive_enabled=typeof screen.proactive_enabled==="boolean"?screen.proactive_enabled:null;
  screen.proactive_interval=Number.isFinite(screen.proactive_interval)?Math.max(60,Math.min(600,screen.proactive_interval)):180;
  const invalidSource = screen.source != null && (typeof screen.source.id!=="string" || !screen.source.id);
  if (!screen.source || invalidSource) screen.source=null;
  screen.source_invalid=!!screen.source_invalid||invalidSource;
  const sharing={...defaults.sharing,...q};
  sharing.origin=typeof sharing.origin==="string"&&/^https?:\/\//.test(sharing.origin)?sharing.origin.slice(0,300):"";
  sharing.sid=typeof sharing.sid==="string"?sharing.sid.slice(0,100):"";
  sharing.name=typeof sharing.name==="string"?sharing.name.slice(0,100):"";
  sharing.enabled=sharing.enabled===true;
  if (!["ask","on_turn","observe"].includes(sharing.mode)) sharing.mode="ask";
  sharing.interval=Number.isFinite(sharing.interval)?Math.max(60,Math.min(600,sharing.interval)):180;
  return {...defaults,...v,screen,sharing,volume:Number.isFinite(v.volume)?Math.max(0,Math.min(3,v.volume!)):1,
    revision:Number.isSafeInteger(v.revision)?v.revision!:0,migration:{...defaults.migration,...v.migration}};
}
const read = (): DevicePreferences => {
  try { return normalize(JSON.parse(localStorage.getItem(KEY)||"null")); }
  catch { return normalize(null); }
};
let current = read();
let loaded = false;
let nativeReceived = false;
const receive = (v: DevicePreferences) => {
  if (native()) {
    if (nativeReceived && v.revision < current.revision) return;
    nativeReceived = true;
  }
  // Legacy app versions also stop hiding windows once the new UI loads. Preserve migration of other options first.
  current = normalize(v);
  if (v.screen?.hide_avatar && v.migration?.imported)
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
  sharing?: Partial<SharingIntent>;
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
    if (p.sharing) next.sharing = normalize({...prev,sharing:{...prev.sharing,...p.sharing}}).sharing;
    if (p.screen) {
      next.screen = { ...prev.screen, ...p.screen };
      if("source" in p.screen)next.screen.source_invalid=false;
      next.migration.screenEdited = true;
    }
    if (typeof p.volume === "number" && Number.isFinite(p.volume)) {
      next.volume = Math.max(0, Math.min(3, p.volume));
      next.migration.volumeEdited = true;
    }
    if(next.screen.proactive_enabled===true && (prev.screen.proactive_enabled!==true || prev.screen.proactive_mate!==next.screen.proactive_mate))queueBrowserEnabled(next.screen.proactive_mate||"");
    return save(normalize(next));
  };
  return navigator.locks ? navigator.locks.request(KEY, run) : run();
}
export async function migrateDevicePreferences(
  mates: {
    id: string;
    voice?: { volume?: number };
    screen?: unknown;
    prefs?: {proactive?: {enabled?:boolean;interval?:number}};
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
      proactive:m.prefs?.proactive,
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
  if (screen.proactive_enabled === null && chosen.proactive) screen = {...screen,proactive_enabled:!!chosen.proactive.enabled,proactive_interval:chosen.proactive.interval || 180};
  save(normalize({ ...prev, revision: prev.revision + 1, volume, screen, migration }));
}
export const devicePreferencesLoaded = () => loaded;
