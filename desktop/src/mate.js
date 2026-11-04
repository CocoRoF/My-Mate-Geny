// The Mate on the desktop (docs/mate.md §7): tray, avatar window (transparent,
// always on top, click-through by default, move mode, remembered bounds), the
// hover action bar, the quick chat card on a global shortcut, the mate chat
// window and start at login. Every surface except the bar is the web app
// (§6, `/?surface=mate-*`) loaded from the configured server, so features
// ship with the console and need no reinstall. Pages reach this module only
// through `window.hrhNative.mate` (preload.js); every IPC checks its sender.
//
// Ported from the user's own apps: ailism-desktop-mate (click-through window,
// cursor-polled action bar, quick card, GNOME Wayland shortcut fallback,
// autostart) and Geny / project-geny-app (always-on-top re-assertion, move-by
// with an authoritative rect, clamping to a live display, crash-loop breaker).
const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, ipcMain, nativeImage, nativeTheme, screen, shell } = require("electron");
const theme = require("./theme");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readSettings, writeSettings, serverUrl, sameOrigin } = require("./settings");
const geo = require("./geometry");
const recovery = require("./recovery");
const chrome = require("./chrome");
const { t, language } = require("./lang");
const { launchCommand } = require("./launch");
const { autostartStale } = require("./rename");

const RETRY_PAGE = path.join(__dirname, "offline.html");

const mac = process.platform === "darwin";
const linux = process.platform === "linux";
const win32 = process.platform === "win32";
const env = process.env;

const PRODUCT = "My Mate Geny";
const DEFAULT_HOTKEY = "CommandOrControl+Shift+G";
const ICON = path.join(__dirname, "..", "build", "icon.png");
const PRELOAD = path.join(__dirname, "preload.js");
const MARGIN = 16;
const AVATAR_DEFAULT = { width: 300, height: 400 };
// The bar window keeps room above the buttons for a label (clicks there pass
// through on Windows/macOS). Linux has no forwarding, so no label room there.
const BAR = { w: 336, h: linux ? 46 : 84, strip: 46 };
// The quick card: a FIXED width (project-geny-app / Geny: the strip never changes
// width); the page reports its height and the window grows downwards from a
// fixed top edge, up to maxH (then the text scrolls inside the card).
const QUICK = { w: 640, h: 76, minH: 56, maxH: 640 };
// The avatar window: what a resize handle can make of it
const AVATAR_MIN = { width: 120, height: 140 };
const CHAT = { w: 420, h: 640 };
// Move mode for pages that draw no move UI of their own (servers older than
// the overlay's own move bar / resize frame / pan-zoom): the whole page drags
// the window. A page that does (html[data-hrh-own-move]) is left alone — its
// avatar area pans and zooms the avatar, its bar moves the window and its
// edges resize it (Geny's overlay: bar = move, avatar = pan/zoom).
const DRAG_CSS = `html:not([data-hrh-own-move]),html:not([data-hrh-own-move]) body{-webkit-app-region:drag!important;cursor:move!important}
html:not([data-hrh-own-move]){outline:2px dashed rgba(110,139,255,.95)!important;outline-offset:-2px;background:rgba(110,139,255,.10)!important}
html:not([data-hrh-own-move]) :is(button,a,input,textarea,select,[data-no-drag]){-webkit-app-region:no-drag!important}`;

let deps = { openConsole: () => {}, consoleWindow: () => null, switchServer: () => {}, signOut: () => {}, quit: () => app.quit() };
let avatar = null;
let bar = null;
let replySpeech = null;
let quick = null;
let chat = null;
let tray = null;
let quitting = false;
let tickTimer = null;
let moveMode = false;
let dragCssKey = null;
let hotkeyBound = ""; // the accelerator actually registered ("" = none)
let barSeenAt = 0;
let quickShownAt = 0;
let quickKeyAt = 0;
let moveRect = null;
let moveIdle = null;
let resizeRect = null;
let resizeIdle = null;
let quickPinned = false; // the quick card holds a draft: a click elsewhere leaves it open
let quickProgAt = 0; // when we last placed / sized the quick card ourselves (not a user drag)
let quickSaveTimer = null;
let saveTimer = null;
let crashes = [];
let gaveUp = false;
let failDelay = 0;
let failTimer = null;
let overlayFailed = false;
let screenPicker = false;
let screenSharing = false;
let screenStatus = "off";
let screenBusy = false;

// ── settings ───────────────────────────────────────────────────

const S = () => readSettings();
const mateId = () => S().mateId || null;
const clickThrough = () => S().mateClickThrough !== false;
const hotkey = () => (typeof S().mateHotkey === "string" ? S().mateHotkey : DEFAULT_HOTKEY);
const shown = () => !!avatar && !avatar.isDestroyed() && avatar.isVisible();
/** the user wants the Mate out (it may still be loading or signed out) */
const wanted = () => !!S().mateVisible && !gaveUp;
const validId = (id) => (typeof id === "string" && /^[\w.:-]{1,100}$/.test(id) ? id : null);
const alive = (w) => !!w && !w.isDestroyed();

/** connected to a server (until then the Mate surfaces have nothing to load) */
const connected = () => !!serverUrl();

function surfaceUrl(kind) {
  const id = mateId();
  return connected() ? `${serverUrl()}/?surface=mate-${kind}${id ? `&mate=${encodeURIComponent(id)}` : ""}` : "";
}

/** Load a Mate window's surface from the connected server (none: stay hidden). */
function loadSurface(win, kind) {
  if (!alive(win)) return;
  if (!connected()) {
    win.hide();
    return;
  }
  win.loadURL(surfaceUrl(kind));
}

/** Is this window actually showing its Mate surface? A signed-out start is
 *  redirected to the server's login page, which must never sit in a
 *  transparent always-on-top window. */
function onSurface(win, kind) {
  return alive(win) && onSurfaceUrl(win.webContents.getURL(), kind);
}

const onSurfaceUrl = (url, kind) => sameOrigin(url) && String(url).includes(`surface=mate-${kind}`);

/** The surface, or the local offline page (which has Retry). */
const presentable = (win, kind) => onSurface(win, kind) || (alive(win) && win.webContents.getURL().startsWith("file:"));

function webPrefs(surface, extra = {}) {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: false,
    autoplayPolicy: "no-user-gesture-required", // the Mate speaks without a click first
    additionalArguments: [`--hrh-version=${app.getVersion()}`, `--hrh-surface=${surface}`],
    ...extra,
  };
}

// ── shared window behaviour ────────────────────────────────────

function floating(win, level = "screen-saver") {
  win.setAlwaysOnTop(true, level);
  // skipTransformProcessType: keep the console's Dock icon on macOS
  if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  else if (linux) win.setVisibleOnAllWorkspaces(true);
}

// Geny's armAlwaysOnTop: a one-shot setAlwaysOnTop decays (fullscreen apps,
// DPI changes, the OS stripping the bit), so re-assert on every observable
// transition, twice (now and once things settle). Event-driven, no polling.
function armAlwaysOnTop(win, after) {
  let settle = null;
  const now = () => {
    if (!alive(win) || !win.isVisible() || win.isMinimized()) return;
    try {
      win.setAlwaysOnTop(true, "screen-saver");
      if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      win.moveTop();
    } catch {
      /* mid-teardown */
    }
    after?.();
  };
  const assert = () => {
    now();
    clearTimeout(settle);
    settle = setTimeout(now, 900);
  };
  win.on("show", assert);
  win.on("restore", assert);
  win.on("blur", assert);
  win.on("always-on-top-changed", (_e, on) => !on && assert());
  screen.on("display-metrics-changed", assert);
  win.on("closed", () => {
    clearTimeout(settle);
    screen.removeListener("display-metrics-changed", assert);
  });
}

function openExternal(url) {
  if (/^https?:/i.test(String(url))) shell.openExternal(String(url));
}

// Only the console's own pages inside the Mate windows; other links go to the
// browser, same-origin popups to the console window.
function guard(win, kind) {
  const wc = win.webContents;
  wc.on("will-navigate", (e, url) => {
    if (sameOrigin(url) || url.startsWith("file:")) return;
    e.preventDefault();
    openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url) && !/[?&]download=1/.test(url)) deps.openConsole(url);
    else openExternal(url);
    return { action: "deny" };
  });
  wc.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    // a transparent corner window must not turn into an opaque error card:
    // the avatar retries quietly with backoff
    if (kind === "overlay") {
      overlayFailed = true; // did-finish-load still follows for the empty error page
      win.hide();
      alive(bar) && bar.hide();
      return retryOverlaySoon();
    }
    // (the chat window and the quick card: recovery.attach → the retry page)
  });
  // Signed out: the server answered with its login page instead of the
  // surface. Hide the Mate window and sign in in the console; the surface
  // reloads once the console is back on the app (consoleNavigated).
  wc.on("did-navigate", (_e, url) => {
    if (!sameOrigin(url) || url.includes(`surface=mate-${kind}`)) return;
    win.hide();
    if (kind === "overlay") {
      alive(bar) && bar.hide();
      retryOverlaySoon();
    } else {
      deps.openConsole();
    }
  });
}

function retryOverlaySoon() {
  failDelay = Math.min(60_000, failDelay ? failDelay * 2 : 5000);
  clearTimeout(failTimer);
  failTimer = setTimeout(() => loadSurface(avatar, "overlay"), failDelay);
}

/** The console window navigated (e.g. after signing in): reload Mate windows
 *  that were left on the login page. */
function consoleNavigated(url) {
  if (!sameOrigin(url) || /\/(login|auth\/exchange)\b/.test(new URL(url).pathname)) return;
  // connected (again): an avatar the user wants out comes back
  if (wanted() && !alive(avatar)) createAvatar();
  for (const [w, kind] of [[avatar, "overlay"], [quick, "quick"], [chat, "chat"]]) {
    if (alive(w) && !w.webContents.isLoading() && !onSurface(w, kind)) {
      if (kind === "overlay") {
        failDelay = 0;
        clearTimeout(failTimer);
      }
      loadSurface(w, kind);
    }
  }
}

function onSomeDisplay(b, slack = 40) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const ix = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const iy = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return ix >= slack && iy >= slack;
  });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function defaultAvatarBounds(size) {
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - size.width - MARGIN, y: a.y + a.height - size.height - MARGIN, ...size };
}

/** Keep remembered bounds on a display that still exists (an unplugged
 *  monitor must not leave an un-clickable avatar somewhere off-screen). */
function clampAvatar(b) {
  const size = { width: clamp(Math.round(Number(b.width) || AVATAR_DEFAULT.width), 60, 2400),
                 height: clamp(Math.round(Number(b.height) || AVATAR_DEFAULT.height), 60, 2400) };
  let r = { x: Math.round(Number(b.x) || 0), y: Math.round(Number(b.y) || 0), ...size };
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !onSomeDisplay(r)) r = defaultAvatarBounds(size);
  const a = screen.getDisplayMatching(r).workArea;
  const width = Math.min(r.width, a.width);
  const height = Math.min(r.height, a.height);
  return { x: clamp(r.x, a.x, a.x + a.width - width), y: clamp(r.y, a.y, a.y + a.height - height), width, height };
}

// ── commands to the pages ──────────────────────────────────────

function command(win, cmd) {
  if (alive(win)) win.webContents.send("mate:command", cmd);
}

function getState() {
  return {
    screenPicker,
    visible: wanted(),
    clickThrough: clickThrough(),
    mateId: mateId(),
    hotkey: hotkey(),
    hotkeyBound: !!hotkeyBound || !hotkey(),
    autostart: autostartOn(),
    moveMode,
    chatOpen: alive(chat) && chat.isVisible(),
    chatOnTop: !!S().mateChatOnTop,
  };
}

function broadcast() {
  const state = { type: "state", ...getState() };
  for (const w of [avatar, quick, chat, deps.consoleWindow()]) command(w, state);
  barState();
  buildTray();
}

// ── the avatar window ──────────────────────────────────────────

function saveAvatarSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (alive(avatar) && !moveRect && !resizeRect) writeSettings({ mateBounds: avatar.getBounds() });
  }, 400);
}

function createAvatar() {
  if(quitting)return;
  const b = clampAvatar(S().mateBounds || defaultAvatarBounds(AVATAR_DEFAULT));
  avatar = new BrowserWindow({
    ...b,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: t("titleMate"),
    icon: ICON,
    webPreferences: webPrefs("mate-overlay", { backgroundThrottling: false }),
  });
  const win = avatar;
  floating(win);
  armAlwaysOnTop(win, raiseBar);
  applyInput();
  guard(win, "overlay");
  const wc = win.webContents;
  wc.on("did-start-loading", () => {
    overlayFailed = false;
    replySpeech = null;
    barState();
  });
  wc.on("did-finish-load", () => {
    if(quitting)return;
    if (overlayFailed || !onSurface(win, "overlay")) return;
    failDelay = 0;
    if (S().mateVisible && !gaveUp) win.showInactive();
    if (moveMode) injectDrag(true);
    command(win, { type: "state", ...getState() });
  });
  // a hung avatar page: reload it quietly (no retry card in a see-through corner window)
  let hang = null;
  win.on("unresponsive", () => {
    clearTimeout(hang);
    hang = setTimeout(() => alive(win) && loadSurface(win, "overlay"), recovery.UNRESPONSIVE_GRACE);
  });
  win.on("responsive", () => clearTimeout(hang));
  win.on("closed", () => clearTimeout(hang));
  wc.on("render-process-gone", (_e, d) => {
    if (d.reason === "clean-exit") return;
    // crash-loop breaker (Geny): a page that dies on load (GPU/WebGL) must not
    // respawn forever; after 3 crashes in a minute give up until asked again
    const t = Date.now();
    crashes = [...crashes.filter((x) => t - x < 60_000), t];
    if (crashes.length > 3) {
      gaveUp = true;
      win.hide();
      alive(bar) && bar.hide();
      notify(t("mateCrashTitle"), t("mateCrashBody"));
      broadcast();
      return;
    }
    setTimeout(() => loadSurface(win, "overlay"), 3000);
  });
  win.on("move", () => {
    placeBar();
    if (!moveRect && !resizeRect) saveAvatarSoon();
  });
  win.on("closed", () => {
    if (avatar === win) avatar = null;
    moveMode = false;
    dragCssKey = null;
    alive(bar) && bar.hide();
  });
  loadSurface(win, "overlay");
}

function applyInput() {
  if (!alive(avatar)) return;
  if (clickThrough() && !moveMode) avatar.setIgnoreMouseEvents(true, linux ? undefined : { forward: true });
  else avatar.setIgnoreMouseEvents(false);
}

function showAvatar(id) {
  if(quitting)return;
  const retrying = gaveUp;
  gaveUp = false;
  crashes = [];
  const next = validId(id);
  const switching = next && next !== mateId();
  writeSettings({ mateVisible: true, ...(next ? { mateId: next } : {}) });
  if (!connected()) {
    // nothing to show yet: the connect screen first (the Mate follows)
    broadcast();
    deps.openConsole();
    return;
  }
  if (switching) reloadSurfaces();
  if (!alive(avatar)) createAvatar();
  else if (retrying || (!avatar.webContents.isLoading() && (overlayFailed || !onSurface(avatar, "overlay")))) {
    loadSurface(avatar, "overlay"); // shown by did-finish-load
  } else {
    avatar.setBounds(clampAvatar(avatar.getBounds()));
    if (!avatar.webContents.isLoading()) avatar.showInactive();
  }
  broadcast();
}

function hideAvatar() {
  writeSettings({ mateVisible: false });
  setMoveMode(false);
  alive(bar) && bar.hide();
  // destroyed, not hidden: a hidden page with throttling off would keep
  // animating (Live2D/WebGL) and holding audio for nothing
  if (alive(avatar)) {
    writeSettings({ mateBounds: avatar.getBounds() });
    avatar.destroy();
  }
  avatar = null;
  broadcast();
}

function setClickThrough(on) {
  writeSettings({ mateClickThrough: !!on });
  applyInput();
  broadcast();
}

async function injectDrag(on) {
  if (!alive(avatar)) return;
  const wc = avatar.webContents;
  try {
    if (on && !dragCssKey) dragCssKey = await wc.insertCSS(DRAG_CSS);
    if (!on && dragCssKey) {
      const key = dragCssKey;
      dragCssKey = null;
      await wc.removeInsertedCSS(key);
    }
  } catch {
    dragCssKey = null;
  }
}

/** Move mode: the avatar takes the mouse and the whole page drags the window
 *  (injected -webkit-app-region), until Done. The page also gets a command
 *  so it can draw its own handle and use moveBy/moveEnd. */
function setMoveMode(on) {
  const next = !!on && alive(avatar) && avatar.isVisible();
  if (next === moveMode) return;
  moveMode = next;
  applyInput();
  void injectDrag(moveMode);
  if (moveMode) showBar();
  else if (alive(avatar)) {
    writeSettings({ mateBounds: avatar.getBounds() });
  }
  command(avatar, { type: "move-mode", on: moveMode });
  broadcast();
}

// Geny's move-by: never read getBounds() mid-drag (on fractional-DPI Windows
// screens the read-back grows the window every frame); keep our own rect.
function moveBy(dx, dy) {
  if (!alive(avatar) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  if (!moveRect) {
    const b = avatar.getBounds();
    moveRect = { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  moveRect.x += clamp(dx, -4000, 4000);
  moveRect.y += clamp(dy, -4000, 4000);
  avatar.setBounds({ x: Math.round(moveRect.x), y: Math.round(moveRect.y), width: moveRect.w, height: moveRect.h });
  placeBar();
  clearTimeout(moveIdle);
  moveIdle = setTimeout(moveEnd, 300); // fallback when moveEnd never comes
}

function moveEnd() {
  clearTimeout(moveIdle);
  moveIdle = null;
  if (!moveRect) return;
  moveRect = null;
  if (!alive(avatar)) return;
  const b = clampAvatar(avatar.getBounds());
  avatar.setBounds(b);
  writeSettings({ mateBounds: b });
  placeBar();
}

/** The size the user gave this mate's window with the resize handles (wins over the page's suggestion). */
function userSize(id = mateId()) {
  const s = id && S().mateSizes?.[id];
  return s && Number.isFinite(s.width) && Number.isFinite(s.height) ? s : null;
}

/** setBounds on a window the user cannot resize (macOS ignores the size otherwise) */
function setBoundsSized(win, b) {
  if (mac && !win.isResizable()) {
    win.setResizable(true);
    win.setBounds(b);
    win.setResizable(false);
  } else win.setBounds(b);
}

/** The page suggests a size for the avatar's shape; the bottom-right corner stays where it is.
 *  A size the user chose with the resize handles (per mate) wins. */
function setAvatarSize(w, h) {
  if (!alive(avatar) || moveRect || resizeRect || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
  const own = userSize();
  if (own) [w, h] = [own.width, own.height];
  const b = avatar.getBounds();
  const width = clamp(Math.round(w), AVATAR_MIN.width, 2400);
  const height = clamp(Math.round(h), AVATAR_MIN.height, 2400);
  const next = clampAvatar({ x: b.x + b.width - width, y: b.y + b.height - height, width, height });
  if (next.x === b.x && next.y === b.y && next.width === b.width && next.height === b.height) return;
  setBoundsSized(avatar, next);
  writeSettings({ mateBounds: next });
  placeBar();
}

// Geny's overlay:resize-by (edge = n/s/e/w or a corner, pointer deltas), with
// an authoritative rect like moveBy: never read getBounds() mid-drag. West /
// north edges move the origin; the size stays between AVATAR_MIN and the
// display's work area.
function resizeBy(edge, dx, dy) {
  if (!alive(avatar) || !Number.isFinite(dx) || !Number.isFinite(dy) || !/^[nsew]{1,2}$/.test(edge)) return;
  if (!resizeRect) {
    const b = avatar.getBounds();
    resizeRect = { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  const cur = resizeRect;
  const a = screen.getDisplayMatching({ x: Math.round(cur.x), y: Math.round(cur.y), width: Math.round(cur.w), height: Math.round(cur.h) }).workArea;
  const r = (resizeRect = geo.resizeRect(cur, edge, dx, dy, AVATAR_MIN, a));
  setBoundsSized(avatar, { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) });
  placeBar();
  clearTimeout(resizeIdle);
  resizeIdle = setTimeout(resizeEnd, 400); // fallback when resizeEnd never comes
}

function resizeEnd() {
  clearTimeout(resizeIdle);
  resizeIdle = null;
  if (!resizeRect) return;
  resizeRect = null;
  if (!alive(avatar)) return;
  const b = clampAvatar(avatar.getBounds());
  setBoundsSized(avatar, b);
  const id = mateId();
  writeSettings({ mateBounds: b, ...(id ? { mateSizes: { ...(S().mateSizes || {}), [id]: { width: b.width, height: b.height } } } : {}) });
  placeBar();
  broadcast();
}

/** Tray → Reset: the avatar back in its corner at the page's size, its pan/zoom and the quick card's place
 *  forgotten — the way out of "I cannot find it / it is huge". */
function resetPlacement() {
  const id = mateId();
  const sizes = { ...(S().mateSizes || {}) };
  if (id) delete sizes[id];
  writeSettings({ mateSizes: sizes, mateQuickPos: undefined });
  if (alive(avatar)) {
    const cur = avatar.getBounds();
    const b = clampAvatar(defaultAvatarBounds({ width: cur.width, height: cur.height }));
    setBoundsSized(avatar, b);
    writeSettings({ mateBounds: b });
    command(avatar, { type: "reset-view" }); // the page forgets its pan/zoom and suggests its size again
    placeBar();
  } else writeSettings({ mateBounds: undefined });
  broadcast();
}

// ── the hover action bar (desktop/src/bar.html) ────────────────

function createBar() {
  bar = new BrowserWindow({
    width: BAR.w,
    height: BAR.h,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: PRODUCT,
    webPreferences: webPrefs("bar"),
  });
  floating(bar);
  if (!linux) bar.setIgnoreMouseEvents(true, { forward: true });
  bar.webContents.on("will-navigate", (e) => e.preventDefault());
  bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  bar.webContents.on("did-finish-load", barState);
  bar.on("closed", () => {
    bar = null;
  });
  bar.loadFile(path.join(__dirname, "bar.html"));
}

function placeBar() {
  if (!alive(bar) || !alive(avatar)) return;
  const b = avatar.getBounds();
  const a = screen.getDisplayMatching(b).workArea;
  const x = clamp(Math.round(b.x + (b.width - BAR.w) / 2), a.x, a.x + a.width - BAR.w);
  const y = clamp(b.y + b.height - BAR.h - 4, a.y, a.y + a.height - BAR.h);
  bar.setBounds({ x, y, width: BAR.w, height: BAR.h }, false);
}

function showBar() {
  if (!alive(bar)) createBar();
  placeBar();
  if (!bar.isVisible()) bar.showInactive();
  raiseBar();
}

function raiseBar() {
  if (alive(bar) && bar.isVisible()) bar.moveTop();
}

function barState() {
  if (!alive(bar)) return;
  bar.webContents.send("bar:state", {
    screenSharing, screenBusy,screenStatus,
    voiceReady: !!replySpeech,
    voiceEnabled: !!replySpeech?.enabled,
    voiceAvailable: !!replySpeech?.available,
    voiceBusy: !!replySpeech?.busy,
    clickThrough: clickThrough(),
    moveMode,
    chatOpen: alive(chat) && chat.isVisible(),
    quickKey: hotkeyBound ? prettyAccel(hotkeyBound) : "",
    linux,
    lang: language(),
    // the buttons' labels in the app's language (bar.js falls back to English)
    labels: {
      voiceOn: t("page.barVoiceOn"),
      voiceOff: t("page.barVoiceOff"),
      voiceUnavailable: t("page.barVoiceUnavailable"),
      voiceLoading: t("page.barVoiceLoading"),
      screen: t("page.barScreen"),
      chat: t("page.barChat"),
      quick: t("page.barQuick"),
      quickKey: t("page.barQuickKey"),
      throughOn: t("page.barThroughOn"),
      throughOff: t("page.barThroughOff"),
      move: t("page.barMove"),
      doneMoving: t("page.barDoneMoving"),
      hide: t("page.barHide"),
      console: t("page.barConsole"),
    },
  });
}

function barAct(name) {
  if (name === "voice") {
    if (!replySpeech || replySpeech.busy || !replySpeech.available) return;
    const on = !replySpeech.enabled;
    replySpeech = { ...replySpeech, busy: true };
    barState();
    command(avatar, { type: "reply-speech", mateId: replySpeech.mateId, on });
  }
  else if (name === "screen") deps.toggleScreenSharing?.();
  else if (name === "chat") toggleChat();
  else if (name === "quick") toggleQuick();
  else if (name === "through") setClickThrough(!clickThrough());
  else if (name === "move") setMoveMode(!moveMode);
  else if (name === "hide") hideAvatar();
  else if (name === "console") deps.openConsole();
}

// cursor polling (ailism): show the bar while the pointer is on the avatar or
// the bar, hide it 450 ms after it leaves
function tick() {
  if(quitting)return;
  if (!alive(avatar) || !avatar.isVisible()) {
    if (alive(bar) && bar.isVisible()) bar.hide();
    return;
  }
  const p = screen.getCursorScreenPoint();
  const inside = (r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
  const bb = alive(bar) && bar.isVisible() ? bar.getBounds() : null;
  const onBar = bb && inside({ x: bb.x, y: bb.y + bb.height - BAR.strip, width: bb.width, height: BAR.strip });
  if (moveMode || onBar || inside(avatar.getBounds())) {
    barSeenAt = Date.now();
    if (!alive(bar) || !bar.isVisible()) showBar();
  } else if (alive(bar) && bar.isVisible() && Date.now() - barSeenAt > 450) bar.hide();
}

// ── the quick chat card ────────────────────────────────────────

function createQuick() {
  if(quitting)return;
  quick = new BrowserWindow({
    width: QUICK.w,
    height: QUICK.h,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: t("titleQuick"),
    icon: ICON,
    webPreferences: webPrefs("mate-quick", { spellcheck: true }),
  });
  const win = quick;
  floating(win);
  guard(win, "quick");
  // a launcher, not a window to clean up after: gone when focus leaves — unless
  // the user has started writing (a draft or files): then it stays, with an ✕
  // on the card, until ✕ / Esc / sending
  win.on("blur", () => Date.now() - quickShownAt > 400 && !quickPinned && hideQuick());
  // where the user drags it is where it opens next time (the card's drag area:
  // -webkit-app-region on the page). 'move' streams on every platform; our own
  // placement and growth are not a user's choice.
  win.on("move", () => {
    if (Date.now() - quickProgAt < 250) return;
    clearTimeout(quickSaveTimer);
    quickSaveTimer = setTimeout(() => {
      if (!alive(win) || !win.isVisible()) return;
      const b = win.getBounds();
      writeSettings({ mateQuickPos: { x: b.x, y: b.y } });
    }, 300);
  });
  win.webContents.on("did-start-loading", () => {
    quickPinned = false;
  });
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    hideQuick();
  });
  win.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "Escape") hideQuick();
  });
  recovery.attach(win, { kind: "quick", isAppUrl: (u) => onSurfaceUrl(u, "quick"), retryPage: RETRY_PAGE, server: serverUrl });
  win.on("closed", () => {
    if (quick === win) quick = null;
  });
  loadSurface(win, "quick");
}

/** Where the quick card opens: the place the user last dragged it to, kept on a
 *  display that still exists (and inside it); else centred near the top of the
 *  display under the pointer (Geny's positionQuickChat). */
function quickPlacement(h) {
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const under = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return geo.quickPlacement(S().mateQuickPos, QUICK.w, h, areas, under);
}

function placeQuick() {
  quickProgAt = Date.now();
  quick.setBounds(quickPlacement(quick.getBounds().height));
}

function openQuick() {
  if(quitting)return;
  if (!connected()) return deps.openConsole();
  if (!alive(quick)) createQuick();
  const win = quick;
  quickShownAt = Date.now();
  placeQuick();
  if (!win.webContents.isLoading() && !presentable(win, "quick")) loadSurface(win, "quick");
  const go = () => {
    if (!alive(win) || !presentable(win, "quick")) return;
    quickShownAt = Date.now();
    if (mac) app.focus({ steal: true });
    win.show();
    win.moveTop();
    win.focus();
    win.webContents.focus();
    command(win, { type: "quick-open" });
  };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", go);
  else go();
}

function hideQuick() {
  if (!alive(quick) || !quick.isVisible()) return;
  quick.hide();
  command(quick, { type: "quick-close" });
}

const toggleQuick = () => (alive(quick) && quick.isVisible() ? hideQuick() : openQuick());

function quickKey() {
  const t = Date.now();
  if (t - quickKeyAt < 300) return; // GNOME file + X11 grab may both fire
  quickKeyAt = t;
  toggleQuick();
}

/** From the quick card: its height. The width is fixed (pages up to 0.4 sent a
 *  width measured inside a page that had grown a scrollbar, so every new line
 *  made the window narrower); the top edge stays put — unless the card would
 *  run off the bottom of its display, then it moves up just enough. */
function setQuickSize(_w, h) {
  if (!alive(quick) || !Number.isFinite(h)) return;
  const b = quick.getBounds();
  const next = geo.quickGrow(b, h, QUICK.w, screen.getDisplayMatching(b).workArea, QUICK.minH, QUICK.maxH);
  if (Math.abs(next.height - b.height) < 2 && b.width === QUICK.w && next.y === b.y) return;
  quickProgAt = Date.now();
  quick.setBounds(next, false);
}

function setQuickPinned(on) {
  quickPinned = !!on;
}

// ── the mate chat window ───────────────────────────────────────

function createChat() {
  const saved = S().mateChatBounds;
  const place = saved && onSomeDisplay(saved) ? saved : null;
  chat = new BrowserWindow({
    width: place?.width || CHAT.w,
    height: place?.height || CHAT.h,
    ...(place ? { x: place.x, y: place.y } : {}),
    minWidth: 320,
    minHeight: 380,
    show: false,
    backgroundColor: theme.backgroundFor(nativeTheme.shouldUseDarkColors), // (light / dark: theme.js)
    title: t("titleMate"),
    icon: ICON,
    autoHideMenuBar: true,
    // no system title bar: the page's header is the title bar (chrome.js)
    ...chrome.frameOptions("chat"),
    webPreferences: webPrefs("mate-chat", { spellcheck: true }),
  });
  const win = chat;
  chrome.register(win, "chat");
  if (!place) {
    // next to the avatar if it is out, else bottom-right
    const m = alive(avatar) ? avatar.getBounds() : null;
    const a = (m ? screen.getDisplayMatching(m) : screen.getPrimaryDisplay()).workArea;
    const x = m ? m.x - CHAT.w - 12 : a.x + a.width - CHAT.w - MARGIN;
    const y = m ? m.y + m.height - CHAT.h : a.y + a.height - CHAT.h - MARGIN;
    win.setBounds({ x: clamp(x, a.x, a.x + a.width - CHAT.w), y: clamp(y, a.y, a.y + a.height - CHAT.h), width: CHAT.w, height: CHAT.h });
  }
  if (S().mateChatOnTop) win.setAlwaysOnTop(true, "floating");
  guard(win, "chat");
  let saving = null;
  const remember = () => {
    clearTimeout(saving);
    saving = setTimeout(() => alive(win) && writeSettings({ mateChatBounds: win.getBounds() }), 400);
  };
  win.on("move", remember);
  win.on("resize", remember);
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    hideChat();
  });
  // never black: load failure / crash / hang / a page that drew nothing → the retry page (recovery.js)
  recovery.attach(win, { kind: "chat", isAppUrl: (u) => onSurfaceUrl(u, "chat"), retryPage: RETRY_PAGE, server: serverUrl, watchBlank: true });
  win.on("closed", () => {
    if (chat === win) chat = null;
  });
  win.webContents.once("did-finish-load", () => showChatNow());
  loadSurface(win, "chat");
}

function showChatNow() {
  if (!alive(chat) || !presentable(chat, "chat")) return;
  if (chat.isMinimized()) chat.restore();
  if (mac) app.focus({ steal: true });
  chat.show();
  chat.focus();
  broadcast();
}

function openChat() {
  if(quitting)return;
  if (!connected()) return deps.openConsole();
  if (!alive(chat)) return createChat();
  if (!chat.webContents.isLoading() && !presentable(chat, "chat")) loadSurface(chat, "chat");
  if (chat.webContents.isLoading()) chat.webContents.once("did-finish-load", showChatNow);
  else showChatNow();
}

function setCaptureSharing(on,busy,status) { screenSharing=!!on;screenBusy=!!busy;screenStatus=status||"off";barState(); }
function openScreenSharing() {
  screenPicker=true;
  openChat();
  if (!alive(chat)) return;
  const send = () => { if(alive(chat)) {command(chat,{type:"screen.open"});} };
  if(chat.webContents.isLoading())chat.webContents.once("did-finish-load",()=>setTimeout(send,400));
  else send();
}

function hideChat() {
  if (!alive(chat) || !chat.isVisible()) return;
  chat.hide();
  broadcast();
}

const toggleChat = () => (alive(chat) && chat.isVisible() && chat.isFocused() ? hideChat() : openChat());

function setChatOnTop(on) {
  writeSettings({ mateChatOnTop: !!on });
  if (alive(chat)) chat.setAlwaysOnTop(!!on, "floating");
  broadcast();
}

// ── mate / server switches ─────────────────────────────────────

function reloadSurfaces() {
  loadSurface(avatar, "overlay");
  loadSurface(quick, "quick");
  loadSurface(chat, "chat");
}

/** Signed out / switching servers: the Mate windows of the old server go
 *  (mateVisible stays, so the avatar returns once connected again). */
function disconnect() {
  replySpeech = null;
  setMoveMode(false);
  clearTimeout(failTimer);
  failDelay = 0;
  alive(bar) && bar.hide();
  if (alive(avatar)) {
    writeSettings({ mateBounds: avatar.getBounds() });
    avatar.destroy();
  }
  avatar = null;
  for (const w of [quick, chat]) if (alive(w)) w.destroy();
  quick = null;
  chat = null;
  broadcast();
}

function setMate(id) {
  const next = validId(id);
  if (!next) return false;
  if (next !== mateId()) {
    replySpeech = null;
    writeSettings({ mateId: next });
    reloadSurfaces();
  }
  broadcast();
  return true;
}

/** offline.html's Retry in a Mate window reloads that window's surface. */
function retry(sender) {
  for (const [w, kind] of [[avatar, "overlay"], [quick, "quick"], [chat, "chat"]]) {
    if (alive(w) && w.webContents === sender) {
      loadSurface(w, kind);
      return true;
    }
  }
  return false;
}

// ── the global shortcut (+ GNOME's own on a GNOME Wayland desktop) ─

// Running as X11 under XWayland, an X11 key grab only sees keys while an X11
// window has focus; on GNOME Wayland the shortcut is a GNOME custom
// keybinding that touches a file this app watches (ailism-desktop-mate).
const QUICK_FILE = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "my-mate-geny-quick") : "";
const GNOME_KEYS = "org.gnome.settings-daemon.plugins.media-keys";
const GNOME_KEY_PATH = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/my-mate-geny-quick/";
const gnomeWayland = linux && env.XDG_SESSION_TYPE === "wayland" && /^\/[\w./-]+$/.test(QUICK_FILE) &&
  String(env.XDG_CURRENT_DESKTOP || "").split(":").some((d) => d.toLowerCase() === "gnome");
let gnomeReady = false;

function prettyAccel(acc) {
  return String(acc)
    .replace(/CommandOrControl|CmdOrCtrl/g, mac ? "Cmd" : "Ctrl")
    .replace(/Control/g, "Ctrl")
    .replace(/Command/g, "Cmd");
}

function hostEnv() {
  // an AppImage's own library folders out of the programs it starts
  const out = { ...env };
  const dir = env.APPDIR;
  if (!dir) return out;
  for (const k of ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"]) {
    if (typeof out[k] !== "string") continue;
    const kept = out[k].split(":").filter((p) => p && !p.startsWith(dir));
    if (kept.length) out[k] = kept.join(":");
    else delete out[k];
  }
  return out;
}

const gsettings = (...args) => new Promise((resolve, reject) => {
  execFile("gsettings", args, { env: hostEnv(), timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
});
const gvString = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const gvStrings = (text) => [...String(text).matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, "$1"));

function gnomeBinding(acc) {
  if (!acc) return "";
  const mods = { commandorcontrol: "<Control>", cmdorctrl: "<Control>", control: "<Control>", ctrl: "<Control>",
                 shift: "<Shift>", alt: "<Alt>", option: "<Alt>", altgr: "<Alt>", super: "<Super>", meta: "<Super>",
                 command: "<Super>", cmd: "<Super>" };
  const keys = { "/": "slash", space: "space", plus: "plus", "-": "minus", "=": "equal", ",": "comma", ".": "period",
                 ";": "semicolon", "'": "apostrophe", "`": "grave", "[": "bracketleft", "]": "bracketright", "\\": "backslash",
                 enter: "Return", return: "Return", tab: "Tab", esc: "Escape", escape: "Escape" };
  const parts = String(acc).split("+").filter(Boolean);
  const key = parts.pop() || "";
  const k = key.toLowerCase();
  const name = keys[k] || (/^f\d{1,2}$/.test(k) ? key.toUpperCase() : k);
  return parts.map((p) => mods[p.toLowerCase()] || "").join("") + name;
}

function watchQuickFile() {
  try {
    fs.closeSync(fs.openSync(QUICK_FILE, "a"));
    const name = path.basename(QUICK_FILE);
    fs.watch(path.dirname(QUICK_FILE), (_type, file) => {
      if (file === name && fs.existsSync(QUICK_FILE)) quickKey();
    }).on("error", () => {});
    return true;
  } catch {
    return false;
  }
}

async function gnomeShortcut(acc, force) {
  const command = `touch ${QUICK_FILE}`;
  const entry = `${GNOME_KEYS}.custom-keybinding:${GNOME_KEY_PATH}`;
  try {
    const list = gvStrings(await gsettings("get", GNOME_KEYS, "custom-keybindings"));
    const listed = list.includes(GNOME_KEY_PATH);
    if (!listed) await gsettings("set", entry, "name", gvString(`${PRODUCT} quick chat`));
    if (!listed || force) await gsettings("set", entry, "binding", gvString(gnomeBinding(acc)));
    if (!listed || (await gsettings("get", entry, "command")) !== gvString(command)) {
      await gsettings("set", entry, "command", gvString(command));
    }
    if (!listed) await gsettings("set", GNOME_KEYS, "custom-keybindings", `[${[...list, GNOME_KEY_PATH].map(gvString).join(", ")}]`);
    return true;
  } catch (e) {
    console.warn(`[mate] GNOME shortcut: ${e.message}`);
    return false;
  }
}

function registerHotkey(acc) {
  if (hotkeyBound) {
    try {
      globalShortcut.unregister(hotkeyBound);
    } catch {
      /* not held */
    }
  }
  hotkeyBound = "";
  if (!acc) return true;
  try {
    if (globalShortcut.register(acc, quickKey)) hotkeyBound = acc;
  } catch {
    /* not an accelerator Electron can parse */
  }
  return !!hotkeyBound;
}

/** Bind the quick-chat shortcut; false (old one kept) when the OS refuses it,
 *  which almost always means another program holds it. "" disables it. */
async function setHotkey(acc) {
  const next = String(acc ?? "").trim();
  if (next && !/^[\w+\-=,./;'`[\]\\]{1,60}$/.test(next)) return false;
  const old = hotkey();
  if (gnomeWayland && gnomeReady) {
    if (!(await gnomeShortcut(next, true))) return false;
    hotkeyBound = next;
  } else if (!registerHotkey(next)) {
    registerHotkey(old);
    broadcast();
    return false;
  }
  writeSettings({ mateHotkey: next });
  broadcast();
  return true;
}

// ── start at login ─────────────────────────────────────────────

const AUTOSTART_FILE = path.join(os.homedir(), ".config", "autostart", "my-mate-geny.desktop");
const desktopQuote = (s) => (/[\s"'\\$`]/.test(s) ? `"${s.replace(/(["`$\\])/g, "\\$1")}"` : s);

function autostartOn() {
  if (linux) return fs.existsSync(AUTOSTART_FILE);
  try {
    return app.getLoginItemSettings(win32 ? { args: ["--hidden"] } : undefined).openAtLogin;
  } catch {
    return false;
  }
}

function setAutostart(on) {
  try {
    if (linux) {
      if (!on) fs.rmSync(AUTOSTART_FILE, { force: true });
      else {
        const exec = launchCommand(env, process.execPath);
        const appArg = process.defaultApp && process.argv[1] ? ` ${desktopQuote(path.resolve(process.argv[1]))}` : "";
        fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
        fs.writeFileSync(AUTOSTART_FILE, [
          "[Desktop Entry]", "Type=Application", `Name=${PRODUCT}`, "Comment=Your Mate on the desktop",
          `Exec=${desktopQuote(exec)}${appArg} --ozone-platform=x11 --hidden`, "Terminal=false",
          "X-GNOME-Autostart-enabled=true", "",
        ].join("\n"));
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: !!on, args: ["--hidden"] });
    }
    writeSettings({ mateAutostart: !!on });
  } catch (e) {
    console.warn(`[mate] autostart: ${e.message}`);
  }
  broadcast();
}

/** Linux: a start-at-login entry naming a launcher that is gone (the .deb's old hr-harnessor-desktop, an AppImage
 *  replaced by an update under a new file name) or this one by another path is rewritten to this app (src/rename.js) */
function refreshAutostart() {
  if (!linux) return;
  let text;
  try {
    text = fs.readFileSync(AUTOSTART_FILE, "utf8");
  } catch {
    return; // no entry: start at login is off
  }
  if (autostartStale(text, launchCommand(env, process.execPath))) setAutostart(true);
}

// ── tray ───────────────────────────────────────────────────────

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: ICON }).show();
}

function buildTray() {
  if(quitting)return;
  if (!tray) {
    try {
      let img = nativeImage.createFromPath(ICON);
      if (!img.isEmpty()) img = img.resize({ width: mac ? 18 : win32 ? 16 : 22, quality: "best" });
      tray = new Tray(img);
      tray.setToolTip(PRODUCT);
      if (!mac) tray.on("click", () => deps.openConsole());
    } catch (e) {
      console.warn(`[mate] no tray: ${e.message}`);
      return;
    }
  }
  const acc = hotkey();
  const key = hotkeyBound ? prettyAccel(hotkeyBound) : acc ? t("trayKeyUnavailable", { key: prettyAccel(acc) }) : "";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t("trayOpen"), click: () => deps.openConsole() },
    wanted() ? { label: t("trayHideMate"), click: hideAvatar } : { label: t("trayShowMate"), click: () => showAvatar() },
    { label: key ? t("trayQuickKey", { key }) : t("trayQuick"), click: openQuick },
    { label: t("trayMateChat"), click: openChat },
    { type: "separator" },
    { label: t("trayClickThrough"), type: "checkbox", checked: clickThrough(), click: (i) => setClickThrough(i.checked) },
    { label: t("trayMove"), type: "checkbox", checked: moveMode, enabled: shown(), click: (i) => setMoveMode(i.checked) },
    { label: t("trayReset"), click: resetPlacement },
    { label: t("trayChatOnTop"), type: "checkbox", checked: !!S().mateChatOnTop, click: (i) => setChatOnTop(i.checked) },
    { label: t("trayAutostart"), type: "checkbox", checked: autostartOn(), click: (i) => setAutostart(i.checked) },
    { type: "separator" },
    { label: t("traySwitch"), click: () => deps.switchServer() },
    { label: t("traySignOut"), enabled: connected(), click: () => deps.signOut() },
    { label: t("trayQuit"), click: () => deps.quit() },
  ]));
}

// ── screen capture (capture.js): out of the picture, and a visible sign that it happened ──

/** the media source ids of our see-through windows (not offered as something to share) */
function ownSourceIds() {
  return [avatar, bar, quick].filter(alive).map((w) => {
    try {
      return w.getMediaSourceId();
    } catch {
      return "";
    }
  }).filter(Boolean);
}

const captureNotifier = require("./capture-notification").createCaptureNotifier({
  windows: () => [chat,deps.consoleWindow(),avatar,quick],
  focused: () => {const w=BrowserWindow.getFocusedWindow();return w===quick ? null : w;},
  send: (w,cmd) => command(w,cmd),
});
/** One lightweight toast in one visible app window, never a tray/title suffix or a broadcast. */
function captureIndicator(state, info = {}) {
  screenBusy = state === "start";barState();
  if(state === "done")captureNotifier.done(info);
}

// ── the bridge (IPC with sender checks) ────────────────────────

function frameUrl(e) {
  try {
    const f = e.senderFrame;
    if (!f || f.parent) return ""; // top-level frames only, never an iframe
    return f.url || "";
  } catch {
    return "";
  }
}

/** A console page (server origin) in one of our windows. */
function fromWeb(e, only) {
  const wins = only || [avatar, quick, chat, deps.consoleWindow()];
  return wins.some((w) => alive(w) && e.sender === w.webContents) && sameOrigin(frameUrl(e));
}

const fromBar = (e) => alive(bar) && e.sender === bar.webContents && frameUrl(e).startsWith("file:");

function registerIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => (fromWeb(e) ? fn(e, ...a) : undefined));
  handle("mate:show", (_e, id) => showAvatar(id));
  handle("mate:hide", () => hideAvatar());
  handle("mate:clickThrough", (_e, on) => setClickThrough(!!on));
  handle("mate:state", () => getState());
  handle("mate:moveMode", (_e, on) => setMoveMode(!!on));
  handle("mate:openQuick", () => openQuick());
  handle("mate:closeQuick", () => hideQuick());
  handle("mate:openChat", () => openChat());
  handle("mate:screenHandled", () => {screenPicker=false;});
  handle("mate:closeChat", () => hideChat());
  handle("mate:chatOnTop", (_e, on) => setChatOnTop(!!on));
  handle("mate:openConsole", (_e, url) => deps.openConsole(typeof url === "string" && sameOrigin(url) ? url : undefined));
  handle("mate:setMate", (_e, id) => setMate(id));
  handle("mate:setHotkey", (_e, acc) => setHotkey(acc));
  handle("mate:setAutostart", (_e, on) => setAutostart(!!on));
  ipcMain.on("mate:moveBy", (e, dx, dy) => fromWeb(e, [avatar]) && moveBy(Number(dx), Number(dy)));
  ipcMain.on("mate:moveEnd", (e) => fromWeb(e, [avatar]) && moveEnd());
  ipcMain.on("mate:resizeBy", (e, edge, dx, dy) => fromWeb(e, [avatar]) && resizeBy(String(edge), Number(dx), Number(dy)));
  ipcMain.on("mate:resizeEnd", (e) => fromWeb(e, [avatar]) && resizeEnd());
  ipcMain.on("mate:quickPinned", (e, on) => fromWeb(e, [quick]) && setQuickPinned(!!on));
  ipcMain.on("mate:size", (e, w, h) => {
    if (fromWeb(e, [avatar])) setAvatarSize(Number(w), Number(h));
    else if (fromWeb(e, [quick])) setQuickSize(Number(w), Number(h));
  });
  // Only the selected overlay may drive the local voice button; never a stale
  // console/chat, cross-origin frame or old mate after switching avatars.
  ipcMain.on("mate:voiceState", (e, state) => {
    if (!fromWeb(e, [avatar])) return;
    if (state && (!validId(state.mateId) || (mateId() && state.mateId !== mateId()))) return;
    if (state && !mateId()) writeSettings({ mateId: state.mateId });
    replySpeech = state ? { mateId: state.mateId, enabled: state.enabled === true,
      available: state.available === true, busy: state.busy === true } : null;
    barState();
  });
  ipcMain.on("bar:act", (e, name) => fromBar(e) && barAct(String(name)));
  ipcMain.on("bar:over", (e, on) => {
    if (!fromBar(e) || linux) return;
    if (on) bar.setIgnoreMouseEvents(false);
    else bar.setIgnoreMouseEvents(true, { forward: true });
  });
}

// ── lifecycle ──────────────────────────────────────────────────

function init(d) {
  deps = { ...deps, ...d };
  registerIpc();
}

function start() {
  refreshAutostart();
  buildTray();
  const acc = hotkey();
  if (gnomeWayland && watchQuickFile()) {
    gnomeReady = true;
    gnomeShortcut(acc, false).then((ok) => {
      hotkeyBound = ok ? acc : "";
      broadcast();
    });
  } else if (acc && !registerHotkey(acc)) {
    notify(t("hotkeyTitle"), t("hotkeyBody", { key: prettyAccel(acc) }));
  }
  if (S().mateVisible && connected()) createAvatar();
  tickTimer=setInterval(tick, 120);
  const reclamp = () => {
    if (!alive(avatar) || moveRect) return;
    avatar.setBounds(clampAvatar(avatar.getBounds()));
    placeBar();
  };
  screen.on("display-removed", reclamp);
  screen.on("display-metrics-changed", reclamp);
  buildTray();
}

function setQuitting(on) {
  quitting = !!on;
}

function stop() {
  clearInterval(tickTimer);tickTimer=null;
  for(const timer of [failTimer,moveIdle,resizeIdle,quickSaveTimer,saveTimer])clearTimeout(timer);
  globalShortcut.unregisterAll();
  if(tray){tray.destroy();tray=null;}
}

module.exports = {
  init,
  start,
  stop,
  setQuitting,
  retry,
  consoleNavigated,
  reloadSurfaces,
  disconnect,
  // the server or the language changed: the tray's items, the bar's labels and the windows' titles follow
  refresh: () => {
    buildTray();
    barState();
    if (alive(avatar)) avatar.setTitle(t("titleMate"));
    if (alive(quick)) quick.setTitle(t("titleQuick"));
  },
  isShown: () => wanted() && alive(avatar) && (avatar.isVisible() || avatar.webContents.isLoading() || (!overlayFailed && onSurface(avatar, "overlay"))),
  mateWindows: () => [avatar, bar, quick, chat].filter(alive),
  // the see-through ones (they keep a transparent background whatever the theme)
  transparentWindows: () => [avatar, bar, quick].filter(alive),
  showAvatar,
  hideAvatar,
  toggleAvatar: () => (wanted() ? hideAvatar() : showAvatar()),
  openQuick,
  toggleQuick,
  openChat,
  setClickThrough,
  setMoveMode,
  resetPlacement,
  clickThrough,
  isMoveMode: () => moveMode,
  broadcast,
  setCaptureSharing,
  openScreenSharing,
  ownSourceIds,
  captureIndicator,
};
