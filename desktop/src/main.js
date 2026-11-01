// My Mate Geny desktop: a native window around the live console, so design
// and features are identical to the web and UI updates need no reinstall,
// plus the Mate on the desktop (mate.js, docs/mate.md §7).
//
// No built-in server: the first start (and Server → Switch server…) shows the
// local connect screen (connect.html; connect-core.js finds the server and
// signs in with exchange:true), then the window loads
// {server}/auth/exchange?code=… so the session cookie is set first-party.
// Later starts go straight to the saved server.
//
// Naming (docs/mate.md §0): the product is shown as "My Mate Geny", but the
// internal ids stay — appId `me.hrletsgo.harnessor` (Windows notifications,
// installer GUID, in-place updates) and the userData folder `hr-harnessor`
// (settings.json, the login cookie), pinned below because Electron would
// otherwise derive it from the new productName and log everyone out.
const { app, BrowserWindow, Menu, Notification, ipcMain, shell, clipboard, session, systemPreferences, net } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

app.setPath("userData", path.join(app.getPath("appData"), "hr-harnessor"));

const { LEGACY_SERVER, readSettings, writeSettings, settingsExisted, serverUrl, sameOrigin } = require("./settings");
const core = require("./connect-core");
const mate = require("./mate");
const recovery = require("./recovery");
const chrome = require("./chrome");

const RETRY_PAGE = path.join(__dirname, "offline.html");

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
    // no system title bar: the page draws an app-styled one (chrome.js; macOS keeps its traffic lights)
    ...chrome.frameOptions("console"),
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
  chrome.register(w, "console");
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
  wc.on("did-navigate", (_e, url) => {
    // just signed in (exchange → console): write the new cookie to disk now,
    // not at Chromium's next periodic flush, so a crash can't lose it
    if (flushCookies && sameOrigin(url)) {
      flushCookies = false;
      session.defaultSession.cookies.flushStore().catch(() => {});
    }
    mate.consoleNavigated(url);
  });
  // never a black window: a load failure, a crashed / hung renderer or a page that drew nothing → the local retry
  // page, which retries by itself with a growing delay (recovery.js)
  recovery.attach(w, { kind: "console", isAppUrl: sameOrigin, retryPage: RETRY_PAGE, server: serverUrl, watchBlank: true });
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

  if (url) w.loadURL(url);
  else if (serverUrl()) w.loadURL(`${serverUrl()}/`);
  else loadConnect(w);
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

// ── the server: connect screen, sign-in, switch, sign out ──────

const CONNECT_PAGE = path.join(__dirname, "connect.html");
const httpRequest = core.fetchRequest((url, init) => net.fetch(url, init));
const found = new Set(); // servers findServer confirmed during this run
let flushCookies = false;

function loadConnect(w, query = {}) {
  w.loadFile(CONNECT_PAGE, { query });
}

/** The connect screen in the console window (first start, Switch server…). */
function showConnect(query = {}) {
  if (!win || win.isDestroyed()) createWindow(null);
  loadConnect(win, query);
  if (win.isMinimized()) win.restore();
  if (mac) app.focus({ steal: true });
  win.show();
  win.focus();
}

async function clearServerCookies(base) {
  const ses = session.defaultSession;
  try {
    const origin = new URL(base).origin;
    const list = await ses.cookies.get({ url: `${origin}/` });
    await Promise.all(list.map((c) => ses.cookies.remove(`${origin}${c.path || "/"}`, c.name).catch(() => {})));
    await ses.clearStorageData({ origin, storages: ["cookies"] }).catch(() => {});
    await ses.cookies.flushStore().catch(() => {});
  } catch (e) {
    console.warn(`[desktop] could not clear cookies: ${e.message}`);
  }
}

/** Close everything but the console and the Mate (popups of the old server). */
function closeStrays() {
  const keep = new Set([win, ...mate.mateWindows()]);
  BrowserWindow.getAllWindows().forEach((w) => !keep.has(w) && w.close());
}

function refreshMenus() {
  buildMenu();
  mate.refresh();
}

/** Sign out: the server's cookies go, the connect screen comes back
 *  (prefilled with the server and username if they were remembered). */
async function signOut() {
  const base = serverUrl();
  if (base) {
    try {
      // the server's own logout (best effort; it only deletes the cookie today)
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      await session.defaultSession.fetch(`${base}/api/auth/logout`, { method: "POST", credentials: "include", signal: ctrl.signal }).catch(() => {});
      clearTimeout(t);
    } catch {}
    await clearServerCookies(base);
  }
  writeSettings({ serverUrl: undefined, forgetServer: undefined });
  mate.disconnect();
  closeStrays();
  refreshMenus();
  showConnect({ notice: "signed-out" });
}

/** Builds before 0.4 fell back to the owner's server when none was saved.
 *  Such an install that is still signed in there keeps going to it; one that
 *  isn't gets it prefilled on the connect screen (never used silently). */
async function migrateLegacy() {
  const s = readSettings();
  if (s.connectMigrated) return;
  if (s.serverUrl || !settingsExisted()) {
    writeSettings({ connectMigrated: true });
    return;
  }
  let signedIn = false;
  try {
    signedIn = (await session.defaultSession.cookies.get({ url: LEGACY_SERVER, name: "hrh_session" })).length > 0;
  } catch {}
  writeSettings(signedIn
    ? { serverUrl: LEGACY_SERVER, lastServer: LEGACY_SERVER, rememberConnect: true, connectMigrated: true }
    : { lastServer: s.lastServer || LEGACY_SERVER, connectMigrated: true });
}

/** A server connected without "Remember" is dropped (with its cookies) at the next start. */
async function forgetIfAsked() {
  if (!readSettings().forgetServer) return;
  const base = serverUrl();
  writeSettings({ serverUrl: undefined, forgetServer: undefined });
  if (base) await clearServerCookies(base);
}

// connect.html's calls: only from the local connect page in the console window
const fromConnect = (e) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return false;
  const f = e.senderFrame;
  if (!f || f.parent) return false;
  try {
    const u = new URL(f.url);
    return u.protocol === "file:" && u.pathname.endsWith("/connect.html");
  } catch {
    return false;
  }
};
const plain = (r) => JSON.parse(JSON.stringify(r));

ipcMain.handle("connect:state", (e) => {
  if (!fromConnect(e)) return null;
  const s = readSettings();
  return {
    server: serverUrl(),
    lastServer: core.cleanBase(s.lastServer),
    username: typeof s.username === "string" ? s.username : "",
    remember: s.rememberConnect !== false,
    version: app.getVersion(),
  };
});
ipcMain.handle("connect:find", async (e, input) => {
  if (!fromConnect(e)) return null;
  const r = await core.findServer(String(input ?? "").slice(0, 2048), httpRequest);
  if (r.ok) found.add(r.server);
  return plain(r);
});
ipcMain.handle("connect:signIn", async (e, o = {}) => {
  if (!fromConnect(e)) return null;
  let server = core.cleanBase(o.server);
  if (!server || !found.has(server)) {
    const r = await core.findServer(String(o.server ?? "").slice(0, 2048), httpRequest);
    if (!r.ok) return plain(r);
    server = r.server;
    found.add(server);
  }
  const r = await core.signIn(server, o.username, o.password, httpRequest);
  if (!r.ok || !win || win.isDestroyed()) return plain(r);
  const remember = o.remember !== false;
  writeSettings(remember
    ? { serverUrl: server, lastServer: server, username: String(o.username || "").trim(), rememberConnect: true, forgetServer: undefined }
    : { serverUrl: server, rememberConnect: false, forgetServer: true, username: undefined });
  closeStrays();
  // Mate windows of the old server go; they come back once the console has
  // landed on the app with the new cookie (mate.consoleNavigated)
  mate.disconnect();
  refreshMenus();
  flushCookies = true;
  win.loadURL(r.exchangeUrl);
  return { ok: true, server };
});
ipcMain.handle("connect:cancel", (e) => {
  if (!fromConnect(e) || !serverUrl()) return false;
  win.loadURL(`${serverUrl()}/`);
  return true;
});

chrome.registerIpc();

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
ipcMain.handle("hrh:retry", (e) => {
  if (!ours(e)) return;
  if (mate.retry(e.sender)) return;
  if (!win || win.isDestroyed()) return;
  if (serverUrl()) win.loadURL(`${serverUrl()}/`);
  else loadConnect(win);
});
// Switch server… / Sign out — from our local pages or the console itself
ipcMain.handle("hrh:switchServer", (e) => {
  if (ours(e) && fileOrServer(e)) showConnect();
});
ipcMain.handle("hrh:signOut", async (e) => {
  if (!ours(e) || !fileOrServer(e)) return false;
  await signOut();
  return true;
});

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
      label: "Server",
      submenu: [
        { label: "Switch server…", click: () => showConnect() },
        { label: "Sign out", enabled: !!serverUrl(), click: () => signOut() },
        { type: "separator" },
        { label: serverUrl() ? `Connected to ${serverUrl()}` : "Not connected", enabled: false },
        { label: "Open in browser", enabled: !!serverUrl(), click: () => shell.openExternal(`${serverUrl()}/`) },
        { label: "Downloads page", enabled: !!serverUrl(), click: () => openConsole(`${serverUrl()}/?view=downloads`) },
      ],
    },
    {
      label: "Help",
      submenu: [
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
  app.whenReady().then(async () => {
    await forgetIfAsked();
    await migrateLegacy();
    setupPermissions();
    buildMenu();
    mate.init({
      openConsole,
      consoleWindow: () => (win && !win.isDestroyed() ? win : null),
      switchServer: () => showConnect(),
      signOut: () => signOut(),
      quit,
    });
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
    // what the pages keep in localStorage (the avatar's pan / zoom, drafts, the chosen mate) is written lazily:
    // write it now, or a quit right after a change forgets it
    try {
      session.defaultSession.flushStorageData();
    } catch {
      /* gone */
    }
  });
  app.on("will-quit", () => mate.stop());
  // A desktop logout / shutdown (and `kill`) ends the app with SIGTERM: quit properly (windows saved, storage
  // flushed) instead of dying with unwritten state.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => quit());
  // (a logout signals every process of the app at once — the storage process too: never sit on much unwritten)
  setInterval(() => {
    try {
      session.defaultSession.flushStorageData();
    } catch {
      /* not ready / gone */
    }
  }, 15_000).unref();
}
