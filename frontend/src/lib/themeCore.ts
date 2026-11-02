/**
 * The theme's pure parts (no React, no store — test/theme.test.ts runs them under node): the modes, how a mode
 * resolves to light or dark, where the choice is kept, and what the account's choice means for this device.
 * lib/theme.ts wires them to the page; index.html repeats `resolve` + `readMode` inline (before the first paint).
 *
 *   mode     what the user picked: "system" (follow the OS, live) | "light" | "dark"
 *   theme    what is drawn: "light" | "dark"
 *
 * Kept: localStorage `hrh_theme` (this browser: every tab and the desktop app's windows), the `hrh_theme` cookie
 * (the server-rendered login page), the account (`/api/preferences` → `theme`: every device follows), unless this
 * device keeps its own (`hrh_theme_device` = "1").
 */

export type ThemeMode = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];
export const THEME_KEY = "hrh_theme";
export const THEME_DEVICE_KEY = "hrh_theme_device";

/** the page's base colour per theme (index.css --c-bg): <meta theme-color>, the desktop window, Android's bars */
export const THEME_BG: Record<Theme, string> = { dark: "#0a0c10", light: "#f1f3f7" };

export const isThemeMode = (v: unknown): v is ThemeMode => v === "system" || v === "light" || v === "dark";

/** the theme a mode draws, given whether the system prefers dark right now */
export const resolveTheme = (mode: ThemeMode, systemDark: boolean): Theme =>
  mode === "system" ? (systemDark ? "dark" : "light") : mode;

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem?(k: string): void;
}

/** the mode saved here (no choice yet, or storage blocked: follow the system) */
export function readMode(storage: StorageLike | null | undefined): ThemeMode {
  try {
    const v = storage?.getItem(THEME_KEY);
    return isThemeMode(v) ? v : "system";
  } catch {
    return "system";
  }
}

/** did the user pick one on this browser (else "system" is only the default) */
export function hasStoredMode(storage: StorageLike | null | undefined): boolean {
  try {
    return isThemeMode(storage?.getItem(THEME_KEY));
  } catch {
    return false;
  }
}

export function writeMode(storage: StorageLike | null | undefined, mode: ThemeMode): void {
  try {
    storage?.setItem(THEME_KEY, mode);
  } catch {
    /* private mode */
  }
}

export function readDeviceOnly(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(THEME_DEVICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDeviceOnly(storage: StorageLike | null | undefined, on: boolean): void {
  try {
    if (on) storage?.setItem(THEME_DEVICE_KEY, "1");
    else storage?.removeItem?.(THEME_DEVICE_KEY);
  } catch {
    /* private mode */
  }
}

/**
 * The account's choice (from /api/preferences) on this device: the mode to switch to, or null to leave it as it is
 * (this device keeps its own, the account has none, or it is already that).
 */
export function accountMode(account: unknown, current: ThemeMode, deviceOnly: boolean): ThemeMode | null {
  if (deviceOnly || !isThemeMode(account) || account === current) return null;
  return account;
}

/** another tab / window changed the stored mode (a `storage` event): the mode to follow, or null */
export function modeFromStorageEvent(key: string | null, newValue: string | null, current: ThemeMode): ThemeMode | null {
  if (key === null) return current === "system" ? null : "system"; // storage cleared: back to the default
  if (key !== THEME_KEY) return null;
  const next = isThemeMode(newValue) ? newValue : "system";
  return next === current ? null : next;
}

/** the cookie the login page reads (one year, this site only) */
export const themeCookie = (mode: ThemeMode) => `${THEME_KEY}=${mode}; path=/; max-age=31536000; SameSite=Lax`;

/** Android's system bars for a theme (Capacitor StatusBar / SystemBars style: "DARK" = light icons on a dark bar) */
export const barStyle = (theme: Theme): "DARK" | "LIGHT" => (theme === "dark" ? "DARK" : "LIGHT");
