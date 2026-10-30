// macOS: without a Developer ID the app is unsigned, and Apple Silicon refuses
// to launch unsigned arm64 code at all. An ad-hoc signature makes it launchable
// (users still confirm once via right-click > Open, see the download page).
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
