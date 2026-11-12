// The Mate's see-through windows (src/mate.js, src/theme.js) in a fake Electron: one avatar window on a Local
// execution start (the console's landing used to make a second one, which the next theme message painted gray /
// black), the theme never painting a transparent window, and the avatar shown only once its page is see-through.
// Run: node --test test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const vm = require("vm");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hrh-mate-"));
const SERVER = "http://127.0.0.1:47123";
fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({ serverUrl: SERVER, mateVisible: true, mateId: "m1", mateHotkey: "" }));
// (mate.js reads these when it loads: no real autostart entry or GNOME shortcut is touched)
process.env.HOME = tmp;
delete process.env.XDG_SESSION_TYPE;

const windows = [];
class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = "";
    this.loading = false;
    this.probe = () => Promise.resolve(true);
    this.probes = 0;
  }
  getURL() { return this.url; }
  isLoading() { return this.loading; }
  send() {}
  setWindowOpenHandler() {}
  insertCSS() { return Promise.resolve("k"); }
  removeInsertedCSS() { return Promise.resolve(); }
  executeJavaScript() { this.probes++; return this.probe(); }
  focus() {}
}
class FakeWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
    this.bg = opts.backgroundColor;
    this.bgSet = [];
    this.bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 100, height: opts.height || 100 };
    this.loads = [];
    windows.push(this);
  }
  static getAllWindows() { return windows.filter((w) => !w.destroyed); }
  static getFocusedWindow() { return null; }
  static fromWebContents(wc) { return windows.find((w) => w.webContents === wc) || null; }
  get surface() { return ((this.opts.webPreferences?.additionalArguments || []).find((a) => a.startsWith("--hrh-surface=")) || "").slice(14); }
  loadURL(url) { this.loads.push(url); this.webContents.url = url; return Promise.resolve(); }
  loadFile(file) { this.loads.push(file); this.webContents.url = `file://${file}`; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
  isVisible() { return this.visible; }
  showInactive() { this.visible = true; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  isMinimized() { return false; }
  getBounds() { return { ...this.bounds }; }
  setBounds(b) { this.bounds = { ...this.bounds, ...b }; }
  setBackgroundColor(c) { this.bg = c; this.bgSet.push(c); }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents() {}
  setTitle() {}
  moveTop() {}
  focus() {}
  isResizable() { return false; }
  setResizable() {}
  getMediaSourceId() { return `window:${windows.indexOf(this)}:0`; }
}
const area = { x: 0, y: 0, width: 1920, height: 1040 };
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: area, scaleFactor: 1 };
const nativeTheme = { themeSource: "system", shouldUseDarkColors: false };
const electron = {
  app: { getPath: () => tmp, getVersion: () => "0.0.0-test", getLocale: () => "en", getLoginItemSettings: () => ({ openAtLogin: false }), focus() {}, quit() {} },
  BrowserWindow: FakeWindow,
  Menu: { buildFromTemplate: (t) => t },
  Notification: { isSupported: () => false },
  Tray: class { setToolTip() {} on() {} setContextMenu() {} destroy() {} },
  globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
  ipcMain: { handle() {}, on() {}, removeHandler() {} },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  nativeTheme,
  screen: Object.assign(new EventEmitter(), {
    getAllDisplays: () => [display], getPrimaryDisplay: () => display, getDisplayMatching: () => display,
    getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: -1, y: -1 }),
  }),
  shell: { openExternal() {} },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "electron" ? electron : load.call(this, request, ...rest);
};
const mate = require("../src/mate");
const theme = require("../src/theme");
Module._load = load;

const avatars = () => windows.filter((w) => w.surface === "mate-overlay" && !w.destroyed);
/** the page in a window loads (did-start-loading → did-finish-load) */
async function landed(w) {
  w.webContents.emit("did-start-loading");
  w.webContents.emit("did-finish-load");
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

mate.init({ openConsole() {}, consoleWindow: () => null, switchServer() {}, signOut() {}, quit() {} });
test.after(() => {
  mate.setQuitting(true);
  mate.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a Local execution start with the console out makes ONE avatar window, and the theme never paints it", async () => {
  // main.js: enterLocal() → the console lands on the local server (did-navigate → consoleNavigated) → mate.start()
  mate.consoleNavigated(`${SERVER}/`);
  mate.start();
  assert.equal(avatars().length, 1, "the console's landing and mate.start() made one avatar between them");
  const [avatar] = avatars();
  assert.equal(avatar.opts.transparent, true);
  assert.equal(avatar.opts.backgroundColor, "#00000000");
  assert.ok(theme.isTransparent(avatar) && mate.transparentWindows().includes(avatar));
  assert.match(avatar.loads[0], /\?surface=mate-overlay&mate=m1$/);

  // a page in any window tells the app its theme (main.js hrh:setTheme → theme.applyTheme over every window)
  const opaque = new FakeWindow({ backgroundColor: "#0a0c10" });
  theme.applyTheme(nativeTheme, "light", FakeWindow.getAllWindows());
  assert.deepEqual(avatar.bgSet, [], "the avatar window keeps its transparent background");
  assert.equal(opaque.bg, theme.BG.light, "an ordinary window follows the theme");
  opaque.destroy();

  // her page is see-through: shown
  await landed(avatar);
  assert.equal(avatar.visible, true);
  assert.equal(avatar.webContents.probes, 1);
});

test("the avatar is shown only once its page is see-through; any other page stays hidden and is retried", async () => {
  const [avatar] = avatars();
  // the server's "Updating…" page (503 while it swaps its files), an error page, an old page whose code is gone
  avatar.webContents.probe = () => Promise.resolve(false);
  avatar.hide();
  await landed(avatar);
  assert.equal(avatar.visible, false, "not shown: it would be an opaque card in the corner");
  mate.showAvatar(); // the tray's Show Mate meanwhile: still not that page
  assert.equal(avatar.visible, false);
  // the page could not be asked (hung): not shown either
  avatar.webContents.probe = () => new Promise(() => {});
  const late = theme.seeThrough(avatar.webContents, { timeoutMs: 20 });
  assert.equal(await late, false);
  // the overlay page itself again
  avatar.webContents.probe = () => Promise.resolve(true);
  await landed(avatar);
  assert.equal(avatar.visible, true);
  // an answer about an earlier page arrives after the next page started: dropped
  let answer;
  avatar.webContents.probe = () => new Promise((r) => (answer = r));
  avatar.hide();
  avatar.webContents.emit("did-finish-load");
  avatar.webContents.emit("did-start-loading");
  answer(true);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(avatar.visible, false);
});

test("the bar and the quick card are see-through windows the theme leaves alone too", () => {
  mate.openQuick();
  const quick = windows.find((w) => w.surface === "mate-quick" && !w.destroyed);
  assert.ok(quick && quick.opts.transparent && theme.isTransparent(quick));
  theme.applyTheme(nativeTheme, "dark", FakeWindow.getAllWindows());
  assert.deepEqual(quick.bgSet, []);
  for (const w of avatars()) assert.deepEqual(w.bgSet, []);
});

test("the probe asks for the overlay's own see-through mark and clear <html> / <body>", () => {
  assert.match(theme.SEE_THROUGH_PROBE, /classList\.contains\("mate-transparent"\)/);
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "index.css"), "utf8");
  assert.match(css, /html\.mate-transparent,\s*html\.mate-transparent body/, "the class the probe looks for (frontend/src/index.css)");
  const main = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "main.tsx"), "utf8");
  assert.match(main, /mateSurface === "mate-overlay"[^\n]*classList\.add\("mate-transparent"\)/);
  // the probe itself on a few pages
  const page = ({ cls = ["mate-transparent"], html = "rgba(0, 0, 0, 0)", body = "rgba(0, 0, 0, 0)", image = "none" } = {}) => {
    const h = { classList: { contains: (c) => cls.includes(c) }, bg: html };
    const b = { bg: body };
    return vm.runInNewContext(theme.SEE_THROUGH_PROBE, {
      document: { documentElement: h, body: b },
      getComputedStyle: (el) => ({ backgroundColor: el.bg, backgroundImage: el === b ? image : "none" }),
    });
  };
  assert.equal(page(), true, "the overlay");
  assert.equal(page({ html: "transparent" }), true);
  assert.equal(page({ cls: [] }), false, "not the overlay surface (the swap page, an error page, an old page)");
  assert.equal(page({ body: "rgb(241, 243, 247)" }), false, "the light theme's page colour");
  assert.equal(page({ body: "rgba(10, 12, 16, 0.5)" }), false);
  assert.equal(page({ image: "radial-gradient(red, blue)" }), false, "the theme's page gradient");
  // the preload keeps the see-through windows' pages without a page colour from their first frame
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
  assert.match(preload, /surface === "mate-overlay" \|\| surface === "mate-quick" \|\| surface === "bar"\) \{\s*try \{\s*webFrame\.insertCSS\("html,body\{background:transparent!important\}"\)/);
});
