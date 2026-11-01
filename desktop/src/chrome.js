// App-like window chrome (docs/mate.md §7): the console and the mate chat window have no system title bar; the
// page draws its own (drag area, minimize / maximize-restore / close, the chat's pin) through
// `window.hrhNative.window` (preload.js). macOS keeps its traffic lights (titleBarStyle "hidden"), Windows and Linux
// get a frameless window — still resizable from its edges (Windows: a thick frame; Linux: Electron's resize border),
// Windows 11 rounds its corners and gives it the system shadow. Not transparent: transparency breaks resizing on
// Windows.
//
// A page that does not draw a title bar (an older web console, the login page, the local connect / retry pages)
// gets a small one from the preload until the page claims the chrome (<html data-hrh-chrome>).
//
// HRH_NATIVE_FRAME=1 (or settings.json "nativeFrame": true) keeps the system title bar.
"use strict";

const { BrowserWindow, ipcMain } = require("electron");
const { readSettings, sameOrigin } = require("./settings");

const mac = process.platform === "darwin";

/** heights of the page's title bars (the traffic lights are centred in them on macOS) */
const BAR_H = { console: 36, chat: 52 };

const wins = new Map(); // BrowserWindow → kind

function custom() {
  return process.env.HRH_NATIVE_FRAME !== "1" && readSettings().nativeFrame !== true;
}

/** BrowserWindow options for a window with our own title bar (none: the system frame). */
function frameOptions(kind) {
  if (!custom()) return {};
  if (mac) return { titleBarStyle: "hidden", trafficLightPosition: { x: 14, y: Math.round((BAR_H[kind] || 36) / 2 - 7) } };
  return { frame: false, thickFrame: true };
}

const state = (w) => ({
  maximized: w.isMaximized(),
  fullscreen: w.isFullScreen(),
  focused: w.isFocused(),
  minimized: w.isMinimized(),
});

function send(w) {
  if (!w.isDestroyed()) w.webContents.send("window:state", state(w));
}

/** This window draws its own title bar (call right after creating it with frameOptions). */
function register(win, kind) {
  if (!custom()) return;
  wins.set(win, kind);
  const push = () => send(win);
  for (const ev of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "focus", "blur", "restore", "minimize"]) win.on(ev, push);
  win.on("closed", () => wins.delete(win));
}

/** the sender: a top-level page (ours or the server's) in a registered window */
function senderWindow(e) {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || !wins.has(w)) return null;
  const f = e.senderFrame;
  if (!f || f.parent) return null;
  const url = f.url || "";
  return url.startsWith("file:") || sameOrigin(url) ? w : null;
}

function info(w) {
  if (!w) return null;
  return { chrome: mac ? "mac" : "custom", kind: wins.get(w), platform: process.platform, height: BAR_H[wins.get(w)] || 36, ...state(w) };
}

function registerIpc() {
  // (sync: the preload needs it before the page runs, to know whether to expose the bridge)
  ipcMain.on("window:info", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    e.returnValue = w && wins.has(w) ? info(w) : null;
  });
  ipcMain.handle("window:state", (e) => {
    const w = senderWindow(e);
    return w ? state(w) : null;
  });
  ipcMain.on("window:minimize", (e) => senderWindow(e)?.minimize());
  ipcMain.on("window:toggleMaximize", (e) => {
    const w = senderWindow(e);
    if (!w) return;
    if (w.isFullScreen()) w.setFullScreen(false);
    else if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.on("window:close", (e) => senderWindow(e)?.close());
}

module.exports = { frameOptions, register, registerIpc, custom, BAR_H };
