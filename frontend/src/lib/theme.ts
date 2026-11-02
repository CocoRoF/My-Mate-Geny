/**
 * Light / dark (Settings → Appearance). The pure rules are in lib/themeCore.ts; this wires them to the page:
 *
 *   <html class="light|dark" data-theme data-theme-mode>   index.css picks its token set by the class
 *   <meta name="theme-color">                              the browser's / phone's bar
 *   localStorage hrh_theme (+ the `storage` event)         every tab and desktop window of this browser at once
 *   cookie hrh_theme                                       the server-rendered login page
 *   hrhNative.setTheme(mode)                               the desktop app: native menus / dialogs, window colour,
 *                                                          its local pages (desktop/src/main.js)
 *   Android (Capacitor)                                    status / navigation bar icons and colour; the app's
 *                                                          GenyServer.setTheme (its local pages) when it has it
 *   prefers-color-scheme (live)                            "system" follows the OS as it changes
 *
 * The account's choice (/api/preferences `theme`) is applied by i18n/sync.ts with the language; a choice made here
 * goes there too unless this device keeps its own (`deviceOnly`).
 */
import { create } from "zustand";
import {
  barStyle,
  hasStoredMode,
  modeFromStorageEvent,
  readDeviceOnly,
  readMode,
  resolveTheme,
  THEME_BG,
  themeCookie,
  writeDeviceOnly,
  writeMode,
  type Theme,
  type ThemeMode,
} from "./themeCore";

export type { Theme, ThemeMode } from "./themeCore";

const ls = (): Storage | null => {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
};

const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const systemDark = () => (query ? query.matches : true);

interface ThemeState {
  mode: ThemeMode;
  /** what is drawn now */
  theme: Theme;
  /** this device keeps its own choice (the account's is neither applied nor changed from here) */
  deviceOnly: boolean;
  /** switch now; `persist` (default): keep it on this browser (localStorage, cookie, the desktop app) */
  setMode: (mode: ThemeMode, opts?: { persist?: boolean }) => void;
  setDeviceOnly: (on: boolean) => void;
}

function applyDocument(theme: Theme, mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  html.classList.toggle("light", theme === "light");
  html.classList.toggle("dark", theme === "dark");
  html.dataset.theme = theme;
  html.dataset.themeMode = mode;
  html.style.colorScheme = theme;
  // the transparent desktop windows draw no page colour; the bar colour is for real pages only
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_BG[theme]);
}

let lastNative = "";
/** the apps' own parts follow (each call is feature-detected: an older app simply lacks it) */
function tellNative(theme: Theme, mode: ThemeMode) {
  if (typeof window === "undefined") return;
  const key = `${mode}/${theme}`;
  if (key === lastNative) return;
  lastNative = key;
  try {
    (window.hrhNative as { setTheme?: (m: string) => void } | undefined)?.setTheme?.(mode);
  } catch {
    /* an older desktop app */
  }
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.()) return;
  const has = (plugin: string, method?: string) => {
    try {
      const h = (cap.PluginHeaders as { name: string; methods?: { name: string }[] }[] | undefined)?.find((p) => p.name === plugin);
      if (h) return !method || !!h.methods?.some((m) => m.name === method);
      return !method && !!cap.isPluginAvailable?.(plugin);
    } catch {
      return false;
    }
  };
  const call = (plugin: string, method: string, options: Record<string, unknown>) => {
    if (!has(plugin, method)) return;
    try {
      (cap.nativePromise(plugin, method, options) as Promise<unknown>).catch(() => {});
    } catch {
      /* not there */
    }
  };
  const style = barStyle(theme);
  // the bar's colour first (Android before 15 draws one; its "DEFAULT" style would pick the icons from it), then the
  // icons; SystemBars (Capacitor 8) also does the navigation bar's
  call("StatusBar", "setBackgroundColor", { color: THEME_BG[theme] });
  call("StatusBar", "setStyle", { style });
  call("SystemBars", "setStyle", { style });
  // the app's own (newer APKs): its window colour and the local connect / offline pages
  call("GenyServer", "setTheme", { mode, theme });
}

function persist(mode: ThemeMode) {
  writeMode(ls(), mode);
  try {
    document.cookie = themeCookie(mode);
  } catch {
    /* no cookies */
  }
}

const initialMode = readMode(ls());

export const useTheme = create<ThemeState>((set, get) => ({
  mode: initialMode,
  theme: resolveTheme(initialMode, systemDark()),
  deviceOnly: readDeviceOnly(ls()),
  setMode: (mode, opts = {}) => {
    if (opts.persist !== false) persist(mode);
    const theme = resolveTheme(mode, systemDark());
    applyDocument(theme, mode);
    tellNative(theme, mode);
    if (get().mode !== mode || get().theme !== theme) set({ mode, theme });
  },
  setDeviceOnly: (on) => {
    writeDeviceOnly(ls(), on);
    set({ deviceOnly: on });
  },
}));

/** the theme drawn now (re-renders on a change) */
export const useResolvedTheme = () => useTheme((s) => s.theme);

/** did this browser ever pick one (the account's choice may then be adopted without asking) */
export const themeChosenHere = () => hasStoredMode(ls());

let installed = false;
/** at the start: draw the saved mode, follow the OS while on "system", and other tabs / windows of this browser */
export function installTheme(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const s = useTheme.getState();
  applyDocument(s.theme, s.mode);
  tellNative(s.theme, s.mode);
  const follow = () => {
    const st = useTheme.getState();
    if (st.mode === "system") st.setMode("system", { persist: false });
  };
  if (query) {
    if (query.addEventListener) query.addEventListener("change", follow);
    else (query as MediaQueryList).addListener?.(follow);
  }
  window.addEventListener("storage", (e) => {
    if (e.storageArea && e.storageArea !== ls()) return;
    const next = modeFromStorageEvent(e.key, e.newValue, useTheme.getState().mode);
    if (next) useTheme.getState().setMode(next, { persist: false });
    if (e.key === null || e.key === "hrh_theme_device") useTheme.setState({ deviceOnly: readDeviceOnly(ls()) });
  });
}
