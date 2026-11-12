// Light / dark in the desktop app (the console's Settings → Appearance, frontend/src/lib/theme.ts): the console
// tells the app its mode (hrhNative.setTheme → settings.json `theme`), and the app follows:
//   - nativeTheme.themeSource = the mode: native menus, dialogs and the tray menu match, and every window's
//     prefers-color-scheme follows — the local pages (connect, retry, the fallback title bar) use it, and the web
//     console's "System" mode keeps reading the real OS preference when the mode is system
//   - the windows' background colour (what shows before a page paints): no dark flash on a light theme
// The Mate's transparent windows (avatar, quick card, action bar) keep a transparent background: each is marked when it
// is made (keepTransparent) and applyTheme never paints a marked window — whatever list it is handed. A theme colour
// on one turns its see-through page into a dark / light-gray box (setBackgroundColor also outlives reloads).
"use strict";

const MODES = ["system", "light", "dark"];
/** the page colours of the two themes (frontend/src/index.css --c-bg) */
const BG = { dark: "#0a0c10", light: "#f1f3f7" };

const isThemeMode = (v) => MODES.includes(v);

/** the see-through windows: never given a background colour */
const CLEAR = new WeakSet();
const keepTransparent = (win) => {
  if (win) CLEAR.add(win);
  return win;
};
const isTransparent = (win) => !!win && CLEAR.has(win);

/** the mode to use for a stored value (anything unknown: follow the system) */
const modeOf = (stored) => (isThemeMode(stored) ? stored : "system");

/** the window background for a theme in effect (nativeTheme.shouldUseDarkColors) */
const backgroundFor = (dark) => (dark ? BG.dark : BG.light);

/**
 * Apply a mode: nativeTheme follows it, the opaque windows get the matching background.
 * `windows`: the BrowserWindows to repaint (the caller leaves out the transparent ones; marked ones are skipped here too).
 */
function applyTheme(nativeTheme, mode, windows = []) {
  const m = modeOf(mode);
  if (nativeTheme.themeSource !== m) nativeTheme.themeSource = m;
  const bg = backgroundFor(nativeTheme.shouldUseDarkColors);
  for (const w of windows) {
    try {
      if (!w.isDestroyed() && !isTransparent(w)) w.setBackgroundColor(bg);
    } catch {
      /* gone */
    }
  }
  return bg;
}

// What a see-through window's page must be before it is shown: the Mate surface itself (frontend/src/main.tsx marks
// it html.mate-transparent before its load event) with no colour on <html> / <body>. Anything else — the server's
// "Updating…" page while it swaps its files, an error page, an old cached page whose code is gone — would be an
// opaque card on the desktop.
const SEE_THROUGH_PROBE = `(() => {
  const clear = (el) => { if (!el) return true; const s = getComputedStyle(el);
    return s.backgroundImage === "none" && /^(transparent|rgba\\(\\d+, \\d+, \\d+, 0\\))$/.test(s.backgroundColor); };
  const h = document.documentElement;
  return !!h && h.classList.contains("mate-transparent") && clear(h) && clear(document.body);
})()`;

/** does this window's page draw nothing but itself (SEE_THROUGH_PROBE)? false when it can't be asked in time */
async function seeThrough(webContents, { timeoutMs = 4000 } = {}) {
  let timer = null;
  try {
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return (await Promise.race([webContents.executeJavaScript(SEE_THROUGH_PROBE, false), late])) === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { MODES, BG, isThemeMode, modeOf, backgroundFor, applyTheme, keepTransparent, isTransparent, SEE_THROUGH_PROBE, seeThrough };
