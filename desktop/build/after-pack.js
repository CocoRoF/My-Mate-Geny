// After electron-builder has laid out the app, before the installers are made.
//
// macOS: without a Developer ID the app is unsigned, and Apple Silicon refuses
// to launch unsigned arm64 code at all. An ad-hoc signature makes it launchable
// (users still confirm once via right-click > Open, see the download page).
//
// Linux: the Electron binary becomes "<executable>.bin" and build/linux-launcher.sh takes its name, so the .deb's
// menu entry and /usr/bin link and the AppImage's AppRun all start the launcher, which adds --no-sandbox where
// Chromium's sandbox cannot work (an AppImage on Ubuntu 23.10+, …) instead of letting it abort before any window.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const LAUNCHER = path.join(__dirname, "linux-launcher.sh");

/** Swap the Electron binary in `appOutDir` for the launcher (idempotent). */
function installLinuxLauncher(appOutDir, executableName) {
  const exe = path.join(appOutDir, executableName);
  const real = `${exe}.bin`;
  if (!fs.existsSync(real)) fs.renameSync(exe, real);
  fs.copyFileSync(LAUNCHER, exe);
  fs.chmodSync(exe, 0o755);
  fs.chmodSync(real, 0o755);
  return { launcher: exe, binary: real };
}

exports.installLinuxLauncher = installLinuxLauncher;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === "linux") {
    installLinuxLauncher(context.appOutDir, context.packager.executableName);
    return;
  }
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
