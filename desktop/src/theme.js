// Light / dark in the desktop app (the console's Settings → Appearance, frontend/src/lib/theme.ts): the console
// tells the app its mode (hrhNative.setTheme → settings.json `theme`), and the app follows:
//   - nativeTheme.themeSource = the mode: native menus, dialogs and the tray menu match, and every window's
//     prefers-color-scheme follows — the local pages (connect, retry, the fallback title bar) use it, and the web
//     console's "System" mode keeps reading the real OS preference when the mode is system
//   - the windows' background colour (what shows before a page paints): no dark flash on a light theme
// The Mate's transparent windows (avatar, quick card, action bar) keep a transparent background.
"use strict";

const MODES = ["system", "light", "dark"];
/** the page colours of the two themes (frontend/src/index.css --c-bg) */
const BG = { dark: "#0a0c10", light: "#f1f3f7" };

const isThemeMode = (v) => MODES.includes(v);

/** the mode to use for a stored value (anything unknown: follow the system) */
const modeOf = (stored) => (isThemeMode(stored) ? stored : "system");

/** the window background for a theme in effect (nativeTheme.shouldUseDarkColors) */
const backgroundFor = (dark) => (dark ? BG.dark : BG.light);

/**
 * Apply a mode: nativeTheme follows it, the opaque windows get the matching background.
 * `windows`: the BrowserWindows to repaint (transparent ones are skipped by the caller).
 */
function applyTheme(nativeTheme, mode, windows = []) {
  const m = modeOf(mode);
  if (nativeTheme.themeSource !== m) nativeTheme.themeSource = m;
  const bg = backgroundFor(nativeTheme.shouldUseDarkColors);
  for (const w of windows) {
    try {
      if (!w.isDestroyed()) w.setBackgroundColor(bg);
    } catch {
      /* gone */
    }
  }
  return bg;
}

module.exports = { MODES, BG, isThemeMode, modeOf, backgroundFor, applyTheme };
