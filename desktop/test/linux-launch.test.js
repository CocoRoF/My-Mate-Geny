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
  const exe = path.join(dir, "my-mate-geny");
  fs.writeFileSync(exe, '#!/bin/sh\necho "ARGS:$*"\necho "STATE:$HRH_SANDBOX_STATE"\necho "LAUNCHER:$HRH_LAUNCHER"\n');
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(dir, "chrome-sandbox"), "");
  fs.chmodSync(path.join(dir, "chrome-sandbox"), 0o755);
  installLinuxLauncher(dir, "my-mate-geny");
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
  installLinuxLauncher(app.dir, "my-mate-geny"); // a second run must not wrap the launcher itself
  assert.match(fs.readFileSync(`${app.exe}.bin`, "utf8"), /ARGS:/);
  assert.ok(fs.statSync(app.exe).mode & 0o111);
});

test("the old launcher name (hr-harnessor-desktop, up to 0.4.19) is a relative link to the new one, and runs it", { skip: !linux }, () => {
  const app = fakeApp();
  const old = path.join(app.dir, "hr-harnessor-desktop");
  assert.equal(fs.readlinkSync(old), "my-mate-geny");
  const r = run({ ...app, exe: old }, { userns: false, args: ["--hidden"] });
  assert.equal(r.args, "--no-sandbox --hidden");
  assert.equal(r.launcher, fs.realpathSync(app.exe)); // the app sees (and writes start at login with) the new name
});

test("the launcher looks for the AppArmor profile named after itself (my-mate-geny)", () => {
  const s = fs.readFileSync(path.join(ROOT, "build", "linux-launcher.sh"), "utf8");
  assert.match(s, /f="\/etc\/apparmor\.d\/\$\(basename "\$self"\)"/);
  assert.doesNotMatch(s, /\/etc\/apparmor\.d\/hr-harnessor/);
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

/** chrome-sandbox as the .deb's postinst leaves it: setuid and (per a stand-in `stat`) owned by root */
function suidRoot(app, mountOptions) {
  const helper = path.join(app.dir, "chrome-sandbox");
  fs.chmodSync(helper, 0o4755);
  fs.writeFileSync(path.join(app.bin, "stat"), "#!/bin/sh\necho 0\n");
  fs.writeFileSync(path.join(app.bin, "findmnt"), `#!/bin/sh\necho ${mountOptions}\n`);
  for (const f of ["stat", "findmnt"]) fs.chmodSync(path.join(app.bin, f), 0o755);
}

test("an installed .deb (chrome-sandbox root SUID) keeps the sandbox even where user namespaces are restricted", { skip: !linux }, () => {
  const app = fakeApp();
  suidRoot(app, "rw,relatime");
  const r = run(app, { userns: false });
  assert.equal(r.args, "");
  assert.equal(r.state, "on:suid-helper");
});

test("a SUID helper on a nosuid mount does not count", { skip: !linux }, () => {
  const app = fakeApp();
  suidRoot(app, "ro,nosuid,nodev,relatime");
  const r = run(app, { userns: false });
  assert.equal(r.args, "--no-sandbox");
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
  const link = path.join(tmp("link"), "my-mate-geny"); // like /usr/bin/my-mate-geny
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
  const vars = { executable: "my-mate-geny", sanitizedProductName: "My Mate Geny", productFilename: "My Mate Geny" };
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
  assert.match(s, /profile my-mate-geny "\$APP_DIR\/my-mate-geny\.bin" flags=\(unconfined\)/);
  assert.match(s, /APPARMOR_PROFILE='\/etc\/apparmor.d\/my-mate-geny'/);
  assert.match(s, /update-alternatives --install '\/usr\/bin\/my-mate-geny' 'my-mate-geny' "\$APP_DIR\/my-mate-geny"/);
  execFileSync("bash", ["-n"], { input: s });
});

/** a maintainer script run against a scratch root: its absolute paths moved under `root`, the tools it calls stubbed
 *  (each call logged) */
function runScript(file, root, args) {
  let s = fill(file);
  for (const p of ["/usr/bin/", "/etc/apparmor.d", "/var/cache/apparmor", "/opt/", "/usr/share/"]) s = s.split(p).join(`${root}${p}`);
  const bin = path.join(root, "stub-bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of ["update-alternatives", "apparmor_parser", "chown", "update-desktop-database", "update-mime-database"]) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${root}/calls"\n`);
    fs.chmodSync(path.join(bin, tool), 0o755);
  }
  const script = path.join(root, `${file}.sh`);
  fs.writeFileSync(script, s);
  const r = spawnSync("bash", [script, ...args], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return fs.existsSync(`${root}/calls`) ? fs.readFileSync(`${root}/calls`, "utf8") : "";
}

test("deb postinst after hr-harnessor-desktop (≤ 0.4.19) was replaced: its alternative, /usr/bin link and AppArmor profile go", { skip: !linux }, () => {
  const root = tmp("root");
  for (const d of ["usr/bin", "etc/apparmor.d", "var/cache/apparmor/0123abcd.0", "opt/My Mate Geny"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, "opt/My Mate Geny/chrome-sandbox"), "");
  fs.symlinkSync("/etc/alternatives/hr-harnessor-desktop", path.join(root, "usr/bin/hr-harnessor-desktop")); // dangling
  fs.writeFileSync(path.join(root, "etc/apparmor.d/hr-harnessor-desktop"), "profile hr-harnessor-desktop {}\n");
  fs.writeFileSync(path.join(root, "var/cache/apparmor/0123abcd.0/hr-harnessor-desktop"), "cache");
  fs.writeFileSync(path.join(root, "etc/apparmor.d/other-app"), "profile other-app {}\n");
  const calls = runScript("deb-postinst.tpl", root, ["configure", ""]);
  assert.match(calls, /^update-alternatives --remove-all hr-harnessor-desktop$/m);
  assert.match(calls, new RegExp(`^apparmor_parser --remove ${root}/etc/apparmor.d/hr-harnessor-desktop$`, "m"));
  assert.match(calls, new RegExp(`^update-alternatives --install ${root}/usr/bin/my-mate-geny my-mate-geny ${root}/opt/My Mate Geny/my-mate-geny 100$`, "m"));
  assert.ok(!fs.existsSync(path.join(root, "etc/apparmor.d/hr-harnessor-desktop")));
  assert.ok(!fs.existsSync(path.join(root, "var/cache/apparmor/0123abcd.0/hr-harnessor-desktop")));
  assert.throws(() => fs.lstatSync(path.join(root, "usr/bin/hr-harnessor-desktop")));
  assert.ok(fs.existsSync(path.join(root, "etc/apparmor.d/other-app")), "someone else's profile stays");
  assert.equal(fs.statSync(path.join(root, "opt/My Mate Geny/chrome-sandbox")).mode & 0o7777, 0o4755);
});

test("deb postrm: on remove / purge drops our alternative (by its real path) and AppArmor profile; an upgrade keeps them", { skip: !linux }, () => {
  const s = fill("deb-postrm.tpl");
  assert.match(s, /update-alternatives --remove 'my-mate-geny' '\/opt\/My Mate Geny\/my-mate-geny'/);
  execFileSync("bash", ["-n"], { input: s });
  const setup = () => {
    const root = tmp("root");
    fs.mkdirSync(path.join(root, "etc/apparmor.d"), { recursive: true });
    fs.writeFileSync(path.join(root, "etc/apparmor.d/my-mate-geny"), "profile my-mate-geny {}\n");
    return root;
  };
  const up = setup();
  assert.equal(runScript("deb-postrm.tpl", up, ["upgrade", "0.4.99"]), "");
  assert.ok(fs.existsSync(path.join(up, "etc/apparmor.d/my-mate-geny")));
  for (const how of ["remove", "purge"]) {
    const root = setup();
    const calls = runScript("deb-postrm.tpl", root, [how]);
    assert.match(calls, new RegExp(`^update-alternatives --remove my-mate-geny ${root}/opt/My Mate Geny/my-mate-geny$`, "m"));
    assert.ok(!fs.existsSync(path.join(root, "etc/apparmor.d/my-mate-geny")));
  }
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

test("package.json: Linux names are my-mate-geny, the deb takes over hr-harnessor-desktop; the ids that must not move stay", () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const b = p.build;
  assert.equal(b.linux.executableName, "my-mate-geny");
  assert.equal(b.deb.packageName, "my-mate-geny");
  assert.equal(p.desktopName, "my-mate-geny.desktop"); // notifications find the menu entry (name, icon)
  const fpm = b.deb.fpm;
  for (const f of ["--replaces", "--conflicts", "--provides"]) assert.equal(fpm[fpm.indexOf(f) + 1], "hr-harnessor-desktop", f);
  // the long description's first line is the synopsis (fpm takes the last --description)
  assert.equal(fpm[fpm.indexOf("--description") + 1].split("\n")[0], b.linux.synopsis);
  assert.match(b.linux.synopsis, /^My Mate Geny /);
  // unchanged: Windows installer GUID / notifications, updater cache folder, macOS bundle id
  assert.equal(b.appId, "me.hrletsgo.harnessor");
  assert.equal(p.name, "hr-harnessor-desktop");
  assert.equal(b.productName, "My Mate Geny");
  assert.equal(b.nsis.shortcutName, "My Mate Geny");
  assert.equal(b.nsis.uninstallDisplayName, "My Mate Geny");
  for (const k of ["win", "mac", "linux"]) assert.match(b[k].artifactName, /^my-mate-geny-\$\{version\}-/); // the update feed's names
  // the hicolor sizes menus and software centres look for
  for (const n of [16, 24, 32, 48, 64, 128, 256, 512]) assert.ok(fs.existsSync(path.join(ROOT, b.linux.icon, `${n}x${n}.png`)), `${n}x${n}`);
});

test("metainfo: version and date filled in, valid ids; addMetainfo hands it to the deb target only", () => {
  const { metainfo, addMetainfo, buildDate, METAINFO_ID } = require("../build/after-pack");
  const x = metainfo("0.4.99", "2026-11-02");
  assert.match(x, /<release version="0\.4\.99" date="2026-11-02"\/>/);
  assert.doesNotMatch(x, /\$\{/);
  for (const m of x.matchAll(/<!--([^]*?)-->/g)) assert.ok(!m[1].includes("--"), "no -- inside an XML comment");
  assert.match(x, new RegExp(`<id>${METAINFO_ID.replace(/\./g, "\\.")}</id>`));
  assert.match(x, /<launchable type="desktop-id">my-mate-geny\.desktop<\/launchable>/);
  assert.match(x, /<name>My Mate Geny<\/name>/);
  assert.equal(buildDate({ SOURCE_DATE_EPOCH: "1798848000" }), "2027-01-02");
  const outDir = tmp("dist");
  const deb = { name: "deb", options: { fpm: ["--replaces", "x"] } };
  const appImage = { name: "appImage", options: {} };
  const ctx = { outDir, targets: [appImage, deb], packager: { appInfo: { version: "1.2.3" } } };
  const file = addMetainfo(ctx);
  addMetainfo(ctx); // twice (another arch): one mapping
  assert.match(fs.readFileSync(file, "utf8"), /version="1\.2\.3"/);
  assert.deepEqual(deb.options.fpm, ["--replaces", "x", `${file}=/usr/share/metainfo/${METAINFO_ID}.metainfo.xml`]);
  assert.equal(appImage.options.fpm, undefined);
  assert.equal(addMetainfo({ outDir, targets: [appImage], packager: ctx.packager }), null);
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
