/**
 * The language across devices (docs/i18n.md): the account's choice lives on the server (`/api/preferences`). The
 * console applies it after loading and again when it comes back to the foreground, so a switch on one device
 * reaches the others; a choice made here is saved there too. The same fetch carries the theme (lib/themeSync.ts).
 */
import { getPreferences, putPreferences } from "../api/preferences";
import { applyAccountTheme } from "../lib/themeSync";
import { tellNative, useI18n, type Lang } from ".";

let lastPull = 0;

/** apply the server's choice (if it has one and it differs) */
export async function pullLanguage(): Promise<void> {
  lastPull = Date.now();
  try {
    const p = await getPreferences();
    applyAccountTheme(p);
    if (p.language && p.language !== useI18n.getState().lang) await useI18n.getState().setLang(p.language);
  } catch {
    /* offline / an older server without preferences: this device's choice stands */
  }
}

/** switch now, then save it for every device; false: only this device has it (the server could not be reached) */
export async function chooseLanguage(lang: Lang): Promise<boolean> {
  await useI18n.getState().setLang(lang);
  try {
    await putPreferences({ language: lang });
    return true;
  } catch {
    return false;
  }
}

let installed = false;
/** the console's start: the server's choice now, then whenever the app comes back (at most once a minute) */
export function installLanguageSync(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  tellNative(useI18n.getState().lang); // the desktop app's tray / menus follow from the start
  void pullLanguage();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastPull > 60_000) void pullLanguage();
  });
}
