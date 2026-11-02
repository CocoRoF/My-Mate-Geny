// Linux names that changed with the rename to My Mate Geny: the .deb package, the launcher and the menu entry were
// `hr-harnessor-desktop` up to 0.4.19 and are `my-mate-geny` now (the data folder ~/.config/hr-harnessor stays, see
// main.js). What a user set up under the old names is carried over at start:
//  - start at login (~/.config/autostart/my-mate-geny.desktop) whose Exec names a launcher that is gone, or this
//    app's launcher under another name (the old one is a link to the new one, build/after-pack.js): rewritten to the
//    launcher that started this app. The same covers an AppImage whose versioned file name changed with an update.
//  - a GNOME dock pin of hr-harnessor-desktop.desktop (org.gnome.shell favorite-apps): pinned as my-mate-geny.desktop.
"use strict";

const fs = require("fs");

const OLD_DESKTOP_ID = "hr-harnessor-desktop.desktop";
const DESKTOP_ID = "my-mate-geny.desktop";

/** the program an Exec= line of a .desktop file starts (desktop-entry quoting: "…" with \" \` \$ \\) */
function execProgram(desktopText) {
  const line = String(desktopText || "").split("\n").find((l) => l.startsWith("Exec="));
  if (!line) return "";
  const v = line.slice(5).trimStart();
  if (!v.startsWith('"')) return v.split(/\s/)[0];
  let out = "";
  for (let i = 1; i < v.length; i++) {
    const c = v[i];
    if (c === "\\" && i + 1 < v.length) out += v[++i];
    else if (c === '"') return out;
    else out += c;
  }
  return out;
}

/** a start-at-login entry to rewrite: its program is missing, or is this app's launcher by another path */
function autostartStale(desktopText, current, { exists = fs.existsSync, realpath = fs.realpathSync } = {}) {
  const prog = execProgram(desktopText);
  if (!prog || !current || prog === current) return false;
  if (!exists(prog)) return true;
  try {
    return realpath(prog) === realpath(current);
  } catch {
    return false;
  }
}

/** org.gnome.shell favorite-apps (GVariant text, e.g. "['a.desktop', 'hr-harnessor-desktop.desktop']") with the old
 *  entry replaced in place by the new one (dropped if both are there); null when there is nothing to change */
function renameFavorites(gvariant) {
  const ids = [...String(gvariant || "").matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  if (!ids.includes(OLD_DESKTOP_ID)) return null;
  const has = ids.includes(DESKTOP_ID);
  const next = [];
  for (const id of ids) {
    if (id !== OLD_DESKTOP_ID) next.push(id);
    else if (!has && !next.includes(DESKTOP_ID)) next.push(DESKTOP_ID);
  }
  return next.length ? `[${next.map((id) => `'${id}'`).join(", ")}]` : "@as []";
}

/** the dock pin, once per install, only where the .deb's menu entry exists; never throws */
function migrateDockPin({ execFile, desktopFileExists, done, markDone, log = () => {} }) {
  if (done() || !desktopFileExists()) return;
  const KEY = ["org.gnome.shell", "favorite-apps"];
  execFile("gsettings", ["get", ...KEY], { timeout: 5000 }, (err, stdout) => {
    if (err) return markDone(); // no GNOME (or no gsettings): nothing to carry over
    const next = renameFavorites(stdout);
    if (next == null) return markDone();
    execFile("gsettings", ["set", ...KEY, next], { timeout: 5000 }, (err2) => {
      if (err2) return log(`dock pin: ${err2.message}`);
      log(`dock pin: ${OLD_DESKTOP_ID} -> ${DESKTOP_ID}`);
      markDone();
    });
  });
}

module.exports = { execProgram, autostartStale, renameFavorites, migrateDockPin, OLD_DESKTOP_ID, DESKTOP_ID };
