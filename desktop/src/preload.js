// The only surface the web app sees: window.hrhNative (contextIsolation on,
// sandboxed preload). The same preload serves every window: the console, the
// Mate surfaces (overlay / quick / chat, docs/mate.md §6–7), the local pages
// (connect, offline) and the action bar. The main process checks every
// message's sender, so exposing a call here grants nothing by itself.
const { contextBridge, ipcRenderer } = require("electron");

// Sandboxed preload: no require() of app files — facts come in argv.
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=").slice(1).join("=");
const surface = arg("hrh-surface") || "console";

const listen = (channel, cb) => {
  if (typeof cb !== "function") return () => {};
  const handler = (_event, payload) => {
    try {
      cb(payload);
    } catch (e) {
      console.error(e);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The app's language and the local pages' words (i18n.js; main.js answers synchronously, so a page has them
// before it draws). An app page (the console) tells the app its language with setLanguage.
const i18n = (() => {
  try {
    return ipcRenderer.sendSync("hrh:i18n") || null;
  } catch {
    return null;
  }
})();
const text = (i18n && i18n.text) || {};
const say = (key, fallback) => (typeof text[key] === "string" ? text[key] : fallback);

const mate = {
  showAvatar: (mateId) => ipcRenderer.invoke("mate:show", typeof mateId === "string" ? mateId : null),
  hideAvatar: () => ipcRenderer.invoke("mate:hide"),
  setClickThrough: (on) => ipcRenderer.invoke("mate:clickThrough", !!on),
  getState: () => ipcRenderer.invoke("mate:state"),
  moveBy: (dx, dy) => ipcRenderer.send("mate:moveBy", num(dx), num(dy)),
  moveEnd: () => ipcRenderer.send("mate:moveEnd"),
  // overlay, move mode: resize from an edge/corner ("n", "se", …) by a pointer delta (Geny's resize-by)
  resizeBy: (edge, dx, dy) => ipcRenderer.send("mate:resizeBy", String(edge || ""), num(dx), num(dy)),
  resizeEnd: () => ipcRenderer.send("mate:resizeEnd"),
  // overlay: the avatar window's suggested size (bottom-right corner fixed; a size the user set wins);
  // quick: the card's height (fixed width, top edge fixed)
  setAvatarSize: (w, h) => ipcRenderer.send("mate:size", num(w), num(h)),
  setSize: (w, h) => ipcRenderer.send("mate:size", num(w), num(h)),
  // quick: the card holds a draft — a click elsewhere does not close it
  setQuickPinned: (on) => ipcRenderer.send("mate:quickPinned", !!on),
  setMoveMode: (on) => ipcRenderer.invoke("mate:moveMode", !!on),
  openQuick: () => ipcRenderer.invoke("mate:openQuick"),
  closeQuick: () => ipcRenderer.invoke("mate:closeQuick"),
  screenHandled: () => ipcRenderer.invoke("mate:screenHandled"),
  openChat: () => ipcRenderer.invoke("mate:openChat"),
  closeChat: () => ipcRenderer.invoke("mate:closeChat"),
  setChatOnTop: (on) => ipcRenderer.invoke("mate:chatOnTop", !!on),
  // (Settings → Desktop app, as the tray's Reset): her place and size back to the start
  resetPlacement: () => ipcRenderer.invoke("mate:resetPlacement"),
  openConsole: (url) => ipcRenderer.invoke("mate:openConsole", typeof url === "string" ? url : undefined),
  setMate: (mateId) => ipcRenderer.invoke("mate:setMate", String(mateId || "")),
  setHotkey: (accel) => ipcRenderer.invoke("mate:setHotkey", String(accel ?? "")),
  setAutostart: (on) => ipcRenderer.invoke("mate:setAutostart", !!on),
  voiceState: (s) => ipcRenderer.send("mate:voiceState", s ? { mateId: String(s.mateId || ""), enabled: !!s.enabled, available: !!s.available, busy: !!s.busy } : null),
  onCommand: (cb) => listen("mate:command", cb),
};

// Screen capture (capture.js, docs/mate.md §4 "Seeing the screen"): what to capture for a mate on this computer, the
// user's own Share screen, and the mate's see_screen requests (the page hands them over from the server). The
// picture comes back as bytes (Uint8Array) — the page uploads it; nothing is saved on this computer.
const capture = {
  version: 3,
  notifications: 1,
  resume: 1,
  runtime: 1,
  info: () => ipcRenderer.invoke("capture:info"),
  sources: (o = {}) => ipcRenderer.invoke("capture:sources", { thumbnails: !!(o && o.thumbnails), size: num(o && o.size) }),
  getChoice: (mateId) => ipcRenderer.invoke("capture:getChoice", String(mateId || "")),
  setChoice: (mateId, src) => ipcRenderer.invoke("capture:setChoice", String(mateId || ""), src && typeof src === "object"
    ? { id: String(src.id || ""), name: String(src.name || ""), kind: String(src.kind || ""), display_id: String(src.display_id || "") } : null),
  grab: (o = {}) => ipcRenderer.invoke("capture:grab", {
    id: String((o && o.id) || ""),
    mateId: String((o && o.mateId) || ""), sourceId: String((o && o.sourceId) || ""), maxEdge: num(o && o.maxEdge),
    hideAvatar: false, hideConsole: false,
  }),
  request: (req = {}) => ipcRenderer.invoke("capture:request", JSON.parse(JSON.stringify(req || {}))),
  cancel: (id) => ipcRenderer.invoke("capture:cancel", String(id || "")),
  openPrivacySettings: () => ipcRenderer.invoke("capture:openPrivacy"),
  sharing: {
    pause: reason => ipcRenderer.invoke("capture:sharing:pause",String(reason||"error")),
    claim: () => ipcRenderer.invoke("capture:sharing:claim"),
    get: () => ipcRenderer.invoke("capture:sharing:get"),
    publish: v => ipcRenderer.invoke("capture:sharing:publish", v ? JSON.parse(JSON.stringify(v)) : null),
    stop: () => ipcRenderer.invoke("capture:sharing:stop"),
    mode: (mode,interval) => ipcRenderer.invoke("capture:sharing:mode",mode,interval),
    onChanged: cb => listen("capture:sharing",cb),
    onControl: cb => listen("capture:control",cb),
  },
};

// App-like window chrome (chrome.js): only in the console and the mate chat window, and only when the app draws no
// system title bar there. The page draws its own title bar with these; absent → the page draws none (older apps).
const chromeInfo = (() => {
  try {
    return ipcRenderer.sendSync("window:info");
  } catch {
    return null;
  }
})();
const windowBridge = chromeInfo
  ? {
      chrome: chromeInfo.chrome, // "custom" (draw min / max / close) | "mac" (the traffic lights are there)
      kind: chromeInfo.kind, // console | chat
      platform: process.platform,
      initial: { maximized: !!chromeInfo.maximized, fullscreen: !!chromeInfo.fullscreen, focused: chromeInfo.focused !== false },
      minimize: () => ipcRenderer.send("window:minimize"),
      toggleMaximize: () => ipcRenderer.send("window:toggleMaximize"),
      close: () => ipcRenderer.send("window:close"),
      getState: () => ipcRenderer.invoke("window:state"),
      onState: (cb) => listen("window:state", cb),
    }
  : undefined;

// Ports can change if another application occupies the saved local port. Keep device UI state across that move.
if(surface==="console"&&location.protocol==="http:"){
  try{
    const saved=ipcRenderer.sendSync("local:browserState");
    if(saved){
      for(const [k,v] of Object.entries(saved))localStorage.setItem(k,v);
      if(!localStorage.getItem("hrh_lang")&&i18n?.lang)localStorage.setItem("hrh_lang",i18n.lang);
      let last=JSON.stringify(saved);
      const save=()=>{try{const state={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k?.startsWith("hrh_"))state[k]=localStorage.getItem(k);}const next=JSON.stringify(state);if(next!==last){ipcRenderer.sendSync("local:browserState",state);last=next;}}catch{}};
      setInterval(save,1000);window.addEventListener("pagehide",save);document.addEventListener("visibilitychange",save);
      ipcRenderer.on("app:quitting",save);
    }
  }catch{}
}

contextBridge.exposeInMainWorld("hrhNative", {
  setup: {state:()=>ipcRenderer.invoke("setup:state"),seen:()=>ipcRenderer.invoke("setup:seen"),complete:()=>ipcRenderer.invoke("setup:complete")},
  platform: `desktop-${process.platform}`,
  version: arg("hrh-version") || "0.0.0",
  // which window this page is in: console | mate-overlay | mate-quick | mate-chat | bar
  surface,
  deviceIdentity: i18n?.device || null,
  executionMode: i18n?.executionMode || "server",
  onQuitting:cb=>listen("app:quitting",cb),
  // the pointer anywhere on the desktop while her avatar looks at it: follow(true) / follow(false), and the points
  // outside this window (its CSS px)
  cursor: { follow: (on) => ipcRenderer.send("cursor:follow", on === true), onPoint: (cb) => listen("cursor:point", cb) },
  notify: (title, body) => ipcRenderer.invoke("hrh:notify", { title, body }),
  openExternal: (url) => ipcRenderer.invoke("hrh:openExternal", url),
  retry: () => ipcRenderer.invoke("hrh:retry"),
  // back to the connect screen (another server or account); signOut also
  // clears this server's cookies. changeServer: the pre-0.4 name.
  switchServer: () => ipcRenderer.invoke("hrh:switchServer"),
  changeServer: () => ipcRenderer.invoke("hrh:switchServer"),
  signOut: () => ipcRenderer.invoke("hrh:signOut"),
  // the UI's language: the console sets it (tray, menus, notifications, these pages follow); the local pages read it
  language: (i18n && i18n.lang) || "en",
  text,
  setLanguage: (lang) => ipcRenderer.send("hrh:setLanguage", String(lang || "")),
  // light / dark: the console tells its mode (system | light | dark); native menus, dialogs, the window colour and
  // the local pages follow (theme.js)
  setTheme: (mode) => ipcRenderer.send("hrh:setTheme", String(mode || "")),
  mate,
  capture,
  device: {
    context: () => ipcRenderer.invoke("device:context"),
    events: mateId => ipcRenderer.invoke("device:events",String(mateId||"")),
    ackEvents: ids => ipcRenderer.invoke("device:events:ack",ids),
    get: () => ipcRenderer.invoke("device:get"),
    patch: p => ipcRenderer.invoke("device:patch", JSON.parse(JSON.stringify(p || {}))),
    migrate: p => ipcRenderer.invoke("device:migrate", JSON.parse(JSON.stringify(p || {}))),
    onChanged: cb => listen("device:changed", cb),
  },
  window: windowBridge,
  // the mouse's back / forward buttons as the OS reports them (Windows app-commands); the page goes back in-app
  onNav: (cb) => listen("nav:command", (dir) => cb(dir === "forward" ? "forward" : "back")),
  // a folder on this computer for a chat (folders.js): pick (native dialog) → scan / read inside it → release
  folders: {
    pick: () => ipcRenderer.invoke("folders:pick"),
    scan: (root, o = {}) => ipcRenderer.invoke("folders:scan", String(root || ""), { maxFiles: num(o.maxFiles), maxBytes: num(o.maxBytes) }),
    read: (root, rel, maxBytes) => ipcRenderer.invoke("folders:read", String(root || ""), String(rel || ""), num(maxBytes)),
    release: (root) => ipcRenderer.invoke("folders:release", String(root || "")),
  },
  // in-app updates (updater.js): the state lives in the app, a page (re)reads it and follows it
  updates: {
    source:()=>ipcRenderer.invoke('update:source'),
    setSource:value=>ipcRenderer.invoke('update:setSource',value),
    catalog:refresh=>ipcRenderer.invoke('update:catalog',refresh===true),
    onSourceChanged:cb=>listen('update:sourceChanged',cb),
    getState: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    cancel: () => ipcRenderer.invoke("update:cancel"),
    install: () => ipcRenderer.invoke("update:install"),
    retry: () => ipcRenderer.invoke("update:retry"),
    onState: (cb) => listen("update:state", cb),
  },
  // Higgsfield's sign-in redirect to localhost:8765 caught by the app (oauth-catch.js) → {url} | {error}
  higgsfield: {
    catchCallback: (o = {}) => ipcRenderer.invoke("higgsfield:catch", { timeoutMs: num(o.timeoutMs) }),
    cancelCatch: () => ipcRenderer.invoke("higgsfield:cancel"),
  },
});

// A page that draws no title bar of its own in a window without the system one (an older web console, the login
// page, the local connect / retry pages, a page still loading or one that failed to): a plain bar from here, so the
// window can always be moved, maximized and closed. A page that draws its own sets <html data-hrh-chrome>; the bar
// goes away then.
if (chromeInfo) installFallbackBar(chromeInfo);

function installFallbackBar(info) {
  const H = 32;
  const mac = info.chrome === "mac";
  let bar = null;
  let style = null;
  const claimed = () => !!document.documentElement && document.documentElement.hasAttribute("data-hrh-chrome");
  const svg = (d) => `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">${d}</svg>`;
  const ICON = {
    min: svg('<path d="M0 5.5h10"/>'),
    max: svg('<rect x="0.5" y="0.5" width="9" height="9" rx="1"/>'),
    restore: svg('<rect x="0.5" y="2.5" width="7" height="7" rx="1"/><path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"/>'),
    close: svg('<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>'),
  };
  const add = () => {
    if (bar || claimed() || !document.documentElement || !document.body) return;
    style = document.createElement("style");
    style.textContent = `
      html:not([data-hrh-chrome]) { --app-h: calc(100dvh - ${H}px) !important; }
      html:not([data-hrh-chrome]) body { padding-top: ${H}px !important; box-sizing: border-box !important; }
      #hrh-native-bar { position: fixed; top: 0; left: 0; right: 0; height: ${H}px; z-index: 2147483647; display: flex; align-items: center;
        background: #0f1218; border-bottom: 1px solid #232936; color: #9aa3b4; font: 12px Inter, "Noto Sans KR", system-ui, sans-serif;
        -webkit-app-region: drag; user-select: none; padding-left: ${mac ? 78 : 12}px; box-sizing: border-box; }
      #hrh-native-bar .t { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; letter-spacing: .01em; }
      #hrh-native-bar button { -webkit-app-region: no-drag; width: 44px; height: ${H}px; border: 0; padding: 0; background: transparent; color: #9aa3b4;
        display: grid; place-items: center; cursor: default; transition: background .12s, color .12s; }
      #hrh-native-bar button:hover { background: #1c212c; color: #e6e9f0; }
      #hrh-native-bar button.x:hover { background: #e5484d; color: #fff; }
      @media (prefers-color-scheme: light) {
        #hrh-native-bar { background: #f8f9fb; border-bottom-color: #dce0e8; color: #474f5f; }
        #hrh-native-bar button { color: #474f5f; }
        #hrh-native-bar button:hover { background: #ebeef3; color: #161a23; }
        #hrh-native-bar button.x:hover { background: #e5484d; color: #fff; }
      }
      #hrh-boot { top: ${H}px !important; }`;
    (document.head || document.documentElement).appendChild(style);
    bar = document.createElement("div");
    bar.id = "hrh-native-bar";
    bar.setAttribute("data-testid", "native-fallback-bar");
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = document.title || "My Mate Geny";
    bar.appendChild(title);
    if (!mac) {
      const btn = (cls, label, icon, fn) => {
        const b = document.createElement("button");
        b.className = cls;
        b.title = label;
        b.setAttribute("aria-label", label);
        b.innerHTML = icon;
        b.addEventListener("click", fn);
        bar.appendChild(b);
        return b;
      };
      btn("m", say("winMinimize", "Minimize"), ICON.min, () => ipcRenderer.send("window:minimize"));
      const max = btn("M", say("winMaximize", "Maximize"), ICON.max, () => ipcRenderer.send("window:toggleMaximize"));
      btn("x", say("winClose", "Close"), ICON.close, () => ipcRenderer.send("window:close"));
      const paint = (st) => {
        max.innerHTML = st && (st.maximized || st.fullscreen) ? ICON.restore : ICON.max;
        max.title = st && st.maximized ? say("winRestore", "Restore") : say("winMaximize", "Maximize");
      };
      paint(info);
      ipcRenderer.on("window:state", (_e, st) => paint(st));
    }
    document.documentElement.appendChild(bar);
    new MutationObserver(() => (title.textContent = document.title || "My Mate Geny")).observe(document.querySelector("title") || document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  const remove = () => {
    bar && bar.remove();
    style && style.remove();
    bar = null;
    style = null;
  };
  // as soon as there is a body (a page that loads slowly is still movable / closable), and whenever the page claims
  const tick = () => (claimed() ? remove() : add());
  const watch = new MutationObserver(tick);
  const start = () => {
    if (!document.documentElement) return;
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-hrh-chrome"], childList: true });
    tick();
  };
  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });
  document.addEventListener("DOMContentLoaded", tick);
}

// The local connect screen (src/connect.html) only.
const onConnectPage = (() => {
  try {
    return location.protocol === "file:" && location.pathname.endsWith("/connect.html");
  } catch {
    return false;
  }
})();
if (onConnectPage) {
  const str = (v) => (typeof v === "string" ? v : "");
  contextBridge.exposeInMainWorld("hrhConnect", {
    state: () => ipcRenderer.invoke("connect:state"),
    startLocal: () => ipcRenderer.invoke("connect:local"),
    cancelLocal: () => ipcRenderer.invoke("connect:localCancel"),
    findServer: (input) => ipcRenderer.invoke("connect:find", str(input)),
    signIn: (o = {}) => ipcRenderer.invoke("connect:signIn", {
      server: str(o.server), username: str(o.username), password: str(o.password), remember: o.remember !== false,
    }),
    cancel: () => ipcRenderer.invoke("connect:cancel"),
  });
}

// the screen-capture prompt (src/capture-ask.html) only
if (surface === "capture-ask") {
  contextBridge.exposeInMainWorld("hrhCaptureAsk", {
    info: () => ipcRenderer.invoke("capture:askInfo"),
    answer: (allow) => ipcRenderer.send("capture:askAnswer", allow === true),
  });
}

if (surface === "bar") {
  contextBridge.exposeInMainWorld("hrhBar", {
    act: (name) => ipcRenderer.send("bar:act", String(name)),
    over: (on) => ipcRenderer.send("bar:over", !!on),
    onState: (cb) => listen("bar:state", cb),
  });
}
