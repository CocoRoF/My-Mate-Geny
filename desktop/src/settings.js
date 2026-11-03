// settings.json in userData: the console window, the server, and the Mate
// (mateId, avatar bounds, click-through, visible, hotkey, autostart, chat).
//
// The server is whatever the user connected to (connect.html); there is no
// built-in default. Keys: serverUrl (base URL, no trailing slash — may carry
// a sub-path), lastServer / username (prefill the connect screen; the
// password is never stored), rememberConnect, forgetServer (not remembered:
// dropped, with its cookies, at the next start).
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const { cleanBase } = require("./connect-core");

// Builds before 0.4 always used this server when none was saved. Only used to
// recognise such installs (src/main.js → migrateLegacy), never as a default.
const LEGACY_SERVER = "https://agent.hrletsgo.me";
const file = () => path.join(app.getPath("userData"), "settings.json");

let cache = null;
let existed = null;

function readSettings() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), "utf8")) || {};
    if (existed === null) existed = true;
  } catch {
    cache = {};
    if (existed === null) existed = fs.existsSync(file());
  }
  return cache;
}

function writeSettings(patch, { strict = false } = {}) {
  const next = { ...readSettings(), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file());
    cache = next;
  } catch (e) {
    console.warn(`[settings] could not save: ${e.message}`);
    if (strict) throw e;
    cache = next;
  }
  return next;
}

/** Did settings.json exist when this run started (the app ran before)? */
function settingsExisted() {
  readSettings();
  return !!existed;
}

/** The connected server's base URL ("" until the user connects). */
const serverUrl = () => cleanBase(readSettings().serverUrl);

function sameOrigin(url) {
  const base = serverUrl();
  if (!base) return false;
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

module.exports = { LEGACY_SERVER, readSettings, writeSettings, settingsExisted, serverUrl, sameOrigin };
