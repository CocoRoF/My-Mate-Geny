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
  openChat: () => ipcRenderer.invoke("mate:openChat"),
  closeChat: () => ipcRenderer.invoke("mate:closeChat"),
  setChatOnTop: (on) => ipcRenderer.invoke("mate:chatOnTop", !!on),
  openConsole: (url) => ipcRenderer.invoke("mate:openConsole", typeof url === "string" ? url : undefined),
  setMate: (mateId) => ipcRenderer.invoke("mate:setMate", String(mateId || "")),
  setHotkey: (accel) => ipcRenderer.invoke("mate:setHotkey", String(accel ?? "")),
  setAutostart: (on) => ipcRenderer.invoke("mate:setAutostart", !!on),
  onCommand: (cb) => listen("mate:command", cb),
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

contextBridge.exposeInMainWorld("hrhNative", {
  platform: `desktop-${process.platform}`,
  version: arg("hrh-version") || "0.0.0",
  // which window this page is in: console | mate-overlay | mate-quick | mate-chat | bar
  surface,
  notify: (title, body) => ipcRenderer.invoke("hrh:notify", { title, body }),
  openExternal: (url) => ipcRenderer.invoke("hrh:openExternal", url),
  retry: () => ipcRenderer.invoke("hrh:retry"),
  // back to the connect screen (another server or account); signOut also
  // clears this server's cookies. changeServer: the pre-0.4 name.
  switchServer: () => ipcRenderer.invoke("hrh:switchServer"),
  changeServer: () => ipcRenderer.invoke("hrh:switchServer"),
  signOut: () => ipcRenderer.invoke("hrh:signOut"),
  mate,
  window: windowBridge,
  // the mouse's back / forward buttons as the OS reports them (Windows app-commands); the page goes back in-app
  onNav: (cb) => listen("nav:command", (dir) => cb(dir === "forward" ? "forward" : "back")),
  // in-app updates (updater.js): the state lives in the app, a page (re)reads it and follows it
  updates: {
    getState: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    cancel: () => ipcRenderer.invoke("update:cancel"),
    install: () => ipcRenderer.invoke("update:install"),
    retry: () => ipcRenderer.invoke("update:retry"),
    onState: (cb) => listen("update:state", cb),
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
      btn("m", "Minimize", ICON.min, () => ipcRenderer.send("window:minimize"));
      const max = btn("M", "Maximize", ICON.max, () => ipcRenderer.send("window:toggleMaximize"));
      btn("x", "Close", ICON.close, () => ipcRenderer.send("window:close"));
      const paint = (st) => {
        max.innerHTML = st && (st.maximized || st.fullscreen) ? ICON.restore : ICON.max;
        max.title = st && st.maximized ? "Restore" : "Maximize";
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
    findServer: (input) => ipcRenderer.invoke("connect:find", str(input)),
    signIn: (o = {}) => ipcRenderer.invoke("connect:signIn", {
      server: str(o.server), username: str(o.username), password: str(o.password), remember: o.remember !== false,
    }),
    cancel: () => ipcRenderer.invoke("connect:cancel"),
  });
}

if (surface === "bar") {
  contextBridge.exposeInMainWorld("hrhBar", {
    act: (name) => ipcRenderer.send("bar:act", String(name)),
    over: (on) => ipcRenderer.send("bar:over", !!on),
    onState: (cb) => listen("bar:state", cb),
  });
}
