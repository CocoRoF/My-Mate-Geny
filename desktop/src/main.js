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
// Naming (docs/mate.md §0, README "Naming"): the product is shown as "My Mate
// Geny" and the Linux package / launcher is `my-mate-geny` (src/rename.js
// carries over start at login and a dock pin), but the internal ids stay —
// appId `me.hrletsgo.harnessor` (Windows notifications, installer GUID,
// in-place updates) and the userData folder `hr-harnessor` (settings.json,
// the login cookie, logs), pinned below because Electron would otherwise
// derive it from the productName and log everyone out.
const { app, BrowserWindow, Menu, Notification, ipcMain, shell, clipboard, session, systemPreferences, net, dialog, nativeTheme, desktopCapturer } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

app.setPath("userData", path.join(app.getPath("appData"), "hr-harnessor"));

// ── a failed start is visible: <userData>/logs/main.log, and a dialog instead of a silent exit ──
const startupLog = require("./startup-log");
const mainLog = startupLog.createLog(path.join(app.getPath("userData"), "logs", "main.log"));
const startup = startupLog.createFailureHandler({
  log: mainLog,
  isReady: () => app.isReady(),
  whenReady: () => app.whenReady(),
  showErrorBox: (title, body) => dialog.showErrorBox(title, body),
  exit: (code) => app.exit(code),
  print: (s) => console.error(s),
  text: (err, file) => {
    const vars = { error: startupLog.errorHeadline(err), log: file };
    try {
      const { t } = require("./lang");
      return [t("startFailedTitle"), t("startFailedBody", vars)];
    } catch {
      return ["My Mate Geny could not start", `${vars.error}\n\nDetails: ${vars.log}`];
    }
  },
});
process.on("uncaughtException", (e) => startup.fail(e, "uncaught exception"));
process.on("unhandledRejection", (e) => startup.fail(e, "unhandled rejection"));
mainLog.info(startupLog.startLine({ version: app.getVersion(), argv: process.argv, env: process.env, platform: process.platform }));

const { LEGACY_SERVER, readSettings, writeSettings, settingsExisted, serverUrl, sameOrigin } = require("./settings");
const core = require("./connect-core");
const mate = require("./mate");
const recovery = require("./recovery");
const chrome = require("./chrome");
const folders = require("./folders");
const { createUpdater, restartArgs, restartCommand } = require("./updater");
const { isLang } = require("./i18n");
const theme = require("./theme");
const { t, language, pageText } = require("./lang");
const { launchCommand } = require("./launch");
const rename = require("./rename");
const oauthCatch = require("./oauth-catch");
const capture = require("./capture");

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
  // a Wayland desktop: screen capture (capture.js) goes through the desktop portal (PipeWire) — the system's own
  // share dialog asks each time; X11 / XWayland's own capture would only see other X11 windows
  if (String(env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland") app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
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
  const exe = launchCommand(env, process.execPath);
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
    backgroundColor: theme.backgroundFor(nativeTheme.shouldUseDarkColors), // (light / dark: theme.js)
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
  // the mouse's back / forward buttons (Windows: app-commands): in-app back / forward (the page's lib/nav.ts)
  w.on("app-command", (_e, cmd) => {
    if (cmd === "browser-backward" || cmd === "browser-forward") wc.send("nav:command", cmd === "browser-forward" ? "forward" : "back");
  });
  // External links open in the user's browser; our own pages stay in-app.
  wc.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url) && !/[?&]download=1/.test(url)) {
      return { action: "allow", overrideBrowserWindowOptions: { backgroundColor: theme.backgroundFor(nativeTheme.shouldUseDarkColors), autoHideMenuBar: true } };
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
    if (p.linkURL) items.push({ label: t("ctxOpenLink"), click: () => shell.openExternal(p.linkURL) },
      { label: t("ctxCopyLink"), click: () => clipboard.writeText(p.linkURL) }, { type: "separator" });
    if (p.mediaType === "image") items.push({ label: t("ctxCopyImage"), click: () => wc.copyImageAt(p.x, p.y) }, { type: "separator" });
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

// ── the language (i18n.js): the console tells it; the menus, tray, bar and local pages follow ──
// (sync: the preload reads it while the page starts — the local pages and the fallback title bar need it at once)
ipcMain.on("hrh:i18n", (e) => {
  e.returnValue = { lang: language(), text: pageText() };
});
ipcMain.on("hrh:setLanguage", (e, lang) => {
  if (!ours(e) || !fileOrServer(e) || !isLang(lang) || readSettings().language === lang) return;
  writeSettings({ language: lang });
  refreshMenus();
  updater.refresh(); // its "can't update here" reason is in words
});

// ── light / dark (theme.js): the console tells its mode; native menus / dialogs, the windows' background and the
// local pages (prefers-color-scheme follows nativeTheme) follow ──
/** the windows that paint a background (not the Mate's see-through avatar, quick card and action bar) */
const opaqueWindows = () => {
  const clear = new Set(mate.transparentWindows ? mate.transparentWindows() : []);
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !clear.has(w));
};
ipcMain.on("hrh:setTheme", (e, mode) => {
  if (!ours(e) || !fileOrServer(e) || !theme.isThemeMode(mode)) return;
  if (readSettings().theme !== mode) writeSettings({ theme: mode });
  theme.applyTheme(nativeTheme, mode, opaqueWindows());
});
// the OS switched while the mode is "system": the windows' background follows
nativeTheme.on("updated", () => theme.applyTheme(nativeTheme, readSettings().theme, opaqueWindows()));

// ── in-app updates (updater.js): state here, every window follows it (the Download page shows it) ──
let notifiedUpdate = "";
const updater = createUpdater({
  autoUpdater: async () => require("electron-updater").autoUpdater,
  cancelToken: () => new (require("electron-updater").CancellationToken)(),
  version: app.getVersion(),
  platform: process.platform,
  isPackaged: app.isPackaged,
  env: process.env,
  server: () => serverUrl(),
  // (development runs only: tests point the feed elsewhere and give electron-updater a config file)
  feedUrl: () => (!app.isPackaged && env.HRH_UPDATE_FEED) || `${serverUrl()}/api/downloads/update`,
  reasonText: (code) => t(code),
  devConfigPath: () => {
    const f = path.join(app.getPath("userData"), "dev-app-update.yml");
    require("fs").writeFileSync(f, "provider: generic\nurl: https://updates.invalid/\nupdaterCacheDirName: my-mate-geny-updater-dev\n");
    return f;
  },
  cookieHeader: async () => {
    const base = serverUrl();
    if (!base) return "";
    const list = await session.defaultSession.cookies.get({ url: `${base}/` });
    return list.map((c) => `${c.name}=${c.value}`).join("; ");
  },
  beforeInstall: () => {
    quitting = true;
    mate.setQuitting(true);
  },
  installFailed: () => {
    quitting = false;
    mate.setQuitting(false);
  },
  // an AppImage's restart after the update: the new file with this app's arguments (`--no-sandbox` on Ubuntu 24.04+),
  // once this process — and its single-instance lock — is gone
  restartAfter: (file) => {
    const [cmd, args] = restartCommand(process.pid, file, restartArgs(process.argv));
    require("child_process").spawn(cmd, args, { detached: true, stdio: "ignore", env: process.env }).unref();
  },
  onState: (st) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("update:state", st);
    // a background check found one: say so once per version
    if (st.status === "available" && st.version && notifiedUpdate !== st.version && !(win && !win.isDestroyed() && win.isFocused())) {
      notifiedUpdate = st.version;
      if (Notification.isSupported()) {
        const n = new Notification({ title: t("updateTitle", { version: st.version }), body: t("updateBody") });
        n.on("click", () => serverUrl() && openConsole(`${serverUrl()}/?view=downloads`));
        n.show();
      }
    }
  },
});
const fromAppPage = (e) => ours(e) && fileOrServer(e);
ipcMain.handle("update:state", (e) => (fromAppPage(e) ? updater.state : null));
ipcMain.handle("update:check", (e) => (fromAppPage(e) ? updater.check() : null));
ipcMain.handle("update:download", (e) => (fromAppPage(e) ? updater.download() : null));
ipcMain.handle("update:cancel", (e) => (fromAppPage(e) ? updater.cancel() : null));
ipcMain.handle("update:install", (e) => (fromAppPage(e) ? updater.install() : null));
ipcMain.handle("update:retry", (e) => (fromAppPage(e) ? updater.retry() : null));

// Higgsfield's sign-in lands on http://localhost:8765/callback (its CLI's OAuth client): while the console's connect
// dialog waits, catch it here and hand the address to the page, which sends it to the server (oauth-catch.js)
let hfCatch = null;
ipcMain.handle("higgsfield:catch", async (e, o = {}) => {
  if (!fromAppPage(e)) return { error: "denied" };
  if (hfCatch) hfCatch.cancel();
  const mine = oauthCatch.catchRedirect({
    port: 8765,
    path: "/callback",
    timeoutMs: Math.min(Math.max(Number(o && o.timeoutMs) || 15 * 60 * 1000, 10 * 1000), 30 * 60 * 1000),
    page: (ok) => oauthCatch.callbackPage({ ok, title: t(ok ? "hfCaughtTitle" : "hfRefusedTitle"), body: t("hfCaughtBody") }),
  });
  hfCatch = mine;
  const result = await mine.done;
  if (hfCatch === mine) hfCatch = null;
  const w = BrowserWindow.fromWebContents(e.sender);
  if (result.url && w && !w.isDestroyed()) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
  return result;
});
ipcMain.handle("higgsfield:cancel", (e) => {
  if (fromAppPage(e) && hfCatch) hfCatch.cancel();
});

// a folder on this computer for a chat (folders.js): native dialog, same-machine probe, its files for a copy
folders.registerIpc({ ipcMain, dialog, BrowserWindow, app, allowed: (e) => fromAppPage(e) && sameOrigin((e.senderFrame && e.senderFrame.url) || ""), pickTitle: () => t("pickFolder") });

// Screen capture (capture.js, docs/mate.md §4 "Seeing the screen"): the mate's see_screen (asked through a page:
// prompt → capture → the page uploads it) and the user's Share screen. Only the server's own pages may call it.
const asker = capture.createAsker({
  BrowserWindow, screen: require("electron").screen, ipcMain, t,
  preload: path.join(__dirname, "preload.js"), file: path.join(__dirname, "capture-ask.html"), version: app.getVersion(),
});
const devicePreferences = require("./device-preferences").createDevicePreferences({
  readSettings, writeSettings,
  changed: (value,prev) => {
    if (prev && JSON.stringify(prev.screen.source) !== JSON.stringify(value.screen.source)) captureSharing.stop();
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("device:changed", value); },
});
const captures = capture.createCapture({
  desktopCapturer, screen: require("electron").screen, systemPreferences, readSettings, writeSettings, preferences: devicePreferences,
  hideWindows: async (source, hideConsole) => {
    const restoreMate = mate.hideForCapture(source && source.id);
    // A general capture also hides the console, unless it is the chosen target.
    // X11 without a compositor can otherwise return its occlusion instead of the selected window.
    let chosenConsole = false;
    try { chosenConsole = !!(source && win && !win.isDestroyed() && source.id === win.getMediaSourceId()); } catch {}
    const consoleWasVisible = hideConsole && win && !win.isDestroyed() && win.isVisible() && !chosenConsole;
    const focused = consoleWasVisible && win.isFocused();
    if (consoleWasVisible) win.hide();
    return () => {
      try { restoreMate(); } finally {
        if (consoleWasVisible && win && !win.isDestroyed()) {
          if (focused) win.show(); else win.showInactive();
        }
      }
    };
  },
  ownSourceIds: () => mate.ownSourceIds(),
  ask: (info) => asker.ask(info),
  cancelAsk: (id) => asker.cancel(id),
  indicate: (state, info) => {
    mate.captureIndicator(state, info);
    if (state === "done") mainLog.info(`screen shared with a mate (${(info.source && info.source.kind) || "screen"})`);
  },
});
const fromServerPage = (e) => ours(e) && sameOrigin((e.senderFrame && e.senderFrame.url) || "");
const captureSharing = require("./capture-sharing").createSharing({
  cancel: () => { captures.cancel("*"); for(const w of BrowserWindow.getAllWindows()) if(!w.isDestroyed())w.webContents.send("capture:control",{type:"cancel-captures"}); },
  broadcast: snapshot => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("capture:sharing", snapshot(w.webContents)); },
  changed: (active,busy) => mate.setCaptureSharing(active,busy),
});
ipcMain.handle("capture:sharing:get", e => fromServerPage(e) ? captureSharing.snapshot(e.sender) : null);
ipcMain.handle("capture:sharing:publish", (e,v) => fromServerPage(e) ? captureSharing.publish(e.sender,v) : null);
ipcMain.handle("capture:sharing:stop", e => {if(fromServerPage(e))captureSharing.stop();});
ipcMain.handle("capture:sharing:mode", (e,m,i) => {if(fromServerPage(e))captureSharing.mode(m,i);});
ipcMain.handle("device:get", e => fromServerPage(e) ? devicePreferences.get() : null);
ipcMain.handle("device:patch", (e,p) => fromServerPage(e) ? devicePreferences.patch(p || {}) : null);
ipcMain.handle("device:migrate", (e,p) => fromServerPage(e) ? devicePreferences.migrate(p || {}) : null);
ipcMain.handle("capture:info", (e) => (fromServerPage(e) ? captures.info() : null));
ipcMain.handle("capture:sources", (e, o = {}) => (fromServerPage(e) ? captures.sources({ thumbnails: !!(o && o.thumbnails), size: Number(o && o.size) || 320 }) : []));
ipcMain.handle("capture:getChoice", (e, mateId) => (fromServerPage(e) ? captures.getChoice(String(mateId || "")) : null));
ipcMain.handle("capture:setChoice", (e, mateId, src) => (fromServerPage(e) ? captures.setChoice(String(mateId || ""), src && typeof src === "object" ? src : null) : false));
ipcMain.handle("capture:grab", (e, o = {}) => (fromServerPage(e) ? captures.grab(o && typeof o === "object" ? o : {}) : { ok: false, code: "denied" }));
ipcMain.handle("capture:request", (e, req = {}) => (fromServerPage(e) ? captures.request(req && typeof req === "object" ? req : {}) : { ok: false, code: "denied" }));
ipcMain.handle("capture:cancel", (e, id) => {
  if (fromServerPage(e)) captures.cancel(String(id || ""));
});
// macOS: Screen Recording is granted in System Settings (the app cannot ask twice)
ipcMain.handle("capture:openPrivacy", (e) => {
  if (fromServerPage(e) && mac) shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
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
  if (d.reason !== "clean-exit") mainLog.warn(`${d.type} process gone: ${d.reason} (exit ${d.exitCode})`);
  if (d.type !== "GPU" || d.reason === "clean-exit" || readSettings().softwareRendering) return;
  const t = Date.now();
  gpuCrashes = [...gpuCrashes.filter((x) => t - x < 120_000), t];
  if (gpuCrashes.length >= 3) {
    writeSettings({ softwareRendering: true });
    if (Notification.isSupported()) {
      new Notification({ title: PRODUCT, body: t("gpuBody") }).show();
    }
  }
});

function buildMenu() {
  const template = [
    ...(mac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: t("menuView"),
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "togglefullscreen" }, { role: "toggleDevTools" },
      ],
    },
    {
      label: t("menuMate"),
      submenu: [
        { label: t("menuShowHide"), click: () => mate.toggleAvatar() },
        { label: t("menuQuick"), click: () => mate.toggleQuick() },
        { label: t("menuMateChat"), click: () => mate.openChat() },
        { label: t("menuMove"), click: () => mate.setMoveMode(!mate.isMoveMode()) },
        { label: t("menuClickThrough"), click: () => mate.setClickThrough(!mate.clickThrough()) },
      ],
    },
    { role: "windowMenu" },
    {
      label: t("menuServer"),
      submenu: [
        { label: t("menuSwitch"), click: () => showConnect() },
        { label: t("menuSignOut"), enabled: !!serverUrl(), click: () => signOut() },
        { type: "separator" },
        { label: serverUrl() ? t("menuConnectedTo", { server: serverUrl() }) : t("menuNotConnected"), enabled: false },
        { label: t("menuOpenBrowser"), enabled: !!serverUrl(), click: () => shell.openExternal(`${serverUrl()}/`) },
        { label: t("menuSettings"), enabled: !!serverUrl(), click: () => openConsole(`${serverUrl()}/?view=settings`) },
        { label: t("menuDownloads"), enabled: !!serverUrl(), click: () => openConsole(`${serverUrl()}/?view=downloads`) },
      ],
    },
    {
      label: t("menuHelp"),
      submenu: [
        { label: `${PRODUCT} ${app.getVersion()}`, enabled: false },
        { label: t("menuCheckUpdates"), enabled: !!serverUrl(), click: () => {
          openConsole(`${serverUrl()}/?view=downloads`);
          void updater.check();
        } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One instance; a second launch opens the console.
if (restartOnX11 && relaunchOnX11()) {
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  // another instance runs (perhaps only in the tray): it got "second-instance" and shows its console
  mainLog.info("another instance is running: handed over to it");
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    mainLog.info(`second launch${argv.includes("--hidden") ? " (hidden: ignored)" : ": showing the console"}`);
    if (argv.includes("--hidden")) return;
    openConsole();
  });
  app.setAppUserModelId("me.hrletsgo.harnessor"); // Windows notifications (unchanged id)
  app.whenReady().then(async () => {
    theme.applyTheme(nativeTheme, readSettings().theme); // before any window: its background and menus match
    await forgetIfAsked();
    await migrateLegacy();
    setupPermissions();
    buildMenu();
    mate.init({
  toggleScreenSharing: () => { if(captureSharing.active() || captures.busy()) captureSharing.stop(); else mate.openScreenSharing(); },
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
    if (env.HRH_TEST_START_FAIL === "1") throw new Error("HRH_TEST_START_FAIL: a start that fails on purpose");
    if (!startedHidden) createWindow();
    mate.start();
    startup.started();
    mainLog.info(`ready${startedHidden ? " (hidden start)" : ""}`);
    // the .deb's menu entry was hr-harnessor-desktop.desktop up to 0.4.19: a GNOME dock pin of it follows the rename
    if (linux && !env.APPIMAGE) {
      rename.migrateDockPin({
        execFile: require("child_process").execFile,
        desktopFileExists: () => require("fs").existsSync(`/usr/share/applications/${rename.DESKTOP_ID}`),
        done: () => !!readSettings().dockPinRenamed,
        markDone: () => writeSettings({ dockPinRenamed: true }),
        log: (m) => mainLog.info(m),
      });
    }
    // updates: a quiet look 30 s after the start and every 6 hours (downloading is the user's call)
    setTimeout(() => void updater.check(), 30_000).unref?.();
    setInterval(() => void updater.check(), 6 * 3600_000).unref?.();
    // macOS: a Dock click opens the console (but not the launch-time
    // activate of a start at login)
    const readyAt = Date.now();
    app.on("activate", () => {
      if (startedHidden && Date.now() - readyAt < 2000) return;
      openConsole();
    });
  }).catch((e) => startup.fail(e, "start"));
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
