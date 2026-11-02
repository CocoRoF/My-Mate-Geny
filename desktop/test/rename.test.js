// src/rename.js: what a user set up under the Linux app's old names (hr-harnessor-desktop, up to 0.4.19) follows the
// rename to my-mate-geny — start at login, a GNOME dock pin.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execProgram, autostartStale, renameFavorites, migrateDockPin } = require("../src/rename");

const entry = (exec) => `[Desktop Entry]\nType=Application\nName=My Mate Geny\nExec=${exec}\nTerminal=false\n`;
const OLD = "/opt/My Mate Geny/hr-harnessor-desktop";
const NEW = "/opt/My Mate Geny/my-mate-geny";

test("execProgram reads the program of an Exec line, quoted or not", () => {
  assert.equal(execProgram(entry('"/opt/My Mate Geny/hr-harnessor-desktop" --ozone-platform=x11 --hidden')), OLD);
  assert.equal(execProgram(entry("/home/u/Apps/my-mate-geny-0.4.19-linux-x86_64.AppImage --ozone-platform=x11 --hidden")), "/home/u/Apps/my-mate-geny-0.4.19-linux-x86_64.AppImage");
  assert.equal(execProgram(entry('"/home/u/a \\"b\\" \\$x" --hidden')), '/home/u/a "b" $x');
  assert.equal(execProgram("[Desktop Entry]\nName=x\n"), "");
});

test("autostartStale: the old .deb launcher (gone, or the compat link to this one) and a replaced AppImage are stale", () => {
  const gone = { exists: () => false, realpath: (p) => p };
  assert.equal(autostartStale(entry(`"${OLD}" --hidden`), NEW, gone), true);
  const link = { exists: () => true, realpath: (p) => (p === OLD ? NEW : p) };
  assert.equal(autostartStale(entry(`"${OLD}" --hidden`), NEW, link), true);
  assert.equal(autostartStale(entry("/home/u/my-mate-geny-0.4.19-linux-x86_64.AppImage --hidden"), "/home/u/my-mate-geny-0.4.20-linux-x86_64.AppImage", gone), true);
});

test("autostartStale: this app's entry, and another installed copy's, are left alone", () => {
  const all = { exists: () => true, realpath: (p) => p };
  assert.equal(autostartStale(entry(`"${NEW}" --ozone-platform=x11 --hidden`), NEW, all), false);
  assert.equal(autostartStale(entry("/home/u/my-mate-geny.AppImage --hidden"), NEW, all), false); // the user's other copy
  assert.equal(autostartStale("", NEW, all), false);
  assert.equal(autostartStale(entry(`"${OLD}"`), NEW, { exists: () => true, realpath: () => { throw new Error("EACCES"); } }), false);
});

test("renameFavorites swaps the old pin in place, drops it when the new one is there, else says null", () => {
  assert.equal(renameFavorites("['org.gnome.Nautilus.desktop', 'hr-harnessor-desktop.desktop', 'firefox_firefox.desktop']\n"),
    "['org.gnome.Nautilus.desktop', 'my-mate-geny.desktop', 'firefox_firefox.desktop']");
  assert.equal(renameFavorites("['hr-harnessor-desktop.desktop', 'my-mate-geny.desktop']"), "['my-mate-geny.desktop']");
  assert.equal(renameFavorites("['org.gnome.Nautilus.desktop']"), null);
  assert.equal(renameFavorites("@as []"), null);
  assert.equal(renameFavorites(""), null);
});

test("migrateDockPin: gsettings get → set once; no GNOME or nothing pinned marks it done; a failed set retries next time", () => {
  const run = (getOut, { setFails = false, done = false, desktop = true } = {}) => {
    const calls = [];
    let marked = false;
    migrateDockPin({
      execFile: (cmd, args, _o, cb) => {
        calls.push([cmd, ...args]);
        if (args[0] === "get") return getOut instanceof Error ? cb(getOut) : cb(null, getOut);
        cb(setFails ? new Error("dconf") : null, "");
      },
      desktopFileExists: () => desktop,
      done: () => done,
      markDone: () => (marked = true),
    });
    return { calls, marked };
  };
  const pinned = run("['hr-harnessor-desktop.desktop']\n");
  assert.deepEqual(pinned.calls.at(-1), ["gsettings", "set", "org.gnome.shell", "favorite-apps", "['my-mate-geny.desktop']"]);
  assert.equal(pinned.marked, true);
  assert.deepEqual(run("['a.desktop']").calls.length, 1);
  assert.equal(run("['a.desktop']").marked, true);
  assert.equal(run(new Error("no gsettings")).marked, true);
  assert.equal(run("['hr-harnessor-desktop.desktop']", { setFails: true }).marked, false);
  assert.equal(run("x", { done: true }).calls.length, 0);
  assert.equal(run("x", { desktop: false }).calls.length, 0); // an AppImage / no .deb: not ours to pin
});
