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
});

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
