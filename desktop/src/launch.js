// What starts this app again on Linux (the X11 restart, start at login): the AppImage file when it is one, else the
// launcher script that started us (build/linux-launcher.sh sets HRH_LAUNCHER; it decides about --no-sandbox), else
// the binary itself (development, Windows, macOS).
"use strict";

const fs = require("fs");

function launchCommand(env, execPath, exists = fs.existsSync) {
  if (env.APPIMAGE) return env.APPIMAGE;
  const launcher = env.HRH_LAUNCHER;
  if (launcher && launcher !== execPath && exists(launcher)) return launcher;
  return execPath;
}

module.exports = { launchCommand };
