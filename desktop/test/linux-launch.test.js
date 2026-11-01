// Linux start-up: the launcher script that takes the Electron binary's place (build/linux-launcher.sh, put there by
// build/after-pack.js) and its --no-sandbox decision, the .deb maintainer scripts (build/deb-*.tpl), what restarts
// the app (src/launch.js) and the start-up log (src/startup-log.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { installLinuxLauncher } = require("../build/after-pack");
const { launchCommand } = require("../src/launch");
const log = require("../src/startup-log");

const linux = process.platform === "linux";
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `hrh-${name}-`));

/** an app dir as electron-builder leaves it, after after-pack: the launcher, a fake "Electron" that prints what it got */
function fakeApp() {
  const dir = tmp("app");
  const exe = path.join(dir, "hr-harnessor-desktop");
  fs.writeFileSync(exe, '#!/bin/sh\necho "ARGS:$*"\necho "STATE:$HRH_SANDBOX_STATE"\necho "LAUNCHER:$HRH_LAUNCHER"\n');
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(dir, "chrome-sandbox"), "");
  fs.chmodSync(path.join(dir, "chrome-sandbox"), 0o755);
  installLinuxLauncher(dir, "hr-harnessor-desktop");
  // stand-ins for the probes: `unshare` says whether user namespaces work here
  const bin = path.join(dir, "fakebin");
  fs.mkdirSync(bin);
  return { dir, exe, bin };
}

function run(app, { userns, args = [], env = {} }) {
  fs.writeFileSync(path.join(app.bin, "unshare"), `#!/bin/sh\nexit ${userns ? 0 : 1}\n`);
  fs.chmodSync(path.join(app.bin, "unshare"), 0o755);
  const r = spawnSync(app.exe, args, {
    env: { PATH: `${app.bin}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const get = (k) => (r.stdout.match(new RegExp(`^${k}:(.*)$`, "m")) || [])[1];
  return { args: get("ARGS"), state: get("STATE"), launcher: get("LAUNCHER"), stderr: r.stderr };
}

test("after-pack swaps the binary for the launcher, idempotently", { skip: !linux }, () => {
  const app = fakeApp();
  assert.ok(fs.existsSync(`${app.exe}.bin`));
  assert.match(fs.readFileSync(app.exe, "utf8"), /^#!\/bin\/sh\n# My Mate Geny — Linux launcher/);
  installLinuxLauncher(app.dir, "hr-harnessor-desktop"); // a second run must not wrap the launcher itself
  assert.match(fs.readFileSync(`${app.exe}.bin`, "utf8"), /ARGS:/);
  assert.ok(fs.statSync(app.exe).mode & 0o111);
});

test("no user namespaces and no SUID helper (an AppImage on Ubuntu 24.04): --no-sandbox, said on stderr", { skip: !linux }, () => {
  const r = run(fakeApp(), { userns: false });
  assert.equal(r.args, "--no-sandbox");
  assert.equal(r.state, "off:no-userns-no-suid-helper");
  assert.match(r.stderr, /--no-sandbox/);
});

test("user namespaces work (Ubuntu 22.04, Fedora…): the sandbox stays", { skip: !linux }, () => {
  const r = run(fakeApp(), { userns: true, args: ["--ozone-platform=x11", "https://x/y z"] });
  assert.equal(r.args, "--ozone-platform=x11 https://x/y z");
  assert.equal(r.state, "on:userns");
  assert.equal(r.stderr, "");
});

test("arguments pass through unchanged; an explicit --no-sandbox is not doubled", { skip: !linux }, () => {
  const r = run(fakeApp(), { userns: false, args: ["--no-sandbox", "--hidden"] });
  assert.equal(r.args, "--no-sandbox --hidden");
  assert.equal(r.state, "off:asked");
});

test("HRH_SANDBOX=off / on override the probe", { skip: !linux }, () => {
  const app = fakeApp();
  assert.equal(run(app, { userns: true, env: { HRH_SANDBOX: "off" } }).args, "--no-sandbox");
  const on = run(app, { userns: false, env: { HRH_SANDBOX: "on" } });
  assert.equal(on.args, "");
  assert.equal(on.state, "on:HRH_SANDBOX");
});

test("the launcher tells the app where it is (for restarts / start at login), also through a symlink", { skip: !linux }, () => {
  const app = fakeApp();
  const link = path.join(tmp("link"), "hr-harnessor-desktop"); // like /usr/bin/hr-harnessor-desktop
  fs.symlinkSync(app.exe, link);
  const r = run({ ...app, exe: link }, { userns: false });
  assert.equal(r.launcher, fs.realpathSync(app.exe));
  assert.equal(r.args, "--no-sandbox");
});

test("the launcher is POSIX sh", { skip: !linux }, () => {
  execFileSync("sh", ["-n", path.join(ROOT, "build", "linux-launcher.sh")]);
});

// ── .deb maintainer scripts ──

/** electron-builder's FpmTarget fills ${name} (and throws on an unknown one) */
function fill(file) {
  const vars = { executable: "hr-harnessor-desktop", sanitizedProductName: "My Mate Geny", productFilename: "My Mate Geny" };
  return fs.readFileSync(path.join(ROOT, "build", file), "utf8").replace(/\${([a-zA-Z]+)}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`${file}: macro ${k} is not defined`);
    return vars[k];
  });
}

test("deb postinst: always a root SUID chrome-sandbox, an AppArmor profile for the real binary, valid bash", { skip: !linux }, () => {
  const s = fill("deb-postinst.tpl");
  assert.match(s, /chmod 4755 "\$APP_DIR\/chrome-sandbox"/);
  assert.match(s, /chown root:root "\$APP_DIR\/chrome-sandbox"/);
  assert.doesNotMatch(s, /chmod 0755 .*chrome-sandbox/);
  assert.match(s, /APP_DIR='\/opt\/My Mate Geny'/);
  assert.match(s, /profile hr-harnessor-desktop "\$APP_DIR\/hr-harnessor-desktop\.bin" flags=\(unconfined\)/);
  assert.match(s, /update-alternatives --install '\/usr\/bin\/hr-harnessor-desktop'/);
  execFileSync("bash", ["-n"], { input: s });
});

test("deb postrm: drops the AppArmor profile only on remove / purge, valid bash", { skip: !linux }, () => {
  const s = fill("deb-postrm.tpl");
  assert.match(s, /remove\|purge\)/);
  assert.match(s, /rm -f '\/etc\/apparmor.d\/hr-harnessor-desktop'/);
  execFileSync("bash", ["-n"], { input: s });
});

test("package.json: the deb uses our scripts and depends that install on Ubuntu 22.04 and 24.04 (t64 names)", () => {
  const b = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).build;
  assert.equal(b.deb.afterInstall, "build/deb-postinst.tpl");
  assert.equal(b.deb.afterRemove, "build/deb-postrm.tpl");
  for (const lib of ["libgtk-3-0", "libasound2", "libatspi2.0-0"]) {
    assert.ok(b.deb.depends.includes(`${lib}t64 | ${lib}`), `${lib}: needs the 24.04 name with the old one as alternative`);
  }
  assert.ok(b.deb.depends.includes("libnss3") && b.deb.depends.includes("libgbm1"));
  assert.equal(b.afterPack, "build/after-pack.js");
});

// ── what restarts the app ──

test("launchCommand: the AppImage, else the launcher, else the binary", () => {
  const yes = () => true;
  assert.equal(launchCommand({ APPIMAGE: "/a/x.AppImage", HRH_LAUNCHER: "/opt/x/l" }, "/opt/x/l.bin", yes), "/a/x.AppImage");
  assert.equal(launchCommand({ HRH_LAUNCHER: "/opt/x/l" }, "/opt/x/l.bin", yes), "/opt/x/l");
  assert.equal(launchCommand({ HRH_LAUNCHER: "/gone" }, "/opt/x/l.bin", () => false), "/opt/x/l.bin");
  assert.equal(launchCommand({}, "/usr/lib/electron", yes), "/usr/lib/electron");
});

// ── the start-up log ──

test("startup log: lines with time and level, folder created, rotated past the limit", () => {
  const dir = tmp("log");
  const file = path.join(dir, "logs", "main.log");
  const l = log.createLog(file, { now: () => new Date("2026-11-01T00:00:00Z") });
  l.info("start 1.2.3");
  l.error("boom");
  assert.equal(fs.readFileSync(file, "utf8"), "2026-11-01T00:00:00.000Z [info] start 1.2.3\n2026-11-01T00:00:00.000Z [error] boom\n");
  fs.writeFileSync(file, "x".repeat(log.MAX_BYTES + 1));
  l.info("after");
  assert.ok(fs.existsSync(`${file}.1`));
  assert.match(fs.readFileSync(file, "utf8"), /\[info\] after\n$/);
});

test("startup log: an unwritable place never throws", () => {
  const file = path.join(tmp("nolog"), "a-file");
  fs.writeFileSync(file, "");
  const l = log.createLog(path.join(file, "logs", "main.log")); // a folder can't be made inside a file
  assert.doesNotThrow(() => l.error("x"));
});

test("startLine names the version, arguments and the launcher's sandbox decision", () => {
  const s = log.startLine({ version: "0.4.99", platform: "linux", argv: ["/opt/x.bin", "--no-sandbox"], env: { HRH_SANDBOX_STATE: "off:no-userns-no-suid-helper", APPIMAGE: "/a.AppImage" } });
  assert.match(s, /start 0\.4\.99/);
  assert.match(s, /argv \["--no-sandbox"\]/);
  assert.match(s, /sandbox off:no-userns-no-suid-helper/);
  assert.match(s, /appimage \/a\.AppImage/);
});

function handler({ ready = true } = {}) {
  const seen = { logged: [], shown: [], exits: [] };
  let resolveReady;
  const h = log.createFailureHandler({
    log: { file: "/home/u/.config/hr-harnessor/logs/main.log", error: (m) => seen.logged.push(m) },
    isReady: () => ready,
    whenReady: () => new Promise((r) => (resolveReady = r)),
    showErrorBox: (title, body) => seen.shown.push([title, body]),
    exit: (c) => seen.exits.push(c),
    text: (err, file) => ["could not start", `${log.errorHeadline(err)}\n${file}`],
  });
  return { h, seen, ready: () => resolveReady() };
}

test("a failing start is logged, shown once with the log's path, and exits 1", () => {
  const { h, seen } = handler();
  h.fail(new Error("settings.json: bad\nmore"), "start");
  h.fail(new Error("again"), "uncaught exception");
  assert.equal(seen.logged.length, 2);
  assert.match(seen.logged[0], /^start: Error: settings.json: bad/);
  assert.deepEqual(seen.shown, [["could not start", "settings.json: bad\n/home/u/.config/hr-harnessor/logs/main.log"]]);
  assert.deepEqual(seen.exits, [1]);
});

test("an error before ready waits for ready to show its dialog", async () => {
  const { h, seen, ready } = handler({ ready: false });
  h.fail(new Error("early"), "uncaught exception");
  assert.equal(seen.shown.length, 0);
  ready();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.shown.length, 1);
  assert.deepEqual(seen.exits, [1]);
});

test("after the start an error is only logged — the app keeps running", () => {
  const { h, seen } = handler();
  h.started();
  h.fail(new Error("later"), "unhandled rejection");
  assert.equal(seen.logged.length, 1);
  assert.equal(seen.shown.length, 0);
  assert.equal(seen.exits.length, 0);
});
