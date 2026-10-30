// hr·harnessor desktop: a native window around the live console, so design
// and features are identical to the web and UI updates need no reinstall.
const { app, BrowserWindow, Menu, Notification, ipcMain, shell, dialog, nativeImage, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULT_SERVER = "https://agent.hrletsgo.me";
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}
const serverUrl = () => (readSettings().serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
const sameOrigin = (url) => {
  try {
    return new URL(url).origin === new URL(serverUrl()).origin;
  } catch {
    return false;
  }
};

let win = null;

function createWindow() {
  const s = readSettings();
  const bounds = s.bounds || { width: 1360, height: 880 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 520,
    backgroundColor: "#0a0c10",
    title: "hr·harnessor",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    autoHideMenuBar: process.platform !== "darwin",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      additionalArguments: [`--hrh-version=${app.getVersion()}`],
    },
  });
  if (s.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());

  const save = () => {
    if (!win || win.isDestroyed()) return;
    writeSettings({ bounds: win.isMaximized() ? s.bounds : win.getBounds(), maximized: win.isMaximized() });
  };
  win.on("resize", save);
  win.on("move", save);
  win.on("close", save);

  const wc = win.webContents;
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
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted (navigation replaced)
    win.loadFile(path.join(__dirname, "offline.html"), { query: { server: serverUrl(), error: desc || String(code) } });
  });
  wc.on("context-menu", (_e, p) => {
    const items = [];
    if (p.linkURL) items.push({ label: "Open link in browser", click: () => shell.openExternal(p.linkURL) },
      { label: "Copy link", click: () => clipboard.writeText(p.linkURL) }, { type: "separator" });
    if (p.mediaType === "image") items.push({ label: "Copy image", click: () => wc.copyImageAt(p.x, p.y) }, { type: "separator" });
    if (p.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    else if (p.selectionText) items.push({ role: "copy" });
    if (p.misspelledWord) {
      items.unshift(...p.dictionarySuggestions.slice(0, 4).map((w) => ({ label: w, click: () => wc.replaceMisspelling(w) })), { type: "separator" });
    }
    if (items.length) Menu.buildFromTemplate(items).popup();
  });

  win.loadURL(serverUrl());
}

function changeServer() {
  const current = serverUrl();
  // Minimal prompt without extra deps: a tiny window with an input.
  const w = new BrowserWindow({
    width: 460, height: 210, resizable: false, parent: win, modal: true, backgroundColor: "#0a0c10",
    title: "Server", autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true,
      additionalArguments: [`--hrh-version=${app.getVersion()}`],
    },
  });
  w.loadFile(path.join(__dirname, "server.html"), { query: { server: current } });
}

ipcMain.handle("hrh:notify", (_e, { title, body }) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: String(title || "hr·harnessor"), body: String(body || ""), silent: false });
  n.on("click", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  n.show();
  if (win && !win.isFocused()) win.flashFrame(true);
  return true;
});
ipcMain.handle("hrh:openExternal", (_e, url) => {
  if (/^https?:/.test(String(url))) shell.openExternal(String(url));
});
ipcMain.handle("hrh:setServer", (_e, url) => {
  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) throw new Error("http(s) only");
    writeSettings({ serverUrl: u.origin });
    BrowserWindow.getAllWindows().forEach((w) => w !== win && w.close());
    win.loadURL(serverUrl());
    return true;
  } catch (e) {
    dialog.showErrorBox("Invalid server URL", String(e.message || e));
    return false;
  }
});
ipcMain.handle("hrh:retry", () => win && win.loadURL(serverUrl()));
ipcMain.handle("hrh:changeServer", () => changeServer());

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "togglefullscreen" }, { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        { label: "Change server…", click: changeServer },
        { label: "Open in browser", click: () => shell.openExternal(serverUrl()) },
        { label: "Downloads page", click: () => win && win.loadURL(`${serverUrl()}/?view=downloads`) },
        { type: "separator" },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One window; a second launch focuses it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.setAppUserModelId("me.hrletsgo.harnessor"); // Windows notifications
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
  app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
}
