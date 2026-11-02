// After electron-builder has laid out the app, before the installers are made.
//
// macOS: without a Developer ID the app is unsigned, and Apple Silicon refuses
// to launch unsigned arm64 code at all. An ad-hoc signature makes it launchable
// (users still confirm once via right-click > Open, see the download page).
//
// Linux: the Electron binary becomes "<executable>.bin" and build/linux-launcher.sh takes its name, so the .deb's
// menu entry and /usr/bin link and the AppImage's AppRun all start the launcher, which adds --no-sandbox where
// Chromium's sandbox cannot work (an AppImage on Ubuntu 23.10+, …) instead of letting it abort before any window.
// The launcher's old name (the package was hr-harnessor-desktop up to 0.4.19) stays as a link to it, so a start at
// login written by an old version keeps working until the app rewrites it (src/rename.js). The .deb also gets the
// AppStream metadata (build/metainfo.xml) that software centres show the installed app with.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const LAUNCHER = path.join(__dirname, "linux-launcher.sh");
const METAINFO = path.join(__dirname, "metainfo.xml");
const METAINFO_ID = "me.hrletsgo.MyMateGeny";
const OLD_EXECUTABLE = "hr-harnessor-desktop";

/** Swap the Electron binary in `appOutDir` for the launcher (idempotent); the old launcher name links to it. */
function installLinuxLauncher(appOutDir, executableName) {
  const exe = path.join(appOutDir, executableName);
  const real = `${exe}.bin`;
  if (!fs.existsSync(real)) fs.renameSync(exe, real);
  fs.copyFileSync(LAUNCHER, exe);
  fs.chmodSync(exe, 0o755);
  fs.chmodSync(real, 0o755);
  if (executableName !== OLD_EXECUTABLE) {
    const old = path.join(appOutDir, OLD_EXECUTABLE);
    fs.rmSync(old, { force: true });
    fs.symlinkSync(executableName, old);
  }
  return { launcher: exe, binary: real };
}

/** build/metainfo.xml with this build's version and date */
function metainfo(version, date) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return fs.readFileSync(METAINFO, "utf8").replace(/\$\{(version|date)\}/g, (_m, k) => esc(k === "version" ? version : date));
}

/** the release date: SOURCE_DATE_EPOCH (reproducible builds) or today, UTC */
function buildDate(env = process.env) {
  const epoch = Number(env.SOURCE_DATE_EPOCH);
  return new Date(Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.now()).toISOString().slice(0, 10);
}

/** write the metainfo next to the installers and have the deb target(s) install it under /usr/share/metainfo */
function addMetainfo(context) {
  const debs = (context.targets || []).filter((t) => t.name === "deb" && t.options);
  if (!debs.length) return null;
  const file = path.join(context.outDir, ".metainfo", `${METAINFO_ID}.metainfo.xml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, metainfo(context.packager.appInfo.version, buildDate()));
  // FpmTarget passes options.fpm to fpm as given; `src=dest` is fpm's way to add a file at a path
  const dest = `/usr/share/metainfo/${METAINFO_ID}.metainfo.xml`;
  for (const t of debs) t.options.fpm = [...(t.options.fpm || []).filter((a) => !a.endsWith(`=${dest}`)), `${file}=${dest}`];
  return file;
}

exports.installLinuxLauncher = installLinuxLauncher;
exports.metainfo = metainfo;
exports.buildDate = buildDate;
exports.addMetainfo = addMetainfo;
exports.METAINFO_ID = METAINFO_ID;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === "linux") {
    installLinuxLauncher(context.appOutDir, context.packager.executableName);
    addMetainfo(context);
    return;
  }
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
