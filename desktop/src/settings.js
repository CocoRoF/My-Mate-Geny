// settings.json in userData: the console window, the server, and the Mate
// (mateId, avatar bounds, click-through, visible, hotkey, autostart, chat).
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULT_SERVER = "https://agent.hrletsgo.me";
const file = () => path.join(app.getPath("userData"), "settings.json");

let cache = null;

function readSettings() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), "utf8")) || {};
  } catch {
    cache = {};
  }
  return cache;
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  cache = next;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file());
  } catch (e) {
    console.warn(`[settings] could not save: ${e.message}`);
  }
  return next;
}

const serverUrl = () => (readSettings().serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");

function sameOrigin(url) {
  try {
    return new URL(url).origin === new URL(serverUrl()).origin;
  } catch {
    return false;
  }
}

module.exports = { DEFAULT_SERVER, readSettings, writeSettings, serverUrl, sameOrigin };
