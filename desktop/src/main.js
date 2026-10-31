// My Mate Geny desktop: a native window around the live console, so design
// and features are identical to the web and UI updates need no reinstall,
// plus the Mate on the desktop (mate.js, docs/mate.md §7).
//
// Naming (docs/mate.md §0): the product is shown as "My Mate Geny", but the
// internal ids stay — appId `me.hrletsgo.harnessor` (Windows notifications,
// installer GUID, in-place updates) and the userData folder `hr-harnessor`
// (settings.json, the login cookie), pinned below because Electron would
// otherwise derive it from the new productName and log everyone out.
const { app, BrowserWindow, Menu, Notification, ipcMain, shell, dialog, clipboard, session, systemPreferences } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

app.setPath("userData", path.join(app.getPath("appData"), "hr-harnessor"));

const { readSettings, writeSettings, serverUrl, sameOrigin } = require("./settings");
const mate = require("./mate");

const PRODUCT = "My Mate Geny";
const mac = process.platform === "darwin";
const linux = process.platform === "linux";
const env = process.env;

// ── Linux: X11 (XWayland on a Wayland desktop) ─────────────────
// A Wayland client cannot place its own windows (setBounds, always-on-top and
// the Mate's move mode do nothing), so the app runs as X11. The .desktop
// entries pass --ozone-platform=x11; a start asking for Wayland is restarted
// once with it. HRH_OZONE_PLATFORM=wayland|auto keeps another backend.
function linuxSwitches() {
  app.commandLine.appendSwitch("enable-transparent-visuals");
  app.commandLine.appendSwitch("disable-gpu-watchdog"); // fall back instead of taking the renderer down
  app.commandLine.appendSwitch("enable-unsafe-swiftshader"); // WebGL (Live2D) needs a software path
  const chosen = String(env.HRH_OZONE_PLATFORM || "").trim().toLowerCase();
  if (chosen === "wayland" || chosen === "auto") return false;
  const flag = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1] || "";
  const given = flag("ozone-platform");
  const hint = flag("ozone-platform-hint") || String(env.ELECTRON_OZONE_PLATFORM_HINT || "");
  const again = env.HRH_RELAUNCHED === "1";
  delete env.HRH_RELAUNCHED;
  const wantsWayland = given ? given !== "x11" : /^(wayland|auto)$/i.test(hint);
  if (!given) {
    delete env.ELECTRON_OZONE_PLATFORM_HINT;
    app.commandLine.appendSwitch("ozone-platform", "x11");
  }
  return wantsWayland && !again && !!env.DISPLAY;
}

function relaunchOnX11() {
  const exe = env.APPIMAGE || process.execPath;
  const args = process.argv.slice(1).filter((a) => !/^--ozone-platform(-hint)?=/.test(a));
  const childEnv = { ...env, HRH_RELAUNCHED: "1" };
  for (const k of ["ELECTRON_OZONE_PLATFORM_HINT", "APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete childEnv[k];
  try {
    spawn(exe, [...args, "--ozone-platform=x11"], { detached: true, stdio: "ignore", env: childEnv }).unref();
    return true;
  } catch (e) {
    console.warn(`[desktop] could not restart on X11: ${e.message}`);
    return false;
  }
}

const restartOnX11 = linux ? linuxSwitches() : false;
// Repeated GPU-process crashes switch the next start to software rendering
// (slow beats a crash loop); HRH_DISABLE_GPU=1 does it by hand.
if (readSettings().softwareRendering || env.HRH_DISABLE_GPU === "1") app.disableHardwareAcceleration();

let win = null;
let quitting = false;
const hiddenStart = process.argv.includes("--hidden");

function quit() {
  quitting = true;
  mate.setQuitting(true);
  app.quit();
}

function createWindow(url) {
  const s = readSettings();
  const bounds = s.bounds || { width: 1360, height: 880 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 520,
    backgroundColor: "#0a0c10",
    title: PRODUCT,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    autoHideMenuBar: process.platform !== "darwin",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      additionalArguments: [`--hrh-version=${app.getVersion()}`, "--hrh-surface=console"],
    },
  });
  const w = win;
  if (s.maximized) w.maximize();
  w.once("ready-to-show", () => w.show());

  let saving = null;
  const save = () => {
    if (w.isDestroyed()) return;
    const max = w.isMaximized();
    writeSettings({ bounds: max ? readSettings().bounds : w.getBounds(), maximized: max });
  };
  const saveSoon = () => {
    clearTimeout(saving);
    saving = setTimeout(save, 400);
  };
  w.on("resize", saveSoon);
  w.on("move", saveSoon);
  w.on("close", (e) => {
    save();
    // while the Mate is out the tray keeps the app: hide instead of closing
    // (turn-finished notifications keep coming). Quit closes for real.
    if (!quitting && mate.isShown()) {
      e.preventDefault();
      w.hide();
    }
  });
  w.on("closed", () => {
    if (win === w) win = null;
    if (!quitting && !mac && !mate.isShown()) quit();
  });

  const wc = w.webContents;
  // External links open in the user's browser; our own pages stay in-app.
  wc.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url) && !/[?&]download=1/.test(url)) {
      return { action: "allow", overrideBrowserWindowOptions: { backgroundColor: "#0a0c10", autoHideMenuBar: true } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (!sameOrigin(url) && !url.startsWith("file:")) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  // back on the app after signing in: Mate windows left on the login page reload
  wc.on("did-navigate", (_e, url) => mate.consoleNavigated(url));
  wc.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted (navigation replaced)
    w.loadFile(path.join(__dirname, "offline.html"), { query: { server: serverUrl(), error: desc || String(code) } });
  });
  wc.on("context-menu", (_e, p) => {
    const items = [];
    if (p.linkURL) items.push({ label: "Open link in browser", click: () => shell.openExternal(p.linkURL) },
      { label: "Copy link", click: () => clipboard.writeText(p.linkURL) }, { type: "separator" });
    if (p.mediaType === "image") items.push({ label: "Copy image", click: () => wc.copyImageAt(p.x, p.y) }, { type: "separator" });
    if (p.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    else if (p.selectionText) items.push({ role: "copy" });
    if (p.misspelledWord) {
      items.unshift(...p.dictionarySuggestions.slice(0, 4).map((x) => ({ label: x, click: () => wc.replaceMisspelling(x) })), { type: "separator" });
    }
    if (items.length) Menu.buildFromTemplate(items).popup();
  });

  w.loadURL(url || serverUrl());
  return w;
}

/** Show (or reopen) the console window, optionally at a same-origin URL. */
function openConsole(url) {
  if (!win || win.isDestroyed()) {
    createWindow(url);
    return;
  }
  if (url) win.loadURL(url);
  if (win.isMinimized()) win.restore();
  if (mac) app.focus({ steal: true });
  win.show();
  win.focus();
}

function changeServer() {
  const current = serverUrl();
  // Minimal prompt without extra deps: a tiny window with an input.
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
  const w = new BrowserWindow({
    width: 460, height: 210, resizable: false, parent, modal: !!parent, backgroundColor: "#0a0c10",
    title: `Server — ${PRODUCT}`, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true,
      additionalArguments: [`--hrh-version=${app.getVersion()}`, "--hrh-surface=server"],
    },
  });
  w.loadFile(path.join(__dirname, "server.html"), { query: { server: current } });
}

// Every hrh:* call comes from a top-level page in one of our windows.
const ours = (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const f = e.senderFrame;
  return !!w && !!f && !f.parent;
};
const fileOrServer = (e) => {
  const url = (e.senderFrame && e.senderFrame.url) || "";
  return url.startsWith("file:") || sameOrigin(url);
};

ipcMain.handle("hrh:notify", (e, { title, body } = {}) => {
  if (!ours(e) || !Notification.isSupported()) return false;
  const n = new Notification({ title: String(title || PRODUCT), body: String(body || ""), silent: false });
  n.on("click", () => openConsole());
  n.show();
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  return true;
});
ipcMain.handle("hrh:openExternal", (e, url) => {
  if (ours(e) && /^https?:/.test(String(url))) shell.openExternal(String(url));
});
ipcMain.handle("hrh:setServer", (e, url) => {
  if (!ours(e) || !fileOrServer(e)) return false;
  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) throw new Error("http(s) only");
    writeSettings({ serverUrl: u.origin });
    const keep = new Set([win, ...mate.mateWindows()]);
    BrowserWindow.getAllWindows().forEach((w) => !keep.has(w) && w.close());
    if (win && !win.isDestroyed()) win.loadURL(serverUrl());
    else openConsole();
    mate.reloadSurfaces();
    return true;
  } catch (err) {
    dialog.showErrorBox("Invalid server URL", String(err.message || err));
    return false;
  }
});
ipcMain.handle("hrh:retry", (e) => {
  if (!ours(e)) return;
  if (mate.retry(e.sender)) return;
  if (win && !win.isDestroyed()) win.loadURL(serverUrl());
});
ipcMain.handle("hrh:changeServer", (e) => ours(e) && changeServer());

// Microphone for push-to-talk (getUserMedia audio) on the server's pages, plus
// what the console already uses (clipboard writes, fullscreen video);
// everything else, and anything from another origin, is refused.
function setupPermissions() {
  const allowed = new Set(["media", "clipboard-sanitized-write", "clipboard-read", "fullscreen"]);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, done, details = {}) => {
    const url = details.requestingUrl || (wc && wc.getURL()) || "";
    if (!sameOrigin(url) || !allowed.has(permission)) return done(false);
    if (permission === "media") {
      const types = details.mediaTypes || [];
      if (types.some((t) => t !== "audio")) return done(false);
      if (mac && systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
        return systemPreferences.askForMediaAccess("microphone").then((ok) => done(!!ok), () => done(false));
      }
    }
    return done(true);
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    const url = origin || (wc && wc.getURL()) || "";
    return sameOrigin(url) && allowed.has(permission);
  });
}

// GPU process crash loop → software rendering from the next start.
let gpuCrashes = [];
app.on("child-process-gone", (_e, d) => {
  if (d.type !== "GPU" || d.reason === "clean-exit" || readSettings().softwareRendering) return;
  const t = Date.now();
  gpuCrashes = [...gpuCrashes.filter((x) => t - x < 120_000), t];
  if (gpuCrashes.length >= 3) {
    writeSettings({ softwareRendering: true });
    if (Notification.isSupported()) {
      new Notification({ title: PRODUCT, body: "The graphics process keeps crashing — software rendering will be used from the next start." }).show();
    }
  }
});

function buildMenu() {
  const template = [
    ...(mac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "togglefullscreen" }, { role: "toggleDevTools" },
      ],
    },
    {
      label: "Mate",
      submenu: [
        { label: "Show / Hide Mate", click: () => mate.toggleAvatar() },
        { label: "Quick chat", click: () => mate.toggleQuick() },
        { label: "Mate chat", click: () => mate.openChat() },
        { label: "Move Mate", click: () => mate.setMoveMode(!mate.isMoveMode()) },
        { label: "Toggle click-through", click: () => mate.setClickThrough(!mate.clickThrough()) },
      ],
    },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        { label: "Change server…", click: changeServer },
        { label: "Open in browser", click: () => shell.openExternal(serverUrl()) },
        { label: "Downloads page", click: () => openConsole(`${serverUrl()}/?view=downloads`) },
        { type: "separator" },
        { label: `${PRODUCT} ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One instance; a second launch opens the console.
if (restartOnX11 && relaunchOnX11()) {
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (argv.includes("--hidden")) return;
    openConsole();
  });
  app.setAppUserModelId("me.hrletsgo.harnessor"); // Windows notifications (unchanged id)
  app.whenReady().then(() => {
    setupPermissions();
    buildMenu();
    mate.init({ openConsole, consoleWindow: () => (win && !win.isDestroyed() ? win : null), changeServer, quit });
    const loginHidden = mac && (() => {
      try {
        return app.getLoginItemSettings().wasOpenedAtLogin;
      } catch {
        return false;
      }
    })();
    // first run and normal starts open the console as before; a start at
    // login (--hidden) goes straight to the tray (and the Mate, if it was out)
    const startedHidden = hiddenStart || loginHidden;
    if (!startedHidden) createWindow();
    mate.start();
    // macOS: a Dock click opens the console (but not the launch-time
    // activate of a start at login)
    const readyAt = Date.now();
    app.on("activate", () => {
      if (startedHidden && Date.now() - readyAt < 2000) return;
      openConsole();
    });
  });
  // the tray (and the Mate) keep the app; closing the console quits it when
  // the Mate is not out (see createWindow), Quit quits from anywhere
  app.on("window-all-closed", () => {
    if (!mac && !mate.isShown()) quit();
  });
  app.on("before-quit", () => {
    quitting = true;
    mate.setQuitting(true);
  });
  app.on("will-quit", () => mate.stop());
}
