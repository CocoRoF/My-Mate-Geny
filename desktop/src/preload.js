// The only surface the web app sees: window.hrhNative (contextIsolation on).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hrhNative", {
  platform: `desktop-${process.platform}`,
  // Sandboxed preload: no require() of app files — the version comes in argv.
  version: (process.argv.find((a) => a.startsWith("--hrh-version=")) || "=0.0.0").split("=")[1],
  notify: (title, body) => ipcRenderer.invoke("hrh:notify", { title, body }),
  openExternal: (url) => ipcRenderer.invoke("hrh:openExternal", url),
  setServer: (url) => ipcRenderer.invoke("hrh:setServer", url),
  retry: () => ipcRenderer.invoke("hrh:retry"),
  changeServer: () => ipcRenderer.invoke("hrh:changeServer"),
});
