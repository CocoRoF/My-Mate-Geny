// Light / dark in the desktop app (src/theme.js): the stored mode, nativeTheme, the windows' background.
// Run: node --test test/*.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { BG, isThemeMode, modeOf, backgroundFor, applyTheme, keepTransparent, isTransparent, seeThrough } = require("../src/theme");

function fakeNativeTheme(osDark) {
  const nt = {
    _source: "system",
    get themeSource() {
      return this._source;
    },
    set themeSource(v) {
      this._source = v;
    },
    get shouldUseDarkColors() {
      return this._source === "system" ? osDark : this._source === "dark";
    },
  };
  return nt;
}
const fakeWindow = () => ({ bg: null, destroyed: false, isDestroyed() { return this.destroyed; }, setBackgroundColor(c) { this.bg = c; } });

test("modes: system / light / dark; anything else follows the system", () => {
  assert.ok(isThemeMode("light") && isThemeMode("dark") && isThemeMode("system"));
  assert.equal(isThemeMode("auto"), false);
  assert.equal(modeOf(undefined), "system");
  assert.equal(modeOf("sepia"), "system");
  assert.equal(modeOf("dark"), "dark");
  assert.equal(backgroundFor(true), BG.dark);
  assert.equal(backgroundFor(false), BG.light);
});

test("applying a mode sets nativeTheme and repaints the windows", () => {
  const nt = fakeNativeTheme(true);
  const a = fakeWindow();
  const b = fakeWindow();
  b.destroyed = true;
  assert.equal(applyTheme(nt, "light", [a, b]), BG.light);
  assert.equal(nt.themeSource, "light");
  assert.equal(a.bg, BG.light);
  assert.equal(b.bg, null, "a closed window is left alone");
  applyTheme(nt, "system", [a]);
  assert.equal(nt.themeSource, "system");
  assert.equal(a.bg, BG.dark, "system: the OS is dark here");
  applyTheme(fakeNativeTheme(false), "system", [a]);
  assert.equal(a.bg, BG.light);
  applyTheme(nt, "nonsense", [a]);
  assert.equal(nt.themeSource, "system");
});

test("a see-through window is never painted, even when it is handed in", async () => {
  const nt = fakeNativeTheme(false);
  const clear = keepTransparent(fakeWindow());
  const plain = fakeWindow();
  assert.ok(isTransparent(clear) && !isTransparent(plain) && !isTransparent(null));
  applyTheme(nt, "light", [clear, plain]);
  assert.equal(clear.bg, null);
  assert.equal(plain.bg, BG.light);
  // seeThrough: the page's answer, false when it throws or does not answer in time
  assert.equal(await seeThrough({ executeJavaScript: async () => true }), true);
  assert.equal(await seeThrough({ executeJavaScript: async () => "yes" }), false);
  assert.equal(await seeThrough({ executeJavaScript: async () => { throw new Error("gone"); } }), false);
  assert.equal(await seeThrough({ executeJavaScript: () => new Promise(() => {}) }, { timeoutMs: 10 }), false);
});

test("the app's colours match the console's (frontend/src/lib/themeCore.ts)", () => {
  const core = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "lib", "themeCore.ts"), "utf8");
  assert.ok(core.includes(`dark: "${BG.dark}"`) && core.includes(`light: "${BG.light}"`));
});

test("the local pages and the fallback title bar have a light theme (prefers-color-scheme follows nativeTheme)", () => {
  for (const f of ["connect.html", "offline.html", "capture-ask.html", "preload.js"]) {
    const s = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
    assert.match(s, /prefers-color-scheme:\s*light/, f);
  }
});
