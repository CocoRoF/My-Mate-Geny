// node --test test/*.test.js   (from mobile/)
// Light / dark on the app's local pages (www/index.html connect, www/offline.html): the console's last choice
// (GenyServer.getState → theme, ThemeBars.java), remembered for the next first paint; else the phone's (CSS).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WWW = path.join(__dirname, "..", "www");

function themeScript(file) {
  const html = fs.readFileSync(path.join(WWW, file), "utf8");
  const at = html.indexOf('localStorage.getItem("geny.theme")');
  assert.ok(at > 0, `${file}: reads the remembered theme`);
  assert.ok(at < html.indexOf("<body"), `${file}: before the page draws`);
  return html.slice(html.lastIndexOf("<script>", at) + 8, html.indexOf("</script>", at));
}

async function run(file, { stored = null, state = null, native = true } = {}) {
  const classes = new Set();
  const store = new Map(stored ? [["geny.theme", stored]] : []);
  const ctx = {
    document: { documentElement: { classList: { add: (c) => classes.add(c), remove: (...c) => c.forEach((x) => classes.delete(x)) } } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    window: { Capacitor: native ? { nativePromise: (p, m) => (p === "GenyServer" && m === "getState" ? Promise.resolve(state) : Promise.reject(new Error("no"))) } : undefined },
  };
  vm.createContext(ctx);
  vm.runInContext(themeScript(file), ctx);
  await new Promise((r) => setTimeout(r, 10));
  return { classes: [...classes].join(" "), stored: store.get("geny.theme") ?? null };
}

for (const file of ["index.html", "offline.html"]) {
  test(`${file}: the remembered theme at once, then the app's`, async () => {
    assert.deepEqual(await run(file, { stored: "light", state: {} }), { classes: "light", stored: "light" });
    assert.deepEqual(await run(file, { stored: "light", state: { theme: "dark" } }), { classes: "dark", stored: "dark" });
    assert.deepEqual(await run(file, { state: { theme: "light", themeMode: "light" } }), { classes: "light", stored: "light" });
  });
  test(`${file}: an older app (no theme in getState) or none: the phone's own (no class)`, async () => {
    assert.deepEqual(await run(file, { state: { server: "" } }), { classes: "", stored: null });
    assert.deepEqual(await run(file, { native: false }), { classes: "", stored: null });
  });
  test(`${file}: a light palette for html.light and the phone's light theme`, () => {
    const html = fs.readFileSync(path.join(WWW, file), "utf8");
    assert.match(html, /html\.light body/);
    assert.match(html, /@media \(prefers-color-scheme: light\)\s*\{\s*html:not\(\.dark\)/);
  });
}
